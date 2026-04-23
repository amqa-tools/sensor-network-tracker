-- Fix the append_progress_note RPC to write the note's `at` timestamp in
-- Alaska time, matching the client-side nowDatetime() format. The
-- original version used now() AT TIME ZONE 'UTC', which produced a
-- YYYY-MM-DDTHH:MI string without a Z suffix — the client then treated
-- it as already-local and displayed it as Alaska time without
-- converting, so notes created via this RPC showed timestamps ~8 hours
-- in the future (whatever UTC offset Alaska happens to be running).
--
-- Using 'America/Anchorage' as the cast target makes the returned
-- string accurate Alaska time, matching how the rest of the app stores
-- progress-note timestamps.

CREATE OR REPLACE FUNCTION public.append_progress_note(
    record_kind text,
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
        'at',             to_char(now() AT TIME ZONE 'America/Anchorage', 'YYYY-MM-DD"T"HH24:MI'),
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
    ELSE
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
