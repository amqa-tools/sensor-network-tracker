-- =============================================
-- QuantAQ Alerts Integration — Supabase Schema
-- Run this in: Supabase Dashboard > SQL Editor
-- =============================================

-- ===== QUANTAQ ALERTS TABLE =====
CREATE TABLE IF NOT EXISTS quantaq_alerts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    sensor_sn TEXT NOT NULL,
    sensor_model TEXT,
    community_name TEXT,
    issue_type TEXT NOT NULL,  -- 'Offline', 'PM Sensor Issue', 'Gaseous Sensor Issue', 'SD Card Issue'
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'pending', 'resolved', 'acknowledged'
    severity TEXT DEFAULT 'warning',       -- 'critical', 'warning', 'info'
    grace_expires_at TIMESTAMPTZ,          -- when grace period ends (null for critical)
    is_new BOOLEAN DEFAULT true,
    detected_at TIMESTAMPTZ DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    last_checked TIMESTAMPTZ DEFAULT now(),
    acknowledged_by TEXT,
    notes JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quantaq_alerts_status ON quantaq_alerts(status);
CREATE INDEX IF NOT EXISTS idx_quantaq_alerts_sensor ON quantaq_alerts(sensor_sn);

-- ===== APP SETTINGS ENTRY =====
INSERT INTO app_settings (key, value)
VALUES ('quantaq_last_check', '')
ON CONFLICT (key) DO NOTHING;

-- ===== ROW LEVEL SECURITY =====
ALTER TABLE quantaq_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read quantaq_alerts"
    ON quantaq_alerts FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert quantaq_alerts"
    ON quantaq_alerts FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update quantaq_alerts"
    ON quantaq_alerts FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated users can delete quantaq_alerts"
    ON quantaq_alerts FOR DELETE TO authenticated USING (true);

-- ===== RPC: run_quantaq_check =====
-- Reads secrets from vault and triggers the Edge Function via pg_net
-- SECURITY DEFINER so it can access vault.decrypted_secrets
CREATE OR REPLACE FUNCTION public.run_quantaq_check()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    _project_url TEXT;
    _service_role_key TEXT;
BEGIN
    -- Read secrets from Supabase Vault
    SELECT decrypted_secret INTO _project_url
    FROM vault.decrypted_secrets
    WHERE name = 'project_url';

    SELECT decrypted_secret INTO _service_role_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key';

    IF _project_url IS NULL OR _service_role_key IS NULL THEN
        RAISE EXCEPTION 'Missing vault secrets: project_url or service_role_key';
    END IF;

    -- Call the Edge Function via pg_net
    PERFORM net.http_post(
        url := _project_url || '/functions/v1/quantaq-check',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || _service_role_key,
            'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.run_quantaq_check() TO authenticated;

-- ===== PG_CRON SCHEDULE =====
-- Runs every 2 hours, every day.
-- NOTE: pg_cron and pg_net extensions must be enabled in Supabase Dashboard first
-- Go to: Database > Extensions > enable pg_cron and pg_net

SELECT cron.schedule(
    'quantaq-every-2h',
    '0 */2 * * *',  -- every 2 hours, on the hour
    $$SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/quantaq-check',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
            'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
    )$$
);
