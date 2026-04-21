-- Fix admin role not reaching profiles on first signup.
--
-- Bug: upsert_profile (called from the browser right after Supabase Auth
-- signs a new user up) only inserts id/email/name. profiles.role defaults
-- to 'user'. Even though allowed_emails.role had 'admin' for the new user,
-- their profile row was created with 'user' — and both the client
-- (currentUserRole = profile?.role || emailRow?.role) and the RLS policies
-- (EXISTS profiles WHERE role = 'admin') read profile.role first. Result:
-- a user invited as admin shows up in the UI as a regular user with no
-- Setup Mode / Sandbox Mode buttons and fails RLS admin checks.
--
-- Two fixes in one migration:
--   1. upsert_profile now reads role from allowed_emails and writes it
--      into the profile on INSERT (ON CONFLICT still only touches name,
--      so we don't clobber a role change an admin made via the UI).
--   2. One-shot backfill: any existing profile whose role differs from
--      the matching allowed_emails.role gets synced. Fixes any user
--      (like Lydia) who already signed up under the old behavior.

CREATE OR REPLACE FUNCTION public.upsert_profile(user_id uuid, user_email text, user_name text)
RETURNS void AS $$
DECLARE
    allowed_role text;
BEGIN
    IF auth.uid() IS NULL OR auth.uid() <> user_id THEN
        RAISE EXCEPTION 'Not authorized to modify another user''s profile';
    END IF;

    SELECT role INTO allowed_role
    FROM public.allowed_emails
    WHERE lower(email) = lower(user_email)
    LIMIT 1;

    INSERT INTO public.profiles (id, email, name, role)
    VALUES (user_id, user_email, user_name, COALESCE(allowed_role, 'user'))
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Backfill existing mismatches. allowed_emails is the source of truth for
-- role because that's the table admins actually edit through the UI.
UPDATE public.profiles AS p
SET role = ae.role
FROM public.allowed_emails AS ae
WHERE lower(ae.email) = lower(p.email)
  AND ae.role IS NOT NULL
  AND ae.role <> COALESCE(p.role, '');
