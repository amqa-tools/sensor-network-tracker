-- Fix the dashboard's "Next scheduled check" line still showing the old
-- weekday-6am schedule even after the cron was switched to every-2h.
--
-- Two probable causes, both addressed here:
--   1. The earlier migration's `cron.unschedule('quantaq-weekday-check')`
--      sat inside an EXCEPTION WHEN OTHERS block, so if it errored once
--      (different schema search path, transient lock, etc) it was silently
--      swallowed and the old job stayed registered alongside the new one.
--   2. get_quantaq_cron_info() filtered `jobname like 'quantaq%'` and
--      ORDER BY jobid → that returns the OLDEST job, which is the stale
--      weekday-6am one if it's still around.
--
-- Step 1: drop the stale job using a safer guarded path that only calls
--         unschedule when the job actually exists.
DO $$
DECLARE
    stale_id bigint;
BEGIN
    SELECT jobid INTO stale_id FROM cron.job WHERE jobname = 'quantaq-weekday-check';
    IF stale_id IS NOT NULL THEN
        PERFORM cron.unschedule(stale_id);
    END IF;
END;
$$;

-- Step 2: prefer the *active* QuantAQ scan job. Match the exact name we
-- schedule today; fall back to the most recent quantaq-* job if someone
-- renames it later. ORDER BY jobid DESC + LIMIT 1 means the newest wins,
-- which is the right tie-breaker for "currently in use."
CREATE OR REPLACE FUNCTION public.get_quantaq_cron_info()
RETURNS TABLE (
    jobname text,
    schedule text,
    last_run_at timestamptz,
    last_run_status text,
    last_run_message text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, cron
AS $$
    SELECT
        j.jobname::text,
        j.schedule::text,
        d.start_time,
        d.status::text,
        d.return_message::text
    FROM cron.job j
    LEFT JOIN LATERAL (
        SELECT start_time, status, return_message
        FROM cron.job_run_details
        WHERE jobid = j.jobid
        ORDER BY start_time DESC
        LIMIT 1
    ) d ON TRUE
    WHERE j.jobname = 'quantaq-every-2h'
       OR j.jobname LIKE 'quantaq%'
    ORDER BY (j.jobname = 'quantaq-every-2h') DESC, j.jobid DESC
    LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_quantaq_cron_info() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_quantaq_cron_info() TO anon;
