-- Closes four critical gaps surfaced by a security + RLS audit:
--
--   1) notes had no DELETE policy → "delete note" silently no-ops in prod.
--   2) comms had no UPDATE or DELETE policy → edit/delete a communication
--      silently fails the same way.
--   3) comm_tags had no DELETE policy → removing a tag from a communication
--      silently no-ops.
--   4) community_files had no UPDATE policy → renaming a file silently fails.
--
-- In every case the UI surfaces a green "saved" toast because Supabase's JS
-- client does NOT reject on RLS denial — it returns `{error: ...}` the app
-- was ignoring. Adding policies lets those writes land; a companion app-side
-- patch routes the same writes through the db.* helpers that now check
-- `{error}` and surface failures.
--
-- Also tightens two SECURITY DEFINER functions that were too permissive:
--
--   5) upsert_profile accepted any user_id, so any authenticated user could
--      overwrite another user's display name. Now requires auth.uid() match.
--   6) run_quantaq_check was executable by any authenticated user, letting a
--      signed-in user force unbounded QuantAQ API calls. Now requires admin.

-- -- 1. notes DELETE --------------------------------------------------------
CREATE POLICY "Authenticated users can delete notes"
    ON notes FOR DELETE TO authenticated USING (true);

-- -- 2. comms UPDATE + DELETE ----------------------------------------------
CREATE POLICY "Authenticated users can update comms"
    ON comms FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete comms"
    ON comms FOR DELETE TO authenticated USING (true);

-- -- 3. comm_tags DELETE ---------------------------------------------------
CREATE POLICY "Authenticated users can delete comm_tags"
    ON comm_tags FOR DELETE TO authenticated USING (true);

-- -- 4. community_files UPDATE ---------------------------------------------
CREATE POLICY "Authenticated users can update community_files"
    ON community_files FOR UPDATE TO authenticated USING (true);

-- -- 5. upsert_profile: require caller to be the profile being edited ------
-- SECURITY DEFINER, so without this guard any authenticated user could
-- clobber someone else's name (which surfaces via notes.created_by joins).
CREATE OR REPLACE FUNCTION public.upsert_profile(user_id uuid, user_email text, user_name text)
RETURNS void AS $$
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> user_id THEN
        RAISE EXCEPTION 'Not authorized to modify another user''s profile';
    END IF;
    INSERT INTO public.profiles (id, email, name)
    VALUES (user_id, user_email, user_name)
    ON CONFLICT (id) DO UPDATE SET name = user_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -- 6. run_quantaq_check: admin-only ---------------------------------------
-- Previously any authenticated user could force a scan. The edge function is
-- metered against QuantAQ's API and runs under the service role, so this is
-- restricted to admins. Cron still fires under postgres (bypassing RLS), so
-- scheduled scans are unaffected.
CREATE OR REPLACE FUNCTION public.run_quantaq_check()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    _project_url TEXT;
    _service_role_key TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin') THEN
        RAISE EXCEPTION 'Not authorized: admin role required';
    END IF;

    SELECT decrypted_secret INTO _project_url
    FROM vault.decrypted_secrets
    WHERE name = 'project_url';

    SELECT decrypted_secret INTO _service_role_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key';

    IF _project_url IS NULL OR _service_role_key IS NULL THEN
        RAISE EXCEPTION 'Missing vault secrets: project_url or service_role_key';
    END IF;

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
