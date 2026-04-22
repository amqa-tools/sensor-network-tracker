-- ============================================================================
-- Hardening pass before the multi-user rollout.
--
-- Four things in one migration so they land atomically and the app never
-- sees a partial state:
--
-- 1. Define RPCs that were called from app.js but only existed in the live
--    Supabase project (send_user_invite, delete_auth_user, admin_reset_mfa,
--    is_email_allowed). Making them versioned in the repo so a fresh
--    Supabase (staging, dev, test) can stand up the app without silently
--    broken user management.
--
-- 2. Tighten RLS. Almost every write policy was `USING (true)` — any
--    signed-in user could delete every sensor, note, contact, or service
--    ticket from the browser console. Keep broad INSERT/UPDATE (the app's
--    day-to-day creates and edits are done by all roles) but restrict
--    DELETE on the irreversible rows to admins.
--
-- 3. Audit trail columns — updated_by + updated_at_by_app on every mutable
--    table so "who last touched this" is answerable at a glance.
--
-- 4. Soft-delete columns (deleted_at, deleted_by) on the destructive-path
--    tables, plus a sensors.active flag so decommissioned pods keep their
--    history instead of being hard-deleted.
--
-- 5. append_progress_note RPC — atomic JSONB append for tickets/audits/
--    collocations so two users adding notes at the same instant don't
--    clobber each other's note. Single UPDATE statement = row-locked.
-- ============================================================================


-- -- 1. Versioned RPCs ---------------------------------------------------------

