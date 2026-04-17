-- Per-user permission for editing the in-app User Guide.
-- Keeps the User Guide writable only by specific admins (not any admin), so
-- one person owns the guide's content while still letting multiple admins
-- manage sensors, users, etc. Off by default; seed Ayla so she can grant it
-- to anyone else via the UI.

ALTER TABLE allowed_emails
  ADD COLUMN IF NOT EXISTS can_edit_user_guide boolean NOT NULL DEFAULT false;

UPDATE allowed_emails
  SET can_edit_user_guide = true
  WHERE lower(email) = 'ayla.crosby@alaska.gov';
