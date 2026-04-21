-- Change the QuantAQ scan schedule from once-daily weekdays to every 2 hours
-- every day. The daily cadence missed real mid-day faults (e.g., a Seward PM
-- malfunction that started after the morning scan and sat unflagged until the
-- next morning), and the Mon-Fri restriction meant weekend outages weren't
-- caught until the following Monday — not useful for a monitoring tool.
--
-- Idempotent via cron.unschedule + re-schedule so this migration can be
-- replayed without erroring on an existing job.

DO $$
BEGIN
    PERFORM cron.unschedule('quantaq-weekday-check');
EXCEPTION WHEN OTHERS THEN
    -- Job didn't exist (fresh environment); nothing to undo.
    NULL;
END;
$$;

DO $$
BEGIN
    PERFORM cron.unschedule('quantaq-every-2h');
EXCEPTION WHEN OTHERS THEN
    NULL;
END;
$$;

SELECT cron.schedule(
    'quantaq-every-2h',
    '0 */2 * * *',  -- every 2 hours, on the hour, every day
    $$SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/quantaq-check',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
            'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
    )$$
);
