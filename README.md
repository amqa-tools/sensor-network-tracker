# ADEC Sensor Network Tracker

Internal tool for the Alaska Department of Environmental Conservation (ADEC) to track air quality sensors (QuantAQ Modulairs), the Alaska communities they're deployed in, and the contacts at each site.

**Live app:** https://amqa-tools.github.io/sensor-network-tracker/

## What's in this repo

- A vanilla HTML/CSS/JS frontend (`index.html`, `styles.css`, `app.js`, `quantaq.js`) — no build step.
- A Supabase project under `supabase/` with migrations and an edge function that runs QuantAQ sensor health scans on a cron.
- A handful of one-off HTML importer tools used to bring data in from Salesforce and spreadsheets.
- An end-user guide (`user-guide.html`).

## Running it

**Locally:**
```
open index.html
```
That's it. The page loads the Supabase JS library from a CDN and talks to the hosted Supabase project directly. You'll be prompted to sign in with an allowed `@alaska.gov` email.

**⚠️ Local mode reads and writes production data.** There is no separate dev database. Be deliberate about what you click.

**Deployed:** GitHub Pages serves `main` automatically. Push to `main` to ship.

## Docs

| Doc | For |
|---|---|
| [`AGENTS.md`](AGENTS.md) | AI agents (Claude Code, Codex, etc.) and new developers — project overview, file map, conventions. `CLAUDE.md` is a thin pointer to this file. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the three pieces (browser, Supabase, QuantAQ) fit together |
| [`docs/data-model.md`](docs/data-model.md) | Database tables, cross-tagging, sensor status model |
| [`docs/quantaq-integration.md`](docs/quantaq-integration.md) | How the QuantAQ edge function, cron, and alerts work |
| [`docs/importers.md`](docs/importers.md) | The standalone importer HTML pages and when to use each |
| [`user-guide.html`](user-guide.html) | End-user guide shipped to ADEC staff |
| [`docs/history/FULLSTACK-PLAN.md`](docs/history/FULLSTACK-PLAN.md) | Historical: the localStorage → Supabase migration plan |

## Stack

- **Frontend:** plain HTML/CSS/JS, loaded from GitHub Pages
- **Backend:** Supabase (Postgres, Auth, Storage, Edge Functions, Cron)
- **Sensor data source:** QuantAQ REST API, proxied through a Supabase edge function

## Access

Sign-ups are gated by an `allowed_emails` table in the database. To add a user, insert their email there; they can then create an account through the normal sign-up flow.
