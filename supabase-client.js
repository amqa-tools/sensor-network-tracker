// ===== SUPABASE CLIENT =====
const SUPABASE_URL = 'https://uejryzioxogquflijgyf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVlanJ5emlveG9ncXVmbGlqZ3lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2OTkyODMsImV4cCI6MjA4OTI3NTI4M30.YD349-X2PeoeCTVp34FbzdGwachr9YCpzIPSXuSURfM';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== AUTH =====
const db = {
    // --- Auth ---
    async signUp(email, password, name) {
        // Check allowed list first
        const { data: allowed, error: checkErr } = await supabase.rpc('is_email_allowed', { check_email: email });
        if (checkErr) throw checkErr;
        if (!allowed) throw new Error('Email not authorized. Contact your administrator.');

        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: { data: { name } }
        });
        if (error) throw error;

        // Create profile
        if (data.user) {
            await supabase.rpc('upsert_profile', {
                user_id: data.user.id,
                user_email: email,
                user_name: name,
            });
        }

        return data;
    },

    async signIn(email, password) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        return data;
    },

    async signOut() {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
    },

    async getSession() {
        const { data: { session } } = await supabase.auth.getSession();
        return session;
    },

    async getProfile() {
        const session = await this.getSession();
        if (!session) return null;
        const { data } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
        return data;
    },

    // --- Communities ---
    async getCommunities() {
        const { data, error } = await supabase.from('communities').select('*').order('name');
        if (error) throw error;
        return data || [];
    },

    async insertCommunity(community) {
        const { error } = await supabase.from('communities').insert(community);
        if (error) throw error;
    },

    async updateCommunity(id, updates) {
        const { error } = await supabase.from('communities').update(updates).eq('id', id);
        if (error) throw error;
    },

    // --- Community Tags ---
    async getCommunityTags() {
        const { data, error } = await supabase.from('community_tags').select('*');
        if (error) throw error;
        return data || [];
    },

    async setCommunityTags(communityId, tags) {
        // Delete existing then insert new
        await supabase.from('community_tags').delete().eq('community_id', communityId);
        if (tags.length > 0) {
            const rows = tags.map(tag => ({ community_id: communityId, tag }));
            const { error } = await supabase.from('community_tags').insert(rows);
            if (error) throw error;
        }
    },

    // --- Sensors ---
    async getSensors() {
        const { data, error } = await supabase.from('sensors').select('*').order('id');
        if (error) throw error;
        return data || [];
    },

    async upsertSensor(sensor) {
        const { error } = await supabase.from('sensors').upsert({
            id: sensor.id,
            soa_tag_id: sensor.soaTagId || '',
            type: sensor.type,
            status: sensor.status || [],
            community_id: sensor.community || null,
            location: sensor.location || '',
            date_purchased: sensor.datePurchased || '',
            collocation_dates: sensor.collocationDates || '',
            updated_at: new Date().toISOString(),
        });
        if (error) throw error;
    },

    async deleteSensor(id) {
        const { error } = await supabase.from('sensors').delete().eq('id', id);
        if (error) throw error;
    },

    // --- Contacts ---
    async getContacts() {
        const { data, error } = await supabase.from('contacts').select('*').order('name');
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
        };
        if (contact.id && typeof contact.id === 'string' && contact.id.length > 10) {
            // Existing UUID — update
            row.id = contact.id;
        }
        const { data, error } = await supabase.from('contacts').upsert(row).select();
        if (error) throw error;
        return data?.[0];
    },

    async deleteContact(id) {
        const { error } = await supabase.from('contacts').delete().eq('id', id);
        if (error) throw error;
    },

    // --- Notes ---
    async getNotes() {
        const { data: notesData, error: notesError } = await supabase.from('notes').select('*').order('date', { ascending: false });
        if (notesError) throw notesError;

        const { data: tagsData, error: tagsError } = await supabase.from('note_tags').select('*');
        if (tagsError) throw tagsError;

        // Merge tags into notes
        return (notesData || []).map(note => {
            const tags = (tagsData || []).filter(t => t.note_id === note.id);
            return {
                id: note.id,
                date: note.date,
                type: note.type,
                text: note.text,
                additionalInfo: note.additional_info || '',
                createdBy: note.created_by,
                taggedSensors: tags.filter(t => t.tag_type === 'sensor').map(t => t.tag_id),
                taggedCommunities: tags.filter(t => t.tag_type === 'community').map(t => t.tag_id),
                taggedContacts: tags.filter(t => t.tag_type === 'contact').map(t => t.tag_id),
            };
        });
    },

    async insertNote(note) {
        const { data, error } = await supabase.from('notes').insert({
            date: note.date,
            type: note.type,
            text: note.text,
            additional_info: note.additionalInfo || '',
            created_by: note.createdBy || null,
        }).select();
        if (error) throw error;

        const noteId = data[0].id;

        // Insert tags
        const tagRows = [];
        (note.taggedSensors || []).forEach(id => tagRows.push({ note_id: noteId, tag_type: 'sensor', tag_id: id }));
        (note.taggedCommunities || []).forEach(id => tagRows.push({ note_id: noteId, tag_type: 'community', tag_id: id }));
        (note.taggedContacts || []).forEach(id => tagRows.push({ note_id: noteId, tag_type: 'contact', tag_id: id }));

        if (tagRows.length > 0) {
            const { error: tagError } = await supabase.from('note_tags').insert(tagRows);
            if (tagError) throw tagError;
        }

        return { ...note, id: noteId };
    },

    // --- Communications ---
    async getComms() {
        const { data: commsData, error: commsError } = await supabase.from('comms').select('*').order('date', { ascending: false });
        if (commsError) throw commsError;

        const { data: tagsData, error: tagsError } = await supabase.from('comm_tags').select('*');
        if (tagsError) throw tagsError;

        return (commsData || []).map(comm => {
            const tags = (tagsData || []).filter(t => t.comm_id === comm.id);
            return {
                id: comm.id,
                date: comm.date,
                type: 'Communication',
                commType: comm.comm_type,
                text: comm.text,
                subject: comm.subject || '',
                fullBody: comm.full_body || '',
                createdBy: comm.created_by,
                community: comm.community_id || '',
                taggedContacts: tags.filter(t => t.tag_type === 'contact').map(t => t.tag_id),
                taggedCommunities: tags.filter(t => t.tag_type === 'community').map(t => t.tag_id),
            };
        });
    },

    async insertComm(comm) {
        const { data, error } = await supabase.from('comms').insert({
            date: comm.date,
            comm_type: comm.commType,
            text: comm.text,
            subject: comm.subject || '',
            full_body: comm.fullBody || '',
            created_by: comm.createdBy || null,
            community_id: comm.community || null,
        }).select();
        if (error) throw error;

        const commId = data[0].id;

        const tagRows = [];
        (comm.taggedContacts || []).forEach(id => tagRows.push({ comm_id: commId, tag_type: 'contact', tag_id: id }));
        (comm.taggedCommunities || []).forEach(id => tagRows.push({ comm_id: commId, tag_type: 'community', tag_id: id }));

        if (tagRows.length > 0) {
            const { error: tagError } = await supabase.from('comm_tags').insert(tagRows);
            if (tagError) throw tagError;
        }

        return { ...comm, id: commId };
    },

    // --- Community Files ---
    async getCommunityFiles() {
        const { data, error } = await supabase.from('community_files').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        return data || [];
    },

    async uploadFile(communityId, file, uploadedBy) {
        const path = `${communityId}/${Date.now()}_${file.name}`;
        const { error: uploadError } = await supabase.storage.from('community-files').upload(path, file);
        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage.from('community-files').getPublicUrl(path);

        const { data, error } = await supabase.from('community_files').insert({
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
        await supabase.storage.from('community-files').remove([storagePath]);
        const { error } = await supabase.from('community_files').delete().eq('id', fileId);
        if (error) throw error;
    },

    getFileUrl(storagePath) {
        const { data } = supabase.storage.from('community-files').getPublicUrl(storagePath);
        return data?.publicUrl || '';
    },

    async getSignedUrl(storagePath) {
        const { data, error } = await supabase.storage.from('community-files').createSignedUrl(storagePath, 3600);
        if (error) throw error;
        return data?.signedUrl || '';
    },
};
