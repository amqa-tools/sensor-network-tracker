-- =============================================
-- ADEC Sensor Network Tracker — Supabase Schema
-- Run this in: Supabase Dashboard > SQL Editor
-- =============================================

-- ===== ACCESS CONTROL =====
CREATE TABLE allowed_emails (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text UNIQUE NOT NULL,
    role text DEFAULT 'user',
    status text DEFAULT 'active',
    added_at timestamptz DEFAULT now()
);

-- ===== APP SETTINGS =====
CREATE TABLE app_settings (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz DEFAULT now()
);

INSERT INTO app_settings (key, value) VALUES ('mfa_required', 'true');

-- Default admin user
INSERT INTO allowed_emails (email, role, status) VALUES ('ayla.crosby@alaska.gov', 'admin', 'active')
    ON CONFLICT (email) DO UPDATE SET role = 'admin';

-- ===== USER PROFILES =====
CREATE TABLE profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email text,
    name text,
    role text DEFAULT 'user',
    created_at timestamptz DEFAULT now()
);

-- Function to check if email is allowed (called from frontend before signup)
CREATE OR REPLACE FUNCTION public.is_email_allowed(check_email text)
RETURNS boolean AS $$
BEGIN
    RETURN EXISTS (SELECT 1 FROM public.allowed_emails WHERE lower(email) = lower(check_email));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant anon access so it can be called before login
GRANT EXECUTE ON FUNCTION public.is_email_allowed(text) TO anon;
GRANT SELECT ON public.allowed_emails TO postgres;

-- Function to create/update profile (called after signup from frontend)
CREATE OR REPLACE FUNCTION public.upsert_profile(user_id uuid, user_email text, user_name text)
RETURNS void AS $$
BEGIN
    INSERT INTO public.profiles (id, email, name)
    VALUES (user_id, user_email, user_name)
    ON CONFLICT (id) DO UPDATE SET name = user_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ===== COMMUNITIES =====
CREATE TABLE communities (
    id text PRIMARY KEY,
    name text NOT NULL,
    parent_id text REFERENCES communities(id),
    active boolean DEFAULT true,
    created_at timestamptz DEFAULT now()
);

-- Migration: If communities table already exists, add active column
-- ALTER TABLE communities ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;

-- ===== COMMUNITY TAGS =====
CREATE TABLE community_tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id text NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    tag text NOT NULL,
    UNIQUE(community_id, tag)
);

-- ===== SENSORS =====
CREATE TABLE sensors (
    id text PRIMARY KEY,
    soa_tag_id text DEFAULT '',
    type text DEFAULT 'Community Pod',
    status text[] DEFAULT '{}',
    community_id text REFERENCES communities(id),
    location text DEFAULT '',
    date_purchased text DEFAULT '',
    date_installed text DEFAULT '',
    collocation_dates text DEFAULT '',
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- ===== CONTACTS =====
CREATE TABLE contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    role text DEFAULT '',
    community_id text REFERENCES communities(id),
    email text DEFAULT '',
    phone text DEFAULT '',
    org text DEFAULT '',
    active boolean DEFAULT true,
    email_list boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
);

-- Migration: If contacts table already exists, add email_list column
-- ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_list boolean DEFAULT false;

-- ===== NOTES =====
CREATE TABLE notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    date timestamptz DEFAULT now(),
    type text DEFAULT 'General',
    text text DEFAULT '',
    additional_info text DEFAULT '',
    created_by uuid REFERENCES profiles(id),
    created_at timestamptz DEFAULT now()
);

-- ===== NOTE TAGS (cross-tagging) =====
CREATE TABLE note_tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_type text NOT NULL CHECK (tag_type IN ('sensor', 'community', 'contact')),
    tag_id text NOT NULL
);

CREATE INDEX idx_note_tags_note_id ON note_tags(note_id);
CREATE INDEX idx_note_tags_lookup ON note_tags(tag_type, tag_id);

-- ===== COMMUNICATIONS =====
CREATE TABLE comms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    date timestamptz DEFAULT now(),
    comm_type text DEFAULT 'Email',
    text text DEFAULT '',
    subject text DEFAULT '',
    full_body text DEFAULT '',
    created_by uuid REFERENCES profiles(id),
    community_id text REFERENCES communities(id),
    created_at timestamptz DEFAULT now()
);

-- ===== COMM TAGS =====
CREATE TABLE comm_tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    comm_id uuid NOT NULL REFERENCES comms(id) ON DELETE CASCADE,
    tag_type text NOT NULL CHECK (tag_type IN ('contact', 'community')),
    tag_id text NOT NULL
);

CREATE INDEX idx_comm_tags_comm_id ON comm_tags(comm_id);
CREATE INDEX idx_comm_tags_lookup ON comm_tags(tag_type, tag_id);

-- ===== COMMUNITY FILES =====
CREATE TABLE community_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    community_id text NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    file_name text NOT NULL,
    file_type text DEFAULT '',
    storage_path text NOT NULL,
    uploaded_by uuid REFERENCES profiles(id),
    created_at timestamptz DEFAULT now()
);

