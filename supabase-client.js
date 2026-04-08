// ===== SUPABASE CLIENT =====
const SUPABASE_URL = 'https://uejryzioxogquflijgyf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVlanJ5emlveG9ncXVmbGlqZ3lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2OTkyODMsImV4cCI6MjA4OTI3NTI4M30.YD349-X2PeoeCTVp34FbzdGwachr9YCpzIPSXuSURfM';

const supa = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function nowDatetime() {
    const now = new Date();
    return now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + 'T' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0');
}

// Migrate old quant_notes string to progress notes array
function parseProgressNotes(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
    // Old format: plain string — migrate to a single note entry
    if (raw.trim()) return [{ text: raw.trim(), by: '', at: '' }];
    return [];
}

// ===== AUTH =====
const db = {
    // --- Auth ---
    async signUp(email, password, name) {
        // Check allowed list first
        const { data: allowed, error: checkErr } = await supa.rpc('is_email_allowed', { check_email: email });
        if (checkErr) throw checkErr;
        if (!allowed) throw new Error('Access denied. Please contact the site admin to request access.');

        const { data, error } = await supa.auth.signUp({
            email,
            password,
            options: {
                data: { name },
                emailRedirectTo: window.location.origin + window.location.pathname,
            }
        });
        if (error) throw error;

        // Create profile
        if (data.user) {
            await supa.rpc('upsert_profile', {
                user_id: data.user.id,
                user_email: email,
                user_name: name,
            });
        }

        return data;
    },

    async signIn(email, password) {
        const result = await supa.auth.signInWithPassword({ email, password });
        if (result.error) throw result.error;
        return result;
    },

    async signOut() {
        const { error } = await supa.auth.signOut();
        if (error) throw error;
    },

    async getSession() {
        const { data: { session } } = await supa.auth.getSession();
        return session;
    },

    async getProfile() {
        const session = await this.getSession();
        if (!session) return null;
        const { data, error } = await supa.from('profiles').select('*').eq('id', session.user.id).single();
        if (error) throw error;
        return data;
    },

    async getAppSetting(key) {
        const { data, error } = await supa.from('app_settings').select('value').eq('key', key).single();
        if (error && error.code !== 'PGRST116') throw error;
        return data?.value || null;
    },

    async setAppSetting(key, value) {
        const { error } = await supa.from('app_settings').upsert({ key, value, updated_at: nowDatetime() });
        if (error) throw error;
    },

    // --- Communities ---
    async getCommunities() {
        const { data, error } = await supa.from('communities').select('*').order('name');
        if (error) throw error;
        return data || [];
    },

    async insertCommunity(community) {
        const { error } = await supa.from('communities').insert(community);
        if (error) throw error;
    },

    async updateCommunity(id, updates) {
        const { error } = await supa.from('communities').update(updates).eq('id', id);
        if (error) throw error;
    },

    async deleteCommunity(id) {
        // Unassign sensors and contacts
        await supa.from('sensors').update({ community_id: null }).eq('community_id', id);
        await supa.from('contacts').update({ community_id: null }).eq('community_id', id);
        // Nullify comms and audits references
        await supa.from('comms').update({ community_id: null }).eq('community_id', id);
        await supa.from('audits').update({ community_id: null }).eq('community_id', id);
        // Detach any child communities
        await supa.from('communities').update({ parent_id: null }).eq('parent_id', id);
        // Clean up note tags and comm tags referencing this community
        await supa.from('note_tags').delete().eq('tag_type', 'community').eq('tag_id', id);
        await supa.from('comm_tags').delete().eq('tag_type', 'community').eq('tag_id', id);
        // Remove community tags and files (CASCADE handles these, but be explicit)
        await supa.from('community_tags').delete().eq('community_id', id);
        await supa.from('community_files').delete().eq('community_id', id);
        // Delete the community
        const { error } = await supa.from('communities').delete().eq('id', id);
        if (error) throw error;
    },

    // --- Community Tags ---
    async getCommunityTags() {
        const { data, error } = await supa.from('community_tags').select('*');
        if (error) throw error;
        return data || [];
    },

    async setCommunityTags(communityId, tags) {
        // Delete existing then insert new
        const { error: deleteError } = await supa.from('community_tags').delete().eq('community_id', communityId);
        if (deleteError) throw deleteError;
        if (tags.length > 0) {
            const rows = tags.map(tag => ({ community_id: communityId, tag }));
            const { error } = await supa.from('community_tags').insert(rows);
            if (error) throw error;
        }
    },

    // --- Sensors ---
    async getSensors() {
        const { data, error } = await supa.from('sensors').select('*').order('id');
        if (error) throw error;
        return data || [];
    },

    async upsertSensor(sensor) {
        const { error } = await supa.from('sensors').upsert({
            id: sensor.id,
            soa_tag_id: sensor.soaTagId || '',
            type: sensor.type,
            status: sensor.status || [],
            community_id: sensor.community || null,
            location: sensor.location || '',
            date_purchased: sensor.datePurchased || '',
            collocation_dates: sensor.collocationDates || '',
            date_installed: sensor.dateInstalled || '',
            updated_at: nowDatetime(),
        });
        if (error) throw error;
    },

    async deleteSensor(id) {
        const { error } = await supa.from('sensors').delete().eq('id', id);
        if (error) throw error;
    },

    // --- Contacts ---
    async getContacts() {
        const { data, error } = await supa.from('contacts').select('*').order('name');
        if (error) throw error;
        return data || [];
    },

    async upsertContact(contact) {
        const row = {
            name: contact.name,
            role: contact.role || '',
            community_id: contact.community || null,
            email: contact.email || '',
            phone: contact.phone || '',
            org: contact.org || '',
            active: contact.active !== false,
            email_list: contact.emailList === true,
            primary_contact: contact.primaryContact === true,
        };
        // Only include id if it's a valid UUID (existing record)
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (contact.id && uuidPattern.test(contact.id)) {
            row.id = contact.id;
        }
        let { data, error } = await supa.from('contacts').upsert(row).select();
        // If email_list or primary_contact columns don't exist yet, retry without them
        if (error && error.message && (error.message.includes('email_list') || error.message.includes('primary_contact'))) {
            const { email_list, primary_contact, ...rowWithout } = row;
            ({ data, error } = await supa.from('contacts').upsert(rowWithout).select());
        }
        if (error) throw error;
        return data?.[0];
    },

    async deleteContact(id) {
        const { error } = await supa.from('contacts').delete().eq('id', id);
        if (error) throw error;
    },

    // --- Notes ---
    async getNotes() {
        const { data, error } = await supa
            .from('notes')
            .select('*, note_tags(*), profiles(name)')
            .order('date', { ascending: false });
        if (error) throw error;

        return (data || []).map(note => {
            const tags = note.note_tags || [];
            return {
                id: note.id,
                date: note.date,
                type: note.type,
                text: note.text,
                additionalInfo: note.additional_info || '',
                createdBy: note.profiles?.name || (note.created_by ? '[Deleted User]' : ''),
                createdById: note.created_by,
                createdAt: note.created_at,
                taggedSensors: tags.filter(t => t.tag_type === 'sensor').map(t => t.tag_id),
                taggedCommunities: tags.filter(t => t.tag_type === 'community').map(t => t.tag_id),
                taggedContacts: tags.filter(t => t.tag_type === 'contact').map(t => t.tag_id),
            };
        });
    },

    async insertNote(note) {
        const { data, error } = await supa.from('notes').insert({
            date: note.date,
            type: note.type,
            text: note.text,
            additional_info: note.additionalInfo || '',
            created_by: note.createdById || null,
        }).select();
        if (error) throw error;

        const noteId = data[0].id;

        // Insert tags — filter out any non-string or empty IDs
        const tagRows = [];
        (note.taggedSensors || []).forEach(id => { if (id) tagRows.push({ note_id: noteId, tag_type: 'sensor', tag_id: String(id) }); });
        (note.taggedCommunities || []).forEach(id => { if (id) tagRows.push({ note_id: noteId, tag_type: 'community', tag_id: String(id) }); });
        (note.taggedContacts || []).forEach(id => { if (id) tagRows.push({ note_id: noteId, tag_type: 'contact', tag_id: String(id) }); });

        if (tagRows.length > 0) {
            const { error: tagError } = await supa.from('note_tags').insert(tagRows);
            if (tagError) throw tagError;
        }

        return { ...note, id: noteId };
    },

    async updateNote(id, updates) {
        const { error } = await supa.from('notes').update(updates).eq('id', id);
        if (error) throw error;
    },

    // --- Communications ---
    async getComms() {
        const { data, error } = await supa
            .from('comms')
            .select('*, comm_tags(*), profiles(name)')
            .order('date', { ascending: false });
        if (error) throw error;

        return (data || []).map(comm => {
            const tags = comm.comm_tags || [];
            return {
                id: comm.id,
                date: comm.date,
                type: 'Communication',
                commType: comm.comm_type,
                text: comm.text,
                subject: comm.subject || '',
                fullBody: comm.full_body || '',
                createdBy: comm.profiles?.name || (comm.created_by ? '[Deleted User]' : ''),
                createdById: comm.created_by,
                createdAt: comm.created_at,
                community: comm.community_id || '',
                taggedContacts: tags.filter(t => t.tag_type === 'contact').map(t => t.tag_id),
                taggedCommunities: tags.filter(t => t.tag_type === 'community').map(t => t.tag_id),
            };
        });
    },

    async insertComm(comm) {
        const { data, error } = await supa.from('comms').insert({
            date: comm.date,
            comm_type: comm.commType,
            text: comm.text,
            subject: comm.subject || '',
            full_body: comm.fullBody || '',
            created_by: comm.createdById || null,
            community_id: comm.community || null,
        }).select();
        if (error) throw error;

        const commId = data[0].id;

        const tagRows = [];
        (comm.taggedContacts || []).forEach(id => tagRows.push({ comm_id: commId, tag_type: 'contact', tag_id: id }));
        (comm.taggedCommunities || []).forEach(id => tagRows.push({ comm_id: commId, tag_type: 'community', tag_id: id }));

        if (tagRows.length > 0) {
            const { error: tagError } = await supa.from('comm_tags').insert(tagRows);
            if (tagError) throw tagError;
        }

        return { ...comm, id: commId };
    },

    // --- Community Files ---
    async getCommunityFiles() {
        const { data, error } = await supa.from('community_files').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        return data || [];
    },

    async uploadFile(communityId, file, uploadedBy) {
        const path = `${communityId}/${Date.now()}_${file.name}`;
        const { error: uploadError } = await supa.storage.from('community-files').upload(path, file);
        if (uploadError) throw uploadError;

        const { data, error } = await supa.from('community_files').insert({
            community_id: communityId,
            file_name: file.name,
            file_type: file.type,
            storage_path: path,
            uploaded_by: uploadedBy || null,
        }).select();
        if (error) throw error;

        return data[0];
    },

    async deleteFile(fileId, storagePath) {
        await supa.storage.from('community-files').remove([storagePath]);
        const { error } = await supa.from('community_files').delete().eq('id', fileId);
        if (error) throw error;
    },

    async getSignedUrl(storagePath) {
        const { data, error } = await supa.storage.from('community-files').createSignedUrl(storagePath, 3600);
        if (error) throw error;
        return data?.signedUrl || '';
    },

    // --- Audits ---
    async getAudits() {
        const { data, error } = await supa.from('audits').select('*, profiles(name)').order('scheduled_start', { ascending: false });
        if (error) throw error;
        return (data || []).map(a => ({
            id: a.id, auditPodId: a.audit_pod_id, communityPodId: a.community_pod_id,
            communityId: a.community_id, status: a.status,
            scheduledStart: a.scheduled_start, scheduledEnd: a.scheduled_end,
            actualStart: a.actual_start, actualEnd: a.actual_end,
            conductedBy: a.conducted_by || '', notes: a.notes || '',
            analysisResults: a.analysis_results || {},
            analysisName: a.analysis_name || '',
            analysisUploadDate: a.analysis_upload_date || null,
            analysisUploadedBy: a.analysis_uploaded_by || '',
            analysisChartData: a.analysis_chart_data || null,
            createdBy: a.profiles?.name || (a.created_by ? '[Deleted User]' : ''), createdById: a.created_by,
            createdAt: a.created_at, updatedAt: a.updated_at,
        }));
    },

    async insertAudit(audit) {
        const { data, error } = await supa.from('audits').insert({
            audit_pod_id: audit.auditPodId, community_pod_id: audit.communityPodId,
            community_id: audit.communityId, status: audit.status || 'Scheduled',
            scheduled_start: audit.scheduledStart || null, scheduled_end: audit.scheduledEnd || null,
            actual_start: audit.actualStart || null, actual_end: audit.actualEnd || null,
            conducted_by: audit.conductedBy || '', notes: audit.notes || '',
            analysis_results: audit.analysisResults || {},
            analysis_name: audit.analysisName || '', analysis_upload_date: audit.analysisUploadDate || null,
            analysis_uploaded_by: audit.analysisUploadedBy || '',
            analysis_chart_data: audit.analysisChartData || null, created_by: audit.createdById || null,
        }).select('*, profiles(name)');
        if (error) throw error;
        const a = data[0];
        return {
            id: a.id, auditPodId: a.audit_pod_id, communityPodId: a.community_pod_id,
            communityId: a.community_id, status: a.status,
            scheduledStart: a.scheduled_start, scheduledEnd: a.scheduled_end,
            actualStart: a.actual_start, actualEnd: a.actual_end,
            conductedBy: a.conducted_by || '', notes: a.notes || '',
            analysisResults: a.analysis_results || {},
            analysisName: a.analysis_name || '',
            analysisUploadDate: a.analysis_upload_date || null,
            analysisUploadedBy: a.analysis_uploaded_by || '',
            analysisChartData: a.analysis_chart_data || null,
            createdBy: a.profiles?.name || '', createdById: a.created_by,
            createdAt: a.created_at, updatedAt: a.updated_at,
        };
    },

    async updateAudit(id, updates) {
        const row = { updated_at: nowDatetime() };
        const map = { status: 'status', scheduledStart: 'scheduled_start', scheduledEnd: 'scheduled_end',
            actualStart: 'actual_start', actualEnd: 'actual_end', conductedBy: 'conducted_by',
            notes: 'notes', analysisResults: 'analysis_results',
            analysisName: 'analysis_name', analysisUploadDate: 'analysis_upload_date',
            analysisUploadedBy: 'analysis_uploaded_by',
            analysisChartData: 'analysis_chart_data' };
        for (const [k, v] of Object.entries(updates)) { if (map[k]) row[map[k]] = v; }
        const { error } = await supa.from('audits').update(row).eq('id', id);
        if (error) throw error;
    },

    // --- Collocations ---
    async getCollocations() {
        const { data, error } = await supa.from('collocations').select('*, profiles(name)').order('start_date', { ascending: false });
        if (error) throw error;
        return (data || []).map(c => ({
            id: c.id, locationId: c.location_id, status: c.status,
            startDate: c.start_date || '', endDate: c.end_date || '',
            sensorIds: c.sensor_ids || [], permanentPodId: c.permanent_pod_id || '',
            bamSource: c.bam_source || '', conductedBy: c.conducted_by || '',
            notes: c.notes || '', analysisResults: c.analysis_results || {},
            analysisChartData: c.analysis_chart_data || null,
            analysisName: c.analysis_name || '',
            analysisUploadDate: c.analysis_upload_date || null,
            analysisUploadedBy: c.analysis_uploaded_by || '',
            createdBy: c.profiles?.name || (c.created_by ? '[Deleted User]' : ''),
            createdById: c.created_by, createdAt: c.created_at, updatedAt: c.updated_at,
        }));
    },

    async insertCollocation(colloc) {
        const { data, error } = await supa.from('collocations').insert({
            location_id: colloc.locationId, status: colloc.status || 'In Progress',
            start_date: colloc.startDate || '', end_date: colloc.endDate || '',
            sensor_ids: colloc.sensorIds || [], permanent_pod_id: colloc.permanentPodId || '',
            bam_source: colloc.bamSource || '', conducted_by: colloc.conductedBy || '',
            notes: colloc.notes || '', created_by: colloc.createdById || null,
        }).select('*, profiles(name)');
        if (error) throw error;
        const c = data[0];
        return {
            id: c.id, locationId: c.location_id, status: c.status,
            startDate: c.start_date || '', endDate: c.end_date || '',
            sensorIds: c.sensor_ids || [], permanentPodId: c.permanent_pod_id || '',
            bamSource: c.bam_source || '', conductedBy: c.conducted_by || '',
            notes: c.notes || '', analysisResults: c.analysis_results || {},
            analysisChartData: c.analysis_chart_data || null, analysisName: c.analysis_name || '',
            analysisUploadDate: c.analysis_upload_date || null, analysisUploadedBy: c.analysis_uploaded_by || '',
            createdBy: c.profiles?.name || '', createdById: c.created_by,
            createdAt: c.created_at, updatedAt: c.updated_at,
        };
    },

    async updateCollocation(id, updates) {
        const row = { updated_at: new Date().toISOString() };
        const map = {
            locationId: 'location_id', status: 'status', startDate: 'start_date', endDate: 'end_date',
            sensorIds: 'sensor_ids', permanentPodId: 'permanent_pod_id', bamSource: 'bam_source',
            conductedBy: 'conducted_by', notes: 'notes', analysisResults: 'analysis_results',
            analysisChartData: 'analysis_chart_data', analysisName: 'analysis_name',
            analysisUploadDate: 'analysis_upload_date', analysisUploadedBy: 'analysis_uploaded_by',
        };
        for (const [k, v] of Object.entries(updates)) {
            if (map[k]) row[map[k]] = v;
        }
        const { error } = await supa.from('collocations').update(row).eq('id', id);
        if (error) throw error;
    },

    async deleteCollocation(id) {
        const { error } = await supa.from('collocations').delete().eq('id', id);
        if (error) throw error;
    },

    // --- Service Tickets ---
    async getServiceTickets() {
        const { data, error } = await supa.from('service_tickets').select('*, profiles(name)').order('created_at', { ascending: false });
        if (error) throw error;
        return (data || []).map(t => ({
            id: t.id, sensorId: t.sensor_id, ticketType: t.ticket_type, status: t.status,
            rmaNumber: t.rma_number || '', fedexTrackingTo: t.fedex_tracking_to || '',
            fedexTrackingFrom: t.fedex_tracking_from || '', issueDescription: t.issue_description || '',
            progressNotes: parseProgressNotes(t.quant_notes), workCompleted: t.work_completed || '',
            createdBy: t.profiles?.name || (t.created_by ? '[Deleted User]' : ''), createdById: t.created_by,
            createdAt: t.created_at, closedAt: t.closed_at, updatedAt: t.updated_at,
        }));
    },

    async insertServiceTicket(ticket) {
        const { data, error } = await supa.from('service_tickets').insert({
            sensor_id: ticket.sensorId, ticket_type: ticket.ticketType,
            status: ticket.status || 'Ticket Opened', rma_number: ticket.rmaNumber || '',
            fedex_tracking_to: ticket.fedexTrackingTo || '', fedex_tracking_from: ticket.fedexTrackingFrom || '',
            issue_description: ticket.issueDescription || '', quant_notes: JSON.stringify(ticket.progressNotes || []),
            work_completed: ticket.workCompleted || '', created_by: ticket.createdById || null,
        }).select('*, profiles(name)');
        if (error) throw error;
        const t = data[0];
        return {
            id: t.id, sensorId: t.sensor_id, ticketType: t.ticket_type, status: t.status,
            rmaNumber: t.rma_number || '', fedexTrackingTo: t.fedex_tracking_to || '',
            fedexTrackingFrom: t.fedex_tracking_from || '', issueDescription: t.issue_description || '',
            progressNotes: parseProgressNotes(t.quant_notes), workCompleted: t.work_completed || '',
            createdBy: t.profiles?.name || '', createdById: t.created_by,
            createdAt: t.created_at, closedAt: t.closed_at, updatedAt: t.updated_at,
        };
    },

    async updateServiceTicket(id, updates) {
        const row = { updated_at: nowDatetime() };
        for (const [k, v] of Object.entries(updates)) {
            const map = { rmaNumber: 'rma_number', fedexTrackingTo: 'fedex_tracking_to', fedexTrackingFrom: 'fedex_tracking_from', issueDescription: 'issue_description', progressNotes: 'quant_notes', workCompleted: 'work_completed', closedAt: 'closed_at', status: 'status' };
            if (k === 'progressNotes') { row['quant_notes'] = JSON.stringify(v); continue; }
            if (map[k]) row[map[k]] = v;
        }
        const { error } = await supa.from('service_tickets').update(row).eq('id', id);
        if (error) throw error;
    },
};
