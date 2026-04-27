-- Auto-purge soft-deleted rows after 30 days.
--
-- The trash bin lets admins restore notes / comms / service tickets /
-- audits / collocations that were soft-deleted (deleted_at set). Without
-- automatic cleanup the trash grows forever, defeats the purpose of the
-- "purge" button, and bloats indexes on tables that are queried with a
-- "deleted_at IS NULL" filter on every read.
--
-- This migration:
--   1. Defines purge_old_trash() — a SECURITY DEFINER function that
--      hard-deletes rows where deleted_at is more than 30 days old. Runs
--      as the function owner (postgres) so RLS doesn't block it.
--   2. Schedules it to run daily at 09:00 UTC (~01:00 AK in summer,
--      00:00 in winter — quiet hours either way).
--
-- Archived sensors are intentionally NOT auto-purged. Sensor rows are
-- referenced by audits / tickets / notes via tag tables and a hard delete
-- has wider blast radius; admins keep that as a deliberate manual action.
--
-- note_tags / comm_tags have ON DELETE CASCADE on their parent FKs, so
-- they go away automatically when the parent row is hard-deleted.

CREATE OR REPLACE FUNCTION public.purge_old_trash()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    cutoff       timestamptz := now() - interval '30 days';
    n_notes      integer;
    n_comms      integer;
    n_tickets    integer;
    n_audits     integer;
    n_collocs    integer;
BEGIN
    DELETE FROM public.notes
        WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
    GET DIAGNOSTICS n_notes = ROW_COUNT;

    DELETE FROM public.comms
        WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
    GET DIAGNOSTICS n_comms = ROW_COUNT;

    DELETE FROM public.service_tickets
        WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
    GET DIAGNOSTICS n_tickets = ROW_COUNT;

    DELETE FROM public.audits
        WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
    GET DIAGNOSTICS n_audits = ROW_COUNT;

    DELETE FROM public.collocations
        WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
    GET DIAGNOSTICS n_collocs = ROW_COUNT;

    RETURN jsonb_build_object(
        'cutoff',        cutoff,
        'notes',         n_notes,
        'comms',         n_comms,
        'service_tickets', n_tickets,
        'audits',        n_audits,
        'collocations',  n_collocs,
        'total',         n_notes + n_comms + n_tickets + n_audits + n_collocs
    );
END;
$$;

-- Idempotent re-schedule so the migration can replay without a cron error.
DO $$
BEGIN
    PERFORM cron.unschedule('purge-old-trash');
EXCEPTION WHEN OTHERS THEN
    NULL;
END;
$$;

SELECT cron.schedule(
    'purge-old-trash',
    '0 9 * * *',  -- daily, 09:00 UTC (~01:00 AK)
    $$SELECT public.purge_old_trash()$$
);

-- We don't grant EXECUTE to authenticated. Cron runs as postgres anyway,
-- and admins shouldn't be triggering this from the browser — too easy to
-- run accidentally and there's no UI for it.
REVOKE ALL ON FUNCTION public.purge_old_trash() FROM PUBLIC, authenticated, anon;
