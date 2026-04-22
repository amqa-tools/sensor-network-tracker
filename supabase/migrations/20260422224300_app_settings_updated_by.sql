-- Add updated_by to app_settings so the User Guide view can show
-- "Last edited by X on Apr 22". Trigger auto-fills from auth.uid()
-- so the client doesn't need to plumb it through setAppSetting.

ALTER TABLE public.app_settings
    ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Replace the trigger function to also bump updated_at on app_settings
-- (its column exists but DEFAULT now() only fires on INSERT, not UPDATE).
CREATE OR REPLACE FUNCTION public.set_updated_by()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF auth.uid() IS NOT NULL THEN
        NEW.updated_by := auth.uid();
    END IF;
    IF TG_TABLE_NAME IN ('communities', 'contacts', 'notes', 'comms', 'app_settings') THEN
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_updated_by_trigger ON public.app_settings;
CREATE TRIGGER set_updated_by_trigger
    BEFORE UPDATE ON public.app_settings
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_by();
