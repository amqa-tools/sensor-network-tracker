-- Fixes two RLS gaps on app_settings that surfaced after the guide editor landed:
--   1) There was no INSERT policy, only UPDATE. The first-ever save of
--      user_guide_body (upsert into a non-existent row) was silently rejected.
--   2) The UPDATE policy required role='admin', so a user with
--      can_edit_user_guide=true but role='user' couldn't actually save edits.
--
-- Both policies now allow admins (any key) OR guide editors (user_guide_body
-- key only — they can't modify arbitrary settings like mfa_required).

DROP POLICY IF EXISTS "Admins can update app_settings" ON app_settings;

CREATE POLICY "Admins or guide editors can update app_settings"
    ON app_settings FOR UPDATE TO authenticated
    USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
        OR (
            key = 'user_guide_body'
            AND EXISTS (
                SELECT 1 FROM allowed_emails
                WHERE lower(email) = lower(auth.jwt() ->> 'email')
                  AND can_edit_user_guide = true
            )
        )
    );

CREATE POLICY "Admins or guide editors can insert app_settings"
    ON app_settings FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
        OR (
            key = 'user_guide_body'
            AND EXISTS (
                SELECT 1 FROM allowed_emails
                WHERE lower(email) = lower(auth.jwt() ->> 'email')
                  AND can_edit_user_guide = true
            )
        )
    );
