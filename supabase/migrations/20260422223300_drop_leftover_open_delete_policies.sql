-- Follow-up to 20260422221400: the live prod DB had leftover
-- permissive DELETE policies with short cryptic names
-- (p9/p13/p17/p30/st4/a4) that were created outside the migrations
-- system (likely via the Supabase dashboard early on). Those survived
-- yesterday's "Admins can delete ..." tightening because my DROP IF
-- EXISTS guards only knew the long descriptive names.
--
-- Postgres evaluates RLS policies with OR semantics per action, so
-- any one permissive "true" policy defeats the admin-only ones.
-- Drop the six leftover policies by name so only the admin-only
-- policy remains on each of these tables.
--
-- Verified via:
--   SELECT tablename, policyname, cmd, qual FROM pg_policies
--   WHERE schemaname = 'public' AND cmd = 'DELETE';
-- before writing this migration.

DROP POLICY IF EXISTS "p9"  ON public.community_tags;
DROP POLICY IF EXISTS "p13" ON public.sensors;
DROP POLICY IF EXISTS "p17" ON public.contacts;
DROP POLICY IF EXISTS "p30" ON public.community_files;
DROP POLICY IF EXISTS "a4"  ON public.audits;
DROP POLICY IF EXISTS "st4" ON public.service_tickets;
