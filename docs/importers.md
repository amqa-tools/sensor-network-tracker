# Importer tools

This repo contains several standalone HTML pages used to load data into Supabase during initial setup and one-off data cleanups. They are **not linked from the main app** — open them directly in a browser when you need them.

Each importer is a self-contained page that loads the Supabase JS library from a CDN, authenticates against the same project as the main app, and writes to one or more tables. They're deliberately kept as plain HTML so they survive framework changes and can be used even after the main app evolves.

**⚠️ All importers write to production Supabase.** There is no dev database. Open them only when you intend to run them.

## Available importers

### `sf-contact-migrator.html`
Migrates contacts out of the legacy Salesforce system into the `contacts` table. Handles the column-name mapping, de-dupes by email, and assigns contacts to communities.

**Use when:** bootstrapping contacts from a fresh Salesforce export.

### `sensor-data-importer.html`
Loads SOA tag IDs and purchase dates onto existing `sensors` rows. Expects a CSV paste or upload with sensor ID, SOA tag, and purchase date columns.

**Use when:** you have a new batch of sensors from procurement and need to fill in their asset-tracking fields.

### `sensor-location-importer.html`
Imports sensor location strings and collocation history. Touches `sensors.location`, `sensors.collocation_dates`, and (if present) any related collocation tables. Useful for backfilling physical location details after initial deployment.

**Use when:** sensor locations were tracked in a spreadsheet separately and need to be reconciled into the database.

### `install-date-importer.html`
Imports sensor install dates. Writes install-date fields onto `sensors` rows matched by ID.

**Use when:** backfilling install dates from a spreadsheet or paper records.

## When to add a new importer

If you're about to do a one-off data migration, consider whether it's a one-time paste into the Supabase SQL editor (simpler) or a reusable importer (appropriate when non-developers will run it, or when the migration needs client-side parsing).

When adding a new importer:
- Copy the scaffold from an existing one — they share the same Supabase bootstrap and design.
- Require sign-in. RLS will block writes anyway, but an early auth check gives a better error.
- Dry-run mode first: show what *would* be changed before committing the transaction.
- Log to a visible status area on the page, not just `console.log`.
- Add a short entry to this file.

## Retiring importers

Importers from completed migrations (e.g., Salesforce → Supabase) can stay in the repo indefinitely — they're small, self-contained, and serve as documentation of the original data shape. Only remove one if it's actively broken or references a table that no longer exists.
