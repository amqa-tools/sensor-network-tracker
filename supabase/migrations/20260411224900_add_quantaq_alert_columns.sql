-- Add severity and grace_expires_at columns to quantaq_alerts.
-- These were in the original quantaq-setup.sql but never actually applied
-- to the live database. Both the browser scan and the new edge-function
-- scan depend on them, so inserts were silently failing until now.
-- Idempotent — safe to re-run.

alter table quantaq_alerts
  add column if not exists severity text default 'warning',
  add column if not exists grace_expires_at timestamptz;