-- ===== ROW LEVEL SECURITY =====
-- Enable RLS on all tables
ALTER TABLE allowed_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE communities ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensors ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE comms ENABLE ROW LEVEL SECURITY;
ALTER TABLE comm_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_files ENABLE ROW LEVEL SECURITY;

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Policies
-- app_settings: all authenticated can read, only admins can update
CREATE POLICY "Authenticated users can read app_settings"
    ON app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can update app_settings"
    ON app_settings FOR UPDATE TO authenticated
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- allowed_emails: all authenticated can read, admins can insert/update
CREATE POLICY "Authenticated users can read allowed_emails"
    ON allowed_emails FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can insert allowed_emails"
    ON allowed_emails FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY "Admins can update allowed_emails"
    ON allowed_emails FOR UPDATE TO authenticated
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY "Admins can delete allowed_emails"
    ON allowed_emails FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- profiles
CREATE POLICY "Authenticated users can read profiles"
    ON profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can update own profile"
    ON profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "Admins can update any profile"
    ON profiles FOR UPDATE TO authenticated
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- communities
CREATE POLICY "Authenticated users can read communities"
    ON communities FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert communities"
    ON communities FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update communities"
    ON communities FOR UPDATE TO authenticated USING (true);

-- community_tags
CREATE POLICY "Authenticated users can read community_tags"
    ON community_tags FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert community_tags"
    ON community_tags FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can delete community_tags"
    ON community_tags FOR DELETE TO authenticated USING (true);

-- sensors
CREATE POLICY "Authenticated users can read sensors"
    ON sensors FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert sensors"
    ON sensors FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update sensors"
    ON sensors FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete sensors"
    ON sensors FOR DELETE TO authenticated USING (true);

-- contacts
CREATE POLICY "Authenticated users can read contacts"
    ON contacts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert contacts"
    ON contacts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update contacts"
    ON contacts FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete contacts"
    ON contacts FOR DELETE TO authenticated USING (true);

-- notes
CREATE POLICY "Authenticated users can read notes"
    ON notes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert notes"
    ON notes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update notes"
    ON notes FOR UPDATE TO authenticated USING (true);

-- note_tags
CREATE POLICY "Authenticated users can read note_tags"
    ON note_tags FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert note_tags"
    ON note_tags FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can delete note_tags"
    ON note_tags FOR DELETE TO authenticated USING (true);

-- comms
CREATE POLICY "Authenticated users can read comms"
    ON comms FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert comms"
    ON comms FOR INSERT TO authenticated WITH CHECK (true);

-- comm_tags
CREATE POLICY "Authenticated users can read comm_tags"
    ON comm_tags FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert comm_tags"
    ON comm_tags FOR INSERT TO authenticated WITH CHECK (true);

-- community_files
CREATE POLICY "Authenticated users can read community_files"
    ON community_files FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert community_files"
    ON community_files FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can delete community_files"
    ON community_files FOR DELETE TO authenticated USING (true);

-- ===== AUDITS =====
CREATE TABLE audits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_pod_id text NOT NULL,
    community_pod_id text NOT NULL,
    community_id text REFERENCES communities(id),
    status text DEFAULT 'Scheduled',
    scheduled_start text,
    scheduled_end text,
    actual_start text,
    actual_end text,
    conducted_by text DEFAULT '',
    notes text DEFAULT '',
    analysis_results jsonb DEFAULT '{}',
    analysis_name text DEFAULT '',
    analysis_upload_date timestamptz,
    analysis_uploaded_by text DEFAULT '',
    analysis_chart_data jsonb DEFAULT NULL,
    created_by uuid REFERENCES profiles(id),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_audits_community ON audits(community_id);
CREATE INDEX idx_audits_status ON audits(status);

ALTER TABLE audits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read audits"
    ON audits FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert audits"
    ON audits FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update audits"
    ON audits FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete audits"
    ON audits FOR DELETE TO authenticated USING (true);

-- ===== SERVICE TICKETS =====
CREATE TABLE service_tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sensor_id text REFERENCES sensors(id),
    ticket_type text NOT NULL,
    status text DEFAULT 'Ticket Opened',
    rma_number text DEFAULT '',
    fedex_tracking_to text DEFAULT '',
    fedex_tracking_from text DEFAULT '',
    issue_description text DEFAULT '',
    quant_notes text DEFAULT '',
    work_completed text DEFAULT '',
    created_by uuid REFERENCES profiles(id),
    created_at timestamptz DEFAULT now(),
    closed_at timestamptz,
    updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_service_tickets_sensor ON service_tickets(sensor_id);
CREATE INDEX idx_service_tickets_status ON service_tickets(status);

ALTER TABLE service_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read service_tickets"
    ON service_tickets FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert service_tickets"
    ON service_tickets FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update service_tickets"
    ON service_tickets FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete service_tickets"
    ON service_tickets FOR DELETE TO authenticated USING (true);

-- ===== STORAGE BUCKET =====
INSERT INTO storage.buckets (id, name, public) VALUES ('community-files', 'community-files', false);

CREATE POLICY "Authenticated users can upload files"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'community-files');

CREATE POLICY "Authenticated users can read files"
    ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'community-files');

CREATE POLICY "Authenticated users can delete files"
    ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'community-files');
