# Data Model

The full table-by-table reference for the Supabase database. For a higher-level picture of how tables fit into the app, see [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Conventions

- **IDs.** `communities` and `sensors` use human-readable text IDs (`anchorage`, `MOD-00442`). Everything else uses `uuid`.
- **Timestamps.** `created_at` is set by default; `updated_at` is maintained on tables where history matters.
- **Arrays.** `sensors.status` is a `text[]` — a sensor can hold multiple statuses at once (e.g. `{Online, PM Sensor Issue}`).
- **Cross-tagging.** Notes and comms attach to *multiple* entities via join tables (`note_tags`, `comm_tags`). Always query history through these joins, never by assuming a single parent.

---

## Core entities

### `communities`
The ~40 Alaska communities plus regulatory sites.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `anchorage`, `fbx-ncore`, etc. |
| `name` | text | Display name |
| `parent_id` | text, nullable, FK → `communities.id` | For sub-communities (e.g., NCore under Fairbanks) |
| `created_at` | timestamp | |

### `community_tags`
Customizable labels per community: *Regulatory Site*, *Interior Network*, *BLM*, etc. Many-to-one with communities.

### `sensors`
QuantAQ Modulairs.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | e.g. `MOD-00442` |
| `soa_tag_id` | text | State of Alaska asset tag |
| `type` | text | `Community Pod`, `Permanent Pod`, `Audit Pod` |
| `status` | text[] | Multi-valued — see [Sensor statuses](#sensor-statuses) |
| `community_id` | text FK → `communities.id` | Current deployment |
| `location` | text | Physical location description |
| `date_purchased` | date | |
| `collocation_dates` | text | Free-form date range |
| `created_at` / `updated_at` | timestamp | |

### `contacts`
People at each community.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name`, `role`, `email`, `phone`, `org` | text | |
| `community_id` | text FK → `communities.id` | |
| `active` | bool | Default true |
| `created_at` | timestamp | |

### `profiles`
App users. Row is created after signup via the `upsert_profile` RPC. `id` matches `auth.users.id`.

### `allowed_emails`
Signup allowlist. Enforced by both the `is_email_allowed` RPC (browser-side UX check) and a database trigger (real security boundary).

---

## History — notes and communications

Notes and comms share the same cross-tagging design. A single note can appear in the history of a sensor, a community, *and* a contact simultaneously.

### `notes`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `date` | timestamp | When the event happened (not when the row was written) |
| `type` | text | `Audit`, `Movement`, `Status Change`, etc. |
| `text` | text | Main note body |
| `additional_info` | text | Extra context (often supplied by the edit-annotation modal) |
| `created_by` | uuid FK → `profiles.id` | |
| `created_at` | timestamp | |

### `note_tags`
Links a note to any number of sensors / communities / contacts.

| Column | Type | Notes |
|---|---|---|
| `note_id` | uuid FK → `notes.id` | |
| `tag_type` | text | `sensor`, `community`, `contact` |
| `tag_id` | text | The ID in the corresponding table |

### `comms`
Communication log (emails, phone calls, site visits).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `date` | timestamp | |
| `comm_type` | text | `Email`, `Phone Call`, `Site Visit`, etc. |
| `text` | text | Summary |
| `subject`, `full_body` | text | Populated for emails |
| `community_id` | text FK → `communities.id` | Primary community |
| `created_by` | uuid FK → `profiles.id` | |
| `created_at` | timestamp | |

### `comm_tags`
Same cross-tagging shape as `note_tags`, but tags comms to contacts and communities.

---

## Files

### `community_files`
Metadata rows. Actual file bytes live in the Supabase Storage bucket `community-files`; this table just holds the pointer.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `community_id` | text FK | |
| `file_name`, `file_type` | text | |
| `storage_path` | text | Path inside the storage bucket |
| `uploaded_by` | uuid FK → `profiles.id` | |

---

## QuantAQ alerts

### `quantaq_alerts`
Written by the `quantaq-check` edge function, read by `quantaq.js`. See [`quantaq-integration.md`](quantaq-integration.md) for the full lifecycle.

| Column | Purpose |
|---|---|
| `sensor_sn`, `sensor_model` | Which sensor |
| `community_name` | Denormalized for display |
| `issue_type` | `Lost Connection`, `PM Sensor Issue`, `Gaseous Sensor Issue`, `SD Card Issue` |
| `detail` | Human-readable explanation (decoded flag names, etc.) |
| `status` | `pending`, `active`, `resolved`, `acknowledged` |
| `severity` | `critical` / `warning` / `info` |
| `grace_expires_at` | When a pending alert becomes active, or resolves-to-nothing if it clears first |
| `is_new` | UI flag for "you haven't seen this yet" |
| `detected_at`, `resolved_at`, `last_checked` | Timestamps |
| `acknowledged_by` | Profile reference |
| `notes` | JSONB array — free-form notes, including the linked `noteId` from the `notes` table if the alert was escalated to history |

### `app_settings`
Misc key/value scratch space. Used for things like `quantaq_last_check`.

---

## Sensor statuses

Valid values for `sensors.status[]`:

Online, Offline, In Transit, Service at Quant, Collocation, Auditing a Community, Lab Storage, Needs Repair, Ready for Deployment, PM Sensor Issue, Gaseous Sensor Issue, SD Card Issue.

The last three are "issue" statuses added and removed by the QuantAQ scan; the rest are set manually from the sensor detail view.

---

## Migrations

Schema changes go in `supabase/migrations/` as timestamped SQL files. Don't edit previous migrations in place — add a new one. `supabase-schema.sql` and the `seed-data*.sql` files at the repo root are historical snapshots from the initial Supabase setup and shouldn't be rerun.
