CREATE TABLE collocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id text REFERENCES communities(id),
    status text DEFAULT 'In Progress',
    start_date text,
    end_date text,
    sensor_ids text[] DEFAULT '{}',
    permanent_pod_id text,
    bam_source text,
    conducted_by text DEFAULT '',
    notes text DEFAULT '',
    analysis_results jsonb DEFAULT '{}',
    analysis_chart_data jsonb DEFAULT NULL,
    analysis_name text DEFAULT '',
    analysis_upload_date timestamptz,
    analysis_uploaded_by text DEFAULT '',
    created_by uuid REFERENCES profiles(id),
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

-- RLS policies
ALTER TABLE collocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read collocations" ON collocations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert collocations" ON collocations FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update collocations" ON collocations FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete collocations" ON collocations FOR DELETE TO authenticated USING (true);