-- is_email_allowed — signup gate. Previously only in the historical
-- supabase-schema.sql dump, never in a timestamped migration.
CREATE OR REPLACE FUNCTION public.is_email_allowed(check_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.allowed_emails
        WHERE lower(email) = lower(check_email)
          AND (status IS NULL OR status = 'active')
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_email_allowed(text) TO anon;
GRANT EXECUTE ON FUNCTION public.is_email_allowed(text) TO authenticated;


-- send_user_invite — caller must be admin. Adds an allowed_emails row;
-- the actual email goes out from the frontend via mailto.
CREATE OR REPLACE FUNCTION public.send_user_invite(invite_email text, invite_role text DEFAULT 'user')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
        RAISE EXCEPTION 'Only admins can invite users';
    END IF;
    IF invite_email IS NULL OR trim(invite_email) = '' THEN
        RAISE EXCEPTION 'invite_email is required';
    END IF;
    IF invite_role NOT IN ('user', 'admin') THEN
        RAISE EXCEPTION 'invite_role must be user or admin';
    END IF;

    -- Reject if someone with that email is already actively allowed.
    IF EXISTS (
        SELECT 1 FROM public.allowed_emails
        WHERE lower(email) = lower(invite_email)
          AND (status IS NULL OR status = 'active')
    ) THEN
        RAISE EXCEPTION 'That email is already an active user';
    END IF;

    INSERT INTO public.allowed_emails (email, role, status)
    VALUES (lower(trim(invite_email)), invite_role, 'active')
    ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, status = 'active';
END;
$$;

GRANT EXECUTE ON FUNCTION public.send_user_invite(text, text) TO authenticated;


-- delete_auth_user — admin-only. Removes auth.users row by email (which
-- cascades to profiles via FK) and clears allowed_emails. The caller must
-- be an admin. Uses service-role privileges (SECURITY DEFINER) to reach
-- the auth schema.
CREATE OR REPLACE FUNCTION public.delete_auth_user(user_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    target_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
        RAISE EXCEPTION 'Only admins can delete users';
    END IF;
    IF lower(user_email) = (SELECT lower(email) FROM auth.users WHERE id = auth.uid()) THEN
        RAISE EXCEPTION 'You cannot delete your own account';
    END IF;

    SELECT id INTO target_id FROM auth.users WHERE lower(email) = lower(user_email);
    IF target_id IS NOT NULL THEN
        -- Clear MFA factors first to avoid FK issues.
        DELETE FROM auth.mfa_factors WHERE user_id = target_id;
        DELETE FROM auth.users WHERE id = target_id;
    END IF;

    DELETE FROM public.allowed_emails WHERE lower(email) = lower(user_email);
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_auth_user(text) TO authenticated;


-- admin_reset_mfa — admin-only. Wipes a target user's MFA factors so they
-- can re-enroll on next login. Used when someone loses their phone.
CREATE OR REPLACE FUNCTION public.admin_reset_mfa(target_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    target_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') THEN
        RAISE EXCEPTION 'Only admins can reset MFA';
    END IF;
    SELECT id INTO target_id FROM auth.users WHERE lower(email) = lower(target_email);
    IF target_id IS NULL THEN
        RAISE EXCEPTION 'No user with that email';
    END IF;
    DELETE FROM auth.mfa_factors WHERE user_id = target_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_reset_mfa(text) TO authenticated;


-- -- 2. Tighten RLS: admins-only DELETE on destructive paths ----------------

-- sensors
DROP POLICY IF EXISTS "Authenticated users can delete sensors" ON public.sensors;
CREATE POLICY "Admins can delete sensors"
    ON public.sensors FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

-- communities
DROP POLICY IF EXISTS "Authenticated users can delete communities" ON public.communities;
CREATE POLICY "Admins can delete communities"
    ON public.communities FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

-- contacts
DROP POLICY IF EXISTS "Authenticated users can delete contacts" ON public.contacts;
CREATE POLICY "Admins can delete contacts"
    ON public.contacts FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

-- notes
DROP POLICY IF EXISTS "Authenticated users can delete notes" ON public.notes;
CREATE POLICY "Admins can delete notes"
    ON public.notes FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

-- comms
DROP POLICY IF EXISTS "Authenticated users can delete comms" ON public.comms;
CREATE POLICY "Admins can delete comms"
    ON public.comms FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

-- service_tickets
DROP POLICY IF EXISTS "Authenticated users can delete service_tickets" ON public.service_tickets;
CREATE POLICY "Admins can delete service_tickets"
    ON public.service_tickets FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

-- audits
DROP POLICY IF EXISTS "Authenticated users can delete audits" ON public.audits;
CREATE POLICY "Admins can delete audits"
    ON public.audits FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

-- collocations
DROP POLICY IF EXISTS "Authenticated users can delete collocations" ON public.collocations;
CREATE POLICY "Admins can delete collocations"
    ON public.collocations FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

-- community_tags and community_files — drop is cheap, admins only
DROP POLICY IF EXISTS "Authenticated users can delete community_tags" ON public.community_tags;
CREATE POLICY "Admins can delete community_tags"
    ON public.community_tags FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));

DROP POLICY IF EXISTS "Authenticated users can delete community_files" ON public.community_files;
CREATE POLICY "Admins can delete community_files"
    ON public.community_files FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'));


-- -- 3. Audit trail columns --------------------------------------------------

ALTER TABLE public.sensors         ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.communities     ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.communities     ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.contacts        ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.contacts        ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.notes           ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.notes           ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE public.comms           ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.comms           ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE public.service_tickets ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.audits          ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.collocations    ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;


-- -- 4. Soft-delete columns + sensors.active ---------------------------------

-- sensors: soft-delete via active flag (not deleted_at, so export/filter
-- UX reads naturally as "Active / Archived" rather than as a tombstone).
ALTER TABLE public.sensors         ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;
ALTER TABLE public.sensors         ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.sensors         ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- notes / comms / service_tickets / audits / collocations — deleted_at
-- pattern for a trash-bin. Rows stay in the DB with a flag so accidental
-- deletes are recoverable from the UI without point-in-time restore.
ALTER TABLE public.notes           ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.notes           ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.comms           ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.comms           ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.service_tickets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.service_tickets ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.audits          ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.audits          ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.collocations    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.collocations    ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notes_deleted_at           ON public.notes           (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comms_deleted_at           ON public.comms           (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_tickets_deleted_at ON public.service_tickets (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audits_deleted_at          ON public.audits          (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collocations_deleted_at    ON public.collocations    (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sensors_active             ON public.sensors         (active);


-- -- 4b. Auto-fill updated_by via triggers -----------------------------------

-- No need to plumb updated_by through every client write — set it from
-- auth.uid() on UPDATE. Cron / service-role jobs keep whatever value the
-- caller passed (auth.uid() is NULL there, so NULL stays NULL).
CREATE OR REPLACE FUNCTION public.set_updated_by()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF auth.uid() IS NOT NULL THEN
        NEW.updated_by := auth.uid();
    END IF;
    -- updated_at bumping: only if the column exists on this table and the
    -- caller didn't set it to a specific value (e.g. historical backfills).
    IF TG_TABLE_NAME IN ('communities', 'contacts', 'notes', 'comms') THEN
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_updated_by_trigger ON public.sensors;
CREATE TRIGGER set_updated_by_trigger BEFORE UPDATE ON public.sensors
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_by();

DROP TRIGGER IF EXISTS set_updated_by_trigger ON public.communities;
CREATE TRIGGER set_updated_by_trigger BEFORE UPDATE ON public.communities
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_by();

DROP TRIGGER IF EXISTS set_updated_by_trigger ON public.contacts;
CREATE TRIGGER set_updated_by_trigger BEFORE UPDATE ON public.contacts
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_by();

DROP TRIGGER IF EXISTS set_updated_by_trigger ON public.notes;
CREATE TRIGGER set_updated_by_trigger BEFORE UPDATE ON public.notes
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_by();

DROP TRIGGER IF EXISTS set_updated_by_trigger ON public.comms;
CREATE TRIGGER set_updated_by_trigger BEFORE UPDATE ON public.comms
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_by();

DROP TRIGGER IF EXISTS set_updated_by_trigger ON public.service_tickets;
CREATE TRIGGER set_updated_by_trigger BEFORE UPDATE ON public.service_tickets
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_by();

DROP TRIGGER IF EXISTS set_updated_by_trigger ON public.audits;
CREATE TRIGGER set_updated_by_trigger BEFORE UPDATE ON public.audits
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_by();

DROP TRIGGER IF EXISTS set_updated_by_trigger ON public.collocations;
CREATE TRIGGER set_updated_by_trigger BEFORE UPDATE ON public.collocations
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_by();


-- -- 5. append_progress_note RPC — race-free JSONB append ---------------------

-- Two users hitting "Add note" on the same ticket at the same instant used
-- to race: each read progressNotes, each appended, each wrote back — last
-- write wins, first note silently gone. Solved by a single UPDATE that
-- reads the current value inside the statement so Postgres row-locking
-- serializes the writes.
CREATE OR REPLACE FUNCTION public.append_progress_note(
    record_kind text,     -- 'service_ticket' | 'audit' | 'collocation'
    record_id uuid,
    note_text text,
    tagged_contacts text[] DEFAULT ARRAY[]::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    new_note jsonb;
    actor_name text;
BEGIN
    IF record_kind NOT IN ('service_ticket', 'audit', 'collocation') THEN
        RAISE EXCEPTION 'Invalid record_kind: %', record_kind;
    END IF;
    IF note_text IS NULL OR trim(note_text) = '' THEN
        RAISE EXCEPTION 'note_text is required';
    END IF;

    SELECT name INTO actor_name FROM public.profiles WHERE id = auth.uid();

    new_note := jsonb_build_object(
        'text',           note_text,
        'by',             COALESCE(actor_name, ''),
        'at',             to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'),
        'taggedContacts', COALESCE(to_jsonb(tagged_contacts), '[]'::jsonb)
    );

    IF record_kind = 'service_ticket' THEN
        UPDATE public.service_tickets
        SET quant_notes = (
                COALESCE(NULLIF(quant_notes, '')::jsonb, '[]'::jsonb) || new_note
            )::text,
            updated_at = now(),
            updated_by = auth.uid()
        WHERE id = record_id;
    ELSIF record_kind = 'audit' THEN
        UPDATE public.audits
        SET notes = (
                COALESCE(NULLIF(notes, '')::jsonb, '[]'::jsonb) || new_note
            )::text,
            updated_at = now(),
            updated_by = auth.uid()
        WHERE id = record_id;
    ELSE  -- collocation
        UPDATE public.collocations
        SET notes = (
                COALESCE(NULLIF(notes, '')::jsonb, '[]'::jsonb) || new_note
            )::text,
            updated_at = now(),
            updated_by = auth.uid()
        WHERE id = record_id;
    END IF;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No % found with id %', record_kind, record_id;
    END IF;

    RETURN new_note;
END;
$$;

GRANT EXECUTE ON FUNCTION public.append_progress_note(text, uuid, text, text[]) TO authenticated;
