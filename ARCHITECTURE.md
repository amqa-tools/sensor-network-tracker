# Architecture

How the ADEC Sensor Network Tracker is put together, from the browser down to the database.

For a plain-language version suitable for non-technical readers, see [`user-guide.html`](user-guide.html). This doc is for developers and agents working on the code.

---

## The three pieces

```
┌───────────────────┐        ┌──────────────────────────┐        ┌──────────────┐
│  Browser          │        │  Supabase                │        │  QuantAQ     │
│  (GitHub Pages)   │◀──────▶│  Postgres · Auth ·       │───────▶│  REST API    │
│  index.html       │        │  Storage · Edge Fns ·    │        │              │
│  app.js           │        │  Cron (pg_cron)          │        │              │
│  quantaq.js       │        │                          │        │              │
│  supabase-client  │        │                          │        │              │
└───────────────────┘        └──────────────────────────┘        └──────────────┘
```

1. **Browser / frontend** — a single static page hosted on GitHub Pages. No build step. All code is vanilla JS.
2. **Supabase** — the only backend. Hosts the database, handles auth, stores uploaded files, runs the edge function, and drives the cron job.
3. **QuantAQ** — the sensor manufacturer's API. The browser never talks to it directly; only the edge function holds the API key.

---

## Request paths

### A normal app interaction (e.g., "save a sensor")

```
User clicks Save
  → app.js calls db.saveSensor(...)   (supabase-client.js)
  → supabase-js library sends PATCH to supabase.co
  → RLS policy checks auth.uid() against the row
  → row is updated, response returns to the browser
  → app.js re-renders the view
```

Every write goes through a helper on the `db` object in `supabase-client.js`. There is no direct `supabase.from(...)` scattered through `app.js` — if you find yourself wanting to add one, add a `db.*` helper instead.

### A QuantAQ health check

```
pg_cron (Supabase)
  → invokes edge function `quantaq-check` on a schedule
  → edge function calls QuantAQ REST API with stored API key
  → decodes flag bitmask, applies grace periods
  → writes rows into `quantaq_alerts` table
  → browser (next time user opens the page) loads alerts via quantaq.js
```

Users can also trigger the scan manually from the UI — same edge function, same code path, different trigger.

See [`docs/quantaq-integration.md`](docs/quantaq-integration.md) for the full integration details.

---

## Authentication

Supabase email + password auth, gated by an allowlist.

1. `allowed_emails` table holds the emails permitted to sign up.
2. `is_email_allowed(check_email)` RPC (called from `db.signUp` in `supabase-client.js`) checks against it before attempting signup.
3. A database trigger also rejects any signup whose email isn't in `allowed_emails` — enforcement runs on Supabase's server, not in the browser, so the browser check is a UX optimization, not the security boundary.
4. Row Level Security is enabled on every table. Without a valid session there is no data access.

The anon key committed in `supabase-client.js` is the public anon key — safe to publish. RLS is what keeps the data private.

---

## Data model (summary)

See [`docs/data-model.md`](docs/data-model.md) for the full table-by-table reference. High-level:

- **`communities`** — the ~40 Alaska communities + 3 regulatory sites. Supports parent/child for sub-communities (e.g., NCore under Fairbanks).
- **`community_tags`** — arbitrary labels per community.
- **`sensors`** — QuantAQ Modulairs. Status is a text array so a sensor can be "Online" + "PM Sensor Issue" simultaneously.
- **`contacts`** — people at each community.
- **`notes`** + **`note_tags`** — cross-tagged history notes. One note can appear in the history of a sensor, a community, and a contact at once.
- **`comms`** + **`comm_tags`** — communication log (emails, phone calls, site visits) with the same cross-tagging model.
- **`community_files`** — metadata rows pointing at files in the `community-files` storage bucket.
- **`quantaq_alerts`** — sensor health alerts produced by the edge function.
- **`profiles`** — user display info, keyed by `auth.users.id`.
- **`allowed_emails`** — signup allowlist.
- **`app_settings`** — misc key/value settings (e.g., last QuantAQ check timestamp).

---

## Code layout

```
index.html              single-page app shell — all views and modals
styles.css              design tokens, layout, theme
app.js                  the main app (rendering, business logic)
quantaq.js              QuantAQ alerts UI (loads from quantaq_alerts)
quantaq.css             QuantAQ-specific styles
supabase-client.js      Supabase setup + `db` helper object — the data layer
supabase/
  config.toml
  functions/quantaq-check/    edge function run by cron
  migrations/                 timestamped SQL migrations
```

Historical/setup SQL (`supabase-schema.sql`, `seed-data*.sql`, `quantaq-setup.sql`, `collocation-schema.sql`) lives at the repo root but should be treated as reference. New schema changes go in `supabase/migrations/`.

---

## Conventions

- **One file per concern, mostly.** `app.js` is monolithic on purpose — keep it that way until it's genuinely painful. Don't introduce a framework or build step without discussion.
- **All data access through `db.*`.** If a feature needs a new query, add a helper to `supabase-client.js`.
- **Edit annotations.** When a sensor changes, the app prompts for a context note and writes it to `notes` — this is how history is built. Preserve that pattern when adding new editable fields.
- **Cross-tagging is a first-class idea.** New entities (e.g., a future "project" type) should plug into the same `note_tags` / `comm_tags` model rather than growing parallel history tables.
- **Design rules:** navy/gold/white only, DM Sans + JetBrains Mono, tokens in `:root`.

---

## Deployment

- Push to `main`. GitHub Pages rebuilds automatically.
- Database changes: create a new file under `supabase/migrations/` and run `supabase db push` (or apply manually via the Supabase SQL editor).
- Edge function changes: `supabase functions deploy quantaq-check`.

---

## What's deliberately not here

- **No build step, bundler, TypeScript, or framework.** Adding any of these is a large architectural decision — don't do it incidentally.
- **No staging environment.** Local dev points at production Supabase. If this becomes a problem, the fix is a second Supabase project, not mocks.
- **No custom backend server.** Supabase is it. Anything that needs secrets (like the QuantAQ API key) goes in an edge function.
