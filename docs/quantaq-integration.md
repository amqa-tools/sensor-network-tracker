# QuantAQ Integration

How sensor health alerts flow from the QuantAQ API into the tracker. If you're touching `quantaq.js`, `supabase/functions/quantaq-check/`, the cron job, or the `quantaq_alerts` table, read this first.

## The pieces

| Piece | Where | Role |
|---|---|---|
| QuantAQ REST API | `api.quant-aq.com` | Source of truth for sensor health. Requires an API key. |
| `quantaq-check` edge function | `supabase/functions/quantaq-check/index.ts` | Holds the API key. Runs the scan. Writes alerts. |
| `pg_cron` schedule | Supabase Postgres | Fires the edge function on a recurring schedule |
| `quantaq_alerts` table | Supabase Postgres | Persistent alert state |
| `quantaq.js` | Repo root | Browser UI: loads alerts, renders them, lets users acknowledge / write notes |

**The browser never calls QuantAQ directly.** The API key only exists inside the edge function's environment variables. The frontend's only QuantAQ-related job is reading `quantaq_alerts` and rendering.

## Scan flow

```
pg_cron fires                   ┐
  or                            ├──▶  quantaq-check edge function
user clicks "Run QuantAQ Check" ┘           │
                                            ▼
                      GET /devices/ on QuantAQ API (with API key)
                                            │
                                            ▼
              decode flag bitmask, classify each sensor, apply grace period
                                            │
                                            ▼
                    upsert/update rows in `quantaq_alerts`
                                            │
                                            ▼
                      (optional) write linked row to `notes` if escalated
```

## Flag decoding

QuantAQ returns a bitmask per sensor. The constants in the edge function mirror those in `quantaq.js`:

| Bit | Meaning | Maps to |
|---|---|---|
| `FLAG_OPC` (2) | Optical particle counter fault | PM Sensor Issue |
| `FLAG_NEPH` (4) | Nephelometer fault | PM Sensor Issue |
| `FLAG_CO` (16) | CO sensor fault | Gaseous Sensor Issue |
| `FLAG_NO` (32) | NO sensor fault | Gaseous Sensor Issue |
| `FLAG_NO2` (64) | NO₂ sensor fault | Gaseous Sensor Issue |
| `FLAG_O3` (128) | O₃ sensor fault | Gaseous Sensor Issue |
| `FLAG_SD` (8192) | SD card issue | SD Card Issue |

`describeFlags()` produces the human-readable detail string (e.g., `"OPC, NEPH"`).

The scan looks at a **window** of the most recent raw readings per sensor (see `RAW_WINDOW_SIZE` in the edge function) and ORs the flag bits across the whole window — not just the latest point. Intermittent faults (e.g., a PM sensor that sets the OPC bit on some readings but not others) are real malfunctions that QuantAQ's own dashboard surfaces, so we need to catch them the same way. If only the single latest reading were checked, intermittent faults would slip through and any pending alert could get silently dismissed the first time a clean reading showed up mid-grace-window.

## Lost Connection detection

A sensor is flagged *Lost Connection* when its last-seen timestamp is older than `OFFLINE_MS` (1 hour) **and** its app status isn't in `EXPECTED_OFFLINE` (Lab Storage, In Transit, Shipped to/from Quant, etc.). The expected-offline list exists because a sensor that's deliberately unplugged shouldn't page anyone.

## Grace periods — the false-alarm filter

The most important behavior in this integration. Without grace periods, every power outage produces a flood of alerts that self-resolve within hours.

| Issue type | Grace period | Why |
|---|---|---|
| Gaseous Sensor Issue | 6 hours | Gas sensors need hours to warm up after a power cycle and look "broken" in the meantime |
| Lost Connection | 2 hours | Brief network blips shouldn't page anyone |
| PM Sensor Issue | 0 (immediate) | Real hardware fault |
| SD Card Issue | 0 (immediate) | Real hardware fault |

A new alert is written with `status = pending` and a `grace_expires_at` timestamp. On each subsequent scan:
- If the issue has **cleared** before `grace_expires_at`, the alert is deleted/resolved and **no user ever sees it**.
- If the issue is **still present** at `grace_expires_at`, the alert transitions to `active` and surfaces in the UI.

**When changing severity or grace periods, update both places:** `supabase/functions/quantaq-check/index.ts` and the `ALERT_SEVERITY` / `GRACE_PERIODS` constants in `quantaq.js`. They are duplicated on purpose (the browser uses them for derived UI fields when the DB value is missing), but drift will cause display bugs.

## Alert lifecycle

```
 pending (inside grace window)
    │
    ├── issue clears  → row removed, never displayed
    │
    └── grace expires → active
                         │
                         ├── user acknowledges → acknowledged
                         │
                         └── issue clears      → resolved
```

`is_new` is a separate UI flag meaning "the current user hasn't looked at this yet" — it has nothing to do with the pending/active lifecycle.

## Linking alerts to history notes

When a user escalates an alert (e.g., writes a follow-up), `quantaq.js` creates a row in `notes` and stores the `noteId` inside the alert's `notes` JSONB array. That's how `quantaq_alerts.notes[0].noteId` shows up — it's the bridge back to normal sensor history.

## Cron schedule

The schedule lives in `cron.job` / `cron.job_run_details` inside Supabase. The migration `20260411235000_add_quantaq_cron_info_rpc.sql` adds an RPC so the frontend can display "last run at X" and "next run at Y" on the QuantAQ view. If you change the schedule, do it via the Supabase dashboard or a new migration — don't edit existing migrations.

## Manual runs

The UI has a "Run QuantAQ Check" button that invokes the same edge function directly. It uses the same code path and same grace periods. The only difference from cron is the trigger source.

## Running the edge function locally

```
supabase functions serve quantaq-check --env-file .env.local
```

Your `.env.local` needs `QUANTAQ_API_KEY` and the Supabase service role key. Treat the service role key like a password — never commit it.

## Gotchas

- **Double-write.** The edge function is idempotent per (sensor, issue type) — it upserts rather than inserts. Don't "fix" this by adding a dedupe on top.
- **Timestamps are UTC.** All the `detected_at` / `grace_expires_at` values are stored as UTC; the UI converts for display.
- **`EXPECTED_OFFLINE` lives in two places.** If you add a new app status that means "intentionally offline," add it to both `quantaq.js` and `supabase/functions/quantaq-check/index.ts`.
- **The anon key is not enough to call the function.** The edge function has an auth gate that requires either the service role key (cron's path) or a real user JWT (the UI button uses `supa.functions.invoke()`, which sends the signed-in user's session JWT automatically).
