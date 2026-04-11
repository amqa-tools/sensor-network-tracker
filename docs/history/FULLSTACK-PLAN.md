# Full-Stack Migration Plan: ADEC Sensor Network Tracker

## Context
The app currently runs entirely in the browser — all data lives in localStorage, which means:
- Data is trapped on one computer/browser (can't share between team members)
- If you clear browser data, everything is gone
- Files are stored as base64 strings in localStorage (has size limits)
- No real user accounts or login security

We're moving to a full-stack setup so the data lives in a real database that multiple people can access from anywhere, with real security. Everything runs on free tiers.

---

## How the Pieces Fit Together (Plain English)

```
You (browser)  ──→  Supabase (database + files + auth + security)
```

**Supabase** (free tier) — Does everything: database, file storage, user login, and security. Your browser talks to it using their JavaScript library. Even though the browser has a "public" API key, Supabase enforces all security rules on its servers — the browser can't bypass them.

**GitHub** — Stores your code and tracks changes (you already use this).

**GitHub Pages** (free) — Hosts your website at a URL like `aylacrosby531.github.io/sensor-network-tracker`. Push code to GitHub, site updates automatically. Replaces opening `index.html` from your desktop.

**No backend server needed.** Security is enforced by:
1. An `allowed_emails` table — only the 3 emails you list can create accounts
2. A database trigger that rejects signups from unlisted emails (runs on Supabase's server, not in the browser)
3. Row Level Security (RLS) — every table is locked down so only logged-in users can read/write

---

## Authentication & Security

### How it works:
1. You add your 3 team email addresses to the `allowed_emails` table
2. Each person goes to the site, enters their `@alaska.gov` email, and gets a confirmation email
3. They click the link, set a password, and they're in
4. Anyone NOT in the `allowed_emails` table is rejected — the signup fails with an error
5. Every database query checks `auth.uid()` — no valid login = no data access

### Why this is secure:
- The `allowed_emails` check is a **database trigger** — it runs on Supabase's server, not in the browser. Even if someone has the public API key and tries to call the signup API directly, the trigger blocks them.
- **RLS policies** on every table mean: no auth token = no data. Period.
- The public API key is designed to be public — it's like a phone number. Knowing the number doesn't let you in; you still need the password and to be on the list.

---

## Data Model (Database Tables)

### `allowed_emails` (access control)
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (primary key) | auto-generated |
| email | text (unique) | e.g., 'ayla.crosby@alaska.gov' |
| added_at | timestamp | auto-set |

### `profiles` (users — auto-created on signup)
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (primary key, from Supabase auth) | matches auth.users.id |
| email | text | their @alaska.gov email |
| name | text | display name |
| created_at | timestamp | auto-set |

### `communities`
| Column | Type | Description |
|--------|------|-------------|
| id | text (primary key) | e.g., 'anchorage', 'fbx-ncore' |
| name | text | e.g., 'Anchorage', 'NCore' |
| parent_id | text (nullable, references communities.id) | e.g., 'fairbanks' for NCore |
| created_at | timestamp | auto-set |

### `community_tags`
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (primary key) | auto-generated |
| community_id | text (references communities.id) | which community |
| tag | text | e.g., 'Regulatory Site', 'BLM' |

### `sensors`
| Column | Type | Description |
|--------|------|-------------|
| id | text (primary key) | e.g., 'MOD-00442' |
| soa_tag_id | text | SOA Tag ID |
| type | text | 'Community Pod', 'Audit Pod', etc. |
| status | text[] (array) | e.g., ['Online', 'PM Sensor Issue'] |
| community_id | text (references communities.id) | where it's deployed |
| location | text | physical location description |
| date_purchased | date | when purchased |
| collocation_dates | text | date range string |
| created_at | timestamp | auto-set |
| updated_at | timestamp | auto-set |

### `contacts`
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (primary key) | auto-generated |
| name | text | full name |
| role | text | job title |
| community_id | text (references communities.id) | associated community |
| email | text | email address |
| phone | text | phone number |
| org | text | organization name |
| active | boolean (default true) | active or inactive |
| created_at | timestamp | auto-set |

### `notes`
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (primary key) | auto-generated |
| date | timestamp | when it happened |
| type | text | 'Audit', 'Movement', 'Status Change', etc. |
| text | text | main note content |
| additional_info | text | extra context |
| created_by | uuid (references profiles.id) | who wrote it |
| created_at | timestamp | auto-set |

### `note_tags` (cross-tagging — links notes to sensors/communities/contacts)
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (primary key) | auto-generated |
| note_id | uuid (references notes.id) | which note |
| tag_type | text | 'sensor', 'community', or 'contact' |
| tag_id | text | the sensor ID, community ID, or contact ID |

### `comms` (communications)
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (primary key) | auto-generated |
| date | timestamp | when it happened |
| comm_type | text | 'Email', 'Phone Call', 'Site Visit', etc. |
| text | text | summary |
| subject | text | email subject (if applicable) |
| full_body | text | full email body (if applicable) |
| created_by | uuid (references profiles.id) | who logged it |
| community_id | text (references communities.id) | primary community |
| created_at | timestamp | auto-set |

### `comm_tags` (links comms to contacts/communities)
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (primary key) | auto-generated |
| comm_id | uuid (references comms.id) | which communication |
| tag_type | text | 'contact' or 'community' |
| tag_id | text | the contact ID or community ID |

### `community_files`
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (primary key) | auto-generated |
| community_id | text (references communities.id) | which community |
| file_name | text | original filename |
| file_type | text | MIME type |
| storage_path | text | path in Supabase Storage bucket |
| uploaded_by | uuid (references profiles.id) | who uploaded |
| created_at | timestamp | auto-set |

### File Storage
Actual files (PDFs, images) go in a **Supabase Storage bucket** — the `community_files` table just stores a reference (path) to the file.

---

## Project Structure

```
sensor-network-tracker/
├── index.html              (existing — update login form)
├── styles.css              (existing — minor additions for loading states)
├── app.js                  (existing — swap localStorage for Supabase calls)
├── supabase-client.js      (NEW — Supabase JS client setup + helper functions)
├── supabase-schema.sql     (NEW — full SQL to create all tables, triggers, RLS)
├── seed-data.sql           (NEW — SQL to insert current sensors/communities/contacts)
├── CLAUDE.md               (existing)
└── FULLSTACK-PLAN.md       (NEW — this plan, committed to repo)
```

---

## Migration Steps (in order)

### Phase 1: Set Up Supabase (15 min)
1. **Create Supabase project** at supabase.com (free tier — just needs an email)
2. **Run `supabase-schema.sql`** in the Supabase SQL editor — creates all tables, triggers, and RLS policies in one shot
3. **Run `seed-data.sql`** — inserts all 51 communities, 69 sensors, 4 contacts, parent relationships, and tags
4. **Create Supabase Storage bucket** called `community-files`
5. **Add your 3 team emails** to the `allowed_emails` table

### Phase 2: Update Frontend Code
6. **Add Supabase JS library** (one `<script>` tag in index.html)
7. **Create `supabase-client.js`** — sets up the Supabase connection and provides helper functions like `getSensors()`, `saveSensor()`, etc.
8. **Update `app.js`** — replace `loadData()`/`saveData()`/`persist()` with Supabase calls
   - Functions become `async` (they wait for the server to respond)
   - `loadData('sensors')` → `await supabase.from('sensors').select('*')`
   - `persist()` → individual saves like `await supabase.from('sensors').upsert(data)`
9. **Update login screen** — email + password form instead of name picker
10. **Update file uploads** — send to Supabase Storage instead of base64

### Phase 3: Deploy to GitHub Pages (5 min)
11. **Go to repo Settings → Pages → Source: Deploy from main branch**
12. Site goes live at `aylacrosby531.github.io/sensor-network-tracker`
13. **Test with all 3 team accounts**

### Phase 4: Polish
14. Add loading spinners while data fetches
15. Add error messages for network issues
16. Remove localStorage code and seed data from app.js (no longer needed)

---

## What Changes vs What Stays the Same

**STAYS THE SAME:**
- All HTML structure
- All CSS styling
- All UI logic (rendering, modals, tabs, sub-communities, setup mode, etc.)
- The app looks and feels identical

**CHANGES:**
- Data reads/writes go to Supabase instead of localStorage
- File uploads go to Supabase Storage instead of base64
- Login uses email + password (must be in allowed_emails list)
- COMMUNITIES array becomes a database table
- App works from a URL instead of opening a local file
- Multiple people can use it simultaneously from different computers

---

## Cost

| Service | Tier | Monthly Cost |
|---------|------|-------------|
| Supabase | Free | $0 |
| GitHub | Free | $0 |
| GitHub Pages | Free | $0 |
| **Total** | | **$0** |

Supabase free tier limits: 500MB database, 1GB file storage, 50K auth users, 500K edge function calls. More than enough for this app.

---

## Verification / Testing
1. Try signing up with a non-listed email — should be rejected
2. Sign in with a listed @alaska.gov email — should work
3. All CRUD operations: create, read, update, delete sensors/contacts/communities
4. Notes and comms cross-tagging works across entities
5. File upload/download works
6. Multiple users see the same data
7. Setup mode still suppresses history notes
8. Sub-community relationships preserved
9. Site accessible via GitHub Pages URL
