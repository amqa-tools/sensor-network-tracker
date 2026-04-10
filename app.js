// ===== DATA LAYER (Supabase-backed) =====
// In-memory arrays — loaded from Supabase on init, kept in sync
let COMMUNITIES = [];
let AVAILABLE_TAGS = [];

let sensors = [];
let contacts = [];
let notes = [];
let comms = [];
let communityFiles = {};
let communityTags = {};
let serviceTickets = [];
let audits = [];
let collocations = [];
let communityParents = {}; // childId -> parentId
let currentUserRole = 'user'; // 'admin' or 'user' — loaded from profile on login
let mfaRequired = true; // global setting, admin-configurable

// Build lookup maps for O(1) access
const communityNameMap = {};
const contactMap = {};
const sensorTicketMap = {};

function rebuildLookupMaps() {
    // Community name lookup
    for (const key in communityNameMap) delete communityNameMap[key];
    COMMUNITIES.forEach(c => { communityNameMap[c.id] = c.name; });

    // Contact lookup by ID
    for (const key in contactMap) delete contactMap[key];
    contacts.forEach(c => { contactMap[c.id] = c; });

    // Sensor -> active tickets lookup
    rebuildSensorTicketMap();
}

function rebuildSensorTicketMap() {
    for (const key in sensorTicketMap) delete sensorTicketMap[key];
    serviceTickets.forEach(t => {
        if (t.status !== 'Closed') {
            if (!sensorTicketMap[t.sensorId]) sensorTicketMap[t.sensorId] = [];
            sensorTicketMap[t.sensorId].push(t);
        }
    });
}

// ===== CUSTOM CONFIRM / ALERT MODAL =====
let _confirmCallback = null;
let _confirmDismissCallback = null;

function showConfirm(title, message, onConfirm, options = {}) {
    const modal = document.getElementById('modal-confirm');
    document.getElementById('modal-confirm-title').textContent = title;
    document.getElementById('modal-confirm-body').innerHTML = message;
    const okBtn = document.getElementById('modal-confirm-ok');
    const cancelBtn = document.getElementById('modal-confirm-cancel');
    okBtn.textContent = options.confirmText || 'Confirm';
    cancelBtn.textContent = options.cancelText || 'Cancel';
    cancelBtn.style.display = '';
    if (options.danger) {
        okBtn.className = 'btn btn-confirm-danger';
    } else {
        okBtn.className = 'btn btn-primary';
    }
    _confirmCallback = onConfirm;
    _confirmDismissCallback = options.onCancel || null;
    modal.classList.add('open');
}

function showAlert(title, message, onDismiss) {
    const modal = document.getElementById('modal-confirm');
    document.getElementById('modal-confirm-title').textContent = title;
    document.getElementById('modal-confirm-body').innerHTML = message;
    const okBtn = document.getElementById('modal-confirm-ok');
    const cancelBtn = document.getElementById('modal-confirm-cancel');
    okBtn.textContent = 'OK';
    okBtn.className = 'btn btn-primary';
    cancelBtn.style.display = 'none';
    _confirmCallback = onDismiss || null;
    _confirmDismissCallback = null;
    modal.classList.add('open');
}

function acceptConfirmModal() {
    const modal = document.getElementById('modal-confirm');
    // Run callback BEFORE closing so form inputs (selects, inputs) are still readable
    if (_confirmCallback) { const cb = _confirmCallback; _confirmCallback = null; _confirmDismissCallback = null; cb(); }
    modal.classList.remove('open');
}

function dismissConfirmModal() {
    const modal = document.getElementById('modal-confirm');
    modal.classList.remove('open');
    if (_confirmDismissCallback) { const cb = _confirmDismissCallback; _confirmCallback = null; _confirmDismissCallback = null; cb(); }
    _confirmCallback = null;
    _confirmDismissCallback = null;
}

// Close confirm modal on backdrop click
document.addEventListener('click', function(e) {
    const modal = document.getElementById('modal-confirm');
    if (modal && e.target === modal) dismissConfirmModal();
});

function loadData(key, fallback) {
    try {
        const raw = localStorage.getItem('snt_' + key);
        return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
}

function saveData(key, data) {
    localStorage.setItem('snt_' + key, JSON.stringify(data));
}

// Load all data from Supabase into memory
async function loadAllData() {
    const results = await Promise.allSettled([
        db.getCommunities(),
        db.getCommunityTags(),
        db.getSensors(),
        db.getContacts(),
        db.getNotes(),
        db.getComms(),
        db.getCommunityFiles(),
        db.getServiceTickets(),
        db.getAudits(),
        db.getCollocations(),
    ]);
    const getValue = (i) => results[i].status === 'fulfilled' ? results[i].value : [];
    const communitiesData = getValue(0);
    const tagsData = getValue(1);
    const sensorsData = getValue(2);
    const contactsData = getValue(3);
    const notesData = getValue(4);
    const commsData = getValue(5);
    const filesData = getValue(6);
    const ticketsData = getValue(7);
    const auditsData = getValue(8);
    const collocationsData = getValue(9);
    results.forEach((r, i) => { if (r.status === 'rejected') console.warn('Data load warning:', r.reason); });

    // Communities
    COMMUNITIES = communitiesData.map(c => ({ id: c.id, name: c.name }));
    communityParents = {};
    communitiesData.forEach(c => {
        if (c.parent_id) communityParents[c.id] = c.parent_id;
    });

    // Sync deactivated communities from DB active column
    deactivatedCommunities = communitiesData.filter(c => c.active === false).map(c => c.id);

    // Tags
    communityTags = {};
    tagsData.forEach(t => {
        if (!communityTags[t.community_id]) communityTags[t.community_id] = [];
        communityTags[t.community_id].push(t.tag);
    });
    // Build AVAILABLE_TAGS from all unique tags
    AVAILABLE_TAGS = [...new Set(tagsData.map(t => t.tag))].sort();

    // Sensors — map DB columns to app format
    sensors = sensorsData.map(s => ({
        id: s.id,
        soaTagId: s.soa_tag_id || '',
        type: s.type || 'Community Pod',
        status: s.status || [],
        community: s.community_id || '',
        location: s.location || '',
        datePurchased: s.date_purchased || '',
        collocationDates: s.collocation_dates || '',
        dateInstalled: s.date_installed || '',
        customFields: {},
    }));

    // Load custom field values from localStorage
    const savedCustomData = loadData('sensorCustomData', {});
    sensors.forEach(s => {
        if (savedCustomData[s.id]) s.customFields = savedCustomData[s.id];
    });

    // Contacts — map DB columns to app format
    contacts = contactsData.map(c => ({
        id: c.id,
        name: c.name,
        role: c.role || '',
        community: c.community_id || '',
        email: c.email || '',
        phone: c.phone || '',
        org: c.org || '',
        active: c.active !== false,
        emailList: c.email_list === true,
        primaryContact: c.primary_contact === true,
    }));

    // Notes — already mapped by db.getNotes()
    notes = notesData;

    // Comms — already mapped by db.getComms()
    comms = commsData;

    // Files — group by community
    communityFiles = {};
    filesData.forEach(f => {
        if (!communityFiles[f.community_id]) communityFiles[f.community_id] = [];
        communityFiles[f.community_id].push({
            id: f.id,
            name: f.file_name,
            type: f.file_type,
            storagePath: f.storage_path,
            date: f.created_at,
        });
    });

    // Service tickets
    serviceTickets = ticketsData;
    audits = auditsData;
    collocations = collocationsData;

    // Migrate old status names BEFORE any cleanup that depends on status values
    migrateAuditCollocStatuses();

    // Clean up stale service statuses on sensors based on current ticket stage
    cleanupSensorServiceStatuses();

    // Remove Collocation status from sensors with no active collocation
    cleanupStaleCollocationStatuses();

    // One-time fix: re-apply Collocation tag to sensors in active collocations
    restoreMissingCollocationStatuses();

    // Clean up orphaned Collocation notes (notes tagged to sensors with no matching active collocation)
    cleanupOrphanedCollocationNotes();

    // Merge duplicate status change notes with general notes created at same time
    mergeStatusChangeNotes();

    // Ensure notes containing status change text have the Status Change type tag
    tagNotesWithStatusChange();

    // One-time migration: convert legacy collocationDates to notes
    cleanupOldMigrationNotes();

    // One-time cleanup: remove duplicated user notes from collocation note titles
    cleanupDuplicatedCollocationNoteTitles();

    // Build O(1) lookup maps
    rebuildLookupMaps();
}

function migrateAuditCollocStatuses() {
    if (localStorage.getItem('snt_statusMigration_v3')) return;
    // Map old status values to new combined ones
    function mapStatus(oldStatus) {
        if (oldStatus === 'Audit Complete' || oldStatus === 'Collocation Complete') return 'Complete';
        if (oldStatus === 'Finished' || oldStatus === 'Analysis Pending') return 'Finished, Analysis Pending';
        // Old intermediate "Complete" (field done) → combined "Finished, Analysis Pending"
        if (oldStatus === 'Complete') return 'Finished, Analysis Pending';
        return null; // no migration needed
    }
    let auditCount = 0;
    audits.forEach(a => {
        const newStatus = mapStatus(a.status);
        if (newStatus && newStatus !== a.status) {
            a.status = newStatus;
            db.updateAudit(a.id, { status: newStatus }).catch(() => {});
            auditCount++;
        }
    });
    let collocCount = 0;
    collocations.forEach(c => {
        const newStatus = mapStatus(c.status);
        if (newStatus && newStatus !== c.status) {
            c.status = newStatus;
            db.updateCollocation(c.id, { status: newStatus }).catch(() => {});
            collocCount++;
        }
    });
    localStorage.setItem('snt_statusMigration_v3', '1');
    if (auditCount > 0 || collocCount > 0) {
        console.log(`Migrated ${auditCount} audit + ${collocCount} collocation statuses to new names`);
    }
}

function cleanupSensorServiceStatuses() {
    const allServiceStatuses = ['Shipped to Quant', 'Service at Quant', 'Shipped from Quant'];
    const sensorStatusMap = { 'Shipped to Quant': 'Shipped to Quant', 'At Quant': 'Service at Quant', 'Shipped from Quant': 'Shipped from Quant' };
    sensors.forEach(s => {
        const activeTickets = serviceTickets.filter(t => t.sensorId === s.id && t.status !== 'Closed');
        if (activeTickets.length === 0) return;
        const ticket = activeTickets[0];
        const currentServiceStatus = sensorStatusMap[ticket.status] || null;
        const currentStatuses = getStatusArray(s);
        const stale = currentStatuses.filter(st => allServiceStatuses.includes(st) && st !== currentServiceStatus);
        if (stale.length > 0) {
            s.status = currentStatuses.filter(st => !allServiceStatuses.includes(st) || st === currentServiceStatus);
            persistSensor(s);
        }
    });
}

function cleanupStaleCollocationStatuses() {
    // Remove "Collocation" status from sensors that have no active (non-complete) collocation
    const activeCollocSensors = new Set();
    collocations.forEach(c => {
        if (c.status !== 'Complete') {
            (c.sensorIds || []).forEach(id => activeCollocSensors.add(id));
        }
    });
    sensors.forEach(s => {
        const statuses = getStatusArray(s);
        if (statuses.includes('Collocation') && !activeCollocSensors.has(s.id)) {
            s.status = statuses.filter(st => st !== 'Collocation');
            if (s.status.length === 0) s.status = ['Online'];
            persistSensor(s);
        }
    });
}

function restoreMissingCollocationStatuses() {
    // One-time fix: re-apply Collocation tag to sensors that are in active collocations
    // but lost the tag (e.g., from Mass Action status overwrites before the merge fix)
    if (localStorage.getItem('snt_restoreCollocStatus_v1')) return;
    let count = 0;
    collocations.forEach(c => {
        if (c.status === 'Complete') return;
        (c.sensorIds || []).forEach(id => {
            const s = sensors.find(x => x.id === id);
            if (!s) return;
            const statuses = getStatusArray(s);
            if (!statuses.includes('Collocation')) {
                s.status = [...statuses, 'Collocation'];
                persistSensor(s);
                count++;
            }
        });
    });
    if (count > 0) {
        console.log(`Restored Collocation status on ${count} sensor(s)`);
        buildSensorSidebar();
    }
    localStorage.setItem('snt_restoreCollocStatus_v1', '1');
}

function cleanupOrphanedCollocationNotes() {
    // Remove Collocation-type notes that reference sensors not in any active collocation
    const collocSensorIds = new Set();
    collocations.forEach(c => (c.sensorIds || []).forEach(id => collocSensorIds.add(id)));

    const orphaned = notes.filter(n =>
        n.type === 'Collocation' &&
        (n.taggedSensors || []).length > 0 &&
        !(n.taggedSensors || []).some(sid => collocSensorIds.has(sid))
    );

    if (orphaned.length > 0) {
        console.log(`Cleaning up ${orphaned.length} orphaned Collocation notes`);
        const toRemoveIds = new Set(orphaned.map(n => n.id));
        notes = notes.filter(n => !toRemoveIds.has(n.id));
        orphaned.forEach(n => {
            supa.from('note_tags').delete().eq('note_id', n.id).then(() =>
                supa.from('notes').delete().eq('id', n.id)
            ).catch(err => console.error('Delete orphaned collocation note error:', err));
        });
    }
}

function mergeStatusChangeNotes() {
    // Find Status Change notes that were created at the same date by the same user
    // as a non-status-change note, and merge them together
    const statusNotes = notes.filter(n => n.type === 'Status Change');
    const toRemove = [];

    statusNotes.forEach(sn => {
        // Look for a non-status-change note at the same date/time by the same user
        // that shares at least one tagged sensor
        const snDate = (sn.date || '').substring(0, 16); // match to the minute
        if (!snDate) return;
        const snSensors = sn.taggedSensors || [];
        if (snSensors.length === 0) return;

        const match = notes.find(n =>
            n.id !== sn.id &&
            n.type !== 'Status Change' &&
            (n.date || '').substring(0, 16) === snDate &&
            n.createdBy === sn.createdBy &&
            (n.taggedSensors || []).some(s => snSensors.includes(s))
        );

        if (match) {
            // Merge status change text into the existing note
            if (!match.text.includes('status changed from')) {
                match.text = match.text + '\n' + sn.text;
                match.type = 'Status Change';
                // Merge tags
                (sn.taggedSensors || []).forEach(s => { if (!(match.taggedSensors || []).includes(s)) match.taggedSensors.push(s); });
                (sn.taggedCommunities || []).forEach(c => { if (!(match.taggedCommunities || []).includes(c)) match.taggedCommunities.push(c); });
                // Persist the merged note
                db.updateNote(match.id, { text: match.text, type: match.type }).catch(err => console.error('Merge note error:', err));
            }
            toRemove.push(sn.id);
        }
    });

    // Remove the now-merged status change notes
    if (toRemove.length > 0) {
        console.log(`Merging ${toRemove.length} duplicate status change notes`);
        const toRemoveSet = new Set(toRemove);
        notes = notes.filter(n => !toRemoveSet.has(n.id));
        toRemove.forEach(id => {
            // Delete from DB
            supa.from('note_tags').delete().eq('note_id', id).then(() =>
                supa.from('notes').delete().eq('id', id)
            ).catch(err => console.error('Delete merged note error:', err));
        });
    }
}

function tagNotesWithStatusChange() {
    // Ensure any note whose text contains a status change line has Status Change in its type
    notes.forEach(n => {
        if (n.text && n.text.includes('status changed from') && !n.type.includes('Status Change')) {
            if (n.type === 'General' || !n.type) {
                n.type = 'Status Change';
            } else {
                n.type = n.type + ' + Status Change';
            }
            db.updateNote(n.id, { type: n.type }).catch(err => console.error('Tag status change error:', err));
        }
    });
}

const INITIAL_COLLOCATION_DATA = {
    "MOD-00442": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00443": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00444": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00445": "12/4/23-12/18/23 @ NCore",
    "MOD-00446": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00447": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00448": "12/4/23-12/18/23 @ NCore",
    "MOD-00449": "12/4/23-12/18/23 @ NCore",
    "MOD-00450": "12/4/23-12/18/23 @ NCore",
    "MOD-00451": "12/4/23-12/18/23 @ NCore",
    "MOD-00452": "12/4/23-12/18/23 @ NCore",
    "MOD-00453": "12/4/23-12/18/23 @ NCore",
    "MOD-00454": "12/4/23-12/18/23 @ NCore",
    "MOD-00455": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00456": "12/22/23-1/5/24 @ NCore",
    "MOD-00457": "12/22/23-1/5/24 @ NCore",
    "MOD-00458": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00459": "8/1/23-8/14/23 at SPAR Bldg Anchorage, 6/26/25-7/16/25 at Garden",
    "MOD-00460": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00461": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00462": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00463": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00464": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00465": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00466": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00467": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00468": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00469": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00470": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00471": "8/1/23-8/14/23 at SPAR Bldg Anchorage",
    "MOD-00649": "3/8/24-3/21/24 @ NCore",
    "MOD-00650": "6/16/24-7/3/24 @ NCore",
    "MOD-00651": "3/8/24-3/21/24 @ NCore",
    "MOD-00652": "3/8/24-3/21/24 @ NCore",
    "MOD-00653": "3/8/24-3/21/24 @ NCore",
    "MOD-00654": "3/8/24-3/21/24 @ NCore",
    "MOD-00655": "3/8/24-3/21/24 @ NCore",
    "MOD-00656": "3/8/24-3/21/24 @ NCore",
    "MOD-00657": "3/8/24-3/21/24 @ NCore",
    "MOD-00658": "3/8/24-3/21/24 @ NCore",
    "MOD-00659": "3/8/24-3/21/24 @ NCore; 2/18/24-",
    "MOD-00660": "3/8/24-3/21/24 @ NCore",
    "MOD-00662": "3/8/24-3/21/24 @ NCore",
    "MOD-00663": "3/21/24-4/3/24 @ NCore",
    "MOD-00664": "3/21/24-4/3/24 @ NCore",
    "MOD-00665": "3/21/24-4/3/24 @ NCore",
    "MOD-00666": "3/21/24-4/3/24 @ NCore",
    "MOD-00667": "3/21/24-4/3/24 @ NCore",
    "MOD-00668": "3/21/24-4/3/24 @ NCore",
    "MOD-00669": "3/21/24-4/3/24 @ NCore",
    "MOD-00670": "3/21/24-4/3/24 @ NCore",
    "MOD-00671": "3/21/24-4/3/24 @ NCore",
    "MOD-00672": "3/21/24-4/3/24 @ NCore",
    "MOD-00673": "3/21/24-4/3/24 @ NCore",
    "MOD-00674": "3/21/24-4/3/24 @ NCore",
    "MOD-X-PM-01656": "Garden 6/30/25-9/26/25",
    "MOD-X-PM-01657": "Garden 6/30/25-9/26/25",
    "MOD-X-PM-01658": "Garden 6/30/25-9/26/25",
    "MOD-X-PM-01754": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01755": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01756": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01757": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01758": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01759": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01760": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01761": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01762": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01763": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01764": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01765": "12/4/2025-1/16/2026 @ NCore",
    "MOD-X-PM-01766": "12/4/2025-1/16/2026 @ NCore"
};

function _parseCollocStartDate(text) {
    const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return '2023-01-01T00:00';
    let y = parseInt(m[3]); if (y < 100) y += 2000;
    return y + '-' + m[1].padStart(2,'0') + '-' + m[2].padStart(2,'0') + 'T00:00';
}

function cleanupOldMigrationNotes() {
    // One-time cleanup: remove any "Initial collocation:" notes from broken previous migrations
    // These are no longer needed — initial collocations render directly from INITIAL_COLLOCATION_DATA
    if (localStorage.getItem('snt_collocMigration_cleaned')) return;
    const toDelete = notes.filter(n => n.text && n.text.startsWith('Initial collocation:'));
    if (toDelete.length > 0) {
        const toDeleteIds = new Set(toDelete.map(n => n.id));
        notes = notes.filter(n => !toDeleteIds.has(n.id));
        toDelete.forEach(n => {
            supa.from('note_tags').delete().eq('note_id', n.id).then(() =>
                supa.from('notes').delete().eq('id', n.id)
            ).catch(() => {});
        });
        console.log('Cleaned up ' + toDelete.length + ' old migration notes');
    }
    localStorage.setItem('snt_collocMigration_cleaned', '1');
}

function cleanupDuplicatedCollocationNoteTitles() {
    // One-time fix: trim user-typed notes from the title of collocation notes
    // The notes already exist in additionalInfo (italics below) — no need to duplicate in title
    if (localStorage.getItem('snt_collocTitlesCleaned')) return;
    let count = 0;
    notes.forEach(n => {
        if (n.type !== 'Collocation' || !n.text || !n.additionalInfo) return;
        // Only fix notes that match the auto-generated collocation title pattern
        if (!/^Collocation at .+:/i.test(n.text)) return;
        let parsed = null;
        try { parsed = JSON.parse(n.additionalInfo); } catch (_) {}
        if (!parsed || !parsed.userNotes) return;
        const userNotes = parsed.userNotes.trim();
        if (!userNotes) return;
        // If the title contains the user notes at the end, strip them
        if (n.text.includes(userNotes)) {
            const cleaned = n.text.replace(userNotes, '').replace(/\s+$/, '').replace(/\.\s*$/, '.');
            if (cleaned !== n.text) {
                n.text = cleaned;
                db.updateNote(n.id, { text: cleaned }).catch(() => {});
                count++;
            }
        }
    });
    if (count > 0) console.log(`Cleaned ${count} collocation note titles`);
    localStorage.setItem('snt_collocTitlesCleaned', '1');
}


// ===== PERSISTENCE LAYER =====
// Fire-and-forget writes to Supabase. UI updates immediately from in-memory arrays.
function handleSaveError(err) {
    console.error('Save error:', err);
    const raw = err?.message || err || 'Unknown error';
    const friendly = raw.includes('duplicate') ? 'This record already exists.' :
        raw.includes('violates') ? 'A data conflict occurred. Please try again.' :
        raw.includes('network') || raw.includes('fetch') ? 'Could not reach the server. Check your connection.' : raw;
    const msg = document.createElement('div');
    msg.className = 'save-error-toast'; msg.setAttribute('role', 'alert');
    msg.textContent = 'Save failed: ' + friendly;
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 6000);
}

function showSuccessToast(text) {
    const msg = document.createElement('div');
    msg.className = 'save-success-toast'; msg.setAttribute('role', 'status');
    msg.textContent = text;
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 3000);
}

function persistSensor(s) { return db.upsertSensor(s).catch(handleSaveError); }
function persistContact(c) { return db.upsertContact(c).catch(handleSaveError); }
function persistNote(n) { return db.insertNote(n).catch(handleSaveError); }
function persistComm(c) { return db.insertComm(c).catch(handleSaveError); }
function persistCommunityTags(id, tags) { db.setCommunityTags(id, tags).catch(handleSaveError); }
function persistCommunity(c) { db.insertCommunity(c).catch(handleSaveError); }
function persistServiceTicketUpdate(id, updates) { db.updateServiceTicket(id, updates).catch(handleSaveError); }
function persistAuditUpdate(id, updates) { db.updateAudit(id, updates).catch(handleSaveError); }

// ===== UTILITIES =====
function generateId(prefix) {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return prefix + '-' + crypto.randomUUID().substring(0, 12);
    }
    return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function createNote(type, text, tags, additionalInfo) {
    const note = {
        id: generateId('n'),
        date: nowDatetime(),
        type,
        text,
        additionalInfo: additionalInfo || '',
        createdBy: getCurrentUserName(), createdById: currentUserId,
        createdAt: new Date().toISOString(),
        taggedSensors: tags?.sensors || [],
        taggedCommunities: tags?.communities || [],
        taggedContacts: tags?.contacts || [],
    };
    notes.push(note);
    // Persist and update in-memory ID with Supabase-generated UUID
    db.insertNote(note).then(saved => {
        if (saved?.id) note.id = saved.id;
    }).catch(handleSaveError);
    return note;
}

async function deleteAutoNotes(noteType, sensorIds) {
    // Remove auto-generated notes of the given type tagged to any of the given sensors
    const toRemove = notes.filter(n =>
        n.type === noteType &&
        sensorIds.some(sid => (n.taggedSensors || []).includes(sid))
    );
    toRemove.forEach(n => {
        const idx = notes.indexOf(n);
        if (idx >= 0) notes.splice(idx, 1);
        supa.from('note_tags').delete().eq('note_id', n.id).then(() =>
            supa.from('notes').delete().eq('id', n.id)
        ).catch(err => console.error('Delete auto note error:', err));
    });
    if (toRemove.length > 0) console.log(`Deleted ${toRemove.length} auto-generated ${noteType} notes`);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Abbreviate sensor ID: MOD-00471 → Mod-471, MOD-X-PM-01656 → Mod-X-PM-1656
function shortSensorId(id) {
    if (!id) return '';
    // Handle MOD-X-PM first (longer pattern), then standard MOD-
    return id.replace(/MOD-X-PM-0*(\d+)/gi, 'Mod-X-PM-$1')
             .replace(/MOD-0*(\d+)/gi, 'Mod-$1');
}

function hideAllAuthForms() {
    document.getElementById('login-form-section').style.display = 'none';
    document.getElementById('signup-form-section').style.display = 'none';
    document.getElementById('mfa-challenge-section').style.display = 'none';
    document.getElementById('mfa-setup-section').style.display = 'none';
    document.getElementById('login-loading').style.display = 'none';
    hideLoginError();
}

function getCommunityTags(communityId) {
    return communityTags[communityId] || [];
}

function getParentCommunity(communityId) {
    const parentId = communityParents[communityId];
    return parentId ? COMMUNITIES.find(c => c.id === parentId) : null;
}

function getChildCommunities(communityId) {
    return COMMUNITIES.filter(c => communityParents[c.id] === communityId)
        .sort((a, b) => a.name.localeCompare(b.name));
}

function isChildCommunity(communityId) {
    return !!communityParents[communityId];
}

// ===== RECENT ACTIVITY TRACKING =====
let recentActivity = null;

function getRecentActivityKey() {
    return 'recentActivity_' + (currentUserId || 'anon');
}

function ensureRecentActivity() {
    if (!recentActivity) {
        recentActivity = loadData(getRecentActivityKey(), { communities: [], contacts: [], sensors: [] });
    }
    return recentActivity;
}

function trackRecent(type, id, action) {
    // type: 'communities' | 'contacts' | 'sensors'
    // action: 'viewed' | 'edited'
    ensureRecentActivity();
    const list = recentActivity[type] || [];
    // Remove existing entry for this id
    const filtered = list.filter(item => item.id !== id);
    // Add to front
    filtered.unshift({ id, action, time: nowDatetime() });
    // Keep only 5
    recentActivity[type] = filtered.slice(0, 5);
    saveData(getRecentActivityKey(), recentActivity);
}

// ===== USER SYSTEM (Supabase Auth) =====
let currentUser = null;
let currentUserId = null;

function showLoginScreen() {
    document.getElementById('loading-overlay').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    hideAllAuthForms();
    document.getElementById('login-form-section').style.display = '';
}

function showSignUpForm() {
    hideAllAuthForms();
    document.getElementById('signup-email').value = '';
    document.getElementById('signup-name').value = '';
    document.getElementById('signup-password').value = '';
    document.getElementById('signup-password-confirm').value = '';
    document.getElementById('signup-form-section').style.display = '';
}

async function backToSignIn() {
    await supa.auth.signOut();
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    hideAllAuthForms();
    document.getElementById('login-form-section').style.display = '';
    document.getElementById('login-email').value = '';
    document.getElementById('login-password').value = '';
}

function showSignInForm() {
    hideAllAuthForms();
    document.getElementById('login-form-section').style.display = '';
}

function showLoginError(msg) {
    const el = document.getElementById('login-error');
    el.textContent = msg;
    el.classList.add('visible');
}

function hideLoginError() {
    document.getElementById('login-error').classList.remove('visible');
}

async function handleSignIn() {
    hideLoginError();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    if (!email || !password) { showLoginError('Please enter email and password.'); return; }

    try {
        const { data: allowed } = await supa.rpc('is_email_allowed', { check_email: email });
        if (!allowed) {
            showLoginError('Access denied. Please contact the site admin to request access.');
            return;
        }
        await db.signIn(email, password);
        await checkMfaAndProceed();
    } catch (err) {
        showLoginError(err.message || 'Sign in failed.');
    }
}

async function checkMfaAndProceed() {
    // Check if MFA is enforced for login challenges
    let mfaOn = true;
    try { const setting = await db.getAppSetting('mfa_required'); mfaOn = setting !== 'false'; } catch(e) { mfaOn = true; }

    const { data: factors } = await supa.auth.mfa.listFactors();
    const totp = factors?.totp?.find(f => f.status === 'verified');

    if (!totp) {
        // No MFA factor set up — ALWAYS require enrollment for new users
        // regardless of app toggle, so they can change passwords and are
        // ready if an admin enables enforcement later
        showMfaSetup();
        return;
    }

    if (mfaOn) {
        // MFA enforced — require code on every login
        showMfaChallenge();
    } else {
        // MFA not enforced — user has a factor but skip the challenge
        await enterApp();
    }
}

function showMfaChallenge() {
    document.getElementById('loading-overlay').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    hideAllAuthForms();
    document.getElementById('mfa-challenge-section').style.display = '';
    document.getElementById('mfa-challenge-code').value = '';
    document.getElementById('mfa-challenge-code').focus();
}

async function showMfaSetup() {
    // Load QR code while overlay is still showing
    const { data, error } = await supa.auth.mfa.enroll({ factorType: 'totp' });
    if (error) {
        document.getElementById('loading-overlay').style.display = 'none';
        showLoginScreen();
        showLoginError(error.message);
        return;
    }

    // Render QR code — use <img> directly (canvas approach fails silently on
    // Safari and some browsers that taint/block SVG data URIs in Image objects)
    const qrContainer = document.getElementById('mfa-setup-qr');
    const qrSrc = data.totp.qr_code;
    qrContainer.innerHTML = '';
    const img = document.createElement('img');
    img.src = qrSrc;
    img.alt = 'Scan this QR code with your authenticator app';
    img.style.cssText = 'display:block;margin:0 auto;width:250px;height:250px;background:#fff;padding:8px;border-radius:8px;border:1px solid #e2e8f0';
    img.onerror = function() {
        // If the SVG data URI fails entirely, show the TOTP URI for manual entry
        qrContainer.innerHTML = '<p style="font-size:13px;color:var(--slate-500);text-align:center">QR code could not be displayed.<br>Enter this key manually in your authenticator app:</p>'
            + '<code style="display:block;text-align:center;word-break:break-all;font-size:12px;background:var(--slate-50);padding:12px;border-radius:6px;margin-top:8px;font-family:var(--font-mono)">'
            + (data.totp.secret || data.totp.uri || '') + '</code>';
    };
    qrContainer.appendChild(img);
    document.getElementById('mfa-setup-section').dataset.factorId = data.id;

    // Now show the screen
    document.getElementById('loading-overlay').style.display = 'none';
    hideAllAuthForms();
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('mfa-setup-section').style.display = '';
}

async function handleMfaSetupVerify() {
    hideLoginError();
    const code = document.getElementById('mfa-setup-code').value.trim();
    if (!code || code.length !== 6) { showLoginError('Enter the 6-digit code from your authenticator app.'); return; }

    const factorId = document.getElementById('mfa-setup-section').dataset.factorId;
    try {
        const { data: challenge } = await supa.auth.mfa.challenge({ factorId });
        const { error } = await supa.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
        if (error) { showLoginError('Invalid code. Try again.'); return; }

        await enterApp();
    } catch (err) {
        showLoginError(err.message || 'Verification failed.');
    }
}

async function handleMfaVerify() {
    hideLoginError();
    const code = document.getElementById('mfa-challenge-code').value.trim();
    if (!code || code.length !== 6) { showLoginError('Enter your 6-digit code.'); return; }

    try {
        const { data: factors } = await supa.auth.mfa.listFactors();
        const totp = factors?.totp?.find(f => f.status === 'verified');
        if (!totp) { showLoginError('No MFA factor found.'); return; }

        const { data: challenge } = await supa.auth.mfa.challenge({ factorId: totp.id });
        const { error } = await supa.auth.mfa.verify({ factorId: totp.id, challengeId: challenge.id, code });
        if (error) { showLoginError('Invalid code. Try again.'); return; }

        await enterApp();
    } catch (err) {
        showLoginError(err.message || 'MFA verification failed.');
    }
}

async function handleSignUp() {
    hideLoginError();
    const name = document.getElementById('signup-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const confirmPassword = document.getElementById('signup-password-confirm').value;

    if (!name || !email || !password) { showLoginError('Please fill in all fields.'); return; }
    if (password.length < 6) { showLoginError('Password must be at least 6 characters.'); return; }
    if (password !== confirmPassword) { showLoginError('Passwords do not match.'); return; }

    try {
        // Sign up — creates auth account and profile
        const result = await db.signUp(email, password, name);

        if (result?.session) {
            // Auto-confirmed — go straight to MFA setup
            await checkMfaAndProceed();
            return;
        }

        // No session — try signing in (works if email confirmation is disabled)
        try {
            await db.signIn(email, password);
            await checkMfaAndProceed();
        } catch(e) {
            // Email confirmation is required
            showAlert('Account Created', 'Your account has been created. Please check your email to confirm, then sign in.', () => {
                showSignInForm();
            });
        }
    } catch (err) {
        showLoginError(err.message || 'Sign up failed. Your email may not be authorized.');
    }
}

async function enterApp() {
    try {
    const session = await db.getSession();
    sessionStorage.setItem('mfa_verified_at', Date.now().toString());
    sessionStorage.setItem('mfa_verified_user', session?.user?.id || '');
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('login-loading').style.display = 'none';
    document.getElementById('loading-overlay').style.display = 'flex';

    const profile = await db.getProfile();
    currentUser = profile?.name || profile?.email || 'User';
    currentUserId = profile?.id || null;
    recentActivity = null; // Reset so lazy init loads with correct user key
    const userEmail = profile?.email || '';

    // Check if user has been archived or deleted
    try {
        // Also try session email in case profile email was cleared by a previous deletion
        const session = await db.getSession();
        const checkEmail = (userEmail || session?.user?.email || '').toLowerCase();
        const { data: emailRow } = await supa.from('allowed_emails').select('role, status').eq('email', checkEmail).maybeSingle();
        if (!emailRow || emailRow.status === 'archived' || emailRow.status === 'revoked') {
            await db.signOut();
            document.getElementById('login-loading').style.display = 'none';
            document.getElementById('loading-overlay').style.display = 'none';
            document.getElementById('login-screen').style.display = 'flex';
            showLoginError('Your account has been archived. Please contact an admin if you need access restored.');
            return;
        }
        // Load role
        currentUserRole = profile?.role || emailRow?.role || 'user';

        // Repair profile if it was previously anonymized by deletion
        if (profile && (profile.name === '[Deleted User]' || !profile.email) && checkEmail) {
            const session2 = await db.getSession();
            const userName = session2?.user?.user_metadata?.name || checkEmail.split('@')[0];
            await supa.from('profiles').update({ email: checkEmail, name: userName }).eq('id', session2.user.id);
            currentUser = userName;
        }
    } catch(e) {
        // Fallback if allowed_emails check fails
        currentUserRole = profile?.role || 'user';
    }

    // Load global MFA setting
    try { const mfaSetting = await db.getAppSetting('mfa_required'); mfaRequired = mfaSetting !== 'false'; } catch(e) { mfaRequired = true; }

    await loadAllData();

    // Load QuantAQ alerts from database (wrapped in try/catch so a QuantAQ
    // failure never prevents the main app from loading)
    if (typeof initQuantAQ === 'function') {
        try { await initQuantAQ(); } catch (e) { console.error('[QuantAQ] Init failed, continuing without alerts:', e); }
    }

    document.getElementById('login-loading').style.display = 'none';
    document.getElementById('loading-overlay').style.display = 'none';
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    document.getElementById('sidebar-user').innerHTML =
        `<span class="user-name">${currentUser}</span><span class="sidebar-user-actions"><span class="sidebar-settings-btn" onclick="event.stopPropagation(); showView('settings')" title="Settings">&#9881;</span><span class="user-logout" onclick="logoutUser()">Sign out</span></span>`;
    renderSetupModeIndicator();
    buildSidebar();
    buildSensorSidebar();
    renderPinnedSidebar();
    updateSidebarServiceCount();
    updateSidebarAuditCount();
    updateSidebarCollocationCount();
    restoreLastView();
    startInactivityTimer();
    } catch (err) {
        console.error('App initialization error:', err);
        document.getElementById('login-loading').style.display = 'none';
        document.getElementById('loading-overlay').style.display = 'none';
        document.getElementById('app').style.display = 'none';
        document.getElementById('login-screen').style.display = 'flex';
        showLoginError('Failed to load app data. Please check your connection and try again.');
    }
}

// ===== INACTIVITY TIMER (1 hour) =====
let inactivityTimeout = null;
let inactivityListenersAdded = false;
const INACTIVITY_LIMIT = 60 * 60 * 1000; // 1 hour in ms

function startInactivityTimer() {
    resetInactivityTimer();
    if (!inactivityListenersAdded) {
        ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(event => {
            document.addEventListener(event, resetInactivityTimer, { passive: true });
        });
        inactivityListenersAdded = true;
    }
}

function resetInactivityTimer() {
    if (inactivityTimeout) clearTimeout(inactivityTimeout);
    inactivityTimeout = setTimeout(async () => {
        sessionStorage.removeItem('mfa_verified_at');
        sessionStorage.removeItem('mfa_verified_user');
        showAlert('Session Expired', 'You have been signed out due to inactivity.', async () => {
            await logoutUser();
        });
    }, INACTIVITY_LIMIT);
}

async function logoutUser() {
    await db.signOut();
    currentUser = null;
    currentUserId = null;
    currentUserRole = 'user';
    selectedSensors.clear();
    viewHistory = [];
    setupMode = false;
    sessionStorage.removeItem('snt_setupMode');
    sessionStorage.removeItem('mfa_verified_at');
    sessionStorage.removeItem('mfa_verified_user');
    if (inactivityTimeout) clearTimeout(inactivityTimeout);
    showLoginScreen();
}

function getCurrentUserName() {
    return currentUser || 'Unknown';
}

// ===== SETUP MODE =====
// Uses sessionStorage so it auto-resets on browser close and logout
let setupMode = sessionStorage.getItem('snt_setupMode') === 'true';

function toggleSetupMode() {
    if (currentUserRole !== 'admin') return;
    setupMode = !setupMode;
    sessionStorage.setItem('snt_setupMode', setupMode);
    renderSetupModeIndicator();
    refreshCurrentView();
}

function renderSetupModeIndicator() {
    const el = document.getElementById('setup-mode-toggle');
    if (el) {
        // Only admins can see setup mode
        el.style.display = currentUserRole === 'admin' ? '' : 'none';
        el.classList.toggle('active', setupMode);
        el.querySelector('.setup-mode-label').textContent = setupMode ? 'Setup Mode ON' : 'Setup Mode';
    }
}

// ===== STATE =====
let currentCommunity = null;
let currentSensor = null;
let currentContact = null;

// ===== OPEN TABS =====
let openTabs = []; // { id, type, label, icon }
let activeTabId = null;

function getTabId(type, itemId) {
    return type + ':' + itemId;
}

function openTab(type, itemId, label) {
    const tabId = getTabId(type, itemId);
    const icons = { community: '\u25CF', sensor: '\u25A0', contact: '\u263B' };
    const existing = openTabs.find(t => t.id === tabId);
    if (!existing) {
        // Insert next to the currently active tab
        const activeIdx = openTabs.findIndex(t => t.id === activeTabId);
        const insertAt = activeIdx >= 0 ? activeIdx + 1 : openTabs.length;
        openTabs.splice(insertAt, 0, { id: tabId, type, itemId, label, icon: icons[type] || '' });
    }
    activeTabId = tabId;
    renderOpenTabs();
}

function closeTab(tabId, event) {
    if (event) event.stopPropagation();
    const idx = openTabs.findIndex(t => t.id === tabId);
    if (idx < 0) return;
    openTabs.splice(idx, 1);

    if (activeTabId === tabId) {
        // Switch to nearest tab, or go to dashboard if none left
        if (openTabs.length > 0) {
            const newIdx = Math.min(idx, openTabs.length - 1);
            switchToTab(openTabs[newIdx].id);
        } else {
            activeTabId = null;
            showView('dashboard');
        }
    }
    renderOpenTabs();
}

function switchToTab(tabId) {
    const tab = openTabs.find(t => t.id === tabId);
    if (!tab) return;
    activeTabId = tabId;
    renderOpenTabs();

    // Re-render the view without creating a new tab
    if (tab.type === 'community') showCommunityView(tab.itemId);
    else if (tab.type === 'sensor') showSensorView(tab.itemId);
    else if (tab.type === 'contact') showContactView(tab.itemId);
}

function renderOpenTabs() {
    const bar = document.getElementById('open-tabs-bar');
    if (openTabs.length === 0) {
        bar.classList.remove('visible');
        bar.innerHTML = '';
        return;
    }
    bar.classList.add('visible');

    // Group: collect child community tabs that have a parent tab open
    const parentTabIds = new Set();
    const childToParent = {};
    openTabs.forEach(tab => {
        if (tab.type === 'community') {
            const parentId = communityParents[tab.itemId];
            if (parentId) {
                const parentTabId = getTabId('community', parentId);
                if (openTabs.find(t => t.id === parentTabId)) {
                    childToParent[tab.id] = parentTabId;
                    parentTabIds.add(parentTabId);
                }
            }
        }
    });

    // Render tabs, grouping children below their parent
    const rendered = new Set();
    let html = '';

    openTabs.forEach(tab => {
        if (rendered.has(tab.id)) return;
        rendered.add(tab.id);

        const isActive = tab.id === activeTabId;
        const isParent = parentTabIds.has(tab.id);

        if (isParent) {
            // Collect children for this parent
            let childrenHtml = '';
            openTabs.forEach(childTab => {
                if (childToParent[childTab.id] === tab.id && !rendered.has(childTab.id)) {
                    rendered.add(childTab.id);
                    const childActive = childTab.id === activeTabId;
                    childrenHtml += `<div class="open-tab-child ${childActive ? 'active' : ''}" onclick="switchToTab('${childTab.id}')" title="${escapeHtml(childTab.label)}">
                        <span class="open-tab-label">${escapeHtml(childTab.label)}</span>
                        <span class="open-tab-close" onclick="closeTab('${childTab.id}', event)">&times;</span>
                    </div>`;
                }
            });

            html += `<div class="open-tab-group">
                <div class="open-tab ${isActive ? 'active' : ''}" onclick="switchToTab('${tab.id}')" title="${escapeHtml(tab.label)}">
                    <span class="open-tab-icon">${tab.icon}</span>
                    <span class="open-tab-label">${escapeHtml(tab.label)}</span>
                    <span class="open-tab-close" onclick="closeTab('${tab.id}', event)">&times;</span>
                </div>
                <div class="open-tab-children">${childrenHtml}</div>
            </div>`;
        } else {
            html += `<div class="open-tab ${isActive ? 'active' : ''}" onclick="switchToTab('${tab.id}')" title="${escapeHtml(tab.label)}">
                <span class="open-tab-icon">${tab.icon}</span>
                <span class="open-tab-label">${escapeHtml(tab.label)}</span>
                <span class="open-tab-close" onclick="closeTab('${tab.id}', event)">&times;</span>
            </div>`;
        }
    });

    bar.innerHTML = html;
}

function clearTabHighlight() {
    // When navigating to a list view, deactivate tab highlight but keep tabs
    activeTabId = null;
    renderOpenTabs();
}

// ===== SIDEBAR =====
function getAllTags() {
    // Combine AVAILABLE_TAGS with any tags assigned to communities
    const allAssigned = Object.values(communityTags).flat();
    return [...new Set([...AVAILABLE_TAGS, ...allAssigned])].sort((a, b) => a.localeCompare(b));
}

// Display names for tags (sidebar & filter bubbles) — tag value stays unchanged
const TAG_DISPLAY_NAMES = {
    'Regulatory Site': 'Regulatory Sites',
};

function getTagDisplayName(tag) {
    return TAG_DISPLAY_NAMES[tag] || tag;
}

function buildSidebar() {
    const list = document.getElementById('community-list');
    const tags = getAllTags();
    list.innerHTML = tags.map(tag =>
        `<li><a href="#" data-tag="${tag}" onclick="event.preventDefault(); filterCommunitiesByTag('${tag.replace(/'/g, "\\'")}')">${getTagDisplayName(tag)}</a></li>`
    ).join('');
}

// Arrow toggles the dropdown, clicking the label navigates to communities view
document.querySelector('.community-menu-item').addEventListener('click', (e) => {
    e.preventDefault();
    // If the click was on the arrow, toggle dropdown only
    if (e.target.classList.contains('community-toggle-arrow')) {
        const list = document.getElementById('community-list');
        const arrow = e.target;
        list.classList.toggle('open');
        arrow.classList.toggle('open');
        return;
    }
    // Otherwise navigate to communities view
    showView('communities');
});

document.querySelector('.sensor-menu-item').addEventListener('click', (e) => {
    e.preventDefault();
    if (e.target.classList.contains('sensor-toggle-arrow')) {
        const list = document.getElementById('sensor-tag-list');
        const arrow = e.target;
        list.classList.toggle('open');
        arrow.classList.toggle('open');
        return;
    }
    sensorTagFilter = '';
    showView('all-sensors');
});

document.querySelectorAll('.menu-item[data-view]').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const view = item.dataset.view;
        if (view === 'dashboard') showView('dashboard');
        if (view === 'all-sensors') return;
        if (view === 'contacts') showView('contacts');
        if (view === 'service') showView('service');
        if (view === 'communities') return; // handled by community-menu-item listener
    });
});

// ===== VIEW MANAGEMENT =====
function saveLastView(type, id) {
    saveData('lastView', { type, id });
}

function restoreLastView() {
    const last = loadData('lastView', null);
    if (!last) { showView('dashboard'); return; }

    if (last.type === 'community' && last.id) {
        const exists = COMMUNITIES.find(c => c.id === last.id);
        if (exists) { showCommunity(last.id); return; }
    } else if (last.type === 'sensor' && last.id) {
        const exists = sensors.find(s => s.id === last.id);
        if (exists) { showSensorDetail(last.id); return; }
    } else if (last.type === 'contact' && last.id) {
        const exists = contacts.find(c => c.id === last.id);
        if (exists) { showContactDetail(last.id); return; }
    } else if (last.type === 'view' && last.id) {
        showView(last.id);
        return;
    }
    showView('dashboard');
}

function showView(viewName) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + viewName).classList.add('active');
    pushViewHistory();

    document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
    const menuItem = document.querySelector(`.menu-item[data-view="${viewName}"]`);
    if (menuItem) menuItem.classList.add('active');

    document.querySelectorAll('.community-list a').forEach(a => a.classList.remove('active'));
    // Highlight active tag in sidebar if filtering
    if (viewName === 'communities' && communityTagFilter) {
        document.querySelectorAll('.community-list a[data-tag]').forEach(a => {
            if (a.dataset.tag === communityTagFilter) a.classList.add('active');
        });
    }

    // Deactivate tab highlight when navigating to list views
    clearTabHighlight();

    if (viewName === 'dashboard') renderDashboard();
    if (viewName === 'all-sensors') renderSensors();
    if (viewName === 'contacts') renderContacts();
    if (viewName === 'communities') renderCommunitiesList();
    if (viewName === 'settings') renderSettings();
    if (viewName === 'service') renderServiceView();
    if (viewName === 'audits') renderAuditsView();
    if (viewName === 'collocations') renderCollocationsView();
    if (viewName === 'quantaq-alerts' && typeof renderQuantAQAlertsView === 'function') renderQuantAQAlertsView();
    if (viewName === 'user-guide') renderUserGuide();

    saveLastView('view', viewName);
}

// ===== DASHBOARD =====
function renderDashboard() {
    const totalSensors = sensors.length;
    const onlineCount = sensors.filter(s => getStatusArray(s).includes('Online')).length;
    const issueCount = getIssueSensorCount();
    const communityCount = COMMUNITIES.filter(c => !isChildCommunity(c.id) && !isCommunityDeactivated(c.id)).length;
    const activeTickets = getActiveTicketCount();
    const activeAudits = audits.filter(a => a.status === 'Scheduled' || a.status === 'In Progress').length;

    // Last check time
    const lastCheckEl = document.getElementById('dashboard-last-check');
    if (lastCheckEl && typeof quantaqLastCheck !== 'undefined' && quantaqLastCheck) {
        lastCheckEl.textContent = 'Last QuantAQ check: ' + new Date(quantaqLastCheck).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: AK_TZ });
    } else if (lastCheckEl) {
        lastCheckEl.textContent = 'No QuantAQ check has been run yet';
    }

    // Compact stat bar
    document.getElementById('dashboard-summary').innerHTML = `
        <div class="dash-stat-bar">
            <div class="dash-stat-bar-item" onclick="showView('all-sensors')">
                <span class="dash-stat-bar-value">${totalSensors}</span>
                <span class="dash-stat-bar-label">Sensors</span>
            </div>
            <div class="dash-stat-bar-divider"></div>
            <div class="dash-stat-bar-item" onclick="sensorTagFilter=''; showView('all-sensors')">
                <span class="dash-stat-bar-value" style="color:#16a34a">${onlineCount}</span>
                <span class="dash-stat-bar-label">Online</span>
            </div>
            <div class="dash-stat-bar-divider"></div>
            <div class="dash-stat-bar-item" onclick="showView('communities')">
                <span class="dash-stat-bar-value">${communityCount}</span>
                <span class="dash-stat-bar-label">Communities</span>
            </div>
            <div class="dash-stat-bar-divider"></div>
            <div class="dash-stat-bar-item" onclick="showView('service')">
                <span class="dash-stat-bar-value">${activeTickets}</span>
                <span class="dash-stat-bar-label">Service Tickets</span>
            </div>
            <div class="dash-stat-bar-divider"></div>
            <div class="dash-stat-bar-item" onclick="showView('audits')">
                <span class="dash-stat-bar-value">${activeAudits}</span>
                <span class="dash-stat-bar-label">Active Audits</span>
            </div>
        </div>
    `;

    // Render QuantAQ alerts section
    if (typeof renderDashboardAlerts === 'function') renderDashboardAlerts();
}

// ===== COMMUNITIES LIST VIEW =====
let communityTagFilter = '';

function renderCommunityTagFilters() {
    const container = document.getElementById('community-tag-filters');
    if (!container) return;
    const tags = getAllTags();
    container.innerHTML = tags.map(tag => {
        const isActive = communityTagFilter === tag;
        return `<button class="community-tag-filter-btn ${isActive ? 'active' : ''}" onclick="filterCommunitiesByTag('${tag.replace(/'/g, "\\'")}')">${getTagDisplayName(tag)}</button>`;
    }).join('');
}

function renderCommunityCard(c) {
    const children = getChildCommunities(c.id);
    const hasChildren = children.length > 0;
    const isChild = isChildCommunity(c.id);
    const commSensors = sensors.filter(s => s.community === c.id).sort((a, b) => a.id.localeCompare(b.id));
    const tags = getCommunityTags(c.id);
    const tagsHtml = tags.map(t =>
        `<span class="community-type-badge clickable-badge" onclick="event.stopPropagation(); filterCommunitiesByTag('${t}')">${t}</span>`
    ).join(' ');

    if (hasChildren) {
        // Parent with children — show expandable row, no sensor list
        const childCount = children.length;
        const totalSensors = children.reduce((sum, ch) => sum + sensors.filter(s => s.community === ch.id).length, 0) + commSensors.length;
        const parentDeleteBtn = isCommunityDeactivated(c.id) ? `<button class="community-delete-btn" onclick="event.stopPropagation(); confirmDeleteCommunity('${c.id}')" title="Delete community">&#128465;</button>` : '';
        return `
            <div class="community-row parent-row" onclick="showCommunity('${c.id}')">
                <span class="parent-expand-arrow open" onclick="event.stopPropagation(); toggleChildList('${c.id}')">&#9654;</span>
                <div class="community-row-info">
                    <span class="community-row-name">${c.name}</span>
                    ${tagsHtml}
                    <span class="community-row-meta">${childCount} site${childCount !== 1 ? 's' : ''} &middot; ${totalSensors} sensor${totalSensors !== 1 ? 's' : ''}</span>
                </div>
                ${parentDeleteBtn}
            </div>
            <div class="child-list open" id="child-list-${c.id}">
                ${children.map(child => renderCommunityCard(child)).join('')}
            </div>
        `;
    }

    if (isChild) {
        // Child community — compact row
        const sensorListStr = commSensors.length > 0
            ? commSensors.map(s => s.id).join(', ')
            : 'No sensors';
        const childDeleteBtn = isCommunityDeactivated(c.id) ? `<button class="community-delete-btn" onclick="event.stopPropagation(); confirmDeleteCommunity('${c.id}')" title="Delete community">&#128465;</button>` : '';
        return `
            <div class="community-row child-row" onclick="showCommunity('${c.id}')">
                <div class="community-row-info">
                    <span class="community-row-name">${c.name}</span>
                    ${tagsHtml}
                </div>
                <div class="community-row-sensors">${sensorListStr}</div>
                ${childDeleteBtn}
            </div>
        `;
    }

    // Regular community (no parent, no children)
    const sensorListStr = commSensors.length > 0
        ? commSensors.map(s => s.id).join(', ')
        : 'No sensors';
    const deleteBtn = isCommunityDeactivated(c.id) ? `<button class="community-delete-btn" onclick="event.stopPropagation(); confirmDeleteCommunity('${c.id}')" title="Delete community">&#128465;</button>` : '';
    return `
        <div class="community-row" onclick="showCommunity('${c.id}')">
            <div class="community-row-info">
                <span class="community-row-name">${c.name}</span>
                ${tagsHtml}
            </div>
            <div class="community-row-sensors">${sensorListStr}</div>
            ${deleteBtn}
        </div>
    `;
}

function toggleChildList(parentId) {
    const el = document.getElementById('child-list-' + parentId);
    if (!el) return;
    const arrow = el.previousElementSibling?.querySelector('.parent-expand-arrow');
    el.classList.toggle('open');
    if (arrow) arrow.classList.toggle('open');
}

let communityListTab = 'active';

function switchCommunityTab(tab) {
    communityListTab = tab;
    document.getElementById('community-tab-active').classList.toggle('active', tab === 'active');
    document.getElementById('community-tab-inactive').classList.toggle('active', tab === 'inactive');
    renderCommunitiesList();
}

function renderCommunitiesList() {
    const search = (document.getElementById('community-search')?.value || '').toLowerCase();
    const isSearching = search.length > 0;

    // Update tab counts
    const allActive = COMMUNITIES.filter(c => !isCommunityDeactivated(c.id));
    const allInactive = COMMUNITIES.filter(c => isCommunityDeactivated(c.id));
    const activeCountEl = document.getElementById('community-active-count');
    const inactiveCountEl = document.getElementById('community-inactive-count');
    if (activeCountEl) activeCountEl.textContent = `(${allActive.length})`;
    if (inactiveCountEl) inactiveCountEl.textContent = `(${allInactive.length})`;

    let filtered = COMMUNITIES.filter(c => {
        if (search && !c.name.toLowerCase().includes(search)) return false;
        if (communityTagFilter && !getCommunityTags(c.id).includes(communityTagFilter)) return false;
        return true;
    });

    renderCommunityTagFilters();

    const container = document.getElementById('communities-list-container');

    if (isSearching) {
        // When searching, show results across both tabs
        container.innerHTML = filtered.map(c => {
            const card = renderCommunityCard(c);
            return isCommunityDeactivated(c.id) ? card.replace('class="community-row', 'class="community-row community-row-deactivated') : card;
        }).join('')
            || '<div class="empty-state">No communities found.</div>';
    } else {
        // Filter by active tab
        const showInactive = communityListTab === 'inactive';
        const tabFiltered = filtered.filter(c => showInactive ? isCommunityDeactivated(c.id) : !isCommunityDeactivated(c.id));

        // Only render top-level communities (parents + standalone); children rendered inside parents
        const topLevel = tabFiltered.filter(c => !isChildCommunity(c.id));

        let html = topLevel.map(c => {
            const card = renderCommunityCard(c);
            return showInactive ? card.replace('class="community-row', 'class="community-row community-row-deactivated') : card;
        }).join('');

        // Orphaned children whose parent didn't pass filter
        const childrenInFilter = tabFiltered.filter(c => isChildCommunity(c.id));
        childrenInFilter.forEach(child => {
            const parentInList = topLevel.find(p => p.id === communityParents[child.id]);
            if (!parentInList) {
                const card = renderCommunityCard(child);
                html += showInactive ? card.replace('class="community-row', 'class="community-row community-row-deactivated') : card;
            }
        });

        const emptyMsg = showInactive ? 'No inactive communities.' : 'No communities found.';
        container.innerHTML = html || `<div class="empty-state">${emptyMsg}</div>`;
    }
}

function filterCommunitiesByTag(tag) {
    communityTagFilter = communityTagFilter === tag ? '' : tag;
    showView('communities');
}

// ===== SENSORS =====
function getStatusBadgeClass(status) {
    const map = {
        'Online': 'badge-online',
        'Offline': 'badge-offline',
        'In Transit Between Audits': 'badge-transit',
        'Service at Quant': 'badge-service-quant',
        'Collocation': 'badge-collocation',
        'Auditing a Community': 'badge-auditing',
        'Lab Storage': 'badge-lab-storage',
        'Needs Repair': 'badge-needs-repair',
        'Ready for Deployment': 'badge-ready',
        'PM Sensor Issue': 'badge-issue-orange',
        'Gaseous Sensor Issue': 'badge-issue-orange',
        'SD Card Issue': 'badge-issue-yellow',
        'Lost Connection': 'badge-issue-red',
        'Quant Ticket in Progress': 'badge-service-quant',
    };
    if (map[status]) return map[status];
    if (status?.startsWith('Audit: ')) return 'badge-auditing';
    return 'badge-offline';
}

const SENSOR_TYPES = ['Community Pod', 'Permanent Pod', 'Audit Pod', 'Collocation/Health Check', 'Not Assigned'];

// Get status as array (handles old single-string data and new array data)
function getStatusArray(s) {
    if (Array.isArray(s.status)) return s.status;
    if (s.status) return [s.status];
    return [];
}

function renderStatusBadges(s, clickable) {
    let statuses = getStatusArray(s);

    // If there's an active service ticket, only show the service status matching the current ticket stage
    // (strip stale ones like "Shipped to Quant" when ticket has moved past that)
    const activeTickets = getActiveTicketsForSensor(s.id);
    if (activeTickets.length > 0) {
        const allServiceStatuses = ['Shipped to Quant', 'Service at Quant', 'Shipped from Quant'];
        const ticket = activeTickets[0];
        const sensorStatusMap = { 'Shipped to Quant': 'Shipped to Quant', 'At Quant': 'Service at Quant', 'Shipped from Quant': 'Shipped from Quant' };
        const currentServiceStatus = sensorStatusMap[ticket.status] || null;
        // Remove all service statuses that don't match the current ticket stage
        statuses = statuses.filter(st => !allServiceStatuses.includes(st) || st === currentServiceStatus);
    }

    if (statuses.length === 0) {
        if (clickable) return `<span class="editable-field" onclick="openStatusChangeModal('${s.id}')">No status set</span>`;
        return '—';
    }
    let html = statuses.map(st => {
        const cls = clickable ? 'badge-clickable' : '';
        if (st === 'Quant Ticket in Progress' && clickable) {
            const activeTicket = activeTickets[0];
            const ticketClick = activeTicket ? `onclick="openTicketDetail('${activeTicket.id}')"` : `onclick="openStatusChangeModal('${s.id}')"`;
            return `<span class="badge ${getStatusBadgeClass(st)} ${cls}" ${ticketClick}>${st}</span>`;
        }
        const onclick = clickable ? `onclick="openStatusChangeModal('${s.id}')"` : '';
        return `<span class="badge ${getStatusBadgeClass(st)} ${cls}" ${onclick}>${st}</span>`;
    }).join(' ');

    // Show active ticket stage as a badge only if it's not already represented in the sensor statuses
    if (activeTickets.length > 0) {
        const sensorStatusMap = { 'Shipped to Quant': 'Shipped to Quant', 'At Quant': 'Service at Quant', 'Shipped from Quant': 'Shipped from Quant' };
        activeTickets.forEach(ticket => {
            const ticketStatus = ticket.status;
            const mappedStatus = sensorStatusMap[ticketStatus];
            // Only show ticket badge if the ticket stage isn't already shown as a sensor status
            if (ticketStatus && ticketStatus !== 'Closed' && !mappedStatus && !statuses.includes(ticketStatus)) {
                const cls = clickable ? 'badge-clickable' : '';
                const onclick = clickable ? `onclick="openTicketDetail('${ticket.id}')"` : '';
                html += ` <span class="badge badge-ticket-status ${cls}" ${onclick} title="Service ticket: ${escapeHtml(ticketStatus)}">${escapeHtml(ticketStatus)}</span>`;
            }
        });
    }

    return html;
}

function getCommunityName(id) {
    return communityNameMap[id] || id || '—';
}

const ALL_SENSOR_COLUMNS = [
    { key: 'status', label: 'Status', sortable: true, removable: false },
    { key: 'community', label: 'Community', sortable: true, removable: false },
    { key: 'location', label: 'Location', sortable: true, removable: true },
    { key: 'dateInstalled', label: 'Install Date', sortable: true, removable: true },

    { key: 'soaTagId', label: 'SOA Tag ID', sortable: true, removable: true },
    { key: 'datePurchased', label: 'Purchase Date', sortable: true, removable: true },
];

let hiddenColumns = loadData('hiddenSensorColumns', []);
let columnOrder = loadData('sensorColumnOrder', null);

function buildColumnList() {
    // All possible columns: built-in + custom
    const builtIn = ALL_SENSOR_COLUMNS.map(c => ({ ...c, isCustom: false }));
    const custom = customSensorFields.map(cf => ({ key: 'custom_' + cf.key, label: cf.label, sortable: false, removable: true, isCustom: true, customKey: cf.key }));
    const all = [...builtIn, ...custom];

    // Apply saved order if exists
    if (columnOrder) {
        const ordered = [];
        columnOrder.forEach(key => {
            const col = all.find(c => c.key === key);
            if (col) ordered.push(col);
        });
        // Add any new columns not in saved order
        all.forEach(c => { if (!ordered.find(o => o.key === c.key)) ordered.push(c); });
        return ordered;
    }
    return all;
}

function getVisibleColumns() {
    return buildColumnList().filter(c => !hiddenColumns.includes(c.key));
}

function saveColumnOrder() {
    columnOrder = buildColumnList().map(c => c.key);
    saveData('sensorColumnOrder', columnOrder);
}

function renderSensorTableHeader() {
    const cols = getVisibleColumns();
    const colHeaders = cols.map((col, i) => {
        let controls = '';
        if (setupMode) {
            const arrows = `<span class="field-reorder-btns">${i > 0 ? `<span class="field-arrow" onclick="event.stopPropagation(); moveColumn(${i}, -1)" title="Move left">&#9664;</span>` : ''}${i < cols.length - 1 ? `<span class="field-arrow" onclick="event.stopPropagation(); moveColumn(${i}, 1)" title="Move right">&#9654;</span>` : ''}</span>`;
            const del = col.removable ? `<span class="delete-field-btn" onclick="event.stopPropagation(); hideOrDeleteColumn('${col.key}')" title="Remove column">&times;</span>` : '';
            controls = arrows + del;
        }
        const sortAttr = col.sortable ? `class="sortable-th" onclick="sortSensorsBy('${col.key.replace('custom_', '')}')"` : '';
        return `<th ${sortAttr}>${col.label}${controls}</th>`;
    }).join('');

    document.getElementById('sensors-table-header').innerHTML = `
        <th style="width:30px"><input type="checkbox" id="select-all-sensors" onchange="toggleAllSensorCheckboxes(this.checked)" aria-label="Select all sensors"></th>
        <th class="sortable-th" onclick="sortSensorsBy('id')">Sensor ID</th>
        ${colHeaders}
        <th>Actions${setupMode ? ` <button class="btn btn-sm" onclick="event.stopPropagation(); openAddFieldModal()" style="margin-left:4px;padding:2px 6px;font-size:10px">+ Field</button>${hiddenColumns.length > 0 ? ` <button class="btn btn-sm" onclick="event.stopPropagation(); restoreHiddenColumns()" style="padding:2px 6px;font-size:10px">Restore (${hiddenColumns.length})</button>` : ''}` : ''}</th>
    `;
}

function hideOrDeleteColumn(key) {
    if (key.startsWith('custom_')) {
        const cfKey = key.replace('custom_', '');
        const cf = customSensorFields.find(f => f.key === cfKey);
        if (!cf) return;
        showConfirm('Delete Field', `Permanently delete "${cf.label}"? This removes the field and all its data from every sensor. This cannot be undone.`, () => {
            customSensorFields = customSensorFields.filter(f => f.key !== cfKey);
            saveData('customSensorFields', customSensorFields);
            sensors.forEach(s => { if (s.customFields) delete s.customFields[cfKey]; });
            saveCustomFieldData();
            renderSensorTableHeader();
            renderSensors();
            if (currentSensor) showSensorView(currentSensor);
        }, { danger: true });
    } else {
        const col = ALL_SENSOR_COLUMNS.find(c => c.key === key);
        showConfirm('Hide Column', `Hide "${col?.label || key}" column? You can restore it later in setup mode.`, () => {
            hiddenColumns.push(key);
            saveData('hiddenSensorColumns', hiddenColumns);
            renderSensorTableHeader();
            renderSensors();
            if (currentSensor) showSensorView(currentSensor);
        });
    }
}

function restoreHiddenColumns() {
    const names = hiddenColumns.map(key => ALL_SENSOR_COLUMNS.find(c => c.key === key)?.label || key).join(', ');
    showConfirm('Restore Columns', `Restore hidden columns: ${names}?`, () => {
        hiddenColumns = [];
        saveData('hiddenSensorColumns', hiddenColumns);
        renderSensorTableHeader();
        renderSensors();
    });
}

function moveColumn(currentIndex, direction) {
    const visible = getVisibleColumns();
    const col = visible[currentIndex];
    const targetIndex = currentIndex + direction;
    if (targetIndex < 0 || targetIndex >= visible.length) return;

    // Work with the full list (including hidden) to swap correctly
    const full = buildColumnList();
    const colIdx = full.findIndex(c => c.key === col.key);
    const targetCol = visible[targetIndex];
    const targetIdx = full.findIndex(c => c.key === targetCol.key);

    if (colIdx < 0 || targetIdx < 0) return;

    // Swap in full list
    [full[colIdx], full[targetIdx]] = [full[targetIdx], full[colIdx]];

    // Also swap in customSensorFields if both are custom (to persist)
    if (col.isCustom && targetCol.isCustom) {
        const ci = customSensorFields.findIndex(f => f.key === col.customKey);
        const ti = customSensorFields.findIndex(f => f.key === targetCol.customKey);
        if (ci >= 0 && ti >= 0) {
            [customSensorFields[ci], customSensorFields[ti]] = [customSensorFields[ti], customSensorFields[ci]];
            saveData('customSensorFields', customSensorFields);
        }
    }

    // Save the new order
    columnOrder = full.map(c => c.key);
    saveData('sensorColumnOrder', columnOrder);

    renderSensorTableHeader();
    renderSensors();
}

function renderSensorCell(s, col) {
    const key = col.isCustom ? col.customKey : col.key;
    const val = col.isCustom ? ((s.customFields || {})[key] || '') : (s[key] || '');

    if (setupMode) {
        if (key === 'status') {
            const cs = getStatusArray(s);
            return `<td><select class="inline-edit-select inline-edit-status" data-sensor="${s.id}" data-field="status" multiple onchange="inlineSaveSensor(this)">
                <option value="" ${cs.length === 0 ? 'selected' : ''}>— No Status —</option>
                ${ALL_STATUSES.map(st => `<option value="${st}" ${cs.includes(st) ? 'selected' : ''}>${st}</option>`).join('')}
            </select></td>`;
        }
        if (key === 'community') {
            return `<td><select class="inline-edit-select" data-sensor="${s.id}" data-field="community" onchange="inlineSaveSensor(this)">
                ${('<option value="">— None —</option>' + COMMUNITIES.map(c => `<option value="${c.id}" ${s.community === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join(''))}
            </select></td>`;
        }
        if (key === 'dateInstalled') return `<td><input class="inline-edit-input" type="date" data-sensor="${s.id}" data-field="dateInstalled" value="${val}" onblur="inlineSaveSensor(this)"></td>`;
        if (col.isCustom) return `<td><input class="inline-edit-input" value="${val}" placeholder="${col.label}" onblur="editCustomFieldInline('${s.id}','${key}',this.value)" onkeydown="if(event.key==='Enter')this.blur()"></td>`;
        if (key === 'datePurchased') return `<td><input class="inline-edit-input" type="date" data-sensor="${s.id}" data-field="${key}" value="${val}" onblur="inlineSaveSensor(this)"></td>`;
        return `<td><input class="inline-edit-input" data-sensor="${s.id}" data-field="${key}" value="${val}" placeholder="${col.label}" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>`;
    }

    if (key === 'status') return `<td>${renderStatusBadges(s, true)}</td>`;
    if (key === 'community') return `<td><span class="clickable" onclick="showCommunity('${s.community}')">${getCommunityName(s.community)}</span></td>`;
    return `<td>${val || '—'}</td>`;
}

function renderSensors() {
    const search = (document.getElementById('sensor-search')?.value || '').toLowerCase();
    const statusFilter = document.getElementById('sensor-status-filter')?.value || '';

    let filtered = sensors.filter(s => {
        if (search && !s.id.toLowerCase().includes(search) && !getCommunityName(s.community).toLowerCase().includes(search) && !(s.soaTagId || '').toLowerCase().includes(search)) return false;
        if (statusFilter && !getStatusArray(s).includes(statusFilter)) return false;
        if (sensorTagFilter) {
            if (sensorTagFilter === 'Issue Sensors') {
                if (!isIssueSensor(s)) return false;
            } else if (sensorTagFilter === 'Audit & Permanent Pods') {
                if (s.type !== 'Audit Pod' && s.type !== 'Permanent Pod') return false;
            } else {
                if (s.type !== sensorTagFilter) return false;
            }
        }
        return true;
    });

    // Sort
    const sf = sensorSortField;
    filtered.sort((a, b) => {
        let va, vb;
        if (sf === 'community') { va = getCommunityName(a.community); vb = getCommunityName(b.community); }
        else if (sf === 'status') { va = getStatusArray(a).join(', '); vb = getStatusArray(b).join(', '); }
        else { va = a[sf] || ''; vb = b[sf] || ''; }
        const cmp = String(va).localeCompare(String(vb));
        return sensorSortAsc ? cmp : -cmp;
    });

    const cols = getVisibleColumns();
    const totalCols = cols.length + 3; // checkbox + sensor ID + actions

    document.getElementById('sensors-tbody').innerHTML = filtered.map(s => {
        const checkbox = `<td><input type="checkbox" class="sensor-checkbox" data-sensor-id="${s.id}" onchange="toggleSensorCheckbox('${s.id}', this.checked)" ${selectedSensors.has(s.id) ? 'checked' : ''}></td>`;
        const idCell = setupMode
            ? `<td><span class="clickable" onclick="showSensorDetail('${s.id}')">${s.id}</span><br>
                <select class="inline-edit-select inline-edit-sm" data-sensor="${s.id}" data-field="type" onchange="inlineSaveSensor(this)">
                    ${SENSOR_TYPES.map(t => `<option value="${t}" ${s.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select></td>`
            : `<td><span class="clickable" onclick="showSensorDetail('${s.id}')">${s.id}</span><br><small style="color:var(--slate-400)">${s.type}</small></td>`;
        const dataCells = cols.map(col => renderSensorCell(s, col)).join('');
        const actions = setupMode
            ? `<td><button class="btn btn-sm" onclick="openMoveSensorModal('${s.id}')">Move</button></td>`
            : `<td><button class="btn btn-sm" onclick="openEditSensorModal('${s.id}')">Edit</button> <button class="btn btn-sm" onclick="openMoveSensorModal('${s.id}')">Move</button></td>`;
        return `<tr>${checkbox}${idCell}${dataCells}${actions}</tr>`;
    }).join('') || `<tr><td colspan="${totalCols}" class="empty-state">No sensors found.</td></tr>`;

    renderSensorTableHeader();
}

function inlineSaveSensor(el) {
    const sensorId = el.dataset.sensor;
    const field = el.dataset.field;
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;

    if (field === 'soaTagId') {
        const newVal = el.value.trim();
        if (newVal) {
            const dup = sensors.find(x => x.soaTagId === newVal && x.id !== sensorId);
            if (dup) {
                showAlert('Duplicate SOA Tag ID', `SOA Tag ID "${newVal}" is already assigned to ${dup.id}. Each sensor must have a unique SOA Tag ID.`);
                el.value = s.soaTagId || '';
                return;
            }
        }
        s.soaTagId = newVal;
    } else if (field === 'status') {
        s.status = Array.from(el.selectedOptions).map(o => o.value).filter(v => v !== '');
        buildSensorSidebar();
    } else {
        s[field] = el.value.trim();
    }
    persistSensor(s);
}

function inlineSaveContact(el) {
    const contactId = el.dataset.contact;
    const field = el.dataset.field;
    const c = contacts.find(x => x.id === contactId);
    if (!c) return;

    const newVal = el.value.trim();

    // Validate email
    if (field === 'email' && newVal && !newVal.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
        el.style.borderColor = 'var(--aurora-rose)';
        return;
    }
    el.style.borderColor = '';

    // Warn on duplicate contact name
    if (field === 'name' && newVal) {
        const nameDup = contacts.find(x => x.name.toLowerCase() === newVal.toLowerCase() && x.id !== contactId);
        if (nameDup) {
            showAlert('Duplicate Contact', `A contact named "${nameDup.name}" already exists (${getCommunityName(nameDup.community) || nameDup.org || 'no community'}). Are you sure this isn't the same person?`);
        }
    }

    // Track old value for phone/email logging
    const oldVal = c[field] || '';

    if (field === 'active') {
        c.active = el.value === 'true';
    } else if (field === 'emailList') {
        c.emailList = el.value === 'true';
    } else if (field === 'primaryContact') {
        c.primaryContact = el.value === 'true';
    } else {
        c[field] = newVal;
    }
    // Update tab label if name changed
    if (field === 'name') {
        const tab = openTabs.find(t => t.id === getTabId('contact', contactId));
        if (tab) tab.label = c.name;
        renderOpenTabs();
    }
    persistContact(c);

    // Auto-log active status changes (not in setup mode)
    if (!setupMode && field === 'active') {
        const action = c.active ? 'reactivated' : 'marked as inactive';
        createNote('Info Edit', `${c.name} ${action}.`, {
            sensors: [], communities: c.community ? [c.community] : [], contacts: [contactId],
        });
    }

    // Auto-log phone/email changes (not in setup mode)
    if (!setupMode && (field === 'email' || field === 'phone') && oldVal !== newVal) {
        const label = field === 'email' ? 'Email' : 'Phone';
        createNote('Info Edit', `${c.name} ${label.toLowerCase()} changed from "${oldVal || '(empty)'}" to "${newVal || '(empty)'}".`, {
            sensors: [], communities: c.community ? [c.community] : [], contacts: [contactId],
        });
    }
}

function openAddSensorModal() {
    document.getElementById('sensor-modal-title').textContent = 'Add New Sensor';
    document.getElementById('sensor-form').reset();
    document.getElementById('sensor-edit-id').value = '';
    populateGroupedCommunitySelect('sensor-community-input');
    renderStatusToggleList('sensor-status-input', []);
    openModal('modal-add-sensor');
}

function openEditSensorModal(sensorId) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;
    document.getElementById('sensor-modal-title').textContent = 'Edit Sensor';
    document.getElementById('sensor-edit-id').value = s.id;
    document.getElementById('sensor-id-input').value = s.id;
    document.getElementById('sensor-soa-input').value = s.soaTagId || '';
    document.getElementById('sensor-type-input').value = s.type;
    renderStatusToggleList('sensor-status-input', getStatusArray(s));
    populateGroupedCommunitySelect('sensor-community-input');
    document.getElementById('sensor-community-input').value = s.community;
    document.getElementById('sensor-location-input').value = s.location || '';
    document.getElementById('sensor-purchased-input').value = s.datePurchased || '';

    openModal('modal-add-sensor');
}

// Annotation queue for sequential change popups
let pendingAnnotations = [];
let currentAnnotationSensorId = null;

function saveSensor(e) {
    e.preventDefault();
    const editId = document.getElementById('sensor-edit-id').value;
    const data = {
        id: document.getElementById('sensor-id-input').value.trim(),
        soaTagId: document.getElementById('sensor-soa-input').value.trim(),
        type: document.getElementById('sensor-type-input').value,
        status: getSelectedStatuses('sensor-status-input'),
        community: document.getElementById('sensor-community-input').value,
        location: document.getElementById('sensor-location-input').value.trim(),
        datePurchased: document.getElementById('sensor-purchased-input').value,

    };

    // Validate SOA Tag ID uniqueness
    if (data.soaTagId) {
        const soaDup = sensors.find(s => s.soaTagId === data.soaTagId && s.id !== data.id);
        if (soaDup) {
            showAlert('Duplicate SOA Tag ID', `SOA Tag ID "${data.soaTagId}" is already assigned to ${soaDup.id}. Each sensor must have a unique SOA Tag ID.`);
            return;
        }
    }

    if (editId) {
        const oldSensor = sensors.find(s => s.id === editId);
        if (!oldSensor) return;

        // Detect changes
        const fieldLabels = {
            soaTagId: 'SOA Tag ID', type: 'Type', status: 'Status',
            community: 'Community', location: 'Location',
            datePurchased: 'Purchase Date'
        };

        const changes = [];
        for (const [field, label] of Object.entries(fieldLabels)) {
            const oldVal = oldSensor[field];
            const newVal = data[field];
            // Compare arrays (status) as strings
            const oldStr = Array.isArray(oldVal) ? oldVal.join(', ') : (oldVal || '');
            const newStr = Array.isArray(newVal) ? newVal.join(', ') : (newVal || '');
            if (oldStr !== newStr) {
                let oldDisplay, newDisplay;
                if (field === 'community') {
                    oldDisplay = getCommunityName(oldVal);
                    newDisplay = getCommunityName(newVal);
                } else {
                    oldDisplay = oldStr || '(empty)';
                    newDisplay = newStr || '(empty)';
                }
                changes.push({ field, label, oldVal: oldDisplay, newVal: newDisplay, sensorId: editId });
            }
        }

        // Apply the data — preserve customFields from the existing sensor
        const idx = sensors.findIndex(s => s.id === editId);
        if (idx >= 0) {
            data.customFields = sensors[idx].customFields || {};
            sensors[idx] = data;
        }
        trackRecent('sensors', data.id, 'edited');
        persistSensor(data);
        closeModal('modal-add-sensor'); showSuccessToast('Sensor saved');
        renderSensors();

        // If there are changes, queue annotation popups (skip in setup mode)
        if (changes.length > 0 && !setupMode) {
            currentAnnotationSensorId = editId;
            pendingAnnotations = changes.map(c => ({
                sensorId: c.sensorId,
                summary: c.field === 'community'
                    ? `Moved from ${c.oldVal} to ${c.newVal}`
                    : `${c.label} changed from "${c.oldVal}" to "${c.newVal}"`,
                field: c.field,
                oldVal: c.oldVal,
                newVal: c.newVal,
                label: c.label,
            }));
            showNextAnnotation();
        }
    } else {
        if (sensors.find(s => s.id === data.id)) {
            showAlert('Duplicate Sensor', 'A sensor with that ID already exists.');
            return;
        }
        sensors.push(data);
        persistSensor(data);
        closeModal('modal-add-sensor'); showSuccessToast('Sensor saved');
        renderSensors();
    }
}

function showNextAnnotation() {
    if (pendingAnnotations.length === 0) {
        currentAnnotationSensorId = null;
        if (currentSensor) showSensorView(currentSensor);
        return;
    }

    const next = pendingAnnotations[0];
    document.getElementById('edit-annotation-summary').innerHTML =
        `<strong>${next.sensorId}</strong>: ${next.summary}`;
    document.getElementById('edit-annotation-text').value = '';
    document.getElementById('edit-annotation-date').value = nowDatetime();
    openModal('modal-edit-annotation');
}

function buildAnnotationNote(annotation, additionalInfo, date) {
    const isMovement = annotation.field === 'community';
    const s = sensors.find(x => x.id === annotation.sensorId);

    let noteText;
    let noteType;
    let taggedCommunities;

    if (isMovement) {
        noteText = `${annotation.sensorId} removed from ${annotation.oldVal} and brought to ${annotation.newVal}.`;
        noteType = 'Movement';
        const oldId = COMMUNITIES.find(c => c.name === annotation.oldVal)?.id;
        const newId = COMMUNITIES.find(c => c.name === annotation.newVal)?.id;
        taggedCommunities = [oldId, newId].filter(Boolean);
    } else {
        noteText = `${annotation.sensorId} ${annotation.label.toLowerCase()} changed from "${annotation.oldVal}" to "${annotation.newVal}".`;
        noteType = 'Info Edit';
        taggedCommunities = s && s.community ? [s.community] : [];
    }

    return {
        id: generateId('n'),
        date: date || nowDatetime(),
        type: noteType,
        text: noteText,
        additionalInfo: additionalInfo || '',
        createdBy: getCurrentUserName(), createdById: currentUserId,
        createdAt: new Date().toISOString(),
        taggedSensors: [annotation.sensorId],
        taggedCommunities: taggedCommunities,
        taggedContacts: additionalInfo ? parseMentionedContacts(additionalInfo) : [],
    };
}

function saveEditAnnotation() {
    const additionalInfo = document.getElementById('edit-annotation-text').value.trim();
    completeAnnotation(additionalInfo);
}

function skipEditAnnotation() {
    completeAnnotation('');
}

function completeAnnotation(additionalInfo) {
    const annotation = pendingAnnotations.shift();
    const date = document.getElementById('edit-annotation-date').value || nowDatetime();
    const note = buildAnnotationNote(annotation, additionalInfo, date);
    notes.push(note);
    persistNote(note);
    closeModal('modal-edit-annotation');
    setTimeout(() => showNextAnnotation(), 150);
}

// ===== INLINE STATUS CHANGE =====
function openStatusChangeModal(sensorId) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;
    document.getElementById('status-change-sensor-id').value = s.id;
    document.getElementById('status-change-old').value = JSON.stringify(getStatusArray(s));
    document.getElementById('status-change-sensor-label').textContent = s.id;
    renderStatusToggleList('status-change-new', getStatusArray(s));
    document.getElementById('status-change-info').value = '';
    document.getElementById('status-change-date').value = nowDatetime();
    document.getElementById('status-change-date-group').style.display = setupMode ? 'none' : '';
    document.getElementById('status-change-notes-group').style.display = setupMode ? 'none' : '';
    openModal('modal-status-change');
}

function saveStatusChange(e) {
    e.preventDefault();
    const sensorId = document.getElementById('status-change-sensor-id').value;
    const oldStatuses = JSON.parse(document.getElementById('status-change-old').value);
    const newStatuses = getSelectedStatuses('status-change-new');
    const additionalInfo = document.getElementById('status-change-info').value.trim();
    const statusDate = document.getElementById('status-change-date').value || nowDatetime();

    const oldStr = oldStatuses.join(', ') || '(none)';
    const newStr = newStatuses.join(', ') || '(none)';

    if (oldStr === newStr) {
        closeModal('modal-status-change');
        return;
    }

    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;

    s.status = newStatuses;
    persistSensor(s);

    let noteText = `${sensorId} status changed from "${oldStr}" to "${newStr}".`;

    const mentionedContacts = parseMentionedContacts(additionalInfo);

    const structuredInfo = JSON.stringify({
        userNotes: additionalInfo || '',
        beforeStatus: oldStatuses,
        afterStatus: newStatuses,
        sensorId: sensorId,
    });

    const note = {
        id: generateId('n'),
        date: statusDate,
        type: 'Status Change',
        text: noteText,
        additionalInfo: structuredInfo,
        createdBy: getCurrentUserName(), createdById: currentUserId,
        createdAt: new Date().toISOString(),
        taggedSensors: [sensorId],
        taggedCommunities: s.community ? [s.community] : [],
        taggedContacts: mentionedContacts,
    };

    if (!setupMode) { notes.push(note); persistNote(note); }
    closeModal('modal-status-change');
    buildSensorSidebar();
    refreshCurrentView();
}

// ===== INSTALL DATE PROMPT =====
function promptInstallDateUpdate(sensorId, suggestedDate, reason) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;
    const currentDate = s.dateInstalled || 'not set';
    showConfirm('Update Install Date?',
        `${reason}<br><br><strong>${s.id}</strong> install date is currently: <strong>${currentDate}</strong><br><br>` +
        `Update install date to <strong>${suggestedDate}</strong>?<br><br>` +
        `<input type="date" id="install-date-prompt-input" value="${suggestedDate}" style="margin-top:4px;padding:6px 10px;border:1px solid var(--slate-200);border-radius:6px;font-size:14px;">`,
        () => {
            const dateInput = document.getElementById('install-date-prompt-input');
            const newDate = dateInput ? dateInput.value : suggestedDate;
            s.dateInstalled = newDate;
            persistSensor(s);
            if (currentSensor === sensorId) showSensorView(sensorId);
            showSuccessToast(`Install date updated to ${newDate}`);
        },
        { confirmText: 'Update', cancelText: 'Keep Current' }
    );
}

// ===== MOVE SENSOR =====
function confirmDeleteSensor(sensorId) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;

    const sensorNotes = notes.filter(n => n.taggedSensors && n.taggedSensors.includes(sensorId));
    let warning = `Are you sure you want to permanently delete sensor ${s.id}?`;
    if (sensorNotes.length > 0) warning += `\n\n${sensorNotes.length} note${sensorNotes.length > 1 ? 's' : ''} are tagged to this sensor.`;
    warning += '\n\nThis cannot be undone.';

    showConfirm('Delete Sensor', warning, () => {
        const idx = sensors.findIndex(x => x.id === sensorId);
        if (idx >= 0) sensors.splice(idx, 1);
        openTabs = openTabs.filter(t => t.id !== getTabId('sensor', sensorId));
        renderOpenTabs();
        showView('all-sensors');
        renderSensors();
        buildSensorSidebar();
        showSuccessToast(`Sensor ${s.id} deleted`);
        db.deleteSensor(sensorId).catch(err => console.error('Delete sensor DB error:', err));
    }, { danger: true });
}

function openMoveSensorModal(sensorId) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;
    document.getElementById('move-sensor-id').value = s.id;
    document.getElementById('move-sensor-label').textContent = s.id;
    document.getElementById('move-from-label').textContent = getCommunityName(s.community);
    document.getElementById('move-additional-info').value = '';
    document.getElementById('move-date').value = nowDatetime();
    populateGroupedCommunitySelect('move-to-community');
    // Hide date and notes fields in setup mode
    document.getElementById('move-date-group').style.display = setupMode ? 'none' : '';
    document.getElementById('move-notes-group').style.display = setupMode ? 'none' : '';
    // Status change option
    const statusGroup = document.getElementById('move-status-group');
    const statusCheckbox = document.getElementById('move-change-status');
    statusGroup.style.display = setupMode ? 'none' : '';
    statusCheckbox.checked = false;
    document.getElementById('move-status-list').style.display = 'none';
    renderStatusToggleList('move-status-list', getStatusArray(s));
    // Contact tagging
    document.querySelectorAll('#move-contacts-container .tag-chip').forEach(c => c.remove());
    setupTagChipInput('move-contacts-container', () => contacts, c => c.name);
    document.getElementById('move-contacts-group').style.display = setupMode ? 'none' : '';
    openModal('modal-move-sensor');
}

function moveSensor(e) {
    e.preventDefault();
    const sensorId = document.getElementById('move-sensor-id').value;
    const toCommunityId = document.getElementById('move-to-community').value;
    const additionalInfo = document.getElementById('move-additional-info').value.trim();
    const moveDate = document.getElementById('move-date').value || nowDatetime();

    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;

    const fromId = s.community;
    const fromName = getCommunityName(fromId);
    const toName = getCommunityName(toCommunityId);
    const beforeDateInstalled = s.dateInstalled || '';

    s.community = toCommunityId;

    // Apply optional status change
    let statusChangeText = '';
    if (document.getElementById('move-change-status').checked) {
        const newStatuses = getSelectedStatuses('move-status-list');
        if (newStatuses.length > 0) {
            const oldStatuses = getStatusArray(s);
            s.status = newStatuses;
            statusChangeText = `\n${sensorId} status changed from "${oldStatuses.join(', ') || '(none)'}" to "${newStatuses.join(', ')}".`;
        }
    }

    persistSensor(s);

    let noteText = `${sensorId} removed from ${fromName} and brought to ${toName}.${statusChangeText}`;

    const mentionedContacts = parseMentionedContacts(additionalInfo);
    // Get contacts tagged via chip input
    const chipContacts = getChipValues('move-contacts-container').map(name => {
        const c = contacts.find(x => x.name.toLowerCase() === name.toLowerCase());
        return c ? c.id : null;
    }).filter(Boolean);
    // Merge chip contacts with @mentioned contacts
    chipContacts.forEach(id => { if (!mentionedContacts.includes(id)) mentionedContacts.push(id); });
    const taggedCommunities = [fromId, toCommunityId].filter(Boolean);

    const structuredInfo = JSON.stringify({
        userNotes: additionalInfo || '',
        sensorId: sensorId,
        fromCommunity: fromId || '',
        toCommunity: toCommunityId,
        beforeDateInstalled: beforeDateInstalled,
    });

    const note = {
        id: generateId('n'),
        date: moveDate,
        type: 'Movement',
        text: noteText,
        additionalInfo: structuredInfo,
        createdBy: getCurrentUserName(), createdById: currentUserId,
        createdAt: new Date().toISOString(),
        taggedSensors: [sensorId],
        taggedCommunities: taggedCommunities,
        taggedContacts: mentionedContacts,
    };

    if (!setupMode) { notes.push(note); persistNote(note); }
    closeModal('modal-move-sensor');
    refreshCurrentView();

    // Prompt to update install date after move (skip lab locations)
    if (!setupMode) {
        const isLabLocation = toCommunityId.includes('lab') || toName.toLowerCase().includes('lab');
        if (!isLabLocation) {
            const suggestedDate = moveDate.split('T')[0] || nowDatetime().split('T')[0];
            promptInstallDateUpdate(sensorId, suggestedDate, `${s.id} was moved to ${toName}.`);
        }
    }
}

// ===== SENSOR DETAIL =====
function showSensorDetail(sensorId) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;
    trackRecent('sensors', sensorId, 'viewed');
    openTab('sensor', sensorId, s.id);
    showSensorView(sensorId);
    saveLastView('sensor', sensorId);
}

function showSensorView(sensorId) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;
    currentSensor = sensorId;

    document.getElementById('sensor-detail-title').textContent = s.id;
    if (setupMode) {
        const currentStatuses = getStatusArray(s);
        document.getElementById('sensor-info-card').innerHTML = `
            <div class="info-item"><label>Type</label>
                <select class="inline-edit-select" data-sensor="${s.id}" data-field="type" onchange="inlineSaveSensor(this); showSensorView('${s.id}')">
                    ${SENSOR_TYPES.map(t => `<option value="${t}" ${s.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </div>
            <div class="info-item"><label>Status</label>
                <div class="status-toggle-list" id="setup-sensor-status-${s.id}">
                    ${ALL_STATUSES.map(st => {
                        const isActive = currentStatuses.includes(st);
                        const badgeClass = getStatusBadgeClass(st);
                        return `<span class="status-toggle-option ${isActive ? 'active' : ''}" data-status="${st}" onclick="toggleStatusOption(this); saveSetupSensorStatus('${s.id}')">
                            <span class="badge ${badgeClass}" style="pointer-events:none">${st}</span>
                        </span>`;
                    }).join('')}
                </div>
            </div>
            <div class="info-item"><label>Community</label>
                <select class="inline-edit-select" data-sensor="${s.id}" data-field="community" onchange="inlineSaveSensor(this); showSensorView('${s.id}')">
                    ${'<option value="">— None —</option>' + [...COMMUNITIES].sort((a, b) => a.name.localeCompare(b.name)).map(c => `<option value="${c.id}" ${s.community === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
                </select>
            </div>
            <div class="info-item"><label>Location</label>
                <input class="inline-edit-input" data-sensor="${s.id}" data-field="location" value="${s.location || ''}" placeholder="Address or GPS coordinates" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Install Date</label>
                <input class="inline-edit-input" type="date" data-sensor="${s.id}" data-field="dateInstalled" value="${s.dateInstalled || ''}" onblur="inlineSaveSensor(this)">
            </div>

            <div class="info-item"><label>SOA Tag ID</label>
                <input class="inline-edit-input" data-sensor="${s.id}" data-field="soaTagId" value="${s.soaTagId || ''}" placeholder="SOA Tag" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Purchase Date</label>
                <input class="inline-edit-input" type="date" data-sensor="${s.id}" data-field="datePurchased" value="${s.datePurchased || ''}" onblur="inlineSaveSensor(this)">
            </div>
            <div class="info-item" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--slate-200)">
                <button class="btn btn-danger btn-sm" onclick="confirmDeleteSensor('${s.id}')">Delete Sensor</button>
            </div>
        `;
    } else {
        document.getElementById('sensor-info-card').innerHTML = `
            <div class="info-item"><label>Type</label><p class="editable-field" onclick="inlineEditSensorType('${s.id}')">${s.type}</p></div>
            <div class="info-item"><label>Status</label><p>${renderStatusBadges(s, true)}</p></div>
            <div class="info-item"><label>Community</label><p>${getCommunityName(s.community)} <a class="move-sensor-link" onclick="openMoveSensorModal('${s.id}')">Move &rarr;</a></p></div>
            <div class="info-item"><label>Location</label><p class="editable-field" onclick="inlineEditSensor('${s.id}', 'location')">${s.location || '<span class="field-placeholder">Address or GPS coordinates</span>'}</p></div>
            <div class="info-item"><label>Install Date</label><p>${s.dateInstalled || '—'}</p></div>

            <div class="info-item"><label>SOA Tag ID</label><p class="editable-field" onclick="inlineEditSensor('${s.id}', 'soaTagId')">${s.soaTagId || '—'}</p></div>
            <div class="info-item"><label>Purchase Date</label><p class="editable-field" onclick="inlineEditSensor('${s.id}', 'datePurchased')">${s.datePurchased || '—'}</p></div>
            ${customSensorFields.map(cf => `<div class="info-item"><label>${cf.label}</label><p class="editable-field" onclick="editCustomField('${s.id}', '${cf.key}')">${(s.customFields || {})[cf.key] || '—'}</p></div>`).join('')}
        `;
    }

    // Reset filter
    const filterEl = document.getElementById('sensor-history-filter');
    if (filterEl) filterEl.value = '';

    filterSensorHistory();

    // Service Tickets
    renderSensorTickets(sensorId);

    // Audits
    renderSensorAudits(sensorId);

    // Collocations
    renderSensorCollocations(sensorId);

    resetTabs(document.getElementById('view-sensor-detail'));

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-sensor-detail').classList.add('active');
    pushViewHistory();
}

function inlineEditSensor(sensorId, field) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;

    const labels = { soaTagId: 'SOA Tag ID', location: 'Location', datePurchased: 'Purchase Date' };
    const label = labels[field] || field;
    const oldVal = s[field] || '';
    const promptMsg = field === 'location' ? `Edit ${label} (enter an address or GPS coordinates):` : `Edit ${label}:`;
    const newVal = prompt(promptMsg, oldVal);
    if (newVal === null || newVal.trim() === oldVal) return;

    // Validate SOA Tag ID uniqueness
    if (field === 'soaTagId' && newVal.trim()) {
        const soaDup = sensors.find(x => x.soaTagId === newVal.trim() && x.id !== sensorId);
        if (soaDup) {
            showAlert('Duplicate SOA Tag ID', `SOA Tag ID "${newVal.trim()}" is already assigned to ${soaDup.id}. Each sensor must have a unique SOA Tag ID.`);
            return;
        }
    }

    s[field] = newVal.trim();
    persistSensor(s);
    showSensorView(sensorId);

    // Queue annotation for this change (skip in setup mode)
    if (!setupMode) {
        currentAnnotationSensorId = sensorId;
        pendingAnnotations = [{
            sensorId: sensorId,
            summary: `${label} changed from "${oldVal || '(empty)'}" to "${newVal.trim()}"`,
            field: field,
            oldVal: oldVal || '(empty)',
            newVal: newVal.trim(),
            label: label,
        }];
        showNextAnnotation();
    }
}

let typeChangeSensorId = null;

function inlineEditSensorType(sensorId) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;
    typeChangeSensorId = sensorId;

    document.getElementById('type-change-sensor-label').textContent = s.id;
    const list = document.getElementById('type-change-options');
    list.innerHTML = SENSOR_TYPES.map(t => {
        const isCurrent = s.type === t;
        return `<button class="type-option-btn ${isCurrent ? 'current' : ''}" onclick="selectSensorType('${t}')" ${isCurrent ? 'disabled' : ''}>
            <span class="type-option-name">${t}</span>
            ${isCurrent ? '<span class="type-option-current">Current</span>' : ''}
        </button>`;
    }).join('');

    openModal('modal-type-change');
}

function selectSensorType(newType) {
    const s = sensors.find(x => x.id === typeChangeSensorId);
    if (!s) return;

    const oldVal = s.type;
    if (newType === oldVal) return;

    s.type = newType;
    trackRecent('sensors', typeChangeSensorId, 'edited');
    persistSensor(s);
    closeModal('modal-type-change');
    showSensorView(typeChangeSensorId);

    // Queue annotation (skip in setup mode)
    if (!setupMode) {
        currentAnnotationSensorId = typeChangeSensorId;
        pendingAnnotations = [{
            sensorId: typeChangeSensorId,
            summary: `Type changed from "${oldVal}" to "${newType}"`,
            field: 'type',
            oldVal: oldVal,
            newVal: newType,
            label: 'Type',
        }];
        showNextAnnotation();
    }
}

// ===== COMMUNITIES =====
function showCommunity(communityId) {
    const community = COMMUNITIES.find(c => c.id === communityId);
    if (!community) return;
    trackRecent('communities', communityId, 'viewed');
    openTab('community', communityId, community.name);
    showCommunityView(communityId);
    saveLastView('community', communityId);
}

function showCommunityView(communityId) {
    const community = COMMUNITIES.find(c => c.id === communityId);
    if (!community) return;
    currentCommunity = communityId;

    // Build header with parent breadcrumb
    const parent = getParentCommunity(communityId);
    const parentHtml = parent
        ? `<span class="community-parent-breadcrumb"><span class="clickable" onclick="showCommunity('${parent.id}')">${escapeHtml(parent.name)}</span> &rsaquo; </span>`
        : '';
    document.getElementById('community-name').innerHTML = parentHtml + escapeHtml(community.name);

    const tags = getCommunityTags(communityId);
    const badgeContainer = document.getElementById('community-type-badge');
    badgeContainer.innerHTML = tags.map(t =>
        `<span class="community-type-badge clickable-badge" onclick="filterCommunitiesByTag('${t}')">${t}</span>`
    ).join(' ') +
    ` <span class="community-tag-edit" onclick="openEditCommunityTags('${communityId}')">+ Edit Tags</span>`;

    // Show/hide toolbar buttons
    const isDeactivated = isCommunityDeactivated(communityId);
    const isChild = isChildCommunity(communityId);
    document.getElementById('add-sub-community-btn').style.display = isChild || isDeactivated ? 'none' : '';
    document.getElementById('change-parent-btn').style.display = isDeactivated ? 'none' : '';
    document.getElementById('deactivate-community-btn').style.display = isDeactivated ? 'none' : '';
    document.getElementById('reactivate-community-btn').style.display = isDeactivated ? '' : 'none';
    updatePinButton(communityId);

    document.querySelectorAll('.community-list a').forEach(a => a.classList.remove('active'));

    // Sensors — grouped by sub-community as cards
    const children = getChildCommunities(communityId);
    const commSensors = sensors.filter(s => s.community === communityId).sort((a, b) => a.id.localeCompare(b.id));
    const sensorsSection = document.getElementById('community-sensors-section');

    const sensorTableHead = `<thead><tr>
        <th>Sensor ID</th><th>Status</th>
        <th>Location</th><th>Install Date</th><th>SOA Tag ID</th><th>Purchase Date</th><th>Actions</th>
    </tr></thead>`;

    function renderSensorRows(list) {
        if (setupMode) {
            return list.map(s => {
                const currentStatuses = getStatusArray(s);
                return `<tr>
                    <td>
                        <span class="clickable" onclick="showSensorDetail('${s.id}')">${s.id}</span><br>
                        <select class="inline-edit-select inline-edit-sm" data-sensor="${s.id}" data-field="type" onchange="inlineSaveSensor(this); showCommunityView('${communityId}')">
                            ${SENSOR_TYPES.map(t => `<option value="${t}" ${s.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                        </select>
                    </td>
                    <td><select class="inline-edit-select inline-edit-status" data-sensor="${s.id}" data-field="status" multiple onchange="inlineSaveSensor(this)">
                        <option value="" ${currentStatuses.length === 0 ? 'selected' : ''}>— No Status —</option>
                        ${ALL_STATUSES.map(st => `<option value="${st}" ${currentStatuses.includes(st) ? 'selected' : ''}>${st}</option>`).join('')}
                    </select></td>
                    <td><input class="inline-edit-input" data-sensor="${s.id}" data-field="location" value="${s.location || ''}" placeholder="Address or GPS" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                    <td><input class="inline-edit-input" type="date" data-sensor="${s.id}" data-field="dateInstalled" value="${s.dateInstalled || ''}" onblur="inlineSaveSensor(this)"></td>

                    <td><input class="inline-edit-input" data-sensor="${s.id}" data-field="soaTagId" value="${s.soaTagId || ''}" placeholder="SOA Tag" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                    <td><input class="inline-edit-input" type="date" data-sensor="${s.id}" data-field="datePurchased" value="${s.datePurchased || ''}" onblur="inlineSaveSensor(this)"></td>
                    <td><button class="btn btn-sm" onclick="openMoveSensorModal('${s.id}')">Move</button></td>
                </tr>`;
            }).join('');
        }
        return list.map(s => `<tr>
            <td><span class="clickable" onclick="showSensorDetail('${s.id}')">${s.id}</span><br><small style="color:var(--slate-400)">${s.type}</small></td>
            <td>${renderStatusBadges(s, true)}</td>
            <td>${s.location || '—'}</td>
            <td>${s.dateInstalled || '—'}</td>

            <td>${s.soaTagId || '—'}</td>
            <td>${s.datePurchased || '—'}</td>
            <td>
                <button class="btn btn-sm" onclick="openEditSensorModal('${s.id}')">Edit</button>
                <button class="btn btn-sm" onclick="openMoveSensorModal('${s.id}')">Move</button>
            </td>
        </tr>`).join('');
    }

    if (children.length > 0) {
        let html = '';

        // Parent's own direct sensors (if any)
        if (commSensors.length > 0) {
            html += `<div class="site-group">
                <div class="site-group-title">${community.name} (unassigned)</div>
                <div class="table-container site-group-table"><table>${sensorTableHead}<tbody>
                    ${renderSensorRows(commSensors)}
                </tbody></table></div>
            </div>`;
        }

        children.forEach(child => {
            const childSensors = sensors.filter(s => s.community === child.id).sort((a, b) => a.id.localeCompare(b.id));
            html += `<div class="site-group">
                <div class="site-group-title">
                    <span class="clickable" onclick="showCommunity('${child.id}')">${child.name}</span>
                    <span class="site-group-count">${childSensors.length} sensor${childSensors.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="table-container site-group-table"><table>${sensorTableHead}<tbody>
                    ${renderSensorRows(childSensors) || '<tr><td colspan="8" class="empty-state">No sensors at this site.</td></tr>'}
                </tbody></table></div>
            </div>`;
        });

        sensorsSection.innerHTML = html;
    } else {
        sensorsSection.innerHTML = `<div class="table-container"><table>${sensorTableHead}<tbody>
            ${renderSensorRows(commSensors) || '<tr><td colspan="8" class="empty-state">No sensors in this community.</td></tr>'}
        </tbody></table></div>`;
    }

    // Contacts
    const commContacts = contacts.filter(c => c.community === communityId).sort((a, b) => {
        const aP = a.primaryContact ? 0 : 1, bP = b.primaryContact ? 0 : 1;
        if (aP !== bP) return aP - bP;
        const aI = a.active === false ? 1 : 0, bI = b.active === false ? 1 : 0;
        if (aI !== bI) return aI - bI;
        return a.name.localeCompare(b.name);
    });
    document.getElementById('community-contacts-list').innerHTML = commContacts.length ? `
        <div class="table-container"><table class="contacts-table"><thead><tr>
            <th class="col-name">Name</th><th class="col-role">Role</th><th class="col-org">Organization</th><th class="col-email">Email</th><th class="col-phone">Phone</th><th class="col-status">Status</th><th class="col-actions"></th>
        </tr></thead><tbody>
        ${commContacts.map(c => renderContactRow(c)).join('')}
        </tbody></table></div>
    ` : '<div class="empty-state">No contacts for this community.</div>';

    // History — include notes tagged to this community, its children, or sensors in this community
    const childIds = children.map(c => c.id);
    const allCommunityIds = [communityId, ...childIds];
    const sensorIdsInCommunity = sensors.filter(s => allCommunityIds.includes(s.community)).map(s => s.id);
    const contactIdsInCommunity = contacts.filter(c => allCommunityIds.includes(c.community)).map(c => c.id);

    const commNotes = notes.filter(n => {
        return n.taggedCommunities && n.taggedCommunities.some(id => allCommunityIds.includes(id));
    });
    renderTimeline('community-history-timeline', commNotes);

    // Comms
    const commComms = comms.filter(c => allCommunityIds.includes(c.community) || (c.taggedCommunities && c.taggedCommunities.some(id => allCommunityIds.includes(id))));
    renderTimeline('community-comms-timeline', commComms.map(c => ({
        ...c,
        type: c.commType || c.type,
    })));

    // Files
    renderCommunityFiles(communityId);

    // Audits
    renderCommunityAudits(communityId);

    // Overview dashboard
    renderCommunityOverview(communityId);

    resetTabs(document.getElementById('view-community'));

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-community').classList.add('active');
    pushViewHistory();
}

// ===== FILES =====
async function handleFileUpload(event) {
    const files = event.target.files;
    if (!files.length || !currentCommunity) return;

    if (!communityFiles[currentCommunity]) communityFiles[currentCommunity] = [];

    for (const file of files) {
        try {
            const result = await db.uploadFile(currentCommunity, file, currentUserId);
            communityFiles[currentCommunity].push({
                id: result.id,
                name: result.file_name,
                type: result.file_type,
                storagePath: result.storage_path,
                date: result.created_at,
            });
            renderCommunityFiles(currentCommunity);
        } catch (err) {
            console.error('Upload error:', err);
            showAlert('Error', 'File upload failed: ' + err.message);
        }
    }

    event.target.value = '';
}

function renderCommunityFiles(communityId) {
    const files = communityFiles[communityId] || [];
    const grid = document.getElementById('community-files-grid');

    if (!files.length) {
        grid.innerHTML = '<div class="empty-state">No files uploaded yet.</div>';
        return;
    }

    grid.innerHTML = files.map((f, idx) => {
        const fileUrl = f.storagePath ? '' : (f.data || ''); // fallback for old base64 data
        const viewOnclick = f.storagePath
            ? `onclick="openStorageFile('${f.storagePath}')"`
            : `onclick="openImageLightbox('${fileUrl}')"`;
        const downloadHref = f.storagePath ? '#' : fileUrl;
        const downloadOnclick = f.storagePath
            ? `onclick="event.preventDefault(); downloadStorageFile('${f.storagePath}', '${(f.name || '').replace(/'/g, "\\'")}')"`
            : '';

        if (f.type && f.type.startsWith('image/')) {
            const imgSrc = f.storagePath ? '' : fileUrl;
            return `
                <div class="file-card file-card-with-thumb">
                    <div class="file-thumb" ${viewOnclick}>
                        <img id="community-file-thumb-${communityId}-${idx}" src="${imgSrc}" alt="${escapeHtml(f.name)}">
                    </div>
                    <div class="file-info">
                        <div>
                            <div class="file-name">${escapeHtml(f.name)}</div>
                            <div class="file-date">${formatDate(f.date)}</div>
                        </div>
                        <button class="btn btn-sm btn-danger" onclick="deleteFile('${communityId}', '${f.id}', '${f.storagePath || ''}')">Delete</button>
                    </div>
                </div>
            `;
        } else {
            return `
                <div class="file-card">
                    <div class="file-card-pdf">
                        <div class="pdf-icon">&#128196;</div>
                        <div class="pdf-label">${escapeHtml(f.name)}</div>
                    </div>
                    <div class="file-info">
                        <div>
                            <div class="file-name">${escapeHtml(f.name)}</div>
                            <div class="file-date">${formatDate(f.date)}</div>
                        </div>
                        <div>
                            <a class="btn btn-sm" href="${downloadHref}" ${downloadOnclick} download="${escapeHtml(f.name)}">Download</a>
                            <button class="btn btn-sm btn-danger" onclick="deleteFile('${communityId}', '${f.id}', '${f.storagePath || ''}')">Delete</button>
                        </div>
                    </div>
                </div>
            `;
        }
    }).join('');

    // Load signed URLs for image thumbnails asynchronously
    if (files.some(f => f.type && f.type.startsWith('image/') && f.storagePath)) {
        setTimeout(() => loadCommunityFileThumbs(communityId, files), 0);
    }
}

async function loadCommunityFileThumbs(communityId, files) {
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.type && f.type.startsWith('image/') && f.storagePath) {
            try {
                const url = await db.getSignedUrl(f.storagePath);
                const img = document.getElementById(`community-file-thumb-${communityId}-${i}`);
                if (img) img.src = url;
            } catch(e) { /* file may not exist */ }
        }
    }
}

async function openStorageFile(storagePath) {
    try {
        const url = await db.getSignedUrl(storagePath);
        openImageLightbox(url);
    } catch (err) {
        console.error('Error opening file:', err);
        showAlert('Error', 'Could not open file: ' + err.message);
    }
}

function openImageLightbox(src) {
    // Remove any existing lightbox
    document.getElementById('image-lightbox')?.remove();

    const lb = document.createElement('div');
    lb.id = 'image-lightbox';
    lb.className = 'image-lightbox';
    lb.innerHTML = `
        <div class="image-lightbox-backdrop" onclick="closeLightbox()"></div>
        <div class="image-lightbox-content">
            <button class="image-lightbox-close" onclick="closeLightbox()">&times;</button>
            <img src="${src}" alt="Full size image">
        </div>
    `;
    document.body.appendChild(lb);

    // Escape to close
    lb._escHandler = (e) => { if (e.key === 'Escape') closeLightbox(); };
    document.addEventListener('keydown', lb._escHandler);
}

function closeLightbox() {
    const lb = document.getElementById('image-lightbox');
    if (!lb) return;
    document.removeEventListener('keydown', lb._escHandler);
    lb.remove();
}

async function downloadStorageFile(storagePath, fileName) {
    try {
        const url = await db.getSignedUrl(storagePath);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
    } catch (err) {
        console.error('Download error:', err);
        showAlert('Error', 'Could not download file: ' + err.message);
    }
}

async function deleteFile(communityId, fileId, storagePath) {
    showConfirm('Delete File', 'Delete this file? This cannot be undone.', async () => {
        try {
            await db.deleteFile(fileId, storagePath);
            communityFiles[communityId] = (communityFiles[communityId] || []).filter(f => f.id !== fileId);
            renderCommunityFiles(communityId);
        } catch (err) {
            console.error('Delete error:', err);
            showAlert('Error', 'Delete failed: ' + err.message);
        }
    }, { danger: true });
}

// ===== CONTACTS =====

function renderContactRow(c) {
    const primaryBadge = c.primaryContact ? '<span class="contact-primary-badge">Primary</span>' : '';
    if (setupMode) {
        return `<tr>
            <td class="col-name"><input class="inline-edit-input" data-contact="${c.id}" data-field="name" value="${escapeHtml(c.name)}" onblur="inlineSaveContact(this); renderContacts()" onkeydown="if(event.key==='Enter')this.blur()"><label class="primary-toggle" title="${c.primaryContact ? 'Primary contact — click to remove' : 'Click to mark as primary contact'}"><input type="checkbox" ${c.primaryContact ? 'checked' : ''} onchange="togglePrimaryContact('${c.id}'); renderContacts()"><span class="primary-toggle-label">${c.primaryContact ? 'Primary' : 'Primary?'}</span></label></td>
            <td class="col-role"><input class="inline-edit-input" data-contact="${c.id}" data-field="role" value="${escapeHtml(c.role || '')}" placeholder="Role" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
            <td class="col-org"><input class="inline-edit-input" data-contact="${c.id}" data-field="org" value="${escapeHtml(c.org || '')}" placeholder="Organization" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
            <td class="col-email"><input class="inline-edit-input" type="email" data-contact="${c.id}" data-field="email" value="${escapeHtml(c.email || '')}" placeholder="Email" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
            <td class="col-phone"><input class="inline-edit-input" type="tel" data-contact="${c.id}" data-field="phone" value="${escapeHtml(c.phone || '')}" placeholder="Phone" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
            <td class="col-status"><select class="inline-edit-select" data-contact="${c.id}" data-field="active" onchange="inlineSaveContact(this)">
                <option value="true" ${c.active !== false ? 'selected' : ''}>Active</option>
                <option value="false" ${c.active === false ? 'selected' : ''}>Inactive</option>
            </select></td>
            <td class="col-actions"><button class="contact-delete-btn" style="opacity:1" onclick="event.stopPropagation(); confirmDeleteContact('${c.id}')" title="Delete contact">&#128465;</button></td>
        </tr>`;
    }
    return `<tr class="${c.active === false ? 'contact-row-inactive' : ''}" onclick="showContactDetail('${c.id}')" style="cursor:pointer">
        <td class="col-name"><span class="clickable">${c.name}</span>${primaryBadge}</td>
        <td class="col-role" title="${escapeHtml(c.role || '')}">${c.role || '—'}</td>
        <td class="col-org" title="${escapeHtml(c.org || '')}">${c.org || '—'}</td>
        <td class="col-email"><span class="email-cell">${c.email ? `<a href="#" class="clickable" onclick="event.stopPropagation(); openQuickEmail('${c.id}')">${c.email}</a>` : '<span class="no-email">—</span>'}<label class="email-list-toggle" onclick="event.stopPropagation()" title="${c.emailList ? 'On Mass Email List — click to remove' : 'Not on Mass Email List — click to add'}"><input type="checkbox" class="email-list-checkbox" ${c.emailList ? 'checked' : ''} onchange="toggleContactEmailList('${c.id}')"><span class="email-list-label">Mass Email List</span></label></span></td>
        <td class="col-phone">${c.phone ? `<a href="tel:${c.phone}" class="clickable" onclick="event.stopPropagation()">${c.phone}</a>` : '—'}</td>
        <td class="col-status">${c.active === false ? '<span class="contact-inactive-badge">Inactive</span>' : '<span style="color:var(--aurora-green);font-size:11px;font-weight:600">Active</span>'}</td>
        <td class="col-actions"><button class="contact-delete-btn" onclick="event.stopPropagation(); confirmDeleteContact('${c.id}')" title="Delete contact">&#128465;</button></td>
    </tr>`;
}

let contactsListTab = 'active';

function switchContactsTab(tab) {
    contactsListTab = tab;
    document.getElementById('contacts-tab-active').classList.toggle('active', tab === 'active');
    document.getElementById('contacts-tab-noncomm').classList.toggle('active', tab === 'noncomm');
    document.getElementById('contacts-tab-inactive').classList.toggle('active', tab === 'inactive');
    renderContacts();
}

function isNonCommunityContact(c) {
    return !c.community || !COMMUNITIES.find(cm => cm.id === c.community);
}

function renderContacts() {
    const search = (document.getElementById('contact-search')?.value || '').toLowerCase();
    const isSearching = search.length > 0;

    // Update tab counts
    const nonCommContacts = contacts.filter(c => isNonCommunityContact(c));
    const activeCommunityContacts = contacts.filter(c => !isNonCommunityContact(c) && !isCommunityDeactivated(c.community));
    const inactiveCommunityContacts = contacts.filter(c => !isNonCommunityContact(c) && isCommunityDeactivated(c.community));
    const activeCountEl = document.getElementById('contacts-active-count');
    const inactiveCountEl = document.getElementById('contacts-inactive-count');
    const noncommCountEl = document.getElementById('contacts-noncomm-count');
    if (activeCountEl) activeCountEl.textContent = `(${activeCommunityContacts.length})`;
    if (inactiveCountEl) inactiveCountEl.textContent = `(${inactiveCommunityContacts.length})`;
    if (noncommCountEl) noncommCountEl.textContent = `(${nonCommContacts.length})`;

    let filtered = contacts.filter(c => {
        if (search && !c.name.toLowerCase().includes(search) && !getCommunityName(c.community).toLowerCase().includes(search) && !(c.org || '').toLowerCase().includes(search)) return false;
        // Filter by tab (skip when searching)
        if (!isSearching) {
            const isNonComm = isNonCommunityContact(c);
            if (contactsListTab === 'noncomm') return isNonComm;
            if (isNonComm) return false; // exclude non-community contacts from active/inactive tabs
            const showInactive = contactsListTab === 'inactive';
            const communityIsInactive = isCommunityDeactivated(c.community);
            if (showInactive !== communityIsInactive) return false;
        }
        return true;
    });

    // Group by community (or org for non-community), sorted alphabetically
    const groups = {};
    filtered.forEach(c => {
        const groupName = isNonCommunityContact(c) ? (c.org || 'Unassigned') : getCommunityName(c.community);
        if (!groups[groupName]) groups[groupName] = [];
        groups[groupName].push(c);
    });

    // Sort community names alphabetically
    const sortedCommunities = Object.keys(groups).sort();

    // Sort: primary first, then active alphabetically, then inactive alphabetically
    sortedCommunities.forEach(comm => {
        groups[comm].sort((a, b) => {
            const aP = a.primaryContact ? 0 : 1, bP = b.primaryContact ? 0 : 1;
            if (aP !== bP) return aP - bP;
            const aInactive = a.active === false ? 1 : 0;
            const bInactive = b.active === false ? 1 : 0;
            if (aInactive !== bInactive) return aInactive - bInactive;
            return a.name.localeCompare(b.name);
        });
    });

    const container = document.getElementById('contacts-grid');

    // Description for non-community tab
    const tabDesc = contactsListTab === 'noncomm' && !isSearching
        ? `<div class="contacts-tab-description">Contacts outside of the sensor community network — partner agencies, vendors, regional coordinators, and other key people worth keeping on file.</div>`
        : '';

    const emptyMessages = {
        active: 'No contacts found.',
        inactive: 'No contacts in inactive communities.',
        noncomm: 'No non-community contacts yet.',
    };

    const isNonCommTab = contactsListTab === 'noncomm' && !isSearching;

    container.innerHTML = tabDesc + (sortedCommunities.map(commName => {
        const commId = groups[commName][0]?.community || '';
        const commExists = commId && COMMUNITIES.find(cm => cm.id === commId);
        const headerContent = isNonCommTab && setupMode
            ? `<span class="editable-group-name" onclick="renameContactGroup('${escapeHtml(commName)}')" title="Click to rename">${commName} <span class="group-edit-icon">&#9998;</span></span>`
            : commExists
                ? `<a class="contacts-group-link" onclick="showCommunity('${commId}')">${commName}</a>`
                : commName;
        return `
        <div class="contacts-group">
            <div class="contacts-group-header">${headerContent}</div>
            <div class="table-container">
                <table class="contacts-table"><thead><tr>
                    <th class="col-name">Name</th><th class="col-role">Role</th><th class="col-org">Organization</th><th class="col-email">Email</th><th class="col-phone">Phone</th><th class="col-status">Status</th><th class="col-actions"></th>
                </tr></thead><tbody>
                ${groups[commName].map(c => renderContactRow(c)).join('')}
                </tbody></table>
            </div>
        </div>
    `}).join('') || `<div class="empty-state">${isSearching ? 'No contacts found.' : (emptyMessages[contactsListTab] || 'No contacts found.')}</div>`);
}

function renameContactGroup(oldName) {
    const newName = prompt('Rename group:', oldName);
    if (!newName || newName.trim() === oldName) return;
    const trimmed = newName.trim();
    // Update org field for all contacts in this group
    contacts.forEach(c => {
        if (isNonCommunityContact(c) && (c.org || 'Unassigned') === oldName) {
            c.org = trimmed === 'Unassigned' ? '' : trimmed;
            persistContact(c);
        }
    });
    renderContacts();
    showSuccessToast(`Group renamed to "${trimmed}"`);
}

function openAddContactModal() {
    document.getElementById('contact-modal-title').textContent = 'Add New Contact';
    document.getElementById('contact-form').reset();
    document.getElementById('contact-edit-id').value = '';
    document.getElementById('contact-active-yes').checked = true;
    document.getElementById('contact-email-list').checked = false;
    document.getElementById('contact-primary-contact').checked = false;
    document.getElementById('delete-contact-btn').style.display = 'none';
    populateGroupedCommunitySelect('contact-community-input');
    openModal('modal-add-contact');
}

function openAddContactForCommunity() {
    openAddContactModal();
    if (currentCommunity) {
        document.getElementById('contact-community-input').value = currentCommunity;
    }
}

async function saveContact(e) {
    e.preventDefault();
    const editId = document.getElementById('contact-edit-id').value;
    const isActive = document.getElementById('contact-active-yes').checked;
    const emailVal = document.getElementById('contact-email-input').value.trim();
    if (emailVal && !emailVal.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
        showAlert('Validation Error', 'Please enter a valid email address.');
        return;
    }

    const data = {
        id: editId || generateId('c'),
        name: document.getElementById('contact-name-input').value.trim(),
        role: document.getElementById('contact-role-input').value.trim(),
        community: document.getElementById('contact-community-input').value,
        email: emailVal,
        phone: document.getElementById('contact-phone-input').value.trim(),
        org: document.getElementById('contact-org-input').value.trim(),
        active: isActive,
        emailList: document.getElementById('contact-email-list').checked,
        primaryContact: document.getElementById('contact-primary-contact').checked,
    };

    // Check for duplicate contact name — confirm before proceeding
    const nameDup = contacts.find(c => c.name.toLowerCase() === data.name.toLowerCase() && c.id !== data.id);
    if (nameDup) {
        return new Promise(resolve => {
            showConfirm('Duplicate Contact',
                `A contact named "${nameDup.name}" already exists (${getCommunityName(nameDup.community) || nameDup.org || 'no community'}). Are you sure this isn't the same person?\n\nClick "Save Anyway" to save, or "Cancel" to go back and edit.`,
                () => { doSaveContact(data, editId, isActive); resolve(); },
                { confirmText: 'Save Anyway' }
            );
        });
    }

    doSaveContact(data, editId, isActive);
}

async function doSaveContact(data, editId, isActive) {
    let statusChanged = null;
    let emailChanged = false;
    let phoneChanged = false;
    let oldEmail = '';
    let oldPhone = '';
    let infoChanges = []; // Track all field changes for history note

    if (editId) {
        const old = contacts.find(c => c.id === editId);
        if (old) {
            const wasActive = old.active !== false;
            if (wasActive && !isActive) statusChanged = 'deactivated';
            else if (!wasActive && isActive) statusChanged = 'reactivated';
            if ((old.email || '') !== data.email) { emailChanged = true; oldEmail = old.email || ''; }
            if ((old.phone || '') !== data.phone) { phoneChanged = true; oldPhone = old.phone || ''; }
            // Track name, role, org, community changes
            if ((old.name || '') !== data.name) infoChanges.push(`Name changed from "${old.name || '(empty)'}" to "${data.name || '(empty)'}"`);
            if ((old.role || '') !== data.role) infoChanges.push(`Role changed from "${old.role || '(empty)'}" to "${data.role || '(empty)'}"`);
            if ((old.org || '') !== data.org) infoChanges.push(`Organization changed from "${old.org || '(empty)'}" to "${data.org || '(empty)'}"`);
            if ((old.community || '') !== data.community) infoChanges.push(`Community changed from "${getCommunityName(old.community) || '(none)'}" to "${getCommunityName(data.community) || '(none)'}"`);
        }
        const idx = contacts.findIndex(c => c.id === editId);
        if (idx >= 0) contacts[idx] = data;
        trackRecent('contacts', data.id, 'edited');
    } else {
        // New contact — let Supabase generate the UUID
        try {
            const saved = await db.upsertContact(data);
            if (saved?.id) data.id = saved.id;
        } catch (err) {
            handleSaveError(err);
            data.id = generateId('c'); // fallback for offline
        }
        contacts.push(data);
        trackRecent('contacts', data.id, 'edited');

        // Log new contact added
        if (!setupMode && data.community) {
            createNote('Info Edit', `${data.name} added as a contact for ${getCommunityName(data.community)}.`, {
                communities: [data.community], contacts: [data.id] });
        }
    }

    if (editId) persistContact(data); // Only fire-and-forget for edits
    closeModal('modal-add-contact'); showSuccessToast('Contact saved');
    renderContacts();

    // Auto-log contact info changes (not in setup mode)
    if (!setupMode && editId) {
        // Collect all field changes into a single note (name, role, org, community, email, phone)
        const allChanges = [...infoChanges];
        if (emailChanged) allChanges.push(`Email changed from "${oldEmail || '(empty)'}" to "${data.email || '(empty)'}"`);
        if (phoneChanged) allChanges.push(`Phone changed from "${oldPhone || '(empty)'}" to "${data.phone || '(empty)'}"`);

        if (allChanges.length > 0) {
            createNote('Info Edit', `Contact updated: ${allChanges.join('; ')}.`, {
                sensors: [], communities: data.community ? [data.community] : [], contacts: [data.id],
            });
        }
    }

    // Refresh contact detail if viewing, and update tab label
    if (currentContact === data.id) {
        const tab = openTabs.find(t => t.id === getTabId('contact', data.id));
        if (tab) tab.label = data.name;
        renderOpenTabs();
        showContactView(data.id);
    }

    // Refresh community view if open (so new contact appears)
    if (currentCommunity) showCommunityView(currentCommunity);

    // If active status changed, prompt for notes (skip in setup mode)
    if (statusChanged && !setupMode) {
        pendingContactStatusNote = {
            contactId: data.id,
            contactName: data.name,
            community: data.community,
            action: statusChanged,
        };
        document.getElementById('contact-status-note-summary').innerHTML =
            `<strong>${data.name}</strong> marked as <strong>${statusChanged === 'deactivated' ? 'Inactive' : 'Active'}</strong>`;
        document.getElementById('contact-status-note-text').value = '';
        document.getElementById('contact-status-note-date').value = nowDatetime();
        openModal('modal-contact-status-note');
    }
}

let pendingContactStatusNote = null;

function saveContactStatusNote() {
    if (!pendingContactStatusNote) return;
    const p = pendingContactStatusNote;
    const additionalInfo = document.getElementById('contact-status-note-text').value.trim();
    const date = document.getElementById('contact-status-note-date').value || nowDatetime();

    const noteText = p.action === 'deactivated'
        ? `${p.contactName} marked as inactive.`
        : `${p.contactName} reactivated.`;

    const note = {
        id: generateId('n'),
        date: date,
        type: 'Info Edit',
        text: noteText,
        additionalInfo: additionalInfo,
        createdBy: getCurrentUserName(), createdById: currentUserId,
        createdAt: new Date().toISOString(),
        taggedSensors: [],
        taggedCommunities: p.community ? [p.community] : [],
        taggedContacts: [p.contactId],
    };

    notes.push(note); persistNote(note);
    pendingContactStatusNote = null;
    closeModal('modal-contact-status-note');

    if (currentContact === p.contactId) showContactView(p.contactId);
    if (currentCommunity) showCommunityView(currentCommunity);
}

function skipContactStatusNote() {
    // Clear the optional note text and save with no additional info
    document.getElementById('contact-status-note-text').value = '';
    saveContactStatusNote();
}

function showContactDetail(contactId) {
    const c = contacts.find(x => x.id === contactId);
    if (!c) return;
    trackRecent('contacts', contactId, 'viewed');
    openTab('contact', contactId, c.name);
    saveLastView('contact', contactId);
    showContactView(contactId);
}

function showContactView(contactId) {
    const c = contacts.find(x => x.id === contactId);
    if (!c) return;
    currentContact = contactId;

    document.getElementById('contact-detail-name').innerHTML = '<span class="editable-field" onclick="inlineEditContact(\'' + c.id + '\', \'name\')">' + escapeHtml(c.name) + '</span>' + (c.primaryContact ? '<span class="contact-primary-badge" style="margin-left:10px;font-size:12px">Primary</span>' : '') + (c.active === false ? '<span class="contact-inactive-badge" style="margin-left:10px;font-size:12px">Inactive</span>' : '');
    if (setupMode) {
        document.getElementById('contact-info-card').innerHTML = `
            <div class="info-item"><label>Name</label>
                <input class="inline-edit-input" data-contact="${c.id}" data-field="name" value="${escapeHtml(c.name)}" onblur="inlineSaveContact(this); showContactView('${c.id}')" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Role</label>
                <input class="inline-edit-input" data-contact="${c.id}" data-field="role" value="${escapeHtml(c.role || '')}" placeholder="Role / Title" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Community</label>
                <select class="inline-edit-select" data-contact="${c.id}" data-field="community" onchange="inlineSaveContact(this)">
                    ${'<option value="">— Select —</option>' + [...COMMUNITIES].sort((a, b) => a.name.localeCompare(b.name)).map(cm => `<option value="${cm.id}" ${c.community === cm.id ? 'selected' : ''}>${cm.name}</option>`).join('')}
                </select>
            </div>
            <div class="info-item"><label>Organization</label>
                <input class="inline-edit-input" data-contact="${c.id}" data-field="org" value="${escapeHtml(c.org || '')}" placeholder="Organization" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Email</label>
                <input class="inline-edit-input" type="email" data-contact="${c.id}" data-field="email" value="${escapeHtml(c.email || '')}" placeholder="Email" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Phone</label>
                <input class="inline-edit-input" type="tel" data-contact="${c.id}" data-field="phone" value="${escapeHtml(c.phone || '')}" placeholder="Phone" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Status</label>
                <select class="inline-edit-select" data-contact="${c.id}" data-field="active" onchange="inlineSaveContact(this)">
                    <option value="true" ${c.active !== false ? 'selected' : ''}>Active</option>
                    <option value="false" ${c.active === false ? 'selected' : ''}>Inactive</option>
                </select>
            </div>
            <div class="info-item"><label>Primary Contact</label>
                <select class="inline-edit-select" data-contact="${c.id}" data-field="primaryContact" onchange="inlineSaveContact(this); showContactView('${c.id}')">
                    <option value="true" ${c.primaryContact ? 'selected' : ''}>Yes</option>
                    <option value="false" ${!c.primaryContact ? 'selected' : ''}>No</option>
                </select>
            </div>
            <div class="info-item"><label>Mass Email List</label>
                <select class="inline-edit-select" data-contact="${c.id}" data-field="emailList" onchange="inlineSaveContact(this)">
                    <option value="true" ${c.emailList ? 'selected' : ''}>Included</option>
                    <option value="false" ${!c.emailList ? 'selected' : ''}>Not included</option>
                </select>
            </div>
            <div class="info-item" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--slate-200)">
                <button class="btn btn-danger btn-sm" onclick="confirmDeleteContact('${c.id}')">Delete Contact</button>
            </div>
        `;
    } else {
        document.getElementById('contact-info-card').innerHTML = `
            <div class="info-item"><label>Role</label><p class="editable-field" onclick="inlineEditContact('${c.id}', 'role')">${c.role || '<span class="field-placeholder">Role / Title</span>'}</p></div>
            <div class="info-item"><label>Community</label><p class="editable-field" onclick="inlineEditContactCommunity('${c.id}')">${getCommunityName(c.community)} <a class="move-sensor-link" onclick="event.stopPropagation(); showCommunity('${c.community}')">View &rarr;</a></p></div>
            <div class="info-item"><label>Organization</label><p class="editable-field" onclick="inlineEditContact('${c.id}', 'org')">${c.org || '<span class="field-placeholder">Organization</span>'}</p></div>
            <div class="info-item"><label>Email</label><p class="editable-field" onclick="inlineEditContact('${c.id}', 'email')">${c.email || '<span class="field-placeholder">Email</span>'}</p></div>
            <div class="info-item"><label>Phone</label><p class="editable-field" onclick="inlineEditContact('${c.id}', 'phone')">${c.phone || '<span class="field-placeholder">Phone</span>'}</p></div>
            <div class="info-item"><label>Status</label><p>${c.active === false ? '<span class="contact-inactive-badge">Inactive</span>' : '<span style="color:var(--navy-500);font-weight:600">Active</span>'}</p></div>
            <div class="info-item"><label>Primary Contact</label><p class="editable-field" onclick="togglePrimaryContact('${c.id}')">${c.primaryContact ? '<span class="contact-primary-badge">Primary</span>' : '<span class="field-placeholder">No</span>'}</p></div>
            <div class="info-item"><label>Mass Email List</label><p class="editable-field" onclick="toggleContactEmailList('${c.id}')">${c.emailList ? '<span style="color:var(--aurora-green);font-weight:600">Included</span>' : '<span class="field-placeholder">Not included</span>'}</p></div>
        `;
    }

    // Reset contact history filter
    const contactFilterEl = document.getElementById('contact-history-filter');
    if (contactFilterEl) contactFilterEl.value = '';

    // Combine notes and comms into one list
    const contactNotes = notes.filter(n => n.taggedContacts && n.taggedContacts.includes(contactId));
    const contactComms = comms.filter(cm => cm.taggedContacts && cm.taggedContacts.includes(contactId))
        .map(cm => ({ ...cm, type: cm.commType || cm.type }));
    const allItems = [...contactNotes, ...contactComms];
    renderTimeline('contact-all-timeline', allItems);

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-contact-detail').classList.add('active');
    pushViewHistory();
}

const CONTACT_FILTER_GROUPS = {
    '_edits': ['Info Edit', 'Status Change'],
};

function filterContactHistory() {
    if (!currentContact) return;
    const filterVal = document.getElementById('contact-history-filter')?.value || '';

    let contactNotes = notes.filter(n => n.taggedContacts && n.taggedContacts.includes(currentContact));
    let contactComms = comms.filter(cm => cm.taggedContacts && cm.taggedContacts.includes(currentContact))
        .map(cm => ({ ...cm, type: cm.commType || cm.type }));

    if (filterVal === 'Communication') {
        renderTimeline('contact-all-timeline', contactComms);
    } else if (filterVal && CONTACT_FILTER_GROUPS[filterVal]) {
        contactNotes = contactNotes.filter(n => CONTACT_FILTER_GROUPS[filterVal].includes(n.type));
        renderTimeline('contact-all-timeline', contactNotes);
    } else {
        const allItems = [...contactNotes, ...contactComms];
        renderTimeline('contact-all-timeline', allItems);
    }
}


function inlineEditContact(contactId, field) {
    const c = contacts.find(x => x.id === contactId);
    if (!c) return;

    const labels = { name: 'Name', role: 'Role', org: 'Organization', email: 'Email', phone: 'Phone' };
    const label = labels[field] || field;
    const oldVal = c[field] || '';

    // Find the editable-field element that was clicked
    const infoCard = document.getElementById('contact-info-card');
    const nameHeader = document.getElementById('contact-detail-name');

    let targetP;
    if (field === 'name') {
        targetP = nameHeader.querySelector('.editable-field');
    } else {
        const items = infoCard.querySelectorAll('.info-item');
        for (const item of items) {
            const lbl = item.querySelector('label');
            if (lbl && lbl.textContent.trim() === label) {
                targetP = item.querySelector('.editable-field');
                break;
            }
        }
    }

    if (!targetP) return;

    const inputType = field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text';
    const input = document.createElement('input');
    input.type = inputType;
    input.className = 'inline-edit-input';
    input.value = oldVal;
    input.placeholder = label;
    input.style.width = '100%';
    input.style.margin = '0';

    targetP.innerHTML = '';
    targetP.classList.remove('editable-field');
    targetP.style.cursor = 'default';
    targetP.onclick = null;
    targetP.appendChild(input);
    input.focus();
    input.select();

    let handled = false;

    function save() {
        if (handled) return;
        handled = true;
        const newVal = input.value.trim();
        if (field === 'email' && newVal && !newVal.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
            handled = false;
            input.style.borderColor = 'var(--aurora-rose)';
            input.focus();
            return;
        }

        if (newVal !== oldVal) {
            c[field] = newVal;
            persistContact(c);

            if (field === 'name') {
                const tab = openTabs.find(t => t.id === getTabId('contact', contactId));
                if (tab) { tab.label = c.name; renderOpenTabs(); }
            }

            if (!setupMode) {
                createNote('Info Edit', `${label} changed from "${oldVal || '(empty)'}" to "${newVal || '(empty)'}" for ${c.name}.`, {
                    sensors: [], communities: c.community ? [c.community] : [], contacts: [contactId],
                });
            }
        }

        showContactView(contactId);
    }

    function cancel() {
        if (handled) return;
        handled = true;
        showContactView(contactId);
    }

    input.addEventListener('blur', function() {
        setTimeout(save, 100);
    });

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            save();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });
}

function toggleContactEmailList(contactId) {
    const c = contacts.find(x => x.id === contactId);
    if (!c) return;
    c.emailList = !c.emailList;
    persistContact(c);
    showSuccessToast(c.emailList ? 'Added to Mass Email List' : 'Removed from Mass Email List');
    // Re-render current view if on contact detail, otherwise leave checkbox as-is (already toggled by click)
    if (currentContact === contactId && document.getElementById('view-contact-detail')?.classList.contains('active')) {
        showContactView(contactId);
    }
}

function togglePrimaryContact(contactId) {
    const c = contacts.find(x => x.id === contactId);
    if (!c) return;
    c.primaryContact = !c.primaryContact;
    persistContact(c);
    showSuccessToast(c.primaryContact ? 'Marked as primary contact' : 'Removed primary contact tag');
    if (currentContact === contactId && document.getElementById('view-contact-detail')?.classList.contains('active')) {
        showContactView(contactId);
    }
}

function inlineEditContactCommunity(contactId) {
    const c = contacts.find(x => x.id === contactId);
    if (!c) return;

    const oldVal = c.community || '';
    const infoCard = document.getElementById('contact-info-card');
    const items = infoCard.querySelectorAll('.info-item');
    let targetP;
    for (const item of items) {
        const lbl = item.querySelector('label');
        if (lbl && lbl.textContent.trim() === 'Community') {
            targetP = item.querySelector('.editable-field');
            break;
        }
    }
    if (!targetP) return;

    const select = document.createElement('select');
    select.className = 'inline-edit-select';
    select.style.width = '100%';
    select.innerHTML = '<option value="">-- Select --</option>' +
        [...COMMUNITIES].sort((a, b) => a.name.localeCompare(b.name))
            .map(cm => `<option value="${cm.id}" ${c.community === cm.id ? 'selected' : ''}>${cm.name}</option>`)
            .join('');

    targetP.innerHTML = '';
    targetP.classList.remove('editable-field');
    targetP.style.cursor = 'default';
    targetP.onclick = null;
    targetP.appendChild(select);
    select.focus();

    let handled = false;

    function save() {
        if (handled) return;
        handled = true;
        const newVal = select.value;
        if (newVal !== oldVal) {
            c.community = newVal;
            persistContact(c);

            if (!setupMode) {
                const oldName = oldVal ? getCommunityName(oldVal) : '(none)';
                const newName = newVal ? getCommunityName(newVal) : '(none)';
                createNote('Info Edit', `Community changed from "${oldName}" to "${newName}" for ${c.name}.`, {
                    sensors: [], communities: [oldVal, newVal].filter(Boolean), contacts: [contactId],
                });
            }
        }
        showContactView(contactId);
    }

    select.addEventListener('change', save);
    select.addEventListener('blur', function() {
        setTimeout(function() { if (!handled) save(); }, 100);
    });
    select.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            if (!handled) { handled = true; showContactView(contactId); }
        }
    });
}

function confirmDeleteContact(contactId) {
    const c = contacts.find(x => x.id === contactId);
    if (!c) return;
    showConfirm(
        'Delete Contact',
        `<p>Are you sure you want to permanently delete <strong>${escapeHtml(c.name)}</strong>?</p>
         <p style="margin-top:8px">This will remove all of their information from the system and cannot be undone.</p>
         <p style="margin-top:12px;padding:10px 14px;background:rgba(234,179,8,0.08);border-radius:8px;border:1px solid rgba(234,179,8,0.2);font-size:13px;color:var(--slate-600)">
            <strong style="color:var(--gold-700)">Tip:</strong> If this person is no longer involved but may be relevant later, consider setting them to <strong>Inactive</strong> instead. Inactive contacts are preserved in the system but hidden from active lists.
         </p>`,
        () => {
            db.deleteContact(contactId).catch(err => console.error('Delete error:', err));
            contacts = contacts.filter(x => x.id !== contactId);
            showSuccessToast(`${c.name} deleted`);

            // Close tab if open
            const tabId = getTabId('contact', contactId);
            const tabIdx = openTabs.findIndex(t => t.id === tabId);
            if (tabIdx >= 0) openTabs.splice(tabIdx, 1);
            if (currentContact === contactId) currentContact = null;
            renderOpenTabs();

            // Re-render whatever view we're on
            if (document.getElementById('view-contacts')?.classList.contains('active')) {
                renderContacts();
            } else if (currentCommunity) {
                showCommunityView(currentCommunity);
            } else {
                showView('contacts');
            }
        },
        { danger: true, confirmText: 'Delete Permanently' }
    );
}

function openContactCommModal() {
    if (!currentContact) return;
    const c = contacts.find(x => x.id === currentContact);
    if (!c) return;
    // Open the comm modal with the contact's community, and pre-fill the contact name
    document.getElementById('comm-form').reset();
    document.getElementById('comm-community-id').value = c.community;
    document.getElementById('comm-date-input').value = nowDatetime();
    document.getElementById('comm-contacts-input').value = c.name;
    openModal('modal-comm');
}

// ===== EMAIL COMPOSER =====
function openEmailModal() {
    populateCommunitySelect('email-community-filter');
    document.getElementById('btn-network-email-list').classList.remove('active');
    renderEmailRecipients();
    emailDeselectAll();
    document.getElementById('email-subject').value = '';
    document.getElementById('email-body').value = '';
    openModal('modal-email');
}

function renderEmailRecipients(filter) {
    const list = document.getElementById('email-recipients-list');

    // filter: undefined = all checked, 'community' = specific community, 'network' = email list only
    const activeContacts = contacts.filter(c => c.active !== false);

    // Group active contacts by community alphabetically
    const groups = {};
    activeContacts.forEach(c => {
        const commName = getCommunityName(c.community);
        if (!groups[commName]) groups[commName] = [];
        groups[commName].push(c);
    });

    const sortedCommunities = Object.keys(groups).sort();

    list.innerHTML = sortedCommunities.map(commName => {
        const groupContacts = groups[commName].sort((a, b) => a.name.localeCompare(b.name));
        // Skip empty groups when filtering
        const hasVisible = filter !== 'network' || groupContacts.some(c => c.emailList);
        if (!hasVisible) return '';
        return `
            <div class="email-community-header">${commName}</div>
            ${groupContacts.map(c => {
                const isChecked = filter === 'network' ? c.emailList : true;
                const badge = c.emailList ? '<span class="email-list-badge">Mass Email List</span>' : '';
                return `
                <div class="email-recipient-row">
                    <input type="checkbox" id="email-cb-${c.id}" data-contact-id="${c.id}" data-community="${c.community}" ${isChecked ? 'checked' : ''}>
                    <label for="email-cb-${c.id}">${c.name}${badge}</label>
                    <span class="recipient-community">${c.email || 'no email'}</span>
                </div>`;
            }).join('')}
        `;
    }).join('');
}

function emailSelectAll() {
    document.querySelectorAll('#email-recipients-list input[type="checkbox"]').forEach(cb => cb.checked = true);
}

function emailDeselectAll() {
    document.querySelectorAll('#email-recipients-list input[type="checkbox"]').forEach(cb => cb.checked = false);
}

function emailSelectNetworkList() {
    // Reset community filter
    document.getElementById('email-community-filter').value = '';
    // Render all contacts but only check those on the email list
    renderEmailRecipients('network');
    // Highlight the button
    document.getElementById('btn-network-email-list').classList.add('active');

    const onListCount = contacts.filter(c => c.active !== false && c.emailList).length;
    if (onListCount === 0) {
        document.getElementById('email-recipients-list').innerHTML =
            '<div class="empty-state">No contacts on the Mass Email List yet. Use the checkboxes on the Contacts tab to add them.</div>';
    }
}

function emailFilterByCommunity() {
    const commId = document.getElementById('email-community-filter').value;
    // Remove network list button highlight
    document.getElementById('btn-network-email-list').classList.remove('active');

    if (!commId) {
        // Show all contacts, none checked
        renderEmailRecipients();
        emailDeselectAll();
        return;
    }

    // Show only active contacts from the selected community
    const filtered = contacts.filter(c => c.community === commId && c.active !== false);
    const list = document.getElementById('email-recipients-list');
    const commName = getCommunityName(commId);

    list.innerHTML = `
        <div class="email-community-header">${commName}</div>
        ${filtered.sort((a, b) => a.name.localeCompare(b.name)).map(c => {
            const badge = c.emailList ? '<span class="email-list-badge">Mass Email List</span>' : '';
            return `
            <div class="email-recipient-row">
                <input type="checkbox" id="email-cb-${c.id}" data-contact-id="${c.id}" data-community="${c.community}" checked>
                <label for="email-cb-${c.id}">${c.name}${badge}</label>
                <span class="recipient-community">${c.email || 'no email'}</span>
            </div>`;
        }).join('')}
    `;

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state">No contacts in this community.</div>';
    }
}

function sendEmail() {
    const subject = document.getElementById('email-subject').value.trim();
    const body = document.getElementById('email-body').value.trim();

    // Get checked contacts
    const checkedBoxes = document.querySelectorAll('#email-recipients-list input[type="checkbox"]:checked');
    const selectedContactIds = Array.from(checkedBoxes).map(cb => cb.dataset.contactId);
    const selectedContacts = selectedContactIds.map(id => contacts.find(c => c.id === id)).filter(Boolean);
    const emails = selectedContacts.map(c => c.email).filter(Boolean);

    if (emails.length === 0) {
        showAlert('No Recipients', 'No contacts with email addresses are selected.');
        return;
    }

    if (!subject || !body) {
        showAlert('Validation Error', 'Please enter both a subject and body before sending.');
        return;
    }

    // Open mailto link (works with Outlook and other mail clients)
    const useBcc = document.getElementById('email-bcc-toggle').checked;
    const mailtoLink = useBcc
        ? `mailto:?bcc=${emails.join(',')}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
        : `mailto:${emails.join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailtoLink;

    closeModal('modal-email');

    // Show log confirmation popup after a brief delay (so mailto opens first)
    _pendingEmailLog = { subject, body, selectedContactIds, selectedContacts, emails };
    setTimeout(() => {
        const recipientNames = selectedContacts.map(c => c.name).join(', ');
        document.getElementById('email-log-recipients').textContent = recipientNames;
        document.getElementById('email-log-subject').value = subject;
        document.getElementById('email-log-notes').value = '';
        openModal('modal-email-log');
    }, 500);
}

let _pendingEmailLog = null;

function confirmLogEmail() {
    if (!_pendingEmailLog) return;
    const { selectedContactIds, selectedContacts } = _pendingEmailLog;
    const logSubject = document.getElementById('email-log-subject').value.trim();
    const logNotes = document.getElementById('email-log-notes').value.trim();
    const involvedCommunities = [...new Set(selectedContacts.map(c => c.community))];

    const comm = {
        id: generateId('comm'),
        date: nowDatetime(),
        type: 'Communication',
        commType: 'Email',
        subject: logSubject,
        fullBody: logNotes || _pendingEmailLog.body,
        text: `[Email] Subject: ${logSubject}${logNotes ? ' — ' + logNotes : ''}`,
        createdBy: getCurrentUserName(), createdById: currentUserId,
        community: involvedCommunities[0] || '',
        taggedContacts: selectedContactIds,
        taggedCommunities: involvedCommunities,
    };

    comms.push(comm); persistComm(comm);
    _pendingEmailLog = null;
    closeModal('modal-email-log');
    showSuccessToast('Email communication logged');
}

function discardEmailLog() {
    _pendingEmailLog = null;
    closeModal('modal-email-log');
}

function openQuickEmail(contactId) {
    const c = contacts.find(x => x.id === contactId);
    if (!c || !c.email) return;

    // Open the email modal with just this contact selected
    populateCommunitySelect('email-community-filter');
    document.getElementById('btn-network-email-list').classList.remove('active');

    // Render only this contact as a recipient
    const badge = c.emailList ? '<span class="email-list-badge">Mass Email List</span>' : '';
    const list = document.getElementById('email-recipients-list');
    list.innerHTML = `
        <div class="email-community-header">${getCommunityName(c.community)}</div>
        <div class="email-recipient-row">
            <input type="checkbox" id="email-cb-${c.id}" data-contact-id="${c.id}" data-community="${c.community}" checked>
            <label for="email-cb-${c.id}">${c.name}${badge}</label>
            <span class="recipient-community">${c.email}</span>
        </div>
    `;

    document.getElementById('email-subject').value = '';
    document.getElementById('email-body').value = '';
    document.getElementById('email-community-filter').value = c.community;
    openModal('modal-email');
}

// ===== NOTES =====
function openAddNoteModal(contextId, contextType) {
    document.getElementById('note-form').reset();
    document.getElementById('note-context-id').value = contextId;
    document.getElementById('note-context-type').value = contextType;
    document.getElementById('note-date-input').value = nowDatetime();

    // Clear all chip containers
    document.querySelectorAll('#modal-add-note .tag-chip').forEach(c => c.remove());

    // Pre-fill based on context
    if (contextType === 'community') {
        prefillChip('tag-communities-container', getCommunityName(contextId));
    } else if (contextType === 'sensor') {
        prefillChip('tag-sensors-container', contextId);
    }

    // Init tag chip inputs
    setupTagChipInput('tag-sensors-container',
        () => sensors,
        s => s.id
    );
    setupTagChipInput('tag-communities-container',
        () => COMMUNITIES,
        c => c.name
    );
    setupTagChipInput('tag-contacts-container',
        () => contacts,
        c => c.name
    );

    // Reset all action checkboxes
    document.querySelectorAll('#note-actions-list input[type="checkbox"]').forEach(cb => cb.checked = false);
    document.getElementById('note-status-change-group').style.display = 'none';
    document.getElementById('note-audit-link-group').style.display = 'none';
    document.getElementById('note-move-target-group').style.display = 'none';

    // Singularize the Move action label when adding a note from a single sensor
    const moveLabel = document.getElementById('note-action-move-label');
    if (moveLabel) moveLabel.textContent = contextType === 'sensor' ? 'Move Sensor' : 'Move Sensors';

    // Pre-populate status list with current sensor's statuses if available
    if (contextType === 'sensor') {
        const s = sensors.find(x => x.id === contextId);
        renderStatusToggleList('note-status-list', s ? getStatusArray(s) : []);
    } else {
        renderStatusToggleList('note-status-list', []);
    }

    // Populate the move sensors dropdown
    const moveTargetSelect = document.getElementById('note-move-target-community');
    if (moveTargetSelect) {
        // Sort: regulatory sites first, then alphabetical
        const regulatoryIds = ['anc-garden', 'fbx-ncore', 'jnu-floyd-dryden'];
        const reg = COMMUNITIES.filter(c => regulatoryIds.includes(c.id));
        const others = COMMUNITIES.filter(c => !regulatoryIds.includes(c.id)).sort((a, b) => a.name.localeCompare(b.name));
        moveTargetSelect.innerHTML = '<option value="">— Select destination community —</option>' +
            (reg.length > 0 ? `<optgroup label="Regulatory Sites">${reg.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</optgroup>` : '') +
            `<optgroup label="Communities">${others.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</optgroup>`;
    }

    openModal('modal-add-note');
}

function onNoteActionsChange() {
    const statusChecked = document.getElementById('note-action-status').checked;
    const moveChecked = document.getElementById('note-action-move').checked;

    // Show/hide status toggle list
    const statusGroup = document.getElementById('note-status-change-group');
    if (statusGroup) statusGroup.style.display = statusChecked ? '' : 'none';

    // Show/hide move target dropdown
    const moveTargetGroup = document.getElementById('note-move-target-group');
    if (moveTargetGroup) moveTargetGroup.style.display = moveChecked ? '' : 'none';

    // Render status toggle list when status checkbox is checked (use full ALL_STATUSES list)
    if (statusChecked) {
        renderStatusToggleList('note-status-list', []);
    }
}

function getNoteActionsType() {
    const actions = [];
    if (document.getElementById('note-action-move').checked) actions.push('Movement');
    if (document.getElementById('note-action-troubleshooting').checked) actions.push('Troubleshooting');
    if (document.getElementById('note-action-site-work').checked) actions.push('Site Work');
    if (document.getElementById('note-action-status').checked) actions.push('Status Change');
    if (actions.length === 0) return 'General';
    if (actions.length === 1) return actions[0];
    return actions.join(' + ');
}

function saveNote(e) {
    e.preventDefault();

    const text = document.getElementById('note-text-input').value.trim();
    const type = getNoteActionsType();
    const noteDate = document.getElementById('note-date-input').value || nowDatetime();

    const sensorTags = getChipValues('tag-sensors-container');

    const noteCommunityTags = getChipValues('tag-communities-container')
        .map(name => {
            const c = COMMUNITIES.find(c => c.name.toLowerCase() === name.toLowerCase());
            return c ? c.id : null;
        }).filter(Boolean);

    const contactTags = getChipValues('tag-contacts-container')
        .map(name => {
            const c = contacts.find(c => c.name.toLowerCase() === name.toLowerCase());
            return c ? c.id : null;
        }).filter(Boolean);

    // Also parse @mentions from the note text itself
    const textMentions = parseMentionedContacts(text);
    textMentions.forEach(id => {
        if (!contactTags.includes(id)) contactTags.push(id);
    });

    const note = {
        id: generateId('n'),
        date: noteDate,
        type: type,
        text: text,
        createdBy: getCurrentUserName(), createdById: currentUserId,
        createdAt: new Date().toISOString(),
        taggedSensors: sensorTags,
        taggedCommunities: noteCommunityTags,
        taggedContacts: contactTags,
    };

    notes.push(note); persistNote(note);

    // Move tagged sensors if Move Sensors action is checked
    let movedCount = 0;
    if (document.getElementById('note-action-move')?.checked) {
        const targetCommunityId = document.getElementById('note-move-target-community')?.value || '';
        if (targetCommunityId && sensorTags.length > 0) {
            const targetName = getCommunityName(targetCommunityId);
            sensorTags.forEach(sId => {
                const s = sensors.find(x => x.id === sId);
                if (!s) return;
                const fromName = getCommunityName(s.community);
                if (s.community === targetCommunityId) return; // already there
                s.community = targetCommunityId;
                persistSensor(s);
                movedCount++;
            });
            buildSensorSidebar();
            // Add the move details to the note text
            note.text = note.text + `\nMoved ${movedCount} sensor${movedCount === 1 ? '' : 's'} to ${targetName}.`;
            db.updateNote(note.id, { text: note.text }).catch(() => {});
        }
    }

    // Apply status change to all tagged sensors if Status Change action is checked
    // ADDS the selected statuses to existing ones, doesn't replace
    let statusChangedCount = 0;
    if (document.getElementById('note-action-status')?.checked) {
        const newStatuses = getSelectedStatuses('note-status-list');
        if (newStatuses.length > 0 && sensorTags.length > 0) {
            sensorTags.forEach(sId => {
                const s = sensors.find(x => x.id === sId);
                if (!s) return;
                const existing = getStatusArray(s);
                // Merge new statuses with existing, preserving Online/Offline mutual exclusion
                let merged = [...existing];
                newStatuses.forEach(st => {
                    // If adding Online, remove Offline (and vice versa)
                    if (st === 'Online') merged = merged.filter(x => x !== 'Offline');
                    if (st === 'Offline') merged = merged.filter(x => x !== 'Online');
                    if (!merged.includes(st)) merged.push(st);
                });
                s.status = merged;
                persistSensor(s);
                statusChangedCount++;
            });
            buildSensorSidebar();
            note.text = note.text + `\nAdded status "${newStatuses.join(', ')}" to ${statusChangedCount} sensor${statusChangedCount === 1 ? '' : 's'}.`;
            db.updateNote(note.id, { text: note.text }).catch(() => {});
        }
    }

    closeModal('modal-add-note');
    let toastMsg = 'Note added';
    if (movedCount > 0) toastMsg += ` · ${movedCount} moved`;
    if (statusChangedCount > 0) toastMsg += ` · ${statusChangedCount} status updated`;
    showSuccessToast(toastMsg);
    refreshCurrentView();
}

// ===== COMMUNICATIONS =====
function openCommModal(communityId) {
    document.getElementById('comm-form').reset();
    document.getElementById('comm-community-id').value = communityId;
    document.getElementById('comm-date-input').value = nowDatetime();
    openModal('modal-comm');
}

function saveComm(e) {
    e.preventDefault();

    const communityId = document.getElementById('comm-community-id').value;
    const commType = document.getElementById('comm-type-input').value;
    const commDate = document.getElementById('comm-date-input').value || nowDatetime();
    const text = document.getElementById('comm-text-input').value.trim();
    const contactNames = document.getElementById('comm-contacts-input').value
        .split(',').map(s => s.trim()).filter(Boolean);

    const taggedContacts = contactNames.map(name => {
        const c = contacts.find(c => c.name.toLowerCase() === name.toLowerCase());
        return c ? c.id : null;
    }).filter(Boolean);

    const comm = {
        id: generateId('comm'),
        date: commDate,
        type: 'Communication',
        commType: commType,
        text: `[${commType}] ${text}`,
        createdBy: getCurrentUserName(), createdById: currentUserId,
        community: communityId,
        taggedContacts: taggedContacts,
        taggedCommunities: [communityId],
    };

    comms.push(comm);
    db.insertComm(comm).then(saved => {
        if (saved?.id) comm.id = saved.id;
    }).catch(handleSaveError);
    closeModal('modal-comm'); showSuccessToast('Communication logged');
    refreshCurrentView();
}

// ===== TIMELINE RENDERER =====
function renderTimeline(containerId, items) {
    const container = document.getElementById(containerId);
    if (!items.length) {
        container.innerHTML = '<div class="empty-state">No history yet.</div>';
        return;
    }

    items.sort((a, b) => b.date.localeCompare(a.date));

    container.innerHTML = items.map(item => {
        const typeClass = getTimelineTypeClass(item.type);
        const tags = buildTagsHTML(item);
        const hasFullBody = item.fullBody;
        const expandable = hasFullBody ? `onclick="this.querySelector('.timeline-text-full').classList.toggle('open')" style="cursor:pointer"` : '';

        // Display userNotes from structured JSON additionalInfo, or raw text for legacy notes
        let additionalInfoDisplay = '';
        if (item.additionalInfo) {
            try {
                const parsed = JSON.parse(item.additionalInfo);
                additionalInfoDisplay = parsed.userNotes || '';
            } catch (_) {
                additionalInfoDisplay = item.additionalInfo;
            }
        }
        const additionalInfoHtml = additionalInfoDisplay
            ? `<div class="timeline-additional-info"><em>${highlightMentions(escapeHtml(additionalInfoDisplay))}</em></div>`
            : '';

        const createdAt = item.createdAt || item.created_at || '';
        const attribution = item.createdBy
            ? `<div class="timeline-attribution">Logged by ${item.createdBy}${createdAt ? ', ' + formatDate(createdAt) : ''}</div>`
            : '';

        const isNote = !item.commType;
        const actions = `<div class="timeline-actions" onclick="event.stopPropagation()">
            <span class="timeline-action-btn" onclick="editTimelineItem('${item.id}', ${isNote})" title="Edit">&#9998;</span>
            <span class="timeline-action-btn" onclick="deleteTimelineItem('${item.id}', ${isNote})" title="Delete">&#128465;</span>
        </div>`;

        return `
            <div class="timeline-item ${typeClass}" ${expandable}>
                <div class="timeline-header">
                    <div>
                        <div class="timeline-date">${formatDate(item.date)}</div>
                        <div class="timeline-type">${item.commType || item.type}</div>
                    </div>
                    ${actions}
                </div>
                <div class="timeline-text">${renderNoteText(item.text, isNote ? item.id : null)}${hasFullBody ? ' <small style="color:var(--navy-500)">(click to expand)</small>' : ''}</div>
                ${additionalInfoHtml}
                ${hasFullBody ? `<div class="timeline-text-full">${escapeHtml(item.fullBody)}</div>` : ''}
                ${attribution}
                ${tags ? `<div class="timeline-tags">${tags}</div>` : ''}
                ${isNote ? `<div class="timeline-add-note">
                    <div id="timeline-note-panel-${item.id}" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid var(--slate-100)">
                        <textarea id="timeline-note-input-${item.id}" rows="2" placeholder="Add a follow-up note..." style="width:100%;font-size:13px;font-family:var(--font-sans);padding:8px 10px;border:1px solid var(--slate-200);border-radius:6px;resize:vertical"></textarea>
                        <div style="display:flex;gap:8px;margin-top:6px">
                            <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); saveTimelineFollowUp('${item.id}')">Save Note</button>
                            <button class="btn btn-sm" onclick="event.stopPropagation(); document.getElementById('timeline-note-panel-${item.id}').style.display='none'">Cancel</button>
                        </div>
                    </div>
                    <button class="btn btn-sm" onclick="event.stopPropagation(); toggleTimelineNotePanel('${item.id}')" style="margin-top:8px;font-size:11px">Add Note</button>
                </div>` : ''}
            </div>
        `;
    }).join('');
}

function renderNoteText(text, noteId) {
    if (!text) return '';
    if (text.includes('\n—')) {
        const lines = text.split('\n');
        const mainText = [];
        const followUps = [];
        for (const line of lines) {
            if (line.startsWith('—')) {
                followUps.push(line.substring(2).trim());
            } else {
                mainText.push(line);
            }
        }
        let html = highlightMentions(escapeHtml(mainText.join('\n')));
        if (followUps.length > 0) {
            html += '<div class="timeline-followups">';
            html += followUps.map((f, idx) => {
                const match = f.match(/^(.+?)\s*\((.+?)\):\s*(.+)$/);
                const actions = noteId
                    ? `<span class="followup-actions" onclick="event.stopPropagation()"><span class="followup-action-btn" onclick="editFollowUp('${noteId}', ${idx})" title="Edit">&#9998;</span><span class="followup-action-btn" onclick="deleteFollowUp('${noteId}', ${idx})" title="Delete">&#128465;</span></span>`
                    : '';
                if (match) {
                    return `<div class="timeline-followup-entry"><div class="followup-header"><div><strong>${escapeHtml(match[1])}</strong> <span class="timeline-followup-date">${escapeHtml(match[2])}</span></div>${actions}</div><div class="timeline-followup-text">${highlightMentions(escapeHtml(match[3]))}</div></div>`;
                }
                return `<div class="timeline-followup-entry"><div class="followup-header"><div>${highlightMentions(escapeHtml(f))}</div>${actions}</div></div>`;
            }).join('');
            html += '</div>';
        }
        return html;
    }
    return highlightMentions(escapeHtml(text));
}

function editFollowUp(noteId, followUpIdx) {
    const note = notes.find(n => n.id === noteId);
    if (!note) return;
    const lines = note.text.split('\n');
    const followUps = [];
    const mainLines = [];
    for (const line of lines) {
        if (line.startsWith('—')) followUps.push(line);
        else mainLines.push(line);
    }
    if (followUpIdx >= followUps.length) return;

    const oldLine = followUps[followUpIdx];
    const match = oldLine.match(/^— (.+?\s*\(.+?\)):\s*(.+)$/);
    const oldText = match ? match[2] : oldLine.substring(2);

    const newText = prompt('Edit note:', oldText);
    if (newText === null || newText.trim() === oldText) return;

    if (match) {
        followUps[followUpIdx] = `— ${match[1]}: ${newText.trim()}`;
    } else {
        followUps[followUpIdx] = `— ${newText.trim()}`;
    }

    note.text = [...mainLines, ...followUps].join('\n');
    supa.from('notes').update({ text: note.text }).eq('id', noteId).catch(err => console.error('Edit follow-up error:', err));
    refreshCurrentView();
    if (typeof renderDashboardAlerts === 'function') renderDashboardAlerts();
}

function deleteFollowUp(noteId, followUpIdx) {
    const note = notes.find(n => n.id === noteId);
    if (!note) return;

    const lines = note.text.split('\n');
    const followUps = [];
    const mainLines = [];
    for (const line of lines) {
        if (line.startsWith('—')) followUps.push(line);
        else mainLines.push(line);
    }
    if (followUpIdx >= followUps.length) return;
    followUps.splice(followUpIdx, 1);

    note.text = [...mainLines, ...followUps].join('\n');
    refreshCurrentView();
    if (typeof renderDashboardAlerts === 'function') renderDashboardAlerts();
    supa.from('notes').update({ text: note.text }).eq('id', noteId).catch(err => console.error('Delete follow-up error:', err));
}

function toggleTimelineNotePanel(noteId) {
    const panel = document.getElementById('timeline-note-panel-' + noteId);
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
    if (panel.style.display !== 'none') {
        const input = document.getElementById('timeline-note-input-' + noteId);
        if (input) { input.value = ''; input.focus(); }
    }
}

async function saveTimelineFollowUp(noteId) {
    const input = document.getElementById('timeline-note-input-' + noteId);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    const note = notes.find(n => n.id === noteId);
    if (!note) return;

    const timestamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: AK_TZ });
    const userName = currentUser || 'Unknown';
    note.text += `\n— ${userName} (${timestamp}): ${text}`;

    try {
        await supa.from('notes').update({ text: note.text }).eq('id', noteId);
    } catch (err) {
        console.error('Failed to save follow-up note:', err);
    }

    input.value = '';
    document.getElementById('timeline-note-panel-' + noteId).style.display = 'none';
    refreshCurrentView();
}

function editTimelineItem(id, isNote) {
    const item = isNote ? notes.find(n => n.id === id) : comms.find(c => c.id === id);
    if (!item) return;

    const label = isNote ? 'Edit Note' : 'Edit Communication';
    const body = document.getElementById('modal-confirm-body');
    const modal = document.getElementById('modal-confirm');

    document.getElementById('modal-confirm-title').textContent = label;
    body.innerHTML = `<textarea id="edit-timeline-text" rows="6" style="width:100%;font-family:var(--font-sans);font-size:14px;padding:10px;border:1px solid var(--slate-200);border-radius:8px;resize:vertical;line-height:1.5"></textarea>`;

    // Set value directly (not via innerHTML) to avoid HTML entity issues
    const textarea = document.getElementById('edit-timeline-text');
    textarea.value = item.text || '';

    const okBtn = document.getElementById('modal-confirm-ok');
    const cancelBtn = document.getElementById('modal-confirm-cancel');
    okBtn.textContent = 'Done';
    okBtn.className = 'btn btn-primary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.display = '';

    // Wire up the save directly — bypass _confirmCallback entirely
    _confirmCallback = null;
    _confirmDismissCallback = null;

    const saveHandler = function() {
        okBtn.removeEventListener('click', saveHandler);
        const newText = document.getElementById('edit-timeline-text')?.value?.trim();
        // Restore default modal handlers
        okBtn.onclick = acceptConfirmModal;
        cancelBtn.onclick = dismissConfirmModal;
        document.querySelector('#modal-confirm .modal-close').onclick = dismissConfirmModal;
        modal.classList.remove('open');

        if (!newText || newText === (item.text || '').trim()) return;

        item.text = newText;
        const table = isNote ? 'notes' : 'comms';
        supa.from(table).update({ text: newText }).eq('id', id)
            .then(({ error }) => { if (error) console.error('Edit save error:', error); })
            .catch(err => console.error('Edit save error:', err));

        refreshCurrentView();
    };

    // Remove the default onclick and use our handler
    okBtn.onclick = null;
    okBtn.addEventListener('click', saveHandler, { once: true });

    // Cancel/close: restore default handlers and close
    function cleanup() {
        okBtn.removeEventListener('click', saveHandler);
        okBtn.onclick = acceptConfirmModal;
        cancelBtn.onclick = dismissConfirmModal;
        document.querySelector('#modal-confirm .modal-close').onclick = dismissConfirmModal;
        modal.classList.remove('open');
    }
    cancelBtn.onclick = cleanup;
    document.querySelector('#modal-confirm .modal-close').onclick = cleanup;

    modal.classList.add('open');
    setTimeout(() => textarea.focus(), 50);
}

async function deleteTimelineItem(id, isNote) {
    // For communications or non-note items, use simple delete
    if (!isNote) {
        showConfirm('Delete Event', 'Are you sure? Only delete events that were created by accident.', async () => {
            try {
                comms = comms.filter(c => c.id !== id);
                await supa.from('comm_tags').delete().eq('comm_id', id);
                await supa.from('comms').delete().eq('id', id);
            } catch (err) {
                console.error('Delete error:', err);
            }
            refreshCurrentView();
        }, { danger: true });
        return;
    }

    const note = notes.find(n => n.id === id);
    if (!note) return;

    // Try to parse structured additionalInfo for revertable event types
    let parsed = null;
    try {
        if (note.additionalInfo) parsed = JSON.parse(note.additionalInfo);
    } catch (_) { /* legacy plain-text or pipe-delimited format — not revertable */ }

    const revertableTypes = ['Status Change', 'Movement', 'Collocation'];
    const canRevert = parsed && revertableTypes.includes(note.type);

    if (!canRevert) {
        // Non-revertable note types: just delete normally
        showConfirm('Delete Event', 'Are you sure? Only delete events that were created by accident.', async () => {
            try {
                notes = notes.filter(n => n.id !== id);
                await supa.from('note_tags').delete().eq('note_id', id);
                await supa.from('notes').delete().eq('id', id);
            } catch (err) {
                console.error('Delete error:', err);
            }
            refreshCurrentView();
        }, { danger: true });
        return;
    }

    // Build revert description based on note type
    let revertDescription = '';
    if (note.type === 'Status Change') {
        const sId = parsed.sensorId || (note.taggedSensors && note.taggedSensors[0]) || 'sensor';
        const beforeStr = (parsed.beforeStatus || []).join(', ') || '(none)';
        revertDescription = `Revert <strong>${escapeHtml(sId)}</strong>'s status back to <strong>${escapeHtml(beforeStr)}</strong>`;
    } else if (note.type === 'Movement') {
        const sId = parsed.sensorId || (note.taggedSensors && note.taggedSensors[0]) || 'sensor';
        const fromName = parsed.fromCommunity ? getCommunityName(parsed.fromCommunity) : 'its previous community';
        revertDescription = `Move <strong>${escapeHtml(sId)}</strong> back to <strong>${escapeHtml(fromName)}</strong>`;
    } else if (note.type === 'Collocation') {
        const sensorList = (note.taggedSensors || []).join(', ') || 'tagged sensors';
        revertDescription = `Revert collocation info for <strong>${escapeHtml(sensorList)}</strong>`;
    }

    const message = `
        <p>Are you sure? Only delete events that were created by accident.</p>
        <div style="margin-top:12px; padding:10px; background:var(--navy-50, #f0f2f5); border-radius:6px;">
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.95em;">
                <input type="checkbox" id="revert-changes-checkbox" checked style="width:16px; height:16px;">
                <span>Also revert sensor changes</span>
            </label>
            <div style="margin-top:6px; font-size:0.85em; color:var(--navy-600, #4a5568);">${revertDescription}</div>
        </div>
    `;

    showConfirm('Delete Event', message, async () => {
        const doRevert = document.getElementById('revert-changes-checkbox')?.checked;

        try {
            // Delete the note
            notes = notes.filter(n => n.id !== id);
            await supa.from('note_tags').delete().eq('note_id', id);
            await supa.from('notes').delete().eq('id', id);

            // Revert sensor changes if checkbox was checked
            if (doRevert) {
                if (note.type === 'Status Change') {
                    // Single sensor status revert
                    const sId = parsed.sensorId || (note.taggedSensors && note.taggedSensors[0]);
                    if (sId && parsed.beforeStatus) {
                        const s = sensors.find(x => x.id === sId);
                        if (s) {
                            s.status = parsed.beforeStatus;
                            persistSensor(s);
                        }
                    }
                    // Bulk status revert (from bulk actions)
                    if (parsed.beforeStatuses) {
                        for (const [sId, oldStatus] of Object.entries(parsed.beforeStatuses)) {
                            const s = sensors.find(x => x.id === sId);
                            if (s) {
                                s.status = oldStatus;
                                persistSensor(s);
                            }
                        }
                    }
                } else if (note.type === 'Movement') {
                    // Single sensor movement revert
                    const sId = parsed.sensorId || (note.taggedSensors && note.taggedSensors[0]);
                    if (sId && parsed.fromCommunity !== undefined) {
                        const s = sensors.find(x => x.id === sId);
                        if (s) {
                            s.community = parsed.fromCommunity;
                            if (parsed.beforeDateInstalled) s.dateInstalled = parsed.beforeDateInstalled;
                            persistSensor(s);
                        }
                    }
                    // Bulk movement revert (from bulk actions)
                    if (parsed.beforeCommunities) {
                        for (const [sId, oldComm] of Object.entries(parsed.beforeCommunities)) {
                            const s = sensors.find(x => x.id === sId);
                            if (s) {
                                s.community = oldComm;
                                if (parsed.beforeDateInstalled && parsed.beforeDateInstalled[sId]) {
                                    s.dateInstalled = parsed.beforeDateInstalled[sId];
                                }
                                persistSensor(s);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Delete/revert error:', err);
        }
        refreshCurrentView();
    }, { danger: true, confirmText: 'Delete' });
}

function refreshCurrentView() {
    buildSensorSidebar();
    // Preserve active tab before re-rendering
    const activeTab = document.querySelector('.view.active .tab.active')?.dataset.tab;
    // Only re-render the currently active view — not all views with non-null state.
    const activeView = document.querySelector('.view.active');
    const activeViewId = activeView?.id;
    if (activeViewId === 'view-dashboard') { if (typeof renderDashboardAlerts === 'function') renderDashboardAlerts(); }
    else if (activeViewId === 'view-all-sensors') { renderSensors(); }
    else if (activeViewId === 'view-contacts') { renderContacts(); }
    else if (activeViewId === 'view-communities') { renderCommunitiesList(); }
    else if (activeViewId === 'view-sensor-detail' && currentSensor) { showSensorView(currentSensor); }
    else if (activeViewId === 'view-community' && currentCommunity) { showCommunityView(currentCommunity); }
    else if (activeViewId === 'view-contact-detail' && currentContact) { showContactView(currentContact); }
    else if (activeViewId === 'view-collocations') { renderCollocationsView(); }
    // Restore active tab after re-render (showXxxView calls resetTabs which defaults to first tab)
    if (activeTab) {
        const container = document.querySelector('.view.active');
        if (container) {
            container.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
            container.querySelectorAll('.tab-content').forEach(tc => tc.classList.toggle('active', tc.id === 'tab-' + activeTab));
        }
    }
}

function getTimelineTypeClass(type) {
    const map = {
        'Audit': 'type-audit',
        'Movement': 'type-movement',
        'Issue': 'type-issue',
        'Communication': 'type-comm',
        'Status Change': 'type-status',
        'Info Edit': 'type-edit',
        'Site Work': 'type-audit',
        'Installation': 'type-audit',
        'Removal': 'type-movement',
        'Maintenance': 'type-audit',
        'Service': 'type-status',
    };
    return map[type] || '';
}

function buildTagsHTML(item) {
    let tags = '';
    if (item.taggedSensors) {
        tags += item.taggedSensors.map(s =>
            `<span class="tag tag-sensor" onclick="event.stopPropagation(); showSensorDetail('${s}')">${s}</span>`
        ).join('');
    }
    if (item.taggedCommunities) {
        tags += item.taggedCommunities.map(c =>
            `<span class="tag tag-community" onclick="event.stopPropagation(); showCommunity('${c}')">${getCommunityName(c)}</span>`
        ).join('');
    }
    if (item.taggedContacts) {
        tags += item.taggedContacts.map(cId => {
            const contact = contactMap[cId];
            return contact ? `<span class="tag tag-contact" onclick="event.stopPropagation(); showContactDetail('${cId}')">${contact.name}</span>` : '';
        }).join('');
    }
    return tags;
}

function highlightMentions(text) {
    return text.replace(/@([\w\s]+?)(?=\.|,|$|@)/g, '<strong style="color:var(--navy-600)">@$1</strong>');
}

const AK_TZ = 'America/Anchorage';

function nowDatetime() {
    const now = new Date();
    // Format in Alaska time
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: AK_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(now);
    const get = type => (parts.find(p => p.type === type) || {}).value || '00';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    if (typeof dateStr !== 'string') dateStr = String(dateStr);
    // Handle "2026-03-14", "2026-03-14T10:30", and ISO "2026-03-14T10:30:00.000Z"
    const hasTime = dateStr.includes('T') && dateStr.split('T')[1];
    const isUTC = dateStr.endsWith('Z') || dateStr.includes('+');
    let d;
    if (isUTC) {
        // Supabase timestamptz — parse as-is, display in Alaska
        d = new Date(dateStr);
    } else if (hasTime) {
        // Local datetime like "2026-04-08T14:30" — these are ALREADY in Alaska time
        // Parse as-is and display the raw values directly (no timezone conversion)
        const [datePart, timePart] = dateStr.split('T');
        const [y, m, day] = datePart.split('-').map(Number);
        const [hr, min] = (timePart || '00:00').split(':').map(Number);
        const dateDisplay = new Date(y, m - 1, day).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        const h = hr % 12 || 12;
        const ampm = hr >= 12 ? 'PM' : 'AM';
        const minStr = String(min).padStart(2, '0');
        return `${dateDisplay} at ${h}:${minStr} ${ampm}`;
    } else {
        d = new Date(dateStr + 'T12:00:00');
    }
    const datePart = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: AK_TZ });
    if (hasTime) {
        const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: AK_TZ });
        return `${datePart} at ${timePart}`;
    }
    return datePart;
}

// ===== @ MENTION AUTOCOMPLETE =====
function setupMentionAutocomplete(textarea, dropdown) {
    let mentionStart = -1;

    textarea.addEventListener('input', function() {
        const val = this.value;
        const cursorPos = this.selectionStart;

        // Find the last @ before the cursor
        const beforeCursor = val.substring(0, cursorPos);
        const atIndex = beforeCursor.lastIndexOf('@');

        if (atIndex >= 0) {
            const afterAt = beforeCursor.substring(atIndex + 1);
            // Only show dropdown if no newline between @ and cursor
            if (!afterAt.includes('\n')) {
                mentionStart = atIndex;
                const query = afterAt.toLowerCase();
                const matches = contacts.filter(c =>
                    c.name.toLowerCase().includes(query)
                );

                if (matches.length > 0 && query.length > 0) {
                    dropdown.innerHTML = matches.map((c, i) =>
                        `<div class="mention-option${i === 0 ? ' selected' : ''}" data-name="${escapeHtml(c.name)}" data-community="${escapeHtml(getCommunityName(c.community))}">
                            <span>${escapeHtml(c.name)}</span>
                            <span class="mention-community">${escapeHtml(getCommunityName(c.community))}</span>
                        </div>`
                    ).join('');
                    dropdown.classList.add('visible');

                    dropdown.querySelectorAll('.mention-option').forEach(opt => {
                        opt.addEventListener('mousedown', function(e) {
                            e.preventDefault();
                            insertMention(textarea, dropdown, mentionStart, this.dataset.name);
                        });
                    });
                    return;
                }
            }
        }

        dropdown.classList.remove('visible');
    });

    textarea.addEventListener('keydown', function(e) {
        if (!dropdown.classList.contains('visible')) return;

        const options = dropdown.querySelectorAll('.mention-option');
        const selected = dropdown.querySelector('.mention-option.selected');
        let selectedIndex = Array.from(options).indexOf(selected);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (selectedIndex < options.length - 1) {
                options[selectedIndex]?.classList.remove('selected');
                options[selectedIndex + 1]?.classList.add('selected');
                options[selectedIndex + 1]?.scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (selectedIndex > 0) {
                options[selectedIndex]?.classList.remove('selected');
                options[selectedIndex - 1]?.classList.add('selected');
                options[selectedIndex - 1]?.scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (selected) {
                e.preventDefault();
                insertMention(textarea, dropdown, mentionStart, selected.dataset.name);
            }
        } else if (e.key === 'Escape') {
            dropdown.classList.remove('visible');
        }
    });

    textarea.addEventListener('blur', function() {
        setTimeout(() => dropdown.classList.remove('visible'), 200);
    });
}

function insertMention(textarea, dropdown, startPos, name) {
    const before = textarea.value.substring(0, startPos);
    const after = textarea.value.substring(textarea.selectionStart);
    textarea.value = before + '@' + name + ' ' + after;
    const newPos = startPos + name.length + 2;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    dropdown.classList.remove('visible');
}

// ===== HELPER: Parse @mentions from text =====
function parseMentionedContacts(text) {
    const mentioned = [];
    const mentionRegex = /@([\w\s]+?)(?=\.|,|$|@)/g;
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
        const name = match[1].trim();
        const contact = contacts.find(c => c.name.toLowerCase() === name.toLowerCase());
        if (contact && !mentioned.includes(contact.id)) mentioned.push(contact.id);
    }
    return mentioned;
}

// ===== ADD COMMUNITY =====
let newCommunitySelectedTags = [];

function openAddCommunityModal() {
    document.getElementById('community-name-input').value = '';
    newCommunitySelectedTags = [];
    renderNewCommunityTags();
    // Populate parent select with existing top-level communities
    const parentSelect = document.getElementById('community-parent-input');
    parentSelect.innerHTML = '<option value="">— None (top-level) —</option>' +
        COMMUNITIES.filter(c => !isChildCommunity(c.id)).map(c =>
            `<option value="${c.id}">${escapeHtml(c.name)}</option>`
        ).join('');
    openModal('modal-add-community');
}

function openAddSubCommunityModal(parentId) {
    openAddCommunityModal();
    document.getElementById('community-parent-input').value = parentId;
}

function renderNewCommunityTags() {
    const allTags = getAllTags();
    document.getElementById('new-community-tags').innerHTML = allTags.map(tag => {
        const isActive = newCommunitySelectedTags.includes(tag);
        return `<span class="edit-tag-option ${isActive ? 'active' : ''}" onclick="toggleNewCommunityTag('${tag.replace(/'/g, "\\'")}')">${tag}</span>`;
    }).join('');
}

function toggleNewCommunityTag(tag) {
    if (newCommunitySelectedTags.includes(tag)) {
        newCommunitySelectedTags = newCommunitySelectedTags.filter(t => t !== tag);
    } else {
        newCommunitySelectedTags.push(tag);
    }
    renderNewCommunityTags();
}

function saveCommunity(e) {
    e.preventDefault();
    const name = document.getElementById('community-name-input').value.trim();
    if (!name) return;

    const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    // Check for duplicates (by ID or exact name)
    const dupById = COMMUNITIES.find(c => c.id === id);
    const dupByName = COMMUNITIES.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (dupById || dupByName) {
        showAlert('Duplicate Community', `A community named "${(dupByName || dupById).name}" already exists.`);
        return;
    }

    // Add to communities list (sorted)
    COMMUNITIES.push({ id, name });
    COMMUNITIES.sort((a, b) => a.name.localeCompare(b.name));
    communityNameMap[id] = name;

    // Set tags if any selected
    if (newCommunitySelectedTags.length > 0) {
        communityTags[id] = [...newCommunitySelectedTags];
    }

    // Set parent if selected
    const parentId = document.getElementById('community-parent-input').value;
    if (parentId) {
        communityParents[id] = parentId;
    }

    // Persist to Supabase
    persistCommunity({ id, name, parent_id: parentId || null });
    if (newCommunitySelectedTags.length > 0) {
        persistCommunityTags(id, newCommunitySelectedTags);
    }

    // Log sub-community creation
    if (!setupMode && parentId) {
        createNote('Info Edit', `Sub-community "${name}" added under ${getCommunityName(parentId)}.`, {
            sensors: [], communities: [parentId, id], contacts: [],
        });
    }

    buildSidebar();
    closeModal('modal-add-community');
    renderCommunitiesList();
    showCommunity(id);
}

// ===== COMMUNITY TAG EDITING =====
let editingTagsCommunity = null;

function openEditCommunityTags(communityId) {
    editingTagsCommunity = communityId;
    const community = COMMUNITIES.find(c => c.id === communityId);
    document.getElementById('edit-tags-community-name').textContent = community.name;
    document.getElementById('custom-tag-input').value = '';
    renderEditTagsList();
    openModal('modal-edit-community-tags');
}

function renderEditTagsList() {
    const current = getCommunityTags(editingTagsCommunity);
    // Combine available tags with any custom tags already on this community
    const allTags = [...new Set([...AVAILABLE_TAGS, ...current])].sort((a, b) => a.localeCompare(b));

    document.getElementById('edit-tags-list').innerHTML = allTags.map(tag => {
        const isActive = current.includes(tag);
        return `<span class="edit-tag-option ${isActive ? 'active' : ''}" onclick="toggleCommunityTag('${tag}')">${tag}</span>`;
    }).join('');
}

function toggleCommunityTag(tag) {
    if (!editingTagsCommunity) return;
    const current = getCommunityTags(editingTagsCommunity);
    const community = COMMUNITIES.find(c => c.id === editingTagsCommunity);

    if (current.includes(tag)) {
        // Remove tag
        communityTags[editingTagsCommunity] = current.filter(t => t !== tag);

        if (!setupMode) {
            createNote('Info Edit', `Tag "${tag}" removed from ${community.name}.`, {
                sensors: [], communities: [editingTagsCommunity], contacts: [],
            });
        }
    } else {
        // Add tag
        if (!communityTags[editingTagsCommunity]) communityTags[editingTagsCommunity] = [];
        communityTags[editingTagsCommunity].push(tag);

        if (!setupMode) {
            createNote('Info Edit', `Tag "${tag}" added to ${community.name}.`, {
                sensors: [], communities: [editingTagsCommunity], contacts: [],
            });
        }
    }

    trackRecent('communities', editingTagsCommunity, 'edited');
    persistCommunityTags(editingTagsCommunity, getCommunityTags(editingTagsCommunity));
    renderEditTagsList();
    buildSidebar(); // Update sidebar tag list
    // Refresh community view if it's showing
    if (currentCommunity === editingTagsCommunity) showCommunityView(editingTagsCommunity);
}

function addCustomTag() {
    const input = document.getElementById('custom-tag-input');
    const tag = input.value.trim();
    if (!tag || !editingTagsCommunity) return;

    // Add to AVAILABLE_TAGS if not already there
    if (!AVAILABLE_TAGS.includes(tag)) AVAILABLE_TAGS.push(tag);

    const current = getCommunityTags(editingTagsCommunity);
    if (!current.includes(tag)) {
        if (!communityTags[editingTagsCommunity]) communityTags[editingTagsCommunity] = [];
        communityTags[editingTagsCommunity].push(tag);

        const community = COMMUNITIES.find(c => c.id === editingTagsCommunity);
        if (!setupMode) {
            createNote('Info Edit', `Tag "${tag}" added to ${community.name}.`, {
                sensors: [], communities: [editingTagsCommunity], contacts: [],
            });
        }
        persistCommunityTags(editingTagsCommunity, getCommunityTags(editingTagsCommunity));
    }

    input.value = '';
    renderEditTagsList();
    buildSidebar(); // Update sidebar with new tag
    if (currentCommunity === editingTagsCommunity) showCommunityView(editingTagsCommunity);
}

// ===== STATUS TOGGLE LIST =====
const MANUAL_STATUSES = [
    'Online', 'Offline', 'Lost Connection', 'Lab Storage', 'Ready for Deployment', 'Needs Repair'
];

// Statuses that are normally managed by workflows (collocation tool, audit workflow, Quant service tickets,
// or detected from sensor data). Users can still pick them, but a warning confirms they really want to override.
const AUTO_STATUSES = [
    'Collocation', 'Auditing a Community', 'In Transit Between Audits',
    'Service at Quant', 'Quant Ticket in Progress',
    'PM Sensor Issue', 'Gaseous Sensor Issue', 'SD Card Issue'
];

const AUTO_STATUS_WARNINGS = {
    'Collocation': '<strong>Collocation</strong> is typically applied automatically when you start a collocation. Consider using the Collocation tool instead.<br><br>Apply this status manually anyway?',
    'Auditing a Community': '<strong>Auditing a Community</strong> is typically applied automatically when an audit begins. Consider starting the audit from the Collocation tool instead.<br><br>Apply this status manually anyway?',
    'In Transit Between Audits': '<strong>In Transit Between Audits</strong> is typically applied automatically as audit pods move between communities. Consider using the Collocation/audit workflow instead.<br><br>Apply this status manually anyway?',
    'Service at Quant': '<strong>Service at Quant</strong> is typically applied automatically by Quant service ticket progression. Consider opening or advancing a Quant ticket instead.<br><br>Apply this status manually anyway?',
    'Quant Ticket in Progress': '<strong>Quant Ticket in Progress</strong> is typically applied automatically when a Quant service ticket is opened. Consider creating a ticket from the Service section instead.<br><br>Apply this status manually anyway?',
    'PM Sensor Issue': '<strong>PM Sensor Issue</strong> is typically applied automatically from sensor data QA/audit results. Consider logging the issue through the audit or service workflow instead.<br><br>Apply this status manually anyway?',
    'Gaseous Sensor Issue': '<strong>Gaseous Sensor Issue</strong> is typically applied automatically from sensor data QA/audit results. Consider logging the issue through the audit or service workflow instead.<br><br>Apply this status manually anyway?',
    'SD Card Issue': '<strong>SD Card Issue</strong> is typically applied automatically when SD card problems are detected. Consider logging the issue through the audit or service workflow instead.<br><br>Apply this status manually anyway?'
};

// Combined list preserved for legacy call sites (selects, filters, etc.)
const ALL_STATUSES = [...MANUAL_STATUSES, ...AUTO_STATUSES];

function renderStatusToggleList(containerId, selectedStatuses) {
    const container = document.getElementById(containerId);
    const renderGroup = (list) => list.map(st => {
        const isActive = selectedStatuses.includes(st);
        const badgeClass = getStatusBadgeClass(st);
        const isAuto = AUTO_STATUSES.includes(st);
        return `<span class="status-toggle-option ${isActive ? 'active' : ''}${isAuto ? ' is-auto' : ''}" data-status="${st}" onclick="toggleStatusOption(this)">
            <span class="badge ${badgeClass}" style="pointer-events:none">${st}</span>
        </span>`;
    }).join('');

    container.innerHTML = `
        <div class="status-toggle-group-label">Manually applied</div>
        <div class="status-toggle-list">${renderGroup(MANUAL_STATUSES)}</div>
        <div class="status-toggle-group-label status-toggle-group-label--auto">
            Typically auto-applied
            <span class="status-toggle-group-hint">managed by collocation, audit, and service ticket workflows</span>
        </div>
        <div class="status-toggle-list">${renderGroup(AUTO_STATUSES)}</div>
    `;
}

function toggleStatusOption(el) {
    const status = el.dataset.status;
    const isBecomingActive = !el.classList.contains('active');

    // Warn before manually applying a status that's normally auto-managed
    if (isBecomingActive && AUTO_STATUS_WARNINGS[status]) {
        showConfirm(
            'Auto-applied status',
            AUTO_STATUS_WARNINGS[status],
            () => applyStatusToggle(el, status, isBecomingActive),
            { confirmText: 'Apply manually', cancelText: 'Cancel' }
        );
        return;
    }

    applyStatusToggle(el, status, isBecomingActive);
}

function applyStatusToggle(el, status, isBecomingActive) {
    el.classList.toggle('active');

    // Online and Offline are mutually exclusive
    if (isBecomingActive && (status === 'Online' || status === 'Offline')) {
        const opposite = status === 'Online' ? 'Offline' : 'Online';
        const root = el.closest('.modal, form, body') || document;
        const oppositeEl = root.querySelector(`.status-toggle-option[data-status="${opposite}"]`);
        if (oppositeEl) oppositeEl.classList.remove('active');
    }
}

function saveSetupSensorStatus(sensorId) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;
    const container = document.getElementById('setup-sensor-status-' + sensorId);
    if (!container) return;
    s.status = Array.from(container.querySelectorAll('.status-toggle-option.active')).map(el => el.dataset.status);
    persistSensor(s);
    buildSensorSidebar();
}

function getSelectedStatuses(containerId) {
    const container = document.getElementById(containerId);
    return Array.from(container.querySelectorAll('.status-toggle-option.active')).map(el => el.dataset.status);
}

const FILTER_GROUPS = {
    '_movement': ['Movement', 'Sensor Install', 'Sensor Removal', 'Sensor Install + Sensor Removal'],
    '_troubleshooting': ['Troubleshooting', 'Site Work', 'Issue', 'Maintenance', 'Troubleshooting + Site Work'],
    '_status': ['Status Change'],
    '_general': ['General', 'Info Edit'],
};

// Note types handled by dedicated tabs on the sensor detail page — excluded from the history timeline
const SENSOR_HISTORY_EXCLUDED_TYPES = ['Audit', 'Collocation', 'Service'];

function filterSensorHistory() {
    if (!currentSensor) return;
    const filterVal = document.getElementById('sensor-history-filter')?.value || '';

    let sensorNotes = notes.filter(n => n.taggedSensors && n.taggedSensors.includes(currentSensor));
    sensorNotes = sensorNotes.filter(n => !SENSOR_HISTORY_EXCLUDED_TYPES.some(t => n.type === t || (n.type && n.type.startsWith(t + ' '))));

    if (filterVal && FILTER_GROUPS[filterVal]) {
        const group = FILTER_GROUPS[filterVal];
        sensorNotes = sensorNotes.filter(n => {
            if (group.includes(n.type)) return true;
            // Also match combined types like "Sensor Install + Status Change"
            return group.some(g => n.type && n.type.includes(g));
        });
    } else if (filterVal) {
        sensorNotes = sensorNotes.filter(n => n.type === filterVal);
    }

    renderTimeline('sensor-history-timeline', sensorNotes);
}

// ===== TAG-CHIP INPUTS (Facebook Marketplace style) =====
function setupTagChipInput(containerId, getOptions, getLabel) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const chips = container.querySelector('.tag-chips');
    const input = container.querySelector('.tag-chip-input');
    const dropdown = container.querySelector('.tag-chip-dropdown');

    if (!input || !dropdown) return;

    input.addEventListener('input', function() {
        const query = this.value.toLowerCase().trim();
        if (query.length === 0) {
            dropdown.classList.remove('visible');
            return;
        }

        const currentTags = getChipValues(containerId);
        const options = getOptions().filter(opt =>
            getLabel(opt).toLowerCase().includes(query) &&
            !currentTags.includes(getLabel(opt))
        );

        if (options.length > 0) {
            dropdown.innerHTML = options.map((opt, i) =>
                `<div class="mention-option${i === 0 ? ' selected' : ''}" data-value="${getLabel(opt)}">
                    <span>${getLabel(opt)}</span>
                </div>`
            ).join('');
            dropdown.classList.add('visible');

            dropdown.querySelectorAll('.mention-option').forEach(opt => {
                opt.addEventListener('mousedown', function(e) {
                    e.preventDefault();
                    addChip(containerId, this.dataset.value);
                    input.value = '';
                    dropdown.classList.remove('visible');
                    input.focus();
                });
            });
        } else {
            dropdown.classList.remove('visible');
        }
    });

    input.addEventListener('keydown', function(e) {
        if (dropdown.classList.contains('visible')) {
            const options = dropdown.querySelectorAll('.mention-option');
            const selected = dropdown.querySelector('.mention-option.selected');
            let idx = Array.from(options).indexOf(selected);

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (idx < options.length - 1) {
                    options[idx]?.classList.remove('selected');
                    options[idx + 1]?.classList.add('selected');
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (idx > 0) {
                    options[idx]?.classList.remove('selected');
                    options[idx - 1]?.classList.add('selected');
                }
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                if (selected) {
                    e.preventDefault();
                    addChip(containerId, selected.dataset.value);
                    input.value = '';
                    dropdown.classList.remove('visible');
                }
            } else if (e.key === 'Escape') {
                dropdown.classList.remove('visible');
            }
        }

        // Backspace to remove last chip
        if (e.key === 'Backspace' && input.value === '') {
            const lastChip = chips.querySelector('.tag-chip:last-of-type');
            if (lastChip) lastChip.remove();
        }
    });

    input.addEventListener('blur', function() {
        setTimeout(() => dropdown.classList.remove('visible'), 200);
    });
}

function addChip(containerId, value) {
    const container = document.getElementById(containerId);
    const chips = container.querySelector('.tag-chips');
    const input = container.querySelector('.tag-chip-input');

    // Don't add duplicates
    const existing = chips.querySelectorAll('.tag-chip');
    for (const chip of existing) {
        if (chip.dataset.value === value) return;
    }

    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.dataset.value = value;
    chip.innerHTML = `${escapeHtml(value)} <span class="tag-chip-remove" onclick="this.parentElement.remove()">&times;</span>`;
    chips.insertBefore(chip, input);
}

function getChipValues(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return Array.from(container.querySelectorAll('.tag-chip')).map(c => c.dataset.value);
}

function prefillChip(containerId, value) {
    if (value) addChip(containerId, value);
}

// ===== TABS =====
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab')) {
        const tabId = e.target.dataset.tab;
        const container = e.target.closest('.view');

        container.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');

        container.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
        document.getElementById('tab-' + tabId).classList.add('active');
    }
});

function resetTabs(container) {
    const tabs = container.querySelectorAll('.tab');
    const contents = container.querySelectorAll('.tab-content');
    tabs.forEach((t, i) => t.classList.toggle('active', i === 0));
    contents.forEach((c, i) => c.classList.toggle('active', i === 0));
}

// ===== MODALS =====
function openModal(id) {
    document.getElementById(id).classList.add('open');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('open');
}

// Escape key closes the topmost open modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // Close analysis modal first if open (it sits on top)
        const analysisModal = document.getElementById('modal-audit-analysis');
        if (analysisModal?.classList.contains('open')) { closeAnalysisModal(); return; }
        // Close any popover first
        const popover = document.querySelector('.axis-popover');
        if (popover) { popover.remove(); return; }
        // Close the topmost regular modal
        const modals = document.querySelectorAll('.modal.open');
        if (modals.length > 0) { closeModal(modals[modals.length - 1].id); }
    }
});

// Modals only close via X, Cancel, or Save buttons — not by clicking outside

// ===== HELPERS =====
function populateCommunitySelect(selectId) {
    const select = document.getElementById(selectId);
    const currentVal = select.value;
    select.innerHTML = '<option value="">— Select —</option>' +
        [...COMMUNITIES].sort((a, b) => a.name.localeCompare(b.name)).map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    if (currentVal) select.value = currentVal;
}

function populateGroupedCommunitySelect(selectId) {
    const select = document.getElementById(selectId);
    const currentVal = select.value;
    const sorted = [...COMMUNITIES].sort((a, b) => a.name.localeCompare(b.name));
    const topLevel = sorted.filter(c => !isChildCommunity(c.id));

    let options = '<option value="">— Select —</option>';
    topLevel.forEach(parent => {
        options += `<option value="${parent.id}">${parent.name}</option>`;
        const children = getChildCommunities(parent.id);
        children.forEach(child => {
            options += `<option value="${child.id}">\u00A0\u00A0\u00A0\u00A0${child.name}</option>`;
        });
    });

    select.innerHTML = options;
    if (currentVal) select.value = currentVal;
}

// ===== SETTINGS & USER MANAGEMENT =====
async function renderSettings() {
    const profile = await db.getProfile();
    const session = await db.getSession();
    const userEmail = session?.user?.email || '';

    document.getElementById('settings-profile').innerHTML = `
        <div class="info-item"><label>Name</label><p class="settings-editable-name" onclick="editProfileName(this)" title="Click to edit">${escapeHtml(profile?.name || '—')} <span style="font-size:11px;color:var(--slate-300);margin-left:4px">&#9998;</span></p></div>
        <div class="info-item"><label>Email</label><p>${escapeHtml(userEmail)}</p></div>
    `;

    await renderAllowedUsers(userEmail);
    await renderMfaSettings();
}

function editProfileName(el) {
    const current = el.textContent.replace('✎', '').trim();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current === '—' ? '' : current;
    input.style.cssText = 'font-size:14px;padding:4px 8px;border:1px solid var(--slate-200);border-radius:6px;width:100%;font-family:var(--font-sans)';
    input.placeholder = 'Enter your name';
    el.innerHTML = '';
    el.appendChild(input);
    input.focus();
    input.select();

    const save = async () => {
        const newName = input.value.trim();
        if (!newName) { renderSettings(); return; }
        if (newName !== current) {
            const session = await db.getSession();
            if (session?.user?.id) {
                await supa.from('profiles').update({ name: newName }).eq('id', session.user.id);
                currentUser = newName;
                document.querySelector('#sidebar-user .user-name').textContent = newName;
            }
        }
        renderSettings();
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { renderSettings(); }
    });
}

async function renderAllowedUsers(currentEmail) {
    const isAdmin = currentUserRole === 'admin';
    const { data, error } = await supa.from('allowed_emails').select('*').order('email');
    if (error) { console.error(error); return; }

    // Get profiles to determine who has actually signed up
    const { data: profiles } = await supa.from('profiles').select('email');
    const signedUpEmails = new Set((profiles || []).map(p => (p.email || '').toLowerCase()).filter(Boolean));

    // Show/hide admin-only controls
    document.getElementById('settings-add-user-row').style.display = isAdmin ? '' : 'none';

    const active = (data || []).filter(r => r.status === 'active' && signedUpEmails.has(r.email.toLowerCase()));
    const pending = (data || []).filter(r => r.status === 'active' && !signedUpEmails.has(r.email.toLowerCase()));
    const archived = (data || []).filter(r => r.status === 'archived' || r.status === 'revoked');

    document.getElementById('settings-active-users').innerHTML = active.map(row => {
        const isYou = row.email.toLowerCase() === currentEmail.toLowerCase();
        const roleBadge = row.role === 'admin'
            ? '<span style="background:var(--navy-800);color:white;padding:1px 8px;border-radius:8px;font-size:10px;font-weight:600;margin-left:6px">Admin</span>'
            : '';
        const roleToggle = isAdmin && !isYou
            ? `<select class="btn btn-sm" onchange="changeUserRole('${row.id}', this.value)" style="font-size:11px;padding:2px 6px">
                <option value="user" ${row.role !== 'admin' ? 'selected' : ''}>User</option>
                <option value="admin" ${row.role === 'admin' ? 'selected' : ''}>Admin</option>
               </select>`
            : '';
        const archiveBtn = isAdmin && !isYou
            ? `<button class="btn btn-sm btn-danger" onclick="archiveUser('${row.id}')">Archive</button>`
            : '';
        const deleteBtn = isAdmin && !isYou
            ? `<button class="btn btn-sm" style="color:#e11d48;border-color:#fecdd3;font-size:11px;font-weight:600" onclick="permanentlyDeleteUser('${row.id}', '${escapeHtml(row.email).replace(/'/g, "\\&#39;")}')">Delete</button>`
            : '';
        const resetMfaBtn = isAdmin && !isYou
            ? `<button class="btn btn-sm" style="font-size:11px" onclick="adminResetMfa('${escapeHtml(row.email).replace(/'/g, "\\&#39;")}')">Reset MFA</button>`
            : '';
        return `<div class="settings-user-row">
            <span>
                <span class="settings-user-email">${escapeHtml(row.email)}</span>
                ${roleBadge}
                ${isYou ? '<span class="settings-user-you">(you)</span>' : ''}
            </span>
            <span style="display:flex;gap:6px;align-items:center">${roleToggle}${resetMfaBtn}${archiveBtn}${deleteBtn}</span>
        </div>`;
    }).join('') || '<p style="color:var(--slate-400);font-size:13px">No active users.</p>';

    // Pending invites
    const pendingSection = document.getElementById('settings-pending-section');
    if (pending.length > 0 && isAdmin) {
        pendingSection.style.display = '';
        document.getElementById('settings-pending-users').innerHTML = pending.map(row => {
            return `<div class="settings-user-row">
                <span>
                    <span class="settings-user-email">${escapeHtml(row.email)}</span>
                    <span style="background:#fff8e8;color:#8a6d20;padding:1px 8px;border-radius:8px;font-size:10px;font-weight:600;margin-left:6px">Pending</span>
                </span>
                <span style="display:flex;gap:6px;align-items:center">
                    <button class="btn btn-sm" style="color:#e11d48;border-color:#fecdd3;font-size:11px;font-weight:600" onclick="permanentlyDeleteUser('${row.id}', '${escapeHtml(row.email).replace(/'/g, "\\&#39;")}')">Revoke</button>
                </span>
            </div>`;
        }).join('');
    } else {
        pendingSection.style.display = 'none';
    }

    const archivedSection = document.getElementById('settings-archived-section');
    if (archived.length > 0 && isAdmin) {
        archivedSection.style.display = '';
        document.getElementById('settings-archived-users').innerHTML = archived.map(row => {
            return `<div class="settings-user-row">
                <span class="settings-user-email" style="color:var(--slate-400)">${escapeHtml(row.email)}</span>
                <span style="display:flex;gap:6px;align-items:center">
                    <button class="btn btn-sm" onclick="reactivateUser('${row.id}')">Reactivate</button>
                    <button class="btn btn-sm" style="color:#e11d48;border-color:#fecdd3;font-size:11px;font-weight:600" onclick="permanentlyDeleteUser('${row.id}', '${escapeHtml(row.email).replace(/'/g, "\\&#39;")}')">Delete</button>
                </span>
            </div>`;
        }).join('');
    } else {
        archivedSection.style.display = 'none';
    }

}

function openInviteUserModal() {
    if (currentUserRole !== 'admin') { showAlert('Access Denied', 'Only admins can invite users.'); return; }
    resetInviteModal();
    openModal('modal-invite-user');
}

function resetInviteModal() {
    document.getElementById('invite-modal-title').textContent = 'Invite New User';
    document.getElementById('invite-email').value = '';
    document.getElementById('invite-role').value = 'user';
    document.getElementById('invite-step-form').style.display = '';
    document.getElementById('invite-step-success').style.display = 'none';
    const errEl = document.getElementById('invite-error');
    errEl.textContent = '';
    errEl.classList.remove('visible');
}

function closeInviteModal() {
    closeModal('modal-invite-user');
    // Refresh user list in case invites were added
    (async () => {
        const session = await db.getSession();
        await renderAllowedUsers(session?.user?.email || '');
    })();
}

async function sendUserInvite(event) {
    event.preventDefault();
    if (currentUserRole !== 'admin') { showAlert('Access Denied', 'Only admins can invite users.'); return; }

    const email = document.getElementById('invite-email').value.trim().toLowerCase();
    const role = document.getElementById('invite-role').value || 'user';
    const errEl = document.getElementById('invite-error');
    errEl.textContent = '';
    errEl.classList.remove('visible');

    if (!email) { errEl.textContent = 'Please enter an email address.'; errEl.classList.add('visible'); return; }

    const btn = document.getElementById('invite-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    // Add to allowed_emails only (no Supabase Auth invite — that creates passwordless accounts that block signup)
    const { error } = await supa.rpc('send_user_invite', { invite_email: email, invite_role: role });
    if (error) {
        errEl.textContent = error.message.includes('already an active') ? 'That email is already an active user.' : error.message;
        errEl.classList.add('visible');
        btn.disabled = false;
        btn.textContent = 'Send Invite';
        return;
    }

    // Send invite email via mailto
    const signupUrl = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');
    const inviterName = currentUser || 'An administrator';
    const subject = "You're invited to the AMQA Sensor Network Tracker";
    const body = `${inviterName} has invited you to the AMQA Community Sensor Network Tracking Platform.\n\nCreate your account:\n\n    ${signupUrl}\n\nSign up with this email (${email}). You'll set up two-factor authentication on your first login.`;
    window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    // Show success state
    document.getElementById('invite-modal-title').textContent = 'Invite Sent';
    document.getElementById('invite-success-email').innerHTML = `<strong>${escapeHtml(email)}</strong> has been approved.<br>Your email app has opened with the invitation — just hit send.`;
    document.getElementById('invite-step-form').style.display = 'none';
    document.getElementById('invite-step-success').style.display = '';
    btn.disabled = false;
    btn.textContent = 'Send Invite';
}

async function archiveUser(id) {
    if (currentUserRole !== 'admin') { showAlert('Access Denied', 'Only admins can archive users.'); return; }
    showConfirm('Archive User', 'Archive this user? They will no longer be able to sign in, but their history and edits will be preserved. You can reactivate them later.', async () => {
        const { error } = await supa.from('allowed_emails').update({ status: 'archived' }).eq('id', id);
        if (error) { showAlert('Error', error.message); return; }

        const session = await db.getSession();
        await renderAllowedUsers(session?.user?.email || '');
    });
}

async function reactivateUser(id) {
    if (currentUserRole !== 'admin') { showAlert('Access Denied', 'Only admins can reactivate users.'); return; }
    const { error } = await supa.from('allowed_emails').update({ status: 'active' }).eq('id', id);
    if (error) { showAlert('Error', error.message); return; }

    const session = await db.getSession();
    await renderAllowedUsers(session?.user?.email || '');
}

async function permanentlyDeleteUser(id, email) {
    if (currentUserRole !== 'admin') { showAlert('Access Denied', 'Only admins can delete users.'); return; }

    // First warning — recommend archiving instead
    showConfirm('Delete User', 'Are you sure you want to permanently delete this user?<br><br>If this user has simply become inactive, you should <strong>archive</strong> them instead. Archiving preserves their account so it can be reactivated later.', () => {
        // Second warning — final confirmation
        showConfirm('Final Warning', 'This action cannot be undone!<br><br>Permanently deleting <strong>"' + email + '"</strong> will:<br>&bull; Remove their account entirely<br>&bull; Change all their past edits and notes to show "[Deleted User]"<br><br>Are you absolutely sure you want to delete this user?', async () => {
            try {
                // Anonymize in-memory data
                const { data: profileRow } = await supa.from('profiles').select('id').eq('email', email).maybeSingle();
                if (profileRow) {
                    notes.forEach(n => { if (n.createdById === profileRow.id) n.createdBy = '[Deleted User]'; });
                    comms.forEach(c => { if (c.createdById === profileRow.id) c.createdBy = '[Deleted User]'; });
                }

                // Delete auth user, profile, and allowed_emails entry via RPC
                await supa.rpc('delete_auth_user', { user_email: email });
                await supa.from('allowed_emails').delete().eq('id', id);

                const session = await db.getSession();
                await renderAllowedUsers(session?.user?.email || '');
            } catch (err) {
                showAlert('Error', 'Failed to delete user: ' + err.message);
            }
        }, { danger: true, confirmText: 'Delete Permanently' });
    }, { danger: true, confirmText: 'Continue' });
}

async function changeUserRole(id, newRole) {
    if (currentUserRole !== 'admin') { showAlert('Access Denied', 'Only admins can change roles.'); return; }
    const { error } = await supa.from('allowed_emails').update({ role: newRole }).eq('id', id);
    if (error) { showAlert('Error', error.message); return; }

    // Also update the profile if the user has one
    const { data: emailRow } = await supa.from('allowed_emails').select('email').eq('id', id).maybeSingle();
    if (emailRow) {
        await supa.from('profiles').update({ role: newRole }).eq('email', emailRow.email);
    }

    const session = await db.getSession();
    await renderAllowedUsers(session?.user?.email || '');
}

async function toggleMfaRequirement(enabled) {
    if (currentUserRole !== 'admin') { showAlert('Access Denied', 'Only admins can change MFA settings.'); return; }
    try {
        await db.setAppSetting('mfa_required', enabled ? 'true' : 'false');
        mfaRequired = enabled;
    } catch (err) {
        showAlert('Error', 'Failed to update MFA setting: ' + err.message);
    }
}

// ===== CHANGE PASSWORD =====
let _pwPendingNewPassword = null;
let _pwPendingFactorId = null;

async function changePassword(event) {
    event.preventDefault();
    const errorEl = document.getElementById('pw-error');
    const successEl = document.getElementById('pw-success');
    const btn = document.getElementById('pw-submit-btn');
    const stepPasswords = document.getElementById('pw-step-passwords');
    const stepMfa = document.getElementById('pw-step-mfa');
    errorEl.textContent = '';
    errorEl.classList.remove('visible');
    successEl.style.display = 'none';

    // Step 2: MFA verification — user is submitting the code
    if (_pwPendingNewPassword) {
        const mfaCode = document.getElementById('pw-mfa-code').value.trim();
        if (!mfaCode || mfaCode.length !== 6) {
            errorEl.textContent = 'Please enter your 6-digit code.';
            errorEl.classList.add('visible');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Verifying...';

        try {
            const { data: challenge, error: challengeErr } = await supa.auth.mfa.challenge({ factorId: _pwPendingFactorId });
            if (challengeErr) { errorEl.textContent = challengeErr.message; errorEl.classList.add('visible'); return; }
            const { error: verifyErr } = await supa.auth.mfa.verify({ factorId: _pwPendingFactorId, challengeId: challenge.id, code: mfaCode });
            if (verifyErr) {
                errorEl.textContent = 'Invalid code. Please try again.';
                errorEl.classList.add('visible');
                document.getElementById('pw-mfa-code').value = '';
                document.getElementById('pw-mfa-code').focus();
                return;
            }

            const { error: updateErr } = await supa.auth.updateUser({ password: _pwPendingNewPassword });
            if (updateErr) { errorEl.textContent = updateErr.message; errorEl.classList.add('visible'); return; }

            // Success — reset everything
            resetPasswordForm();
            successEl.textContent = 'Password updated successfully.';
            successEl.style.display = 'block';
            setTimeout(() => { successEl.style.display = 'none'; }, 5000);
        } catch (err) {
            errorEl.textContent = err.message || 'Failed to update password.';
            errorEl.classList.add('visible');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Confirm & Update Password';
        }
        return;
    }

    // Step 1: Validate passwords
    const currentPw = document.getElementById('pw-current').value;
    const newPw = document.getElementById('pw-new').value;
    const confirmPw = document.getElementById('pw-confirm').value;

    if (newPw !== confirmPw) { errorEl.textContent = 'New passwords do not match.'; errorEl.classList.add('visible'); return; }
    if (newPw.length < 8) { errorEl.textContent = 'Password must be at least 8 characters.'; errorEl.classList.add('visible'); return; }
    if (!/[a-zA-Z]/.test(newPw)) { errorEl.textContent = 'Password must include at least one letter.'; errorEl.classList.add('visible'); return; }
    if (!/[0-9]/.test(newPw)) { errorEl.textContent = 'Password must include at least one number.'; errorEl.classList.add('visible'); return; }
    if (!/[^a-zA-Z0-9]/.test(newPw)) { errorEl.textContent = 'Password must include at least one symbol (e.g. !@#$%).'; errorEl.classList.add('visible'); return; }
    if (newPw === currentPw) { errorEl.textContent = 'New password must be different from current password.'; errorEl.classList.add('visible'); return; }

    btn.disabled = true;
    btn.textContent = 'Updating...';

    try {
        // Check if MFA verification is needed (Supabase requires AAL2 if account has a verified factor)
        const { data: factors } = await supa.auth.mfa.listFactors();
        const totp = factors?.totp?.find(f => f.status === 'verified');

        if (totp) {
            // Show MFA step, hide password fields
            _pwPendingNewPassword = newPw;
            _pwPendingFactorId = totp.id;
            stepPasswords.style.display = 'none';
            stepMfa.style.display = '';
            btn.textContent = 'Confirm & Update Password';
            btn.disabled = false;
            document.getElementById('pw-mfa-code').value = '';
            document.getElementById('pw-mfa-code').focus();
            return;
        }

        // No MFA — update directly
        const { error: updateErr } = await supa.auth.updateUser({ password: newPw });
        if (updateErr) { errorEl.textContent = updateErr.message; errorEl.classList.add('visible'); return; }

        resetPasswordForm();
        successEl.textContent = 'Password updated successfully.';
        successEl.style.display = 'block';
        setTimeout(() => { successEl.style.display = 'none'; }, 5000);
    } catch (err) {
        errorEl.textContent = err.message || 'Failed to update password.';
        errorEl.classList.add('visible');
    } finally {
        btn.disabled = false;
        if (!_pwPendingNewPassword) btn.textContent = 'Update Password';
    }
}

function resetPasswordForm() {
    _pwPendingNewPassword = null;
    _pwPendingFactorId = null;
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
    document.getElementById('pw-confirm').value = '';
    document.getElementById('pw-mfa-code').value = '';
    document.getElementById('pw-step-passwords').style.display = '';
    document.getElementById('pw-step-mfa').style.display = 'none';
    document.getElementById('pw-submit-btn').textContent = 'Update Password';
}

// ===== MFA =====
async function renderMfaSettings() {
    const { data: factors } = await supa.auth.mfa.listFactors();
    const totp = factors?.totp?.find(f => f.status === 'verified');
    const container = document.getElementById('settings-mfa');
    const isAdmin = currentUserRole === 'admin';

    let html = '';

    // Status message
    if (mfaRequired) {
        html += `<p style="color:#16a34a;font-weight:600;font-size:14px;margin-bottom:12px">MFA is enabled. A 6-digit authenticator code is required on every sign-in.</p>`;
    } else {
        html += `<p style="color:#dc2626;font-weight:600;font-size:14px;margin-bottom:12px">MFA is disabled. No code is required on sign-in, but all users are required to set up MFA when creating their account.</p>`;
    }

    // User's own MFA status
    if (totp) {
        html += `<div style="background:var(--slate-50);border:1px solid var(--slate-200);border-radius:8px;padding:12px 16px;margin-bottom:16px">
            <p style="font-size:13px;color:var(--slate-600)">Your authenticator is set up and active.</p>
            <p style="font-size:11px;color:var(--slate-400);margin-top:6px">Lost access to your authenticator app? Contact an administrator to reset your MFA.</p>
        </div>`;
    } else {
        html += `<div style="background:#fff8e8;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;margin-bottom:16px">
            <p style="font-size:13px;color:#8a6d20;font-weight:600">Your MFA setup is pending.</p>
            <p style="font-size:12px;color:#8a6d20;margin-top:4px">You'll be prompted to set up your authenticator app on your next sign-in.</p>
        </div>`;
    }

    // Admin toggle
    if (isAdmin) {
        html += `<div style="border-top:1px solid var(--slate-200);padding-top:16px;margin-top:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                <div>
                    <p style="font-size:13px;font-weight:600;color:var(--slate-700)">Require MFA on every sign-in</p>
                    <p style="font-size:11px;color:var(--slate-400)">Only administrators can change this setting.</p>
                </div>
                <label class="mfa-toggle-switch">
                    <input type="checkbox" ${mfaRequired ? 'checked' : ''} onchange="confirmMfaToggle(this.checked, this)">
                    <span class="mfa-toggle-slider"></span>
                </label>
            </div>
        </div>`;
    }

    container.innerHTML = html;
}

async function confirmMfaToggle(enabled, checkbox) {
    const action = enabled ? 'enable' : 'disable';
    const message = enabled
        ? 'This will require <strong>all users</strong> to enter a 6-digit authenticator code every time they sign in.<br><br>Are you sure you want to enable MFA enforcement?'
        : 'This will allow users to sign in <strong>without</strong> an authenticator code. All users still have MFA set up from account creation and can re-enable it at any time.<br><br>Are you sure you want to disable MFA enforcement?';

    showConfirm(`${enabled ? 'Enable' : 'Disable'} MFA for All Users`, message, async () => {
        await toggleMfaRequirement(enabled);
        await renderMfaSettings();
    }, {
        confirmText: `Yes, ${action} MFA`,
        danger: !enabled,
        onCancel: () => { checkbox.checked = !enabled; }
    });
}

async function adminResetMfa(email) {
    if (currentUserRole !== 'admin') { showAlert('Access Denied', 'Only admins can reset MFA.'); return; }
    showConfirm('Reset MFA', `Reset MFA for <strong>${escapeHtml(email)}</strong>?<br><br>Their authenticator will be removed and they will need to set up a new one on their next sign-in.`, async () => {
        try {
            const { error } = await supa.rpc('admin_reset_mfa', { target_email: email });
            if (error) { showAlert('Error', error.message); return; }
            showAlert('MFA Reset', `MFA has been reset for ${email}. They will be prompted to set up a new authenticator on their next sign-in.`);
        } catch (err) {
            showAlert('Error', 'Failed to reset MFA: ' + err.message);
        }
    }, { danger: true, confirmText: 'Reset MFA' });
}

// ===== SENSOR TAGS & SIDEBAR =====
const SENSOR_ISSUE_STATUSES = ['PM Sensor Issue', 'Gaseous Sensor Issue', 'SD Card Issue', 'Needs Repair', 'Lost Connection'];

function isIssueSensor(s) {
    if (getStatusArray(s).some(st => SENSOR_ISSUE_STATUSES.includes(st))) return true;
    if (serviceTickets.some(t => t.sensorId === s.id && t.status !== 'Closed')) return true;
    return false;
}

function getIssueSensorCount() {
    return sensors.filter(isIssueSensor).length;
}

function getSensorTags() {
    return [
        { label: 'Issue Sensors', id: 'Issue Sensors', count: getIssueSensorCount() },
        { label: 'Community Pod', id: 'Community Pod', count: sensors.filter(s => s.type === 'Community Pod').length },
        { label: 'Audit & Permanent Pods', id: 'Audit & Permanent Pods', count: sensors.filter(s => s.type === 'Audit Pod' || s.type === 'Permanent Pod').length },
        { label: 'Collocation/Health Check', id: 'Collocation/Health Check', count: sensors.filter(s => s.type === 'Collocation/Health Check').length },
        { label: 'Not Assigned', id: 'Not Assigned', count: sensors.filter(s => s.type === 'Not Assigned').length },
    ];
}

let sensorTagFilter = '';

function buildSensorSidebar() {
    const list = document.getElementById('sensor-tag-list');
    const tags = getSensorTags();
    list.innerHTML = tags.map(tag =>
        `<li><a href="#" data-sensor-tag="${tag.id}" onclick="event.preventDefault(); filterSensorsByTag('${tag.id.replace(/'/g, "\\'")}')">${tag.label} <span style="opacity:0.5">(${tag.count})</span></a></li>`
    ).join('');
}

function filterSensorsByTag(tag) {
    sensorTagFilter = sensorTagFilter === tag ? '' : tag;
    showView('all-sensors');

    document.querySelectorAll('#sensor-tag-list a').forEach(a => a.classList.remove('active'));
    if (sensorTagFilter) {
        const link = document.querySelector(`#sensor-tag-list a[data-sensor-tag="${sensorTagFilter}"]`);
        if (link) link.classList.add('active');
    }
}

// ===== SENSOR TABLE SORTING =====
let sensorSortField = 'id';
let sensorSortAsc = true;

function sortSensorsBy(field) {
    if (sensorSortField === field) {
        sensorSortAsc = !sensorSortAsc;
    } else {
        sensorSortField = field;
        sensorSortAsc = true;
    }
    renderSensors();

    document.querySelectorAll('.sortable-th').forEach(th => {
        th.classList.remove('sort-active', 'sort-desc');
    });
    const activeTh = document.querySelector(`.sortable-th[onclick*="${field}"]`);
    if (activeTh) {
        activeTh.classList.add('sort-active');
        if (!sensorSortAsc) activeTh.classList.add('sort-desc');
    }
}

// ===== GLOBAL SEARCH =====
function handleGlobalSearch() {
    const query = document.getElementById('global-search').value.trim().toLowerCase();
    const results = document.getElementById('global-search-results');

    if (query.length < 2) {
        results.classList.remove('visible');
        return;
    }

    const matchedSensors = sensors.filter(s =>
        s.id.toLowerCase().includes(query) || (s.soaTagId || '').toLowerCase().includes(query)
    ).slice(0, 5);

    const matchedCommunities = COMMUNITIES.filter(c =>
        c.name.toLowerCase().includes(query)
    ).slice(0, 5);

    const matchedContacts = contacts.filter(c =>
        c.name.toLowerCase().includes(query) || (c.org || '').toLowerCase().includes(query) || (c.email || '').toLowerCase().includes(query)
    ).slice(0, 5);

    if (!matchedSensors.length && !matchedCommunities.length && !matchedContacts.length) {
        results.innerHTML = '<div style="padding:16px;color:var(--slate-400);text-align:center;font-size:13px">No results found</div>';
        results.classList.add('visible');
        return;
    }

    let html = '';
    if (matchedSensors.length) {
        html += `<div class="search-result-group"><div class="search-result-group-label">Sensors</div>
            ${matchedSensors.map(s => `<div class="search-result-item" onclick="closeGlobalSearch(); showSensorDetail('${s.id}')">
                <span class="search-result-name" style="font-family:var(--font-mono)">${s.id}</span>
                <span class="search-result-meta">${getCommunityName(s.community)} &middot; ${s.type}</span>
            </div>`).join('')}</div>`;
    }
    if (matchedCommunities.length) {
        html += `<div class="search-result-group"><div class="search-result-group-label">Communities</div>
            ${matchedCommunities.map(c => `<div class="search-result-item" onclick="closeGlobalSearch(); showCommunity('${c.id}')">
                <span class="search-result-name">${escapeHtml(c.name)}</span>
                <span class="search-result-meta">${getChildCommunities(c.id).length ? getChildCommunities(c.id).length + ' sub-communities' : ''}</span>
            </div>`).join('')}</div>`;
    }
    if (matchedContacts.length) {
        html += `<div class="search-result-group"><div class="search-result-group-label">Contacts</div>
            ${matchedContacts.map(c => `<div class="search-result-item" onclick="closeGlobalSearch(); showContactDetail('${c.id}')">
                <span class="search-result-name">${escapeHtml(c.name)}</span>
                <span class="search-result-meta">${getCommunityName(c.community)}${c.active === false ? ' &middot; Inactive' : ''}</span>
            </div>`).join('')}</div>`;
    }

    results.innerHTML = html;
    results.classList.add('visible');
}

function closeGlobalSearch() {
    document.getElementById('global-search').value = '';
    document.getElementById('global-search-results').classList.remove('visible');
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.global-search-bar')) {
        document.getElementById('global-search-results').classList.remove('visible');
    }
});

// ===== EXPORT SPREADSHEET =====
function localDate() {
    const d = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: AK_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    const get = type => (parts.find(p => p.type === type) || {}).value || '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
}

function exportSpreadsheet(headers, rows, filename) {
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    ws['!cols'] = headers.map(() => ({ wch: 20 }));
    XLSX.writeFile(wb, filename);
}

const SENSOR_EXPORT_FIELDS = [
    { key: 'id', label: 'Sensor ID', get: s => s.id },
    { key: 'type', label: 'Type', get: s => s.type },
    { key: 'status', label: 'Status', get: s => getStatusArray(s).join('; ') },
    { key: 'community', label: 'Community', get: s => getCommunityName(s.community) },
    { key: 'location', label: 'Location', get: s => s.location || '' },
    { key: 'dateInstalled', label: 'Install Date', get: s => s.dateInstalled || '' },

    { key: 'soaTagId', label: 'SOA Tag ID', get: s => s.soaTagId || '' },
    { key: 'datePurchased', label: 'Purchase Date', get: s => s.datePurchased || '' },
];

const CONTACT_EXPORT_FIELDS = [
    { key: 'name', label: 'Name', get: c => c.name },
    { key: 'role', label: 'Role', get: c => c.role || '' },
    { key: 'community', label: 'Community', get: c => getCommunityName(c.community) },
    { key: 'org', label: 'Organization', get: c => c.org || '' },
    { key: 'email', label: 'Email', get: c => c.email || '' },
    { key: 'phone', label: 'Phone', get: c => c.phone || '' },
    { key: 'emailList', label: 'Mass Email List', get: c => c.emailList ? 'Yes' : 'No' },
    { key: 'active', label: 'Status', get: c => c.active === false ? 'Inactive' : 'Active' },
];

function openExportModal(type) {
    const fields = type === 'sensors' ? SENSOR_EXPORT_FIELDS : CONTACT_EXPORT_FIELDS;
    const container = document.getElementById('export-fields-list');
    container.innerHTML = fields.map(f =>
        `<label class="export-field-option"><input type="checkbox" checked data-key="${f.key}"> ${f.label}</label>`
    ).join('');
    document.getElementById('export-type').value = type;

    // Add custom fields
    const customFields = loadData('customSensorFields', []);
    if (type === 'sensors' && customFields.length > 0) {
        customFields.forEach(cf => {
            container.innerHTML += `<label class="export-field-option"><input type="checkbox" checked data-key="custom_${cf.key}"> ${cf.label}</label>`;
        });
    }

    // Show/hide inactive contacts checkbox
    const inactiveOption = document.getElementById('export-inactive-option');
    const inactiveCheckbox = document.getElementById('export-include-inactive');
    if (type === 'contacts') {
        inactiveOption.style.display = '';
        inactiveCheckbox.checked = false;
    } else {
        inactiveOption.style.display = 'none';
    }

    openModal('modal-export');
}

function executeExport() {
    const type = document.getElementById('export-type').value;
    const checkboxes = document.querySelectorAll('#export-fields-list input[type="checkbox"]:checked');
    const selectedKeys = Array.from(checkboxes).map(cb => cb.dataset.key);

    const fields = type === 'sensors' ? SENSOR_EXPORT_FIELDS : CONTACT_EXPORT_FIELDS;
    const customFields = loadData('customSensorFields', []);
    let data;
    if (type === 'sensors') {
        data = [...sensors].sort((a, b) => a.id.localeCompare(b.id));
    } else {
        const includeInactive = document.getElementById('export-include-inactive').checked;
        data = contacts.filter(c => includeInactive || c.active !== false).sort((a, b) => a.name.localeCompare(b.name));
    }

    const headers = [];
    const getters = [];

    selectedKeys.forEach(key => {
        if (key.startsWith('custom_')) {
            const cfKey = key.replace('custom_', '');
            const cf = customFields.find(f => f.key === cfKey);
            if (cf) {
                headers.push(cf.label);
                getters.push(item => (item.customFields || {})[cfKey] || '');
            }
        } else {
            const field = fields.find(f => f.key === key);
            if (field) {
                headers.push(field.label);
                getters.push(field.get);
            }
        }
    });

    const rows = data.map(item => getters.map(get => get(item)));
    exportSpreadsheet(headers, rows, `${type}_${localDate()}.xlsx`);
    closeModal('modal-export');
}

function exportSensors() { openExportModal('sensors'); }
function exportContacts() { openExportModal('contacts'); }

// ===== BULK ACTIONS =====
let selectedSensors = new Set();

function toggleSensorCheckbox(sensorId, checked) {
    if (checked) selectedSensors.add(sensorId);
    else selectedSensors.delete(sensorId);
    updateBulkActionButton();
}

function toggleAllSensorCheckboxes(checked) {
    document.querySelectorAll('.sensor-checkbox').forEach(cb => {
        cb.checked = checked;
        const sensorId = cb.dataset.sensorId;
        if (checked) selectedSensors.add(sensorId);
        else selectedSensors.delete(sensorId);
    });
    updateBulkActionButton();
}

function updateBulkActionButton() {
    const count = selectedSensors.size;
    document.getElementById('bulk-count').textContent = count;
    document.getElementById('bulk-action-btn').style.display = count > 0 ? '' : 'none';
    document.getElementById('bulk-clear-btn').style.display = count > 0 ? '' : 'none';
}

function clearSensorSelection() {
    selectedSensors.clear();
    document.getElementById('select-all-sensors').checked = false;
    document.querySelectorAll('.sensor-checkbox').forEach(cb => cb.checked = false);
    updateBulkActionButton();
}

// ===== BACK BUTTON =====
let viewHistory = []; // Each entry: { viewId, itemId }

function pushViewHistory() {
    if (isNavigatingBack) return;
    const active = document.querySelector('.view.active');
    if (!active) return;

    // Build entry with the specific item being viewed
    const entry = { viewId: active.id, itemId: null };
    if (active.id === 'view-sensor-detail') entry.itemId = currentSensor;
    else if (active.id === 'view-community') entry.itemId = currentCommunity;
    else if (active.id === 'view-contact-detail') entry.itemId = currentContact;

    // Don't push duplicate of current top
    const top = viewHistory[viewHistory.length - 1];
    if (top && top.viewId === entry.viewId && top.itemId === entry.itemId) return;

    viewHistory.push(entry);
    if (viewHistory.length > 20) viewHistory.shift();
    updateBackButton();
}

function updateBackButton() {
    const btn = document.getElementById('back-button');
    btn.style.display = viewHistory.length > 1 ? '' : 'none';
}

let isNavigatingBack = false;

function goBack() {
    if (viewHistory.length <= 1) return;
    viewHistory.pop(); // remove current view
    const prev = viewHistory[viewHistory.length - 1];
    if (!prev) return;

    isNavigatingBack = true;
    if (prev.viewId === 'view-dashboard') showView('dashboard');
    else if (prev.viewId === 'view-all-sensors') showView('all-sensors');
    else if (prev.viewId === 'view-communities') showView('communities');
    else if (prev.viewId === 'view-contacts') showView('contacts');
    else if (prev.viewId === 'view-settings') showView('settings');
    else if (prev.viewId === 'view-service') showView('service');
    else if (prev.viewId === 'view-audits') showView('audits');
    else if (prev.viewId === 'view-quantaq-alerts') showView('quantaq-alerts');
    else if (prev.viewId === 'view-community' && prev.itemId) showCommunityView(prev.itemId);
    else if (prev.viewId === 'view-sensor-detail' && prev.itemId) { currentSensor = prev.itemId; showSensorView(prev.itemId); }
    else if (prev.viewId === 'view-contact-detail' && prev.itemId) { currentContact = prev.itemId; showContactView(prev.itemId); }
    isNavigatingBack = false;
    updateBackButton();
}

// ===== VIEW INSTALLATION HISTORY =====
function viewInstallHistory() {
    const filterEl = document.getElementById('sensor-history-filter');
    if (filterEl) filterEl.value = '_changes';
    filterSensorHistory();
    document.getElementById('tab-sensor-history').scrollIntoView({ behavior: 'smooth' });
}

function viewCollocationHistory() {
    const filterEl = document.getElementById('sensor-history-filter');
    if (filterEl) filterEl.value = 'Audit';
    filterSensorHistory();
    document.getElementById('tab-sensor-history').scrollIntoView({ behavior: 'smooth' });
}

function getMostRecentCollocation(sensorId) {
    // Pull from collocation notes (type "Collocation"), NOT from audits
    const collocNotes = notes
        .filter(n => n.type === 'Collocation' && n.taggedSensors && n.taggedSensors.includes(sensorId))
        .sort((a, b) => (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || ''));
    if (collocNotes.length === 0) return null;
    const n = collocNotes[0];
    // Try JSON format first, fall back to legacy pipe-delimited format
    let location = '', start = '', end = '';
    try {
        const parsed = JSON.parse(n.additionalInfo);
        location = parsed.location || '';
        start = parsed.startDate ? formatDate(parsed.startDate) : '';
        end = parsed.endDate === 'TBD' ? 'TBD' : (parsed.endDate ? formatDate(parsed.endDate) : '');
    } catch (_) {
        // Legacy pipe-delimited format: "location|startDate|endDate"
        const parts = (n.additionalInfo || '').split('|');
        location = parts[0] || '';
        start = parts[1] ? formatDate(parts[1]) : '';
        end = parts[2] === 'TBD' ? 'TBD' : (parts[2] ? formatDate(parts[2]) : '');
    }
    return { communityName: location, dateRange: `${start} - ${end}` };
}

function openCollocationModal(sensorId) {
    document.getElementById('collocation-sensor-id').value = sensorId;
    document.getElementById('collocation-start-input').value = '';
    document.getElementById('collocation-end-input').value = '';
    document.getElementById('collocation-notes-input').value = '';
    // Populate location dropdown with all communities
    const select = document.getElementById('collocation-location-input');
    select.innerHTML = '<option value="">— Select Community —</option>' +
        [...COMMUNITIES].sort((a, b) => a.name.localeCompare(b.name))
        .map(c => `<option value="${c.name}">${escapeHtml(c.name)}</option>`).join('');
    openModal('modal-collocation');
}

function saveCollocation(e) {
    e.preventDefault();
    const sensorId = document.getElementById('collocation-sensor-id').value;
    const location = document.getElementById('collocation-location-input').value;
    const startDate = document.getElementById('collocation-start-input').value;
    const endDate = document.getElementById('collocation-end-input').value;
    const extraNotes = document.getElementById('collocation-notes-input').value.trim();
    if (!sensorId || !location || !startDate || !endDate) return;
    if (new Date(endDate) < new Date(startDate)) { showAlert('Validation Error', 'End date must be after start date.'); return; }

    const s = sensors.find(x => x.id === sensorId);
    const communityId = s?.community || '';
    // Create note with structured additionalInfo for getMostRecentCollocation
    const noteText = `Collocation at ${location}: ${formatDate(startDate)} \u2013 ${formatDate(endDate)}.`;
    const structuredInfo = JSON.stringify({
        userNotes: extraNotes || '',
        location: location,
        startDate: startDate,
        endDate: endDate,
    });
    createNote('Collocation', noteText, {
        sensors: [sensorId],
        communities: communityId ? [communityId] : [],
    }, structuredInfo);

    closeModal('modal-collocation'); showSuccessToast('Collocation logged');
    if (currentSensor === sensorId) showSensorView(sensorId);
}

function openGlobalCollocationModal() {
    // Populate location dropdown — regulatory sites first, then alphabetical
    const regulatorySites = ['anc-garden', 'fbx-ncore', 'jnu-floyd-dryden'];
    const regulatory = COMMUNITIES.filter(c => regulatorySites.includes(c.id) || (getCommunityTags(c.id) || []).includes('Regulatory Site'));
    const others = COMMUNITIES.filter(c => !regulatory.includes(c)).sort((a, b) => a.name.localeCompare(b.name));

    const select = document.getElementById('global-colloc-location');
    select.innerHTML = '<option value="">— Select Location —</option>' +
        (regulatory.length > 0 ? `<optgroup label="Regulatory Sites">${regulatory.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</optgroup>` : '') +
        `<optgroup label="Communities">${others.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</optgroup>`;

    document.getElementById('global-colloc-start').value = '';
    document.getElementById('global-colloc-end').value = '';
    document.getElementById('global-colloc-end').disabled = false;
    document.getElementById('global-colloc-end').required = true;
    document.getElementById('global-colloc-end-tbd').checked = false;
    document.getElementById('global-colloc-conducted-by').value = getCurrentUserName();
    document.getElementById('global-colloc-notes').value = '';

    // Clear sensor chips and init
    document.querySelectorAll('#global-colloc-sensors .tag-chip').forEach(c => c.remove());
    setupTagChipInput('global-colloc-sensors', () => sensors, s => s.id);

    openModal('modal-global-collocation');
}

async function saveGlobalCollocation(e) {
    e.preventDefault();
    const communityId = document.getElementById('global-colloc-location').value;
    if (!communityId) return;
    const communityName = getCommunityName(communityId);
    const startDate = document.getElementById('global-colloc-start').value;
    const endTbd = document.getElementById('global-colloc-end-tbd').checked;
    const endDate = endTbd ? 'TBD' : document.getElementById('global-colloc-end').value;
    if (!startDate) return;
    if (!endTbd && !endDate) return;
    if (!endTbd && new Date(endDate) < new Date(startDate)) { showAlert('Validation Error', 'End date must be after start date.'); return; }

    const taggedSensors = getChipValues('global-colloc-sensors');
    const conductedBy = document.getElementById('global-colloc-conducted-by').value.trim();
    const extraNotes = document.getElementById('global-colloc-notes').value.trim();

    if (taggedSensors.length === 0) { showAlert('Validation Error', 'Tag at least one sensor for this collocation.'); return; }

    const endDisplay = endTbd ? 'TBD' : formatDate(endDate);
    const noteText = `Collocation at ${communityName}: ${formatDate(startDate)} \u2013 ${endDisplay}.${conductedBy ? ' Conducted by ' + conductedBy + '.' : ''}`;

    const structuredInfo = JSON.stringify({
        userNotes: extraNotes || '',
        location: communityName,
        startDate: startDate,
        endDate: endDate,
        conductedBy: conductedBy,
    });

    createNote('Collocation', noteText, {
        sensors: taggedSensors,
        communities: [communityId],
    }, structuredInfo);

    // Create collocation record
    try {
        const newColloc = await db.insertCollocation({
            locationId: communityId,
            status: 'In Progress',
            startDate: startDate,
            endDate: endDate,
            sensorIds: taggedSensors,
            conductedBy: conductedBy,
            progressNotes: extraNotes ? [{ text: extraNotes, by: getCurrentUserName(), at: nowDatetime() }] : [],
            createdById: currentUserId,
        });
        collocations.push(newColloc);
        updateSidebarCollocationCount();
    } catch (err) {
        console.error('Insert collocation error:', err);
    }

    // Add Collocation status to each tagged sensor
    taggedSensors.forEach(sId => {
        const s = sensors.find(x => x.id === sId);
        if (s) {
            const statuses = getStatusArray(s);
            if (!statuses.includes('Collocation')) {
                s.status = [...statuses, 'Collocation'];
            }
            persistSensor(s);
        }
    });

    closeModal('modal-global-collocation');
    showSuccessToast(`Collocation logged for ${taggedSensors.length} sensor${taggedSensors.length !== 1 ? 's' : ''}`);
    refreshCurrentView();
}

// ===== PINNED SIDEBAR ITEMS =====
let pinnedItems = loadData('pinnedItems', []);

function renderPinnedSidebar() {
    const section = document.getElementById('sidebar-pinned-section');
    const list = document.getElementById('sidebar-pinned-list');
    if (!pinnedItems.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    list.innerHTML = pinnedItems.map(pin => {
        let onclick = '';
        let label = pin.label;
        if (pin.type === 'community') onclick = `showCommunity('${pin.id}')`;
        else if (pin.type === 'tag') onclick = `filterCommunitiesByTag('${pin.id.replace(/'/g, "\\'")}')`;
        return `<li><a href="#" class="sidebar-pinned-item" onclick="event.preventDefault(); ${onclick}">
            ${label}
            <span class="sidebar-pin-remove" onclick="event.stopPropagation(); event.preventDefault(); unpinItem('${pin.type}', '${pin.id.replace(/'/g, "\\'")}')">&times;</span>
        </a></li>`;
    }).join('');
}

function pinCommunity(communityId) {
    const c = COMMUNITIES.find(x => x.id === communityId);
    if (!c || pinnedItems.find(p => p.type === 'community' && p.id === communityId)) return;
    pinnedItems.push({ type: 'community', id: communityId, label: c.name });
    saveData('pinnedItems', pinnedItems);
    renderPinnedSidebar();
    updatePinButton(communityId);
}

function togglePinCommunity(communityId) {
    const existing = pinnedItems.find(p => p.type === 'community' && p.id === communityId);
    if (existing) {
        unpinItem('community', communityId);
    } else {
        pinCommunity(communityId);
    }
    updatePinButton(communityId);
}

function updatePinButton(communityId) {
    const isPinned = pinnedItems.find(p => p.type === 'community' && p.id === communityId);
    const icon = document.getElementById('pin-icon');
    const label = document.getElementById('pin-label');
    if (icon) icon.textContent = isPinned ? '\u2605' : '\u2606';
    if (label) label.textContent = isPinned ? 'Unpin' : 'Pin';
}

function editCommunityName() {
    if (!currentCommunity) return;
    const c = COMMUNITIES.find(x => x.id === currentCommunity);
    if (!c) return;
    const newName = prompt('Edit community name:', c.name);
    if (!newName || newName.trim() === c.name) return;

    const trimmedName = newName.trim();
    const nameDup = COMMUNITIES.find(x => x.name.toLowerCase() === trimmedName.toLowerCase() && x.id !== currentCommunity);
    if (nameDup) {
        showAlert('Duplicate Community', `A community named "${nameDup.name}" already exists.`);
        return;
    }

    const oldName = c.name;
    c.name = trimmedName;
    communityNameMap[currentCommunity] = trimmedName;
    db.updateCommunity(currentCommunity, { name: c.name }).catch(err => console.error(err));

    if (!setupMode) {
        createNote('Info Edit', `Community renamed from "${oldName}" to "${c.name}".`, {
            sensors: [], communities: [currentCommunity], contacts: [],
        });
    }

    showCommunityView(currentCommunity);
    buildSidebar();
    renderPinnedSidebar();
}

function openChangeParentModal(communityId) {
    const community = COMMUNITIES.find(c => c.id === communityId);
    if (!community) return;
    const currentParent = getParentCommunity(communityId);
    const children = getChildCommunities(communityId);
    const childIds = children.map(c => c.id);

    // Build options: "None (standalone)" + all top-level communities except self and own children
    const options = COMMUNITIES
        .filter(c => c.id !== communityId && !childIds.includes(c.id) && !isChildCommunity(c.id))
        .sort((a, b) => a.name.localeCompare(b.name));

    const currentLabel = currentParent ? currentParent.name : 'None (standalone)';

    const body = `
        <p style="margin-bottom:12px;color:var(--slate-500);font-size:13px">
            <strong>${escapeHtml(community.name)}</strong> is currently:
            <strong>${currentParent ? 'a child of ' + escapeHtml(currentParent.name) : 'a standalone community'}</strong>
        </p>
        ${children.length > 0 ? `<p style="margin-bottom:12px;color:var(--slate-400);font-size:12px">This community has ${children.length} sub-communit${children.length === 1 ? 'y' : 'ies'}: ${children.map(c => escapeHtml(c.name)).join(', ')}. Assigning a parent will move them too.</p>` : ''}
        <label style="display:block;font-size:12px;font-weight:600;color:var(--slate-500);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em">Parent Community</label>
        <select id="change-parent-select" style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid var(--slate-200);font-size:14px;font-family:var(--font-sans)">
            <option value="">None (standalone)</option>
            ${options.map(c => `<option value="${c.id}" ${currentParent && currentParent.id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
    `;

    showConfirm('Change Parent Community', body, () => {
        const select = document.getElementById('change-parent-select');
        if (!select) return;
        const newParentId = select.value;
        const oldParentId = communityParents[communityId] || null;

        // No change
        if ((newParentId || null) === oldParentId) return;

        const oldParentName = oldParentId ? getCommunityName(oldParentId) : 'standalone';
        const newParentName = newParentId ? getCommunityName(newParentId) : 'standalone';

        // Update in-memory
        if (newParentId) {
            communityParents[communityId] = newParentId;
        } else {
            delete communityParents[communityId];
        }

        // Persist to DB
        db.updateCommunity(communityId, { parent_id: newParentId || null }).catch(err => console.error('Change parent error:', err));

        // Log note
        if (!setupMode) {
            let noteText;
            if (!oldParentId && newParentId) {
                noteText = `"${community.name}" assigned as a sub-community of "${newParentName}".`;
            } else if (oldParentId && !newParentId) {
                noteText = `"${community.name}" detached from "${oldParentName}" and is now standalone.`;
            } else {
                noteText = `"${community.name}" moved from under "${oldParentName}" to under "${newParentName}".`;
            }
            const taggedCommunities = [communityId];
            if (oldParentId) taggedCommunities.push(oldParentId);
            if (newParentId && !taggedCommunities.includes(newParentId)) taggedCommunities.push(newParentId);

            createNote('Info Edit', noteText, {
                sensors: [], communities: taggedCommunities, contacts: [],
            });
        }

        showCommunityView(communityId);
        buildSidebar();
        renderPinnedSidebar();
        showSuccessToast(newParentId ? `"${community.name}" is now under "${newParentName}"` : `"${community.name}" is now standalone`);
    }, { confirmText: 'Save' });
}

function pinTag(tag) {
    if (pinnedItems.find(p => p.type === 'tag' && p.id === tag)) return;
    pinnedItems.push({ type: 'tag', id: tag, label: tag });
    saveData('pinnedItems', pinnedItems);
    renderPinnedSidebar();
}

function unpinItem(type, id) {
    pinnedItems = pinnedItems.filter(p => !(p.type === type && p.id === id));
    saveData('pinnedItems', pinnedItems);
    renderPinnedSidebar();
}

// ===== COMMUNITY DEACTIVATION =====
let deactivatedCommunities = [];

function deactivateCommunity(communityId) {
    const community = COMMUNITIES.find(c => c.id === communityId);
    const communityName = community ? community.name : communityId;
    const communityContacts = contacts.filter(c => c.community === communityId && c.active !== false);
    const contactMsg = communityContacts.length > 0
        ? `\n\nThis will also inactivate ${communityContacts.length} active contact${communityContacts.length === 1 ? '' : 's'} in this community.`
        : '';

    showConfirm('Deactivate Community', `Deactivate "${communityName}"? It will move to the Inactive tab. All history is preserved.${contactMsg}`, () => {
        if (!deactivatedCommunities.includes(communityId)) {
            deactivatedCommunities.push(communityId);
        }
        // Persist to Supabase
        db.updateCommunity(communityId, { active: false }).catch(err => console.error('Deactivate error:', err));

        // Also deactivate child communities
        const children = COMMUNITIES.filter(c => communityParents[c.id] === communityId);
        children.forEach(child => {
            if (!deactivatedCommunities.includes(child.id)) {
                deactivatedCommunities.push(child.id);
            }
            db.updateCommunity(child.id, { active: false }).catch(err => console.error('Deactivate child error:', err));
        });

        // Auto-inactivate contacts in this community (and children)
        const allDeactivatedIds = [communityId, ...children.map(c => c.id)];
        contacts.forEach(c => {
            if (allDeactivatedIds.includes(c.community) && c.active !== false) {
                c.active = false;
                persistContact(c);
            }
        });

        showSuccessToast(`${communityName} deactivated`);
        showView('communities');
    }, { danger: true });
}

function reactivateCommunity(communityId) {
    const community = COMMUNITIES.find(c => c.id === communityId);
    const communityName = community ? community.name : communityId;

    deactivatedCommunities = deactivatedCommunities.filter(id => id !== communityId);
    db.updateCommunity(communityId, { active: true }).catch(err => console.error('Reactivate error:', err));

    // Also reactivate child communities
    const children = COMMUNITIES.filter(c => communityParents[c.id] === communityId);
    children.forEach(child => {
        deactivatedCommunities = deactivatedCommunities.filter(id => id !== child.id);
        db.updateCommunity(child.id, { active: true }).catch(err => console.error('Reactivate child error:', err));
    });

    showSuccessToast(`${communityName} reactivated`);
    showView('communities');
}

function isCommunityDeactivated(communityId) {
    return deactivatedCommunities.includes(communityId);
}

function confirmDeleteCommunity(communityId) {
    const community = COMMUNITIES.find(c => c.id === communityId);
    const communityName = community ? community.name : communityId;
    const commContacts = contacts.filter(c => c.community === communityId);
    const commSensors = sensors.filter(s => s.community === communityId);
    const commNotes = notes.filter(n => n.taggedCommunities && n.taggedCommunities.includes(communityId));

    let warning = `Are you sure you want to permanently delete "${communityName}"?`;
    if (commContacts.length > 0) warning += `\n\n${commContacts.length} contact${commContacts.length > 1 ? 's' : ''} will be unassigned.`;
    if (commSensors.length > 0) warning += `\n${commSensors.length} sensor${commSensors.length > 1 ? 's' : ''} will be unassigned.`;
    if (commNotes.length > 0) warning += `\n${commNotes.length} note${commNotes.length > 1 ? 's' : ''} are tagged to this community.`;
    warning += '\n\nThis cannot be undone.';

    showConfirm('Delete Community', warning, async () => {
        try {
            // Unassign contacts
            commContacts.forEach(c => { c.community = ''; persistContact(c); });
            // Unassign sensors
            commSensors.forEach(s => { s.community = ''; persistSensor(s); });
            // Detach child communities (make them standalone)
            const children = COMMUNITIES.filter(c => communityParents[c.id] === communityId);
            children.forEach(child => { delete communityParents[child.id]; });
            // Remove from COMMUNITIES array
            const idx = COMMUNITIES.findIndex(c => c.id === communityId);
            if (idx >= 0) COMMUNITIES.splice(idx, 1);
            delete communityNameMap[communityId];
            // Remove from deactivated list
            deactivatedCommunities = deactivatedCommunities.filter(id => id !== communityId);
            // Delete from DB (handles all FK cleanup)
            await db.deleteCommunity(communityId);
            // Close any open tabs for this community
            openTabs = openTabs.filter(t => t.id !== getTabId('community', communityId));
            renderOpenTabs();
            showSuccessToast(`"${communityName}" deleted`);
            showView('communities');
        } catch (err) {
            console.error('Delete community error:', err);
            showAlert('Error', 'Failed to delete community: ' + err.message);
        }
    }, { danger: true });
}

// ===== ADD CUSTOM TAG IN NEW COMMUNITY MODAL =====
function addNewCommunityCustomTag() {
    const input = document.getElementById('new-community-custom-tag');
    const tag = input.value.trim();
    if (!tag) return;
    if (!AVAILABLE_TAGS.includes(tag)) AVAILABLE_TAGS.push(tag);
    if (!newCommunitySelectedTags.includes(tag)) newCommunitySelectedTags.push(tag);
    input.value = '';
    renderNewCommunityTags();
}

// ===== CUSTOM SENSOR FIELDS =====
let customSensorFields = loadData('customSensorFields', []);

let wizardState = null;

function openAddFieldModal() {
    const name = prompt('Enter the new field name (e.g. "Serial Number", "Firmware Version"):');
    if (!name || !name.trim()) return;

    const key = name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (customSensorFields.find(f => f.key === key)) {
        showAlert('Duplicate Field', 'A field with that name already exists.');
        return;
    }

    customSensorFields.push({ key, label: name.trim() });
    saveData('customSensorFields', customSensorFields);
    renderSensorTableHeader();
    renderSensors();

    wizardState = { fieldKey: key, fieldLabel: name.trim(), index: 0 };
    showWizardStep();
    openModal('modal-field-wizard');
}

function showWizardStep() {
    if (!wizardState || wizardState.index >= sensors.length) {
        document.getElementById('wizard-content').innerHTML = '<p style="text-align:center;color:var(--slate-500);padding:20px">All sensors complete.</p>';
        document.getElementById('wizard-next-btn').style.display = 'none';
        return;
    }
    const s = sensors[wizardState.index];
    const currentVal = (s.customFields || {})[wizardState.fieldKey] || '';
    document.getElementById('wizard-progress').textContent = `${wizardState.index + 1} of ${sensors.length}`;
    document.getElementById('wizard-content').innerHTML = `
        <div style="margin-bottom:8px"><strong style="font-family:var(--font-mono)">${s.id}</strong> <span style="color:var(--slate-400)">${getCommunityName(s.community)}</span></div>
        <input type="text" id="wizard-field-input" class="inline-edit-input" value="${currentVal}" placeholder="Enter ${wizardState.fieldLabel}" style="width:100%" onkeydown="if(event.key==='Enter'){event.preventDefault();wizardNext();}">
    `;
    document.getElementById('wizard-next-btn').style.display = '';
    setTimeout(() => document.getElementById('wizard-field-input')?.focus(), 50);
}

function wizardNext() {
    if (!wizardState) return;
    const input = document.getElementById('wizard-field-input');
    if (input && input.value.trim()) {
        const s = sensors[wizardState.index];
        if (!s.customFields) s.customFields = {};
        s.customFields[wizardState.fieldKey] = input.value.trim();
    }
    wizardState.index++;
    showWizardStep();
}

function wizardSaveAndClose() {
    const input = document.getElementById('wizard-field-input');
    if (input && input.value.trim() && wizardState && wizardState.index < sensors.length) {
        const s = sensors[wizardState.index];
        if (!s.customFields) s.customFields = {};
        s.customFields[wizardState.fieldKey] = input.value.trim();
    }
    saveCustomFieldData();
    wizardState = null;
    closeModal('modal-field-wizard');
    renderSensors();
    if (currentSensor) showSensorView(currentSensor);
}

function wizardDiscard() {
    showConfirm('Discard Field', 'Discard this new field and all values entered so far?', () => {
        if (wizardState) {
            sensors.forEach(s => { if (s.customFields) delete s.customFields[wizardState.fieldKey]; });
            customSensorFields = customSensorFields.filter(f => f.key !== wizardState.fieldKey);
            saveData('customSensorFields', customSensorFields);
            saveCustomFieldData();
        }
        wizardState = null;
        closeModal('modal-field-wizard');
        renderSensorTableHeader();
        renderSensors();
        if (currentSensor) showSensorView(currentSensor);
    }, { danger: true });
}

function editCustomField(sensorId, fieldKey) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;
    const cf = customSensorFields.find(f => f.key === fieldKey);
    const currentVal = (s.customFields || {})[fieldKey] || '';
    const newVal = prompt(`Edit ${cf?.label || fieldKey}:`, currentVal);
    if (newVal === null) return;

    if (!s.customFields) s.customFields = {};
    s.customFields[fieldKey] = newVal.trim();
    saveCustomFieldData();
    if (currentSensor) showSensorView(currentSensor);
}

function editCustomFieldInline(sensorId, fieldKey, value) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;
    if (!s.customFields) s.customFields = {};
    s.customFields[fieldKey] = value.trim();
    saveCustomFieldData();
}

function saveCustomFieldData() {
    const data = {};
    sensors.forEach(s => {
        if (s.customFields && Object.keys(s.customFields).length > 0) {
            data[s.id] = s.customFields;
        }
    });
    saveData('sensorCustomData', data);
}

// ===== SERVICE TICKETS =====
const TICKET_STATUSES = ['Ticket Opened', 'RMA Assigned', 'Shipped to Quant', 'At Quant', 'Shipped from Quant', 'Received', 'Closed'];
const TICKET_STATUS_CSS = { 'Ticket Opened': 'ts-opened', 'RMA Assigned': 'ts-rma', 'Shipped to Quant': 'ts-shipped-to', 'At Quant': 'ts-at-quant', 'Shipped from Quant': 'ts-shipped-from', 'Received': 'ts-received', 'Closed': 'ts-closed' };

function getActiveTicketCount() { return serviceTickets.filter(t => t.status !== 'Closed').length; }
function formatTicketType(type) {
    if (type === 'issue+calibration') return 'Issue + Calibration';
    if (type === 'calibration') return 'Calibration';
    return 'Issue / Repair';
}
function getActiveTicketsForSensor(sensorId) { return sensorTicketMap[sensorId] || []; }

function updateSidebarServiceCount() {
    const count = getActiveTicketCount();
    const el = document.getElementById('sidebar-service-count');
    if (!el) return;
    el.textContent = count > 0 ? `(${count})` : '';
}

function renderServiceView() {
    updateSidebarServiceCount();
    const typeFilter = document.getElementById('service-type-filter')?.value || '';
    let allTickets = [...serviceTickets];
    if (typeFilter) allTickets = allTickets.filter(t => t.ticketType.includes(typeFilter));

    const activeTickets = allTickets.filter(t => t.status !== 'Closed');
    const closedTickets = allTickets.filter(t => t.status === 'Closed')
        .sort((a, b) => (b.closedAt || b.createdAt || '').localeCompare(a.closedAt || a.createdAt || ''));

    // Active pipeline (no Closed column)
    const pipeline = document.getElementById('service-pipeline');
    const activeStatuses = TICKET_STATUSES.filter(s => s !== 'Closed');
    pipeline.innerHTML = activeStatuses.map(status => {
        const st = activeTickets.filter(t => t.status === status);
        return `<div class="service-pipeline-column">
            <div class="service-pipeline-column-header"><h3>${status}</h3><span class="service-pipeline-count">${st.length}</span></div>
            ${st.length === 0 ? '<p style="font-size:13px;color:var(--slate-400)">No tickets</p>' : st.map(t => renderTicketCard(t)).join('')}
        </div>`;
    }).join('');

    // Closed tickets section below
    const closedSection = document.getElementById('service-closed-section');
    if (closedSection) {
        if (closedTickets.length === 0) {
            closedSection.innerHTML = '';
        } else {
            closedSection.innerHTML = `
                <div style="border-top:2px solid var(--slate-200);margin-top:24px;padding-top:16px">
                    <h3 style="font-size:14px;color:var(--slate-400);margin-bottom:12px">Closed Tickets (${closedTickets.length})</h3>
                    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">
                        ${closedTickets.map(t => renderTicketCard(t)).join('')}
                    </div>
                </div>`;
        }
    }
}

const TICKET_STATUS_LABELS = {
    'Ticket Opened': 'Opened', 'RMA Assigned': 'RMA', 'Shipped to Quant': 'Shipped',
    'At Quant': 'At Quant', 'Shipped from Quant': 'Returning', 'Received': 'Received', 'Closed': 'Closed'
};

function renderTicketProgress(ticket) {
    const statusIndex = TICKET_STATUSES.indexOf(ticket.status);
    return TICKET_STATUSES.slice(0, -1).map((st, i) => {
        const state = i < statusIndex ? 'completed' : i === statusIndex ? 'current' : 'pending';
        return `<div class="ticket-step ${state}"><div class="ticket-step-dot"></div><div class="ticket-step-label">${TICKET_STATUS_LABELS[st]}</div></div>`;
    }).join('');
}

function renderTicketCard(ticket) {
    return `<div class="service-ticket-card ticket-type-${ticket.ticketType}" onclick="openTicketDetail('${ticket.id}')">
        <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="ticket-sensor-id">${ticket.sensorId}</span>
            <span class="ticket-type-label">${formatTicketType(ticket.ticketType)}</span>
        </div>
        ${ticket.issueDescription ? `<div class="ticket-description">${escapeHtml(ticket.issueDescription)}</div>` : ''}
        <div class="ticket-meta">
            ${ticket.rmaNumber ? `<span>RMA: ${escapeHtml(ticket.rmaNumber)}</span>` : ''}
            ${ticket.fedexTrackingTo ? `<span>Tracking to Quant: ${escapeHtml(ticket.fedexTrackingTo)}</span>` : ''}
            ${ticket.fedexTrackingFrom ? `<span>Tracking from Quant: ${escapeHtml(ticket.fedexTrackingFrom)}</span>` : ''}
            <span>${formatDate(ticket.createdAt)}</span>
        </div>
        <div class="ticket-steps">${renderTicketProgress(ticket)}</div>
    </div>`;
}

function openTicketDetail(ticketId) {
    const ticket = serviceTickets.find(t => t.id === ticketId);
    if (!ticket) return;
    const statusIndex = TICKET_STATUSES.indexOf(ticket.status);
    const nextStatus = statusIndex < TICKET_STATUSES.length - 2 ? TICKET_STATUSES[statusIndex + 1] : null;
    const isOpen = ticket.status !== 'Closed';

    document.getElementById('service-ticket-modal-title').textContent = `Service Ticket: ${ticket.sensorId}`;
    document.getElementById('service-ticket-modal-body').innerHTML = `
        <div style="padding:12px 28px 0"><div class="ticket-steps ticket-steps-detail">${renderTicketProgress(ticket)}</div></div>
        <div class="ticket-detail-actions" style="border-top:none">
            ${isOpen && nextStatus ? `<button class="btn btn-primary" onclick="advanceTicketStatus('${ticket.id}')">Advance to: ${nextStatus}</button>` : ''}
            ${statusIndex > 0 && isOpen ? `<a class="undo-link" onclick="revertTicketStatus('${ticket.id}')">Undo</a>` : ''}
            <span class="action-spacer"></span>
            ${isOpen ? `<button class="btn btn-danger" onclick="openCloseTicketModal('${ticket.id}')">Close Out</button>` : ''}
            <button class="btn" onclick="closeModal('modal-service-ticket')">Done</button>
        </div>
        <div class="ticket-detail-grid">
            <div class="ticket-field"><label>Sensor</label><p><a href="#" onclick="closeModal('modal-service-ticket'); showSensorDetail('${ticket.sensorId}'); return false;" style="color:var(--navy-500)">${ticket.sensorId}</a></p></div>
            <div class="ticket-field"><label>Actions Needed</label><p>${formatTicketType(ticket.ticketType)}</p></div>
            <div class="ticket-field"><label>Status</label><p><span class="ticket-status-badge ${TICKET_STATUS_CSS[ticket.status] || ''}">${ticket.status}</span></p></div>
            <div class="ticket-field"><label>Opened</label><p>${escapeHtml(ticket.createdBy)} on ${formatDate(ticket.createdAt)}</p></div>
            <div class="ticket-field full-width"><label>Issue Description</label><p>${escapeHtml(ticket.issueDescription) || '—'}</p></div>
            <div class="ticket-field"><label>RMA Number</label>${isOpen ? `<input class="ticket-edit-input" value="${escapeHtml(ticket.rmaNumber)}" placeholder="e.g. RMA-2026-0042" onblur="saveTicketField('${ticket.id}','rmaNumber',this.value)">` : `<p>${escapeHtml(ticket.rmaNumber) || '—'}</p>`}</div>
            <div class="ticket-field"><label>Return Tracking Info (to QuantAQ)</label>${isOpen ? `<input class="ticket-edit-input" value="${escapeHtml(ticket.fedexTrackingTo)}" placeholder="e.g. UPS, 1234567890" onblur="saveTicketField('${ticket.id}','fedexTrackingTo',this.value)">` : `<p>${escapeHtml(ticket.fedexTrackingTo) || '—'}</p>`}</div>
            <div class="ticket-field"><label>Return Tracking Info (from QuantAQ)</label>${isOpen ? `<input class="ticket-edit-input" value="${escapeHtml(ticket.fedexTrackingFrom)}" placeholder="e.g. UPS, 1234567890" onblur="saveTicketField('${ticket.id}','fedexTrackingFrom',this.value)">` : `<p>${escapeHtml(ticket.fedexTrackingFrom) || '—'}</p>`}</div>
            <div class="ticket-field"><label>Closed</label><p>${ticket.closedAt ? formatDate(ticket.closedAt) : '—'}</p></div>
            ${renderProgressNotesSection(ticket.progressNotes, ticket.id, 'addProgressNote')}
            <div class="ticket-field full-width"><label>Work Completed</label>${isOpen ? `<textarea class="ticket-edit-input" rows="3" placeholder="Describe work done..." onblur="saveTicketField('${ticket.id}','workCompleted',this.value)">${escapeHtml(ticket.workCompleted)}</textarea>` : `<p>${escapeHtml(ticket.workCompleted) || '—'}</p>`}</div>
        </div>
        <div style="padding:16px 28px;border-top:1px solid var(--slate-100);text-align:right">
            <button class="btn btn-sm btn-danger" onclick="deleteServiceTicket('${ticket.id}')" style="font-size:11px;opacity:0.7">Delete Ticket</button>
        </div>`;
    openModal('modal-service-ticket');
}

function saveTicketField(ticketId, field, value) {
    const ticket = serviceTickets.find(t => t.id === ticketId);
    if (!ticket || ticket[field] === value) return;
    ticket[field] = value;
    persistServiceTicketUpdate(ticketId, { [field]: value });
}

function addProgressNote(ticketId) {
    const input = document.getElementById('progress-note-input-' + ticketId);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    const ticket = serviceTickets.find(t => t.id === ticketId);
    if (!ticket) return;

    if (!ticket.progressNotes) ticket.progressNotes = [];
    ticket.progressNotes.push({
        text: text,
        by: getCurrentUserName(),
        at: nowDatetime(),
    });

    persistServiceTicketUpdate(ticketId, { progressNotes: ticket.progressNotes });
    input.value = '';
    // Re-render the ticket detail to show the new note
    openTicketDetail(ticketId);
    // Also refresh sensor ticket preview if visible
    if (currentSensor) renderSensorTickets(currentSensor);
}

function renderProgressNotesSection(notes, itemId, addFn) {
    const notesList = (notes || []).slice().reverse().map((n, i) =>
        `<div style="font-size:13px;padding:6px 0;${i < (notes || []).length - 1 ? 'border-bottom:1px solid var(--slate-100);' : ''}">
            <span style="color:var(--slate-400);font-size:11px">${n.at ? formatDate(n.at) : ''}${n.by ? ' — ' + escapeHtml(n.by) : ''}</span>
            <div style="color:var(--slate-700);margin-top:2px">${escapeHtml(n.text)}</div>
        </div>`
    ).join('');
    return `<div class="ticket-field full-width"><label>Progress Notes</label>
        <div>${notesList || '<p style="color:var(--slate-400);font-size:13px">No notes yet.</p>'}</div>
        <div style="margin-top:8px;display:flex;gap:8px">
            <input type="text" id="progress-note-input-${itemId}" class="ticket-edit-input" placeholder="Add a note..." style="flex:1" onkeydown="if(event.key==='Enter'){${addFn}('${itemId}');event.preventDefault();}">
            <button class="btn btn-sm btn-primary" onclick="${addFn}('${itemId}')">Add</button>
        </div>
    </div>`;
}

function addAuditProgressNote(auditId) {
    const input = document.getElementById('progress-note-input-' + auditId);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    if (!audit.progressNotes) audit.progressNotes = [];
    audit.progressNotes.push({ text, by: getCurrentUserName(), at: nowDatetime() });
    persistAuditUpdate(auditId, { progressNotes: audit.progressNotes });
    input.value = '';
    openAuditDetail(auditId);
}

function addCollocationProgressNote(collocId) {
    const input = document.getElementById('progress-note-input-' + collocId);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc) return;
    if (!colloc.progressNotes) colloc.progressNotes = [];
    colloc.progressNotes.push({ text, by: getCurrentUserName(), at: nowDatetime() });
    persistCollocationUpdate(collocId, { progressNotes: colloc.progressNotes });
    input.value = '';
    openCollocationDetail(collocId);
}

function advanceTicketStatus(ticketId) {
    const ticket = serviceTickets.find(t => t.id === ticketId);
    if (!ticket) return;
    const idx = TICKET_STATUSES.indexOf(ticket.status);
    if (idx >= TICKET_STATUSES.length - 2) return;
    const oldStatus = ticket.status;
    const newStatus = TICKET_STATUSES[idx + 1];
    ticket.status = newStatus;
    persistServiceTicketUpdate(ticketId, { status: newStatus });

    const sensorStatusMap = { 'Shipped to Quant': ['Shipped to Quant'], 'At Quant': ['Service at Quant'], 'Shipped from Quant': ['Shipped from Quant'] };
    const allServiceStatuses = ['Shipped to Quant', 'Service at Quant', 'Shipped from Quant'];
    if (sensorStatusMap[newStatus]) {
        const s = sensors.find(x => x.id === ticket.sensorId);
        if (s) {
            // Strip ALL service-related statuses, then apply only the current stage's status
            const current = getStatusArray(s).filter(st => st !== 'Quant Ticket in Progress' && !allServiceStatuses.includes(st));
            s.status = [...current, ...sensorStatusMap[newStatus]];
            persistSensor(s); buildSensorSidebar();
        }
    }

    rebuildSensorTicketMap();
    createNote('Service', `Service ticket advanced: "${oldStatus}" → "${newStatus}".`, { sensors: [ticket.sensorId] });
    openTicketDetail(ticketId);
    updateSidebarServiceCount();
    if (document.getElementById('view-service')?.classList.contains('active')) renderServiceView();
}

function revertTicketStatus(ticketId) {
    const ticket = serviceTickets.find(t => t.id === ticketId);
    if (!ticket) return;
    const idx = TICKET_STATUSES.indexOf(ticket.status);
    if (idx <= 0) return;
    const oldStatus = ticket.status;
    const newStatus = TICKET_STATUSES[idx - 1];
    ticket.status = newStatus;
    persistServiceTicketUpdate(ticketId, { status: newStatus });

    // Restore sensor status to match the reverted-to step
    const sensorStatusMap = { 'Shipped to Quant': ['Shipped to Quant'], 'At Quant': ['Service at Quant'], 'Shipped from Quant': ['Shipped from Quant'] };
    const s = sensors.find(x => x.id === ticket.sensorId);
    if (s) {
        // Strip all service-related statuses, then apply what the new status implies
        const serviceStatuses = ['Shipped to Quant', 'Service at Quant', 'Shipped from Quant'];
        const cleaned = getStatusArray(s).filter(st => !serviceStatuses.includes(st));
        if (sensorStatusMap[newStatus]) {
            s.status = [...cleaned, ...sensorStatusMap[newStatus]];
        } else {
            // Earlier statuses (Ticket Opened, RMA Assigned) just have "Quant Ticket in Progress"
            s.status = cleaned.length > 0 ? cleaned : ['Quant Ticket in Progress'];
        }
        persistSensor(s); buildSensorSidebar();
    }

    createNote('Service', `Service ticket reverted: "${oldStatus}" \u2192 "${newStatus}".`, { sensors: [ticket.sensorId] });
    rebuildSensorTicketMap();
    openTicketDetail(ticketId);
    updateSidebarServiceCount();
    if (document.getElementById('view-service')?.classList.contains('active')) renderServiceView();
}

async function deleteServiceTicket(ticketId) {
    const ticket = serviceTickets.find(t => t.id === ticketId);
    if (!ticket) return;

    showConfirm('Delete Service Ticket', `Delete this service ticket permanently?<br><br><strong>Sensor:</strong> ${ticket.sensorId}<br><strong>Status:</strong> ${ticket.status}<br><strong>Type:</strong> ${formatTicketType(ticket.ticketType)}<br><br>This will delete all ticket data and history. This cannot be undone.`, async () => {
        // Remove from in-memory array
        const idx = serviceTickets.indexOf(ticket);
        if (idx >= 0) serviceTickets.splice(idx, 1);
        rebuildSensorTicketMap();

        // Delete auto-generated service notes
        await deleteAutoNotes('Service', [ticket.sensorId]);

        // Remove from database
        try {
            await supa.from('service_tickets').delete().eq('id', ticketId);
        } catch (err) {
            console.error('Delete ticket error:', err);
        }

        // Clean up sensor service statuses
        const s = sensors.find(x => x.id === ticket.sensorId);
        if (s) {
            const serviceStatuses = ['Quant Ticket in Progress', 'Shipped to Quant', 'Service at Quant', 'Shipped from Quant'];
            const cleaned = getStatusArray(s).filter(st => !serviceStatuses.includes(st));
            s.status = cleaned.length > 0 ? cleaned : ['Online'];
            persistSensor(s);
        }
        buildSensorSidebar();

        closeModal('modal-service-ticket');
        updateSidebarServiceCount();
        if (document.getElementById('view-service')?.classList.contains('active')) renderServiceView();
        if (currentSensor === ticket.sensorId) showSensorView(ticket.sensorId);
    }, { danger: true });
}

function openNewTicketModal(preselectedSensorId) {
    const select = document.getElementById('ticket-sensor-input');
    select.innerHTML = '<option value="">— Select Sensor —</option>' + [...sensors].sort((a, b) => a.id.localeCompare(b.id)).map(s => `<option value="${s.id}">${s.id}</option>`).join('');
    if (preselectedSensorId) select.value = preselectedSensorId;
    document.getElementById('ticket-type-issue').checked = true;
    document.getElementById('ticket-type-calibration').checked = false;
    document.getElementById('ticket-description-input').value = '';
    document.getElementById('ticket-rma-input').value = '';
    openModal('modal-new-service-ticket');
}

function openTicketFromSensor(sensorId) { openNewTicketModal(sensorId); }

async function saveNewTicket(event) {
    event.preventDefault();
    const sensorId = document.getElementById('ticket-sensor-input').value;
    const isIssue = document.getElementById('ticket-type-issue').checked;
    const isCalibration = document.getElementById('ticket-type-calibration').checked;
    const description = document.getElementById('ticket-description-input').value.trim();
    const rmaNumber = document.getElementById('ticket-rma-input').value.trim();
    if (!sensorId || !description) return;
    if (!isIssue && !isCalibration) { showAlert('Validation Error', 'Select at least one action needed.'); return; }

    const actions = [];
    if (isIssue) actions.push('Issue / Repair');
    if (isCalibration) actions.push('Calibration');
    const ticketType = isIssue && isCalibration ? 'issue+calibration' : isIssue ? 'issue' : 'calibration';

    const ticket = { sensorId, ticketType, status: rmaNumber ? 'RMA Assigned' : 'Ticket Opened',
        rmaNumber, fedexTrackingTo: '', fedexTrackingFrom: '', issueDescription: description,
        progressNotes: [], workCompleted: '', createdBy: getCurrentUserName(), createdById: currentUserId,
        createdAt: new Date().toISOString(), closedAt: null };
    try {
        const saved = await db.insertServiceTicket(ticket);
        serviceTickets.unshift(saved);
    } catch (err) { handleSaveError(err); ticket.id = generateId('tkt'); serviceTickets.unshift(ticket); }

    // Tag sensor with 'Quant Ticket in Progress' instead of 'Service at Quant'
    const s = sensors.find(x => x.id === sensorId);
    if (s) {
        const currentStatuses = getStatusArray(s);
        if (!currentStatuses.includes('Quant Ticket in Progress')) {
            currentStatuses.push('Quant Ticket in Progress');
            s.status = currentStatuses;
            persistSensor(s);
            buildSensorSidebar();
        }
    }

    rebuildSensorTicketMap();
    createNote('Service', `Service ticket opened (${actions.join(' + ')}): ${description}`, { sensors: [sensorId] });
    closeModal('modal-new-service-ticket');
    updateSidebarServiceCount();
    if (document.getElementById('view-service')?.classList.contains('active')) renderServiceView();
    if (currentSensor === sensorId) showSensorView(sensorId);
}

function openCloseTicketModal(ticketId) {
    const ticket = serviceTickets.find(t => t.id === ticketId);
    if (!ticket) return;
    document.getElementById('close-ticket-sensor-label').textContent = ticket.sensorId;
    document.getElementById('close-ticket-id').value = ticketId;
    document.getElementById('close-ticket-work').value = ticket.workCompleted || '';
    renderStatusToggleList('close-ticket-status', ['Offline']);
    closeModal('modal-service-ticket');
    openModal('modal-close-ticket');
}

function confirmCloseTicket() {
    const ticketId = document.getElementById('close-ticket-id').value;
    const ticket = serviceTickets.find(t => t.id === ticketId);
    if (!ticket) return;
    const workCompleted = document.getElementById('close-ticket-work').value.trim();
    const newStatuses = getSelectedStatuses('close-ticket-status');

    ticket.status = 'Closed';
    ticket.closedAt = nowDatetime();
    if (workCompleted) ticket.workCompleted = workCompleted;
    persistServiceTicketUpdate(ticketId, { status: 'Closed', closedAt: ticket.closedAt, workCompleted: ticket.workCompleted });
    rebuildSensorTicketMap();

    const s = sensors.find(x => x.id === ticket.sensorId);
    if (s) {
        // Remove 'Quant Ticket in Progress' if no other active tickets
        const otherActive = serviceTickets.filter(t => t.sensorId === ticket.sensorId && t.status !== 'Closed' && t.id !== ticketId);
        let finalStatuses = newStatuses.length > 0 ? newStatuses : getStatusArray(s);
        if (otherActive.length === 0) finalStatuses = finalStatuses.filter(st => st !== 'Quant Ticket in Progress');
        s.status = finalStatuses.length > 0 ? finalStatuses : ['Online'];
        persistSensor(s); buildSensorSidebar();
    }

    createNote('Service', `Service ticket closed.${workCompleted ? ' Work completed: ' + workCompleted : ''}`, { sensors: [ticket.sensorId] });
    closeModal('modal-close-ticket');
    updateSidebarServiceCount();
    renderServiceView();
    if (currentSensor === ticket.sensorId) showSensorView(ticket.sensorId);
}

// ===== AUDITS =====
const AUDIT_STATUSES = ['Scheduled', 'In Progress', 'Finished, Analysis Pending', 'Complete'];
const AUDIT_STATUS_CSS = { 'Scheduled': 'as-scheduled', 'In Progress': 'as-in-progress', 'Finished, Analysis Pending': 'as-analysis', 'Complete': 'as-verified' };
const AUDIT_PARAMETERS = [
    { key: 'pm25', label: 'PM2.5', labelHtml: 'PM<sub>2.5</sub>', unit: '\u00B5g/m\u00B3', hasTimeSeries: true },
    { key: 'pm10', label: 'PM10', labelHtml: 'PM<sub>10</sub>', unit: '\u00B5g/m\u00B3', hasTimeSeries: true },
    { key: 'co', label: 'CO', labelHtml: 'CO', unit: 'ppb', hasTimeSeries: false },
    { key: 'no', label: 'NO', labelHtml: 'NO', unit: 'ppb', hasTimeSeries: false },
    { key: 'no2', label: 'NO2', labelHtml: 'NO<sub>2</sub>', unit: 'ppb', hasTimeSeries: false },
    { key: 'o3', label: 'O3', labelHtml: 'O<sub>3</sub>', unit: 'ppb', hasTimeSeries: false },
];

const NON_AUDITABLE_COMMUNITIES = ['anchorage', 'fairbanks', 'juneau', 'anc-lab', 'anc-garden', 'fbx-lab', 'fbx-ncore', 'jnu-lab', 'jnu-floyd-dryden'];

function getAuditableCommunities() {
    return COMMUNITIES.filter(c => !NON_AUDITABLE_COMMUNITIES.includes(c.id) && !isCommunityDeactivated(c.id));
}

function getUnauditedCommunities() {
    const auditedIds = new Set(audits.map(a => a.communityId));
    return getAuditableCommunities().filter(c => !auditedIds.has(c.id));
}

function updateSidebarAuditCount() {
    const el = document.getElementById('sidebar-audit-count');
    if (!el) return;
    const count = audits.filter(a => a.status === 'Scheduled' || a.status === 'In Progress').length;
    el.textContent = `(${count})`;
}

function renderAuditsView() {
    updateSidebarAuditCount();
    const statusFilter = document.getElementById('audit-status-filter')?.value || '';
    let filtered = [...audits];
    if (statusFilter) filtered = filtered.filter(a => a.status === statusFilter);

    const pipeline = document.getElementById('audit-pipeline');
    const statusesToShow = statusFilter ? [statusFilter] : AUDIT_STATUSES;
    pipeline.innerHTML = statusesToShow.map(status => {
        const items = filtered.filter(a => a.status === status);
        return `<div class="audit-pipeline-column">
            <div class="audit-pipeline-column-header"><h3>${status}</h3><span class="audit-pipeline-count">${items.length}</span></div>
            ${items.length === 0 ? '<p style="font-size:13px;color:var(--slate-400)">No audits</p>' : items.map(renderAuditCard).join('')}
        </div>`;
    }).join('');
}

function renderAuditCard(audit) {
    const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || audit.communityId;
    const dateRange = audit.scheduledStart ? `${new Date(audit.scheduledStart + 'T00:00').toLocaleDateString('en-US', { timeZone: AK_TZ })} - ${new Date(audit.scheduledEnd + 'T00:00').toLocaleDateString('en-US', { timeZone: AK_TZ })}` : '—';
    const progress = AUDIT_STATUSES.map((st, i) => {
        const idx = AUDIT_STATUSES.indexOf(audit.status);
        const state = i < idx ? 'completed' : i === idx ? 'current' : 'pending';
        return `<div class="ticket-step ${state}"><div class="ticket-step-dot"></div><div class="ticket-step-label">${st}</div></div>`;
    }).join('');
    return `<div class="audit-card" onclick="openAuditDetail('${audit.id}')">
        <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="audit-community-name">${escapeHtml(communityName)}</span>
            <span class="audit-status-badge ${AUDIT_STATUS_CSS[audit.status]}">${audit.status}</span>
        </div>
        <div class="audit-card-sensors">
            <span class="ticket-sensor-id">${audit.auditPodId}</span>
            <span style="color:var(--slate-400);font-size:11px">auditing</span>
            <span class="ticket-sensor-id">${audit.communityPodId}</span>
        </div>
        <div class="ticket-meta">
            <span>${dateRange}</span>
            ${audit.conductedBy ? `<span>${escapeHtml(audit.conductedBy)}</span>` : ''}
        </div>
        <div class="ticket-steps">${progress}</div>
    </div>`;
}

function openNewAuditModal(preselectedCommunityId) {
    const auditPods = sensors.filter(s => s.type === 'Audit Pod').sort((a, b) => a.id.localeCompare(b.id));
    document.getElementById('audit-pod-input').innerHTML = '<option value="">— Select Audit Pod —</option>' + auditPods.map(s => `<option value="${s.id}">${s.id}</option>`).join('');
    const auditable = getAuditableCommunities().sort((a, b) => a.name.localeCompare(b.name));
    document.getElementById('audit-community-input').innerHTML = '<option value="">— Select Community —</option>' + auditable.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    document.getElementById('audit-community-pod-input').innerHTML = '<option value="">— Select community first —</option>';
    document.getElementById('audit-start-input').value = '';
    document.getElementById('audit-end-input').value = '';
    document.getElementById('audit-install-team-input').value = '';
    document.getElementById('audit-takedown-team-input').value = '';
    document.getElementById('audit-notes-input').value = '';
    if (preselectedCommunityId) { document.getElementById('audit-community-input').value = preselectedCommunityId; updateAuditCommunityPods(); }
    openModal('modal-new-audit');
}

function updateAuditCommunityPods() {
    const communityId = document.getElementById('audit-community-input').value;
    const podSelect = document.getElementById('audit-community-pod-input');
    if (!communityId) { podSelect.innerHTML = '<option value="">— Select community first —</option>'; return; }
    const pods = sensors.filter(s => s.community === communityId && s.type !== 'Audit Pod').sort((a, b) => a.id.localeCompare(b.id));
    podSelect.innerHTML = '<option value="">— Select Pod —</option>' + pods.map(s => `<option value="${s.id}">${s.id} (${s.type})</option>`).join('');
}

async function saveNewAudit(event) {
    event.preventDefault();
    const auditPodId = document.getElementById('audit-pod-input').value;
    const communityId = document.getElementById('audit-community-input').value;
    const communityPodId = document.getElementById('audit-community-pod-input').value;
    const scheduledStart = document.getElementById('audit-start-input').value;
    const scheduledEnd = document.getElementById('audit-end-input').value;
    const installTeam = document.getElementById('audit-install-team-input').value.trim();
    const takedownTeam = document.getElementById('audit-takedown-team-input').value.trim();
    const auditNotes = document.getElementById('audit-notes-input').value.trim();
    if (!auditPodId || !communityId || !communityPodId || !scheduledStart || !scheduledEnd) return;
    if (new Date(scheduledEnd) < new Date(scheduledStart)) { showAlert('Validation Error', 'End date must be after start date.'); return; }

    // Check for sensor overlap with existing audits
    const conflicts = audits.filter(a => {
        if (a.status === 'Complete') return false;
        const hasSensorOverlap = a.auditPodId === auditPodId || a.auditPodId === communityPodId || a.communityPodId === auditPodId || a.communityPodId === communityPodId;
        if (!hasSensorOverlap) return false;
        const hasDateOverlap = a.scheduledStart <= scheduledEnd && a.scheduledEnd >= scheduledStart;
        return hasDateOverlap;
    });

    const doSaveAudit = async () => {
        const conductedBy = [installTeam, takedownTeam].filter(Boolean).join(' / ');
        const audit = { auditPodId, communityPodId, communityId, status: 'Scheduled', scheduledStart, scheduledEnd,
            actualStart: null, actualEnd: null, conductedBy, progressNotes: auditNotes ? [{ text: auditNotes, by: getCurrentUserName(), at: nowDatetime() }] : [], analysisResults: {},
            createdBy: getCurrentUserName(), createdById: currentUserId };
        try { const saved = await db.insertAudit(audit); audits.unshift(saved); }
        catch (err) { handleSaveError(err); audit.id = generateId('aud'); audits.unshift(audit); }

        const communityName = COMMUNITIES.find(c => c.id === communityId)?.name || communityId;
        createNote('Audit', `Audit scheduled: ${auditPodId} auditing ${communityPodId} at ${communityName} (${scheduledStart} to ${scheduledEnd}).`, {
            sensors: [auditPodId, communityPodId], communities: [communityId] });
        closeModal('modal-new-audit'); showSuccessToast('Audit scheduled');
        updateSidebarAuditCount();
        if (document.getElementById('view-audits')?.classList.contains('active')) renderAuditsView();
    };

    if (conflicts.length > 0) {
        const msgs = conflicts.map(c => {
            const cName = COMMUNITIES.find(x => x.id === c.communityId)?.name || c.communityId;
            return `&bull; ${c.auditPodId} &harr; ${c.communityPodId} at ${cName} (${c.scheduledStart} to ${c.scheduledEnd})`;
        });
        showConfirm('Scheduling Conflict', `Warning: One or more sensors are already assigned to overlapping audits:<br><br>${msgs.join('<br>')}<br><br>Schedule anyway?`, doSaveAudit);
    } else {
        doSaveAudit();
    }
}

function openAuditDetail(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || audit.communityId;
    const idx = AUDIT_STATUSES.indexOf(audit.status);
    const nextStatus = idx < AUDIT_STATUSES.length - 1 ? AUDIT_STATUSES[idx + 1] : null;
    const progress = AUDIT_STATUSES.map((st, i) => {
        const state = i < idx ? 'completed' : i === idx ? 'current' : 'pending';
        return `<div class="ticket-step ${state}"><div class="ticket-step-dot"></div><div class="ticket-step-label">${st}</div></div>`;
    }).join('');

    const analysisHtml = Object.keys(audit.analysisResults || {}).length > 0
        ? `<table class="analysis-results-table"><thead><tr><th>Parameter<br><span style="font-weight:400;font-size:10px;text-transform:none">(DQO Threshold)</span></th><th>R\u00B2</th><th>Slope</th><th>Intercept</th><th>Result</th></tr></thead><tbody>
            ${AUDIT_PARAMETERS.map(p => { const r = (audit.analysisResults || {})[p.key]; if (!r) return ''; return `<tr><td>${p.label} (${p.unit})</td><td>${r.r2 ?? '—'}</td><td>${r.slope ?? '—'}</td><td>${r.intercept ?? '—'}</td><td>${r.pass ? '<span style="color:var(--aurora-green);font-weight:600">PASS</span>' : '<span style="color:var(--aurora-rose);font-weight:600">FAIL</span>'}</td></tr>`; }).join('')}
           </tbody></table>`
        : '<p style="font-size:13px;color:var(--slate-400)">No analysis results yet.</p>';

    document.getElementById('audit-detail-modal-title').textContent = `Audit: ${communityName}`;
    document.getElementById('audit-detail-modal-body').innerHTML = `
        <div style="padding:12px 28px 0"><div class="ticket-steps ticket-steps-detail">${progress}</div></div>
        <div class="ticket-detail-actions" style="border-top:none">
            ${nextStatus ? `<button class="btn btn-primary" onclick="advanceAuditStatus('${audit.id}')">Advance to: ${nextStatus}</button>` : ''}
            ${idx > 0 ? `<a class="undo-link" onclick="revertAuditStatus('${audit.id}')">Undo</a>` : ''}
            <span class="action-spacer"></span>
            ${audit.status === 'Finished, Analysis Pending' || audit.status === 'Complete' ? `<button class="btn" onclick="beginAnalysis('${audit.id}')" style="border-color:var(--navy-500);color:var(--navy-500)">${Object.keys(audit.analysisResults || {}).length > 0 ? 'View Analysis' : 'Begin Analysis'}</button>` : ''}
            ${Object.keys(audit.analysisResults || {}).length > 0 ? `<button class="btn" onclick="delete analysisDataCache['${audit.id}']; beginAnalysis('${audit.id}')">Re-upload Data</button>` : ''}
            <button class="btn" onclick="closeModal('modal-audit-detail')">Done</button>
        </div>
        <div class="ticket-detail-grid">
            <div class="ticket-field"><label>Community</label><p><a href="#" onclick="closeModal('modal-audit-detail'); showCommunity('${audit.communityId}'); return false;" style="color:var(--navy-500)">${escapeHtml(communityName)}</a></p></div>
            <div class="ticket-field"><label>Status</label><p><span class="audit-status-badge ${AUDIT_STATUS_CSS[audit.status]}">${audit.status}</span></p></div>
            <div class="ticket-field"><label>Audit Pod</label><p style="font-family:var(--font-mono);font-size:13px"><a href="#" onclick="closeModal('modal-audit-detail'); showSensorDetail('${audit.auditPodId}'); return false;" style="color:var(--navy-500)">${audit.auditPodId}</a></p></div>
            <div class="ticket-field"><label>Community Pod</label><p style="font-family:var(--font-mono);font-size:13px"><a href="#" onclick="closeModal('modal-audit-detail'); showSensorDetail('${audit.communityPodId}'); return false;" style="color:var(--navy-500)">${audit.communityPodId}</a></p></div>
            <div class="ticket-field"><label>Scheduled Start</label><input type="date" class="ticket-edit-input" value="${audit.scheduledStart || ''}" onblur="saveAuditField('${audit.id}','scheduledStart',this.value)"></div>
            <div class="ticket-field"><label>Scheduled End</label><input type="date" class="ticket-edit-input" value="${audit.scheduledEnd || ''}" onblur="saveAuditField('${audit.id}','scheduledEnd',this.value)"></div>
            <div class="ticket-field"><label>Actual Start</label><input type="date" class="ticket-edit-input" value="${audit.actualStart || ''}" onblur="saveAuditField('${audit.id}','actualStart',this.value)"></div>
            <div class="ticket-field"><label>Actual End</label><input type="date" class="ticket-edit-input" value="${audit.actualEnd || ''}" onblur="saveAuditField('${audit.id}','actualEnd',this.value)"></div>
            <div class="ticket-field"><label>Install Team</label><input class="ticket-edit-input" value="${escapeHtml(audit.conductedBy?.split(' / ')[0] || '')}" placeholder="Who installed" onblur="saveAuditConductors('${audit.id}', this.value, null)"></div>
            <div class="ticket-field"><label>Takedown Team</label><input class="ticket-edit-input" value="${escapeHtml(audit.conductedBy?.split(' / ')[1] || '')}" placeholder="Who removed" onblur="saveAuditConductors('${audit.id}', null, this.value)"></div>
            ${renderProgressNotesSection(audit.progressNotes, audit.id, 'addAuditProgressNote')}
        </div>
        <div style="padding:0 28px 16px"><label style="font-size:11px;font-weight:600;color:var(--slate-400);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:8px">Analysis Results</label>${analysisHtml}</div>
        <div style="padding:0 28px 16px"><label style="font-size:11px;font-weight:600;color:var(--slate-400);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:8px">Photos</label>
            <label class="btn btn-sm" style="cursor:pointer;margin-bottom:8px">Upload Photos <input type="file" accept="image/*" multiple style="display:none" onchange="uploadAuditPhotos('${audit.id}', '${audit.communityId}', this.files)"></label>
            <div id="audit-photos-grid" class="audit-photos-grid">${renderAuditPhotos(audit.id, audit.communityId)}</div>
        </div>
        <div style="padding:16px 28px;border-top:1px solid var(--slate-100);text-align:right">
            <button class="btn btn-sm btn-danger" onclick="deleteAudit('${audit.id}')" style="font-size:11px;opacity:0.7">Delete Audit</button>
        </div>`;
    openModal('modal-audit-detail');
}

function saveAuditField(auditId, field, value) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit || audit[field] === value) return;
    audit[field] = value;
    persistAuditUpdate(auditId, { [field]: value });
}

function saveAuditConductors(auditId, installVal, takedownVal) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    const parts = (audit.conductedBy || '').split(' / ');
    while (parts.length < 2) parts.push('');
    if (installVal !== null) parts[0] = installVal.trim();
    if (takedownVal !== null) parts[1] = takedownVal.trim();
    audit.conductedBy = parts.filter(Boolean).join(' / ');
    persistAuditUpdate(auditId, { conductedBy: audit.conductedBy });
}

function advanceAuditStatus(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    const idx = AUDIT_STATUSES.indexOf(audit.status);
    if (idx >= AUDIT_STATUSES.length - 1) return;
    const oldStatus = audit.status;
    const newStatus = AUDIT_STATUSES[idx + 1];

    const doAdvance = () => {
        audit.status = newStatus;
        const updates = { status: newStatus };

        if (newStatus === 'In Progress' && !audit.actualStart) { audit.actualStart = localDate(); updates.actualStart = audit.actualStart; }
        if (newStatus === 'Finished, Analysis Pending' && !audit.actualEnd) { audit.actualEnd = localDate(); updates.actualEnd = audit.actualEnd; }
        persistAuditUpdate(auditId, updates);

        const auditStatusPrefix = 'Audit: ';
        const communityPod = sensors.find(x => x.id === audit.communityPodId);
        const auditPod = sensors.find(x => x.id === audit.auditPodId);

        if (communityPod) {
            const cleaned = getStatusArray(communityPod).filter(st => !st.startsWith(auditStatusPrefix));
            if (newStatus !== 'Complete') {
                communityPod.status = [...cleaned, auditStatusPrefix + newStatus];
            } else {
                communityPod.status = cleaned.length > 0 ? cleaned : ['Online'];
            }
            persistSensor(communityPod);
        }

        if (auditPod) {
            const cleaned = getStatusArray(auditPod).filter(st => st !== 'Auditing a Community');
            if (newStatus === 'In Progress') {
                auditPod.status = [...cleaned, 'Auditing a Community'];
            } else {
                auditPod.status = cleaned.length > 0 ? cleaned : ['Online'];
            }
            persistSensor(auditPod);
        }
        buildSensorSidebar();

        const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || '';
        createNote('Audit', `Audit advanced: "${oldStatus}" \u2192 "${newStatus}" for ${communityName}.`, { sensors: [audit.auditPodId, audit.communityPodId], communities: [audit.communityId] });
        openAuditDetail(auditId);
        updateSidebarAuditCount();
        if (document.getElementById('view-audits')?.classList.contains('active')) renderAuditsView();
    };

    // Warn if skipping analysis
    if (newStatus === 'Complete' && Object.keys(audit.analysisResults || {}).length === 0) {
        showConfirm('No Analysis Data', 'No analysis data has been uploaded for this audit. Are you sure you want to mark it as complete without DQO analysis?', doAdvance);
    } else {
        doAdvance();
    }
}

function revertAuditStatus(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    const idx = AUDIT_STATUSES.indexOf(audit.status);
    if (idx <= 0) return;
    const oldStatus = audit.status;
    const newStatus = AUDIT_STATUSES[idx - 1];
    audit.status = newStatus;
    persistAuditUpdate(auditId, { status: newStatus });

    // Update sensor statuses to match reverted step
    const auditStatusPrefix = 'Audit: ';
    const communityPod = sensors.find(x => x.id === audit.communityPodId);
    const auditPod = sensors.find(x => x.id === audit.auditPodId);
    if (communityPod) {
        const cleaned = getStatusArray(communityPod).filter(st => !st.startsWith(auditStatusPrefix));
        if (newStatus === 'Scheduled') {
            communityPod.status = cleaned.length > 0 ? cleaned : ['Online'];
        } else {
            communityPod.status = [...cleaned, auditStatusPrefix + newStatus];
        }
        persistSensor(communityPod);
    }
    if (auditPod) {
        const cleaned = getStatusArray(auditPod).filter(st => st !== 'Auditing a Community');
        if (newStatus === 'In Progress') {
            auditPod.status = [...cleaned, 'Auditing a Community'];
        } else {
            auditPod.status = cleaned.length > 0 ? cleaned : ['Online'];
        }
        persistSensor(auditPod);
    }
    buildSensorSidebar();

    const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || '';
    createNote('Audit', `Audit reverted: "${oldStatus}" \u2192 "${newStatus}" for ${communityName}.`, { sensors: [audit.auditPodId, audit.communityPodId], communities: [audit.communityId] });
    openAuditDetail(auditId);
    updateSidebarAuditCount();
    if (document.getElementById('view-audits')?.classList.contains('active')) renderAuditsView();
}

// ===== AUDIT ANALYSIS ENGINE =====
let analysisChartInstances = [];
let analysisDataCache = {}; // keyed by auditId — raw parsed data, not persisted

const DQO_THRESHOLDS = {
    r2: { min: 0.70 },
    slope: { min: 0.65, max: 1.35 },
    intercept: { min: -5, max: 5 },
    sd: { max: 5 },
    rmse: { max: 7 },
};

const SAMPLE_SIZE_TIERS = { critical: 10, minimum: 24, adequate: 72, ideal: 168 };

// ===== FAILSAFE VALIDATION =====

// Check 7: Self-test (runs once, cached)
let _regressionSelfTestResults = null;
function _regressionSelfTest() {
    if (_regressionSelfTestResults !== null) return _regressionSelfTestResults;
    _regressionSelfTestResults = [];
    try {
        // Test 1: Perfect line y = 2x + 1 (slope=2, intercept=1, R²=1)
        const r1 = runLinearRegression([1,2,3,4,5], [3,5,7,9,11]);
        // Test 2: Perfect line y = x (slope=1, intercept=0, R²=1)
        const r2 = runLinearRegression([1,2,3,4,5], [1,2,3,4,5]);
        if (!r1 || !r2) {
            _regressionSelfTestResults.push({ test: 'Regression returns results', pass: false, detail: 'Function returned null' });
            return _regressionSelfTestResults;
        }
        _regressionSelfTestResults.push({ test: 'Known slope (y=2x+1, expected 2.0)', pass: Math.abs(r1.slope - 2.0) < 0.001, detail: `Got ${r1.slope}` });
        _regressionSelfTestResults.push({ test: 'Known intercept (y=2x+1, expected 1.0)', pass: Math.abs(r1.intercept - 1.0) < 0.001, detail: `Got ${r1.intercept}` });
        _regressionSelfTestResults.push({ test: 'Perfect fit R\u00B2 (y=2x+1, expected 1.0)', pass: r1.r2 >= 0.9999, detail: `Got ${r1.r2}` });
        _regressionSelfTestResults.push({ test: 'Identity slope (y=x, expected 1.0)', pass: Math.abs(r2.slope - 1) < 0.001, detail: `Got ${r2.slope}` });
        _regressionSelfTestResults.push({ test: 'Identity intercept (y=x, expected 0)', pass: Math.abs(r2.intercept) < 0.001, detail: `Got ${r2.intercept}` });
        _regressionSelfTestResults.push({ test: 'Identity R\u00B2 (y=x, expected 1.0)', pass: r2.r2 >= 0.9999, detail: `Got ${r2.r2}` });
        _regressionSelfTestResults.push({ test: 'Sample size preserved (n=5)', pass: r1.n === 5 && r2.n === 5, detail: `Got n=${r1.n}, n=${r2.n}` });
    } catch(e) {
        _regressionSelfTestResults.push({ test: 'Regression engine runs without error', pass: false, detail: e.message });
    }
    const allPass = _regressionSelfTestResults.every(t => t.pass);
    if (!allPass) console.error('REGRESSION SELF-TEST FAILED', _regressionSelfTestResults.filter(t => !t.pass));
    return _regressionSelfTestResults;
}

function runFailsafeValidation(parsed, results, type) {
    const warnings = [];

    // Check 7 — Self-test (granular results)
    const selfTestResults = _regressionSelfTest();
    const selfTestAllPass = selfTestResults.every(t => t.pass);
    selfTestResults.forEach(t => {
        warnings.push({ category: 'self-test', severity: t.pass ? 'pass' : 'error', msg: `${t.test}: ${t.pass ? 'PASS' : 'FAIL'} (${t.detail})` });
    });
    if (!selfTestAllPass) {
        warnings.push({ category: 'self-test', severity: 'error', msg: 'One or more self-test checks FAILED. Results may be unreliable.' });
    }

    // Helper: iterate all result entries with their label and result object
    function _forEachResult(callback) {
        if (type === 'audit') {
            AUDIT_PARAMETERS.forEach(p => {
                if (results[p.key]) callback(p.label, p.key, results[p.key]);
            });
        } else {
            // Collocation: bamVsPods, bamVsPerma, permaVsPods
            if (results.bamVsPods) {
                for (const podId of Object.keys(results.bamVsPods)) {
                    for (const [key, res] of Object.entries(results.bamVsPods[podId])) {
                        const p = AUDIT_PARAMETERS.find(x => x.key === key);
                        callback(`BAM vs ${podId} ${p ? p.label : key}`, key, res);
                    }
                }
            }
            if (results.bamVsPerma) {
                for (const [key, res] of Object.entries(results.bamVsPerma)) {
                    const p = AUDIT_PARAMETERS.find(x => x.key === key);
                    callback(`BAM vs Perma ${p ? p.label : key}`, key, res);
                }
            }
            if (results.permaVsPods) {
                for (const podId of Object.keys(results.permaVsPods)) {
                    for (const [key, res] of Object.entries(results.permaVsPods[podId])) {
                        const p = AUDIT_PARAMETERS.find(x => x.key === key);
                        callback(`Perma vs ${podId} ${p ? p.label : key}`, key, res);
                    }
                }
            }
        }
    }

    // Check 1 — Regression verification (Pearson R2 cross-check)
    _forEachResult((paramLabel, key, result) => {
        const pairs = result.pairs;
        if (pairs && pairs.length > 2) {
            const n = pairs.length;
            let sx=0,sy=0,sxy=0,sx2=0,sy2=0;
            pairs.forEach(p => { sx+=p.x; sy+=p.y; sxy+=p.x*p.y; sx2+=p.x*p.x; sy2+=p.y*p.y; });
            const num = n*sxy - sx*sy;
            const den = Math.sqrt((n*sx2-sx*sx)*(n*sy2-sy*sy));
            const r2_pearson_raw = den === 0 ? 0 : (num/den)*(num/den);
            // Round to same precision as runLinearRegression (4 decimal places) before comparing
            const r2_pearson = Math.round(r2_pearson_raw * 10000) / 10000;
            if (Math.abs(r2_pearson - result.r2) > 0.001) {
                warnings.push({ category: 'regression-verify', severity: 'error', msg: `${paramLabel} R\u00B2 cross-check FAIL: regression=${result.r2}, Pearson=${r2_pearson}` });
            } else {
                warnings.push({ category: 'regression-verify', severity: 'pass', msg: `${paramLabel} R\u00B2 cross-check verified (${result.r2})` });
            }
        }
    });

    // Check 3 — Timestamp validation
    if (parsed.trimmedRows && parsed.trimmedRows.length >= 2) {
        const rows = parsed.trimmedRows;
        const now = new Date();
        const minDate = new Date('2020-01-01T00:00:00Z');
        let gapCount = 0;
        let maxGapHours = 0;
        let futureCount = 0;
        let preDateCount = 0;

        for (let i = 0; i < rows.length; i++) {
            const ts = rows[i].timestamp;
            if (ts > now) futureCount++;
            if (ts < minDate) preDateCount++;
            if (i > 0) {
                const diffHours = Math.abs(ts - rows[i-1].timestamp) / 3600000;
                if (diffHours > 2) {
                    gapCount++;
                    if (diffHours > maxGapHours) maxGapHours = diffHours;
                }
            }
        }

        const firstTs = rows[0].timestamp;
        const lastTs = rows[rows.length - 1].timestamp;
        const totalHours = Math.abs(lastTs - firstTs) / 3600000;

        if (gapCount > 0) {
            warnings.push({ category: 'timestamp', severity: 'warning', msg: `${gapCount} time gap(s) > 2 hours detected (largest: ${maxGapHours.toFixed(1)}h)` });
        }
        if (totalHours < 48) {
            warnings.push({ category: 'timestamp', severity: 'warning', msg: `Post-trim data spans only ${totalHours.toFixed(1)} hours (< 48h recommended)` });
        }
        if (futureCount > 0) {
            warnings.push({ category: 'timestamp', severity: 'error', msg: `${futureCount} timestamp(s) are in the future` });
        }
        if (preDateCount > 0) {
            warnings.push({ category: 'timestamp', severity: 'error', msg: `${preDateCount} timestamp(s) are before 2020` });
        }
    }

    // Check 4 — Sample size
    _forEachResult((paramLabel, key, result) => {
        const n = result.n;
        if (n == null) return;
        if (n < SAMPLE_SIZE_TIERS.critical) {
            warnings.push({ category: 'sample-size', severity: 'error', msg: `${paramLabel}: only ${n} data pairs \u2014 critically low (minimum ${SAMPLE_SIZE_TIERS.critical})` });
        } else if (n < SAMPLE_SIZE_TIERS.minimum) {
            warnings.push({ category: 'sample-size', severity: 'error', msg: `${paramLabel}: ${n} data pairs \u2014 minimum ${SAMPLE_SIZE_TIERS.minimum} recommended` });
        } else if (n < SAMPLE_SIZE_TIERS.adequate) {
            warnings.push({ category: 'sample-size', severity: 'warning', msg: `${paramLabel}: ${n} data pairs \u2014 ${SAMPLE_SIZE_TIERS.adequate}+ recommended for robust analysis` });
        } else {
            warnings.push({ category: 'sample-size', severity: 'info', msg: `${paramLabel}: ${n} data pairs` });
        }
    });

    // Check 8 — Near-boundary DQO
    _forEachResult((paramLabel, key, result) => {
        const T = DQO_THRESHOLDS;
        // R2 near boundary: 0.70-0.73
        if (result.r2 >= T.r2.min && result.r2 < T.r2.min + 0.03) {
            const margin = ((result.r2 - T.r2.min) * 100).toFixed(1);
            warnings.push({ category: 'near-boundary', severity: 'info', msg: `${paramLabel} R\u00B2 = ${result.r2} \u2014 borderline (margin: ${margin}%)` });
        }
        // Slope near lower boundary: 0.65-0.72
        if (result.slope >= T.slope.min && result.slope < T.slope.min + 0.07) {
            const margin = ((result.slope - T.slope.min) / T.slope.min * 100).toFixed(1);
            warnings.push({ category: 'near-boundary', severity: 'info', msg: `${paramLabel} slope = ${result.slope} \u2014 borderline (margin: ${margin}%)` });
        }
        // Slope near upper boundary: 1.28-1.35
        if (result.slope > T.slope.max - 0.07 && result.slope <= T.slope.max) {
            const margin = ((T.slope.max - result.slope) / T.slope.max * 100).toFixed(1);
            warnings.push({ category: 'near-boundary', severity: 'info', msg: `${paramLabel} slope = ${result.slope} \u2014 borderline (margin: ${margin}%)` });
        }
        // Intercept near lower: -5 to -4
        if (result.intercept >= T.intercept.min && result.intercept < T.intercept.min + 1) {
            const margin = (result.intercept - T.intercept.min).toFixed(2);
            warnings.push({ category: 'near-boundary', severity: 'info', msg: `${paramLabel} intercept = ${result.intercept} \u2014 borderline (margin: ${margin})` });
        }
        // Intercept near upper: 4 to 5
        if (result.intercept > T.intercept.max - 1 && result.intercept <= T.intercept.max) {
            const margin = (T.intercept.max - result.intercept).toFixed(2);
            warnings.push({ category: 'near-boundary', severity: 'info', msg: `${paramLabel} intercept = ${result.intercept} \u2014 borderline (margin: ${margin})` });
        }
        // SD near boundary: 4.5-5.0
        if (result.sd > T.sd.max - 0.5 && result.sd <= T.sd.max) {
            const margin = ((T.sd.max - result.sd) / T.sd.max * 100).toFixed(1);
            warnings.push({ category: 'near-boundary', severity: 'info', msg: `${paramLabel} SD = ${result.sd} \u2014 borderline (margin: ${margin}%)` });
        }
        // RMSE near boundary: 6.3-7.0
        if (result.rmse > T.rmse.max - 0.7 && result.rmse <= T.rmse.max) {
            const margin = ((T.rmse.max - result.rmse) / T.rmse.max * 100).toFixed(1);
            warnings.push({ category: 'near-boundary', severity: 'info', msg: `${paramLabel} RMSE = ${result.rmse} \u2014 borderline (margin: ${margin}%)` });
        }
    });

    return warnings;
}

function renderValidationReport(warnings) {
    if (!warnings || !warnings.length) return '';
    const errors = warnings.filter(w => w.severity === 'error');
    const warns = warnings.filter(w => w.severity === 'warning');
    const passes = warnings.filter(w => w.severity === 'pass');
    const infos = warnings.filter(w => w.severity === 'info');
    const hasIssues = errors.length > 0 || warns.length > 0;

    // Summary line
    let summaryColor = hasIssues ? '#c53030' : '#15803d';
    let summaryBg = hasIssues ? '#fef2f2' : '#f0fdf4';
    let summaryBorder = hasIssues ? '#fecaca' : '#86efac';
    let summaryIcon = hasIssues ? '\u26A0' : '\u2705';
    let summaryText = hasIssues
        ? `${errors.length} error(s), ${warns.length} warning(s)`
        : `All ${passes.length + infos.length} checks passed`;

    let html = `<details style="margin-bottom:16px;border:1px solid ${summaryBorder};border-radius:8px;overflow:hidden">
        <summary style="padding:10px 14px;background:${summaryBg};color:${summaryColor};font-size:12px;font-weight:600;cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px">
            <span>${summaryIcon}</span>
            <span>Data Validation: ${summaryText}</span>
            <span style="margin-left:auto;font-weight:400;font-size:11px;color:#94a3b8">Click to ${hasIssues ? 'review' : 'expand'}</span>
        </summary>
        <div style="padding:10px 14px;background:#fff">`;

    // Errors first
    errors.forEach(w => {
        html += `<div style="padding:5px 8px;margin-bottom:3px;border-radius:4px;font-size:11px;background:#fef2f2;color:#c53030;border:1px solid #fecaca">\u26D4 ${escapeHtml(w.msg)}</div>`;
    });

    // Warnings
    warns.forEach(w => {
        html += `<div style="padding:5px 8px;margin-bottom:3px;border-radius:4px;font-size:11px;background:#fffbeb;color:#d97706;border:1px solid #fde68a">\u26A0 ${escapeHtml(w.msg)}</div>`;
    });

    // Passes (green)
    passes.forEach(w => {
        html += `<div style="padding:5px 8px;margin-bottom:3px;border-radius:4px;font-size:11px;background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0">\u2713 ${escapeHtml(w.msg)}</div>`;
    });

    // Info (gray)
    infos.forEach(w => {
        html += `<div style="padding:5px 8px;margin-bottom:3px;border-radius:4px;font-size:11px;background:#f8fafc;color:#64748b;border:1px solid #e2e8f0">\u2139 ${escapeHtml(w.msg)}</div>`;
    });

    html += '</div></details>';
    return html;
}

// Column name mapping: match QuantAQ AirVision export columns to our parameter keys
const PARAM_COLUMN_MAP = {
    co: [/\bCO_PPB\b/i, /\bco_ppb\b/i, /\bCO\b.*ppb/i],
    no: [/(?<!NO2|OZONE)\bNO_PPB\b/i, /(?<![A-Z])NO_PPB/i, /(?<![A-Z])NO\b.*ppb/i],
    no2: [/\bNO2_PPB\b/i, /\bno2_ppb\b/i, /\bNO\u2082\b/i],
    o3: [/\bOZONE_PPB\b/i, /\bO3_PPB\b/i, /\bO3\b.*ppb/i, /\bozone\b/i],
    pm10: [/\bPM10[_\s]?CONTIN\b/i, /\bPM10L\b/i, /\bPM10\b/i, /\bPM\s*10\b/i],
    pm25: [/\bPM25(?!L)\b/i, /\bPM2[\._]?5(?!L)\b/i, /\bPM\s*2\.?5\b/i],
};

async function deleteAudit(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || audit.communityId;

    showConfirm('Delete Audit', `Delete this audit permanently?<br><br><strong>Community:</strong> ${communityName}<br><strong>Pods:</strong> ${audit.auditPodId} &harr; ${audit.communityPodId}<br><strong>Dates:</strong> ${audit.scheduledStart || '?'} to ${audit.scheduledEnd || '?'}<br><br>This will delete all audit data, analysis results, and associated notes. This cannot be undone.`, async () => {
        // Remove from in-memory array
        const idx = audits.indexOf(audit);
        if (idx >= 0) audits.splice(idx, 1);

        // Delete auto-generated audit notes
        await deleteAutoNotes('Audit', [audit.auditPodId, audit.communityPodId]);

        // Remove from database
        try {
            await supa.from('audits').delete().eq('id', auditId);
        } catch (err) {
            console.error('Delete audit error:', err);
        }

        // Clean up cached analysis data
        delete analysisDataCache[auditId];

        // Clean up sensor audit statuses if the audit was in progress
        const auditStatusPrefix = 'Audit: ';
        const communityPod = sensors.find(x => x.id === audit.communityPodId);
        const auditPod = sensors.find(x => x.id === audit.auditPodId);
        if (communityPod) {
            const cleaned = getStatusArray(communityPod).filter(st => !st.startsWith(auditStatusPrefix));
            communityPod.status = cleaned.length > 0 ? cleaned : ['Online'];
            persistSensor(communityPod);
        }
        if (auditPod) {
            const cleaned = getStatusArray(auditPod).filter(st => st !== 'Auditing a Community');
            auditPod.status = cleaned.length > 0 ? cleaned : ['Online'];
            persistSensor(auditPod);
        }
        buildSensorSidebar();

        closeModal('modal-audit-detail');
        updateSidebarAuditCount();
        if (document.getElementById('view-audits')?.classList.contains('active')) renderAuditsView();
        if (currentCommunity) showCommunityView(currentCommunity);
        if (currentSensor) showSensorView(currentSensor);
    }, { danger: true });
}

function beginAnalysis(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    purgeAnalysisPlots();
    // Close audit detail modal first so analysis modal is visible
    closeModal('modal-audit-detail');
    const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || audit.communityId;

    const hasResults = Object.keys(audit.analysisResults || {}).length > 0;

    // If we have both results and cached data, show full analysis
    if (hasResults && analysisDataCache[auditId]) {
        document.getElementById('analysis-modal-title').textContent = audit.analysisName || `Audit Analysis: ${communityName}`;
        renderAnalysisResults(auditId, analysisDataCache[auditId]);
        openModal('modal-audit-analysis');
        return;
    }

    // If we have results but no cached data (page was refreshed), rebuild cache from saved chart data
    if (hasResults && !analysisDataCache[auditId]) {
        if (audit.analysisChartData) {
            analysisDataCache[auditId] = rebuildCacheFromSaved(audit);
        }
        if (analysisDataCache[auditId]) {
            document.getElementById('analysis-modal-title').textContent = audit.analysisName || `Audit Analysis: ${communityName}`;
            renderAnalysisResults(auditId, analysisDataCache[auditId]);
            openModal('modal-audit-analysis');
            return;
        }
        // Fallback if no chart data saved (old audits before this feature)
        document.getElementById('analysis-modal-title').textContent = audit.analysisName || `Audit Analysis: ${communityName}`;
        renderSavedAnalysisView(auditId);
        openModal('modal-audit-analysis');
        return;
    }

    // Show upload flow
    const defaultName = `Audit ${audit.auditPodId} \u2014 ${communityName} ${audit.communityPodId}, ${audit.scheduledStart || ''} to ${audit.scheduledEnd || ''}`;
    document.getElementById('analysis-modal-title').textContent = 'New Audit Analysis';

    // Body was already cleared by purgeAnalysisPlots; use requestAnimationFrame
    // to let the browser fully flush the empty state before injecting new content
    const body = document.getElementById('audit-analysis-body');
    requestAnimationFrame(() => {
        body.innerHTML = `
            <div class="analysis-instructions">
                <strong>Data Preparation Instructions:</strong>
                <ol>
                    <li>Pull data from the audit pod and local pod from AirVision</li>
                    <li>Open the file and clean up: remove invalidated data</li>
                    <li>Trim start and end of dataset to the start and end of the audit period</li>
                    <li><strong>Do not remove the first 24 hours</strong> \u2014 the app will automatically exclude them from regression analysis</li>
                </ol>
            </div>
            <label style="font-size:12px;font-weight:600;color:var(--slate-500);text-transform:uppercase;letter-spacing:0.5px">Analysis Name</label>
            <input type="text" class="analysis-name-input" id="analysis-name-input" value="${escapeHtml(defaultName)}" placeholder="e.g. Audit 471 - Kodiak 660, March 4-13 2026">
            <div class="analysis-upload-zone" id="analysis-drop-zone" onclick="this.querySelector('input[type=file]').click()">
                <div class="analysis-upload-icon">&#128196;</div>
                <div class="analysis-upload-text">Click to upload Excel file (.xls or .xlsx)</div>
                <div class="analysis-upload-hint">Hourly data export from AirVision with both sensor columns</div>
                <input type="file" accept=".xls,.xlsx" onchange="handleAnalysisUpload('${auditId}', this.files[0])">
            </div>
        `;
    });
    openModal('modal-audit-analysis');
}

function purgeAnalysisPlots() {
    // Destroy Chart.js instances
    analysisChartInstances.forEach(c => { try { c.destroy(); } catch(e) {} });
    analysisChartInstances = [];
    // Purge all Plotly plots from the analysis modal body
    const body = document.getElementById('audit-analysis-body');
    if (body) {
        if (typeof Plotly !== 'undefined') {
            // Purge every child that Plotly may have touched — not just .js-plotly-plot
            Array.from(body.querySelectorAll('.js-plotly-plot, .plot-container, .svg-container')).forEach(el => {
                try { Plotly.purge(el); } catch(e) {}
            });
        }
        // Nuke the entire container so no stale SVG/DOM fragments survive
        body.innerHTML = '';
    }
}

function closeAnalysisModal() {
    purgeAnalysisPlots();
    closeModal('modal-audit-analysis');
}

function handleAnalysisUpload(auditId, file) {
    if (!file) return;
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;

    // Capture the analysis name before we replace the DOM
    const analysisName = document.querySelector('#analysis-name-input')?.value || `Audit ${audit.auditPodId} - ${audit.communityPodId}`;

    const body = document.getElementById('audit-analysis-body');
    body.innerHTML = '<div class="analysis-processing">Processing data... parsing Excel file and running regression analysis.</div>';

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            // Use first sheet (or "Sheet1" or "Hour Data")
            const sheetName = wb.SheetNames.find(n => /hour|data|sheet1/i.test(n)) || wb.SheetNames[0];
            const sheet = wb.Sheets[sheetName];
            const jsonRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            const parsed = parseAuditData(jsonRows, audit);
            if (!parsed) {
                body.innerHTML = '<div class="analysis-processing" style="color:var(--aurora-rose)">Could not parse the uploaded file. Make sure it contains hourly data for two sensors with parameter columns (CO, NO, NO\u2082, O\u2083, PM\u2081\u2080, PM\u2082.\u2085).</div>';
                return;
            }

            // Start the validation chain: missing params → duration → run analysis
            _analysisValidationChain(auditId, audit, parsed, analysisName, body, []);

        } catch (err) {
            console.error('Analysis error:', err);
            body.innerHTML = `<div class="analysis-processing" style="color:var(--aurora-rose)">Error processing file: ${escapeHtml(err.message)}</div>`;
        }
    };
    reader.readAsArrayBuffer(file);
}

// Determine which parameters are required based on sensor model (PM-only vs full Modulair)
function _getRequiredParams(audit) {
    const pmOnlyPattern1 = /MOD-?\d{2,}-PM-/i;
    const pmOnlyPattern2 = /MOD-.*PM.*\d{4,}/i;
    const sensorIds = [audit.auditPodId || '', audit.communityPodId || ''];
    const isPmOnly = sensorIds.some(id => pmOnlyPattern1.test(id) || pmOnlyPattern2.test(id));
    if (isPmOnly) return ['pm25', 'pm10'];
    return ['pm25', 'pm10', 'co', 'no', 'no2', 'o3'];
}

// Check which required params are missing valid paired data
function _findMissingParams(parsed, requiredKeys) {
    const missing = [];
    for (const key of requiredKeys) {
        let validPairs = 0;
        for (const row of parsed.trimmedRows) {
            const a = row.values[key]?.a;
            const b = row.values[key]?.b;
            if (!isNaN(a) && !isNaN(b) && isFinite(a) && isFinite(b)) validPairs++;
        }
        if (validPairs === 0) missing.push(key);
    }
    return missing;
}

// Validation chain: step 1 — missing parameters
function _analysisValidationChain(auditId, audit, parsed, analysisName, body, collectedNotes) {
    const requiredKeys = _getRequiredParams(audit);
    const missingKeys = _findMissingParams(parsed, requiredKeys);

    if (missingKeys.length > 0) {
        const paramLabels = missingKeys.map(k => {
            const p = AUDIT_PARAMETERS.find(x => x.key === k);
            return p ? p.label : k.toUpperCase();
        });
        const msg = `The uploaded dataset is missing data for: <strong>${paramLabels.join(', ')}</strong>.<br><br>This may indicate an incomplete export or a PM-only sensor. Do you want to proceed with the available data?`;
        showConfirm('Missing Parameters', msg, () => {
            // User clicked "Proceed Anyway" — prompt for optional note
            _promptAnalysisNote('Missing parameters: ' + paramLabels.join(', '), (note) => {
                const notes = [...collectedNotes];
                if (note) notes.push(note);
                _analysisValidationChainStep2(auditId, audit, parsed, analysisName, body, notes);
            });
        }, { confirmText: 'Proceed Anyway', cancelText: 'Cancel', onCancel: () => {
            body.innerHTML = '<div class="analysis-processing" style="color:var(--slate-400)">Upload cancelled.</div>';
            setTimeout(() => rerunAnalysisUpload(auditId), 600);
        } });
    } else {
        _analysisValidationChainStep2(auditId, audit, parsed, analysisName, body, collectedNotes);
    }
}

// Validation chain: step 2 — dataset duration
function _analysisValidationChainStep2(auditId, audit, parsed, analysisName, body, collectedNotes) {
    const firstTs = parsed.allRows[0]?.timestamp?.getTime();
    const lastTs = parsed.allRows[parsed.allRows.length - 1]?.timestamp?.getTime();
    const durationDays = (lastTs && firstTs) ? (lastTs - firstTs) / (1000 * 60 * 60 * 24) : 0;

    if (durationDays < 7 && durationDays > 0) {
        const daysStr = durationDays.toFixed(1);
        const msg = `This dataset covers only <strong>${daysStr} days</strong>. Audits typically run for at least 7 days for reliable results.<br><br>Do you want to proceed anyway?`;
        showConfirm('Short Dataset Duration', msg, () => {
            _promptAnalysisNote('Short duration: ' + daysStr + ' days', (note) => {
                const notes = [...collectedNotes];
                if (note) notes.push(note);
                _finalizeAnalysis(auditId, audit, parsed, analysisName, body, notes);
            });
        }, { confirmText: 'Proceed Anyway', cancelText: 'Cancel', onCancel: () => {
            body.innerHTML = '<div class="analysis-processing" style="color:var(--slate-400)">Upload cancelled.</div>';
            setTimeout(() => rerunAnalysisUpload(auditId), 600);
        } });
    } else {
        _finalizeAnalysis(auditId, audit, parsed, analysisName, body, collectedNotes);
    }
}

// Prompt for an optional note after a warning
function _promptAnalysisNote(context, callback) {
    const msg = `<p style="margin-bottom:12px">You can add an optional note explaining the situation (${escapeHtml(context)}):</p>
        <textarea id="analysis-warning-note" rows="3" style="width:100%;padding:8px 12px;border:1px solid var(--slate-200);border-radius:6px;font-family:var(--font-sans);font-size:13px;resize:vertical" placeholder="Optional note (e.g., reason for missing data or short duration)..."></textarea>`;
    showConfirm('Add Note (Optional)', msg, () => {
        const note = document.getElementById('analysis-warning-note')?.value?.trim() || '';
        callback(note);
    }, { confirmText: 'Continue', cancelText: 'Skip', onCancel: () => { callback(''); } });
}

// Build data integrity warnings for the analysis view
function _buildDataIntegrityWarnings(parsed, audit) {
    const warnings = [];
    const results = audit.analysisResults || {};
    const totalRows = parsed.trimmedRows.length;

    // Low data count warnings
    for (const p of AUDIT_PARAMETERS) {
        const r = results[p.key];
        if (r && r.n < 20) {
            warnings.push({ type: 'warning', msg: `Low data count for ${p.label}: only ${r.n} valid data pairs` });
        }
    }

    // >25% NaN/missing values per parameter
    if (totalRows > 0) {
        for (const p of AUDIT_PARAMETERS) {
            let missingCount = 0;
            for (const row of parsed.trimmedRows) {
                const a = row.values[p.key]?.a;
                const b = row.values[p.key]?.b;
                if (isNaN(a) || isNaN(b) || !isFinite(a) || !isFinite(b)) missingCount++;
            }
            const missingPct = Math.round((missingCount / totalRows) * 100);
            if (missingPct > 25) {
                warnings.push({ type: 'warning', msg: `${p.label} has ${missingPct}% missing values \u2014 data may be incomplete` });
            }
        }
    }

    // Negative PM values (with count)
    let negativePMCount = 0;
    for (const row of parsed.trimmedRows) {
        for (const pmKey of ['pm25', 'pm10']) {
            const a = row.values[pmKey]?.a;
            const b = row.values[pmKey]?.b;
            if (!isNaN(a) && a < 0) negativePMCount++;
            if (!isNaN(b) && b < 0) negativePMCount++;
        }
    }
    if (negativePMCount > 0) {
        warnings.push({ type: 'warning', msg: `Negative PM values detected (${negativePMCount} occurrences) \u2014 these are physically impossible and may indicate sensor malfunction` });
    }

    // Duplicate timestamps
    const timestampStrings = parsed.trimmedRows.map(r => r.timestamp?.getTime?.() || r.timestamp);
    const seen = new Set();
    let duplicateCount = 0;
    for (const ts of timestampStrings) {
        if (seen.has(ts)) {
            duplicateCount++;
        } else {
            seen.add(ts);
        }
    }
    if (duplicateCount > 0) {
        warnings.push({ type: 'warning', msg: `${duplicateCount} duplicate timestamps found \u2014 data may have been exported incorrectly` });
    }

    // Hourly interval validation
    if (parsed.trimmedRows.length >= 3) {
        const intervals = [];
        for (let i = 1; i < parsed.trimmedRows.length; i++) {
            const t1 = parsed.trimmedRows[i - 1].timestamp?.getTime?.() || parsed.trimmedRows[i - 1].timestamp;
            const t2 = parsed.trimmedRows[i].timestamp?.getTime?.() || parsed.trimmedRows[i].timestamp;
            if (t1 && t2) {
                const diffMin = Math.abs(t2 - t1) / 60000;
                if (diffMin > 0) intervals.push(diffMin);
            }
        }
        if (intervals.length > 0) {
            const sorted = intervals.slice().sort((a, b) => a - b);
            const medianInterval = sorted[Math.floor(sorted.length / 2)];
            if (medianInterval < 55 || medianInterval > 65) {
                warnings.push({ type: 'warning', msg: `Data interval appears to be ${Math.round(medianInterval)} minutes instead of hourly \u2014 verify correct data resolution` });
            }
        }
    }

    // Sensor ID cross-check
    const fileSensorA = parsed.sensorA?.id || '';
    const fileSensorB = parsed.sensorB?.id || '';
    const auditPodNorm = (audit.auditPodId || '').replace(/[-_\s]/g, '').toUpperCase();
    const communityPodNorm = (audit.communityPodId || '').replace(/[-_\s]/g, '').toUpperCase();
    const fileIds = [fileSensorA, fileSensorB].map(s => s.replace(/[-_\s]/g, '').toUpperCase());
    const matchesAudit = fileIds.some(fid => fid.includes(auditPodNorm.replace('MOD', '')) || auditPodNorm.includes(fid.replace('MOD', '')));
    const matchesCommunity = fileIds.some(fid => fid.includes(communityPodNorm.replace('MOD', '')) || communityPodNorm.includes(fid.replace('MOD', '')));
    if (!matchesAudit || !matchesCommunity) {
        warnings.push({ type: 'warning', msg: `Sensor IDs in file (${fileSensorA}, ${fileSensorB}) don't match the audit's assigned pods (${audit.auditPodId}, ${audit.communityPodId})` });
    }

    // Data coverage per parameter
    if (totalRows > 0) {
        const coverageLines = [];
        for (const p of AUDIT_PARAMETERS) {
            let validPairs = 0;
            for (const row of parsed.trimmedRows) {
                const a = row.values[p.key]?.a;
                const b = row.values[p.key]?.b;
                if (!isNaN(a) && !isNaN(b) && isFinite(a) && isFinite(b)) validPairs++;
            }
            const pct = Math.round((validPairs / totalRows) * 100);
            coverageLines.push(`${p.label}: ${pct}% (${validPairs}/${totalRows})`);
        }
        warnings.push({ type: 'info', msg: 'Data coverage: ' + coverageLines.join(', ') });
    }

    return warnings;
}

// Render data integrity warnings HTML
function _renderIntegrityWarnings(warnings) {
    if (!warnings || warnings.length === 0) return '';
    return `<div class="analysis-integrity-warnings" style="margin-bottom:16px">
        ${warnings.map(w => {
            const color = w.type === 'warning' ? 'var(--aurora-rose, #c53030)' : 'var(--slate-500, #64748b)';
            const bg = w.type === 'warning' ? '#fef2f2' : 'var(--slate-50, #f8fafc)';
            const icon = w.type === 'warning' ? '\u26A0' : '\u2139';
            const border = w.type === 'warning' ? '#fecaca' : 'var(--slate-200, #e2e8f0)';
            return `<div style="padding:8px 12px;margin-bottom:6px;border-radius:6px;font-size:12px;background:${bg};color:${color};border:1px solid ${border}">
                <span style="margin-right:6px">${icon}</span>${escapeHtml(w.msg)}
            </div>`;
        }).join('')}
    </div>`;
}

// Finalize: run analysis, save, render
function _finalizeAnalysis(auditId, audit, parsed, analysisName, body, collectedNotes) {
    body.innerHTML = '<div class="analysis-processing">Running regression analysis...</div>';

    // Run regression on trimmed data (excluding first 24 hours)
    const results = runAllAnalyses(parsed);

    // Save results including pairs for scatter plots
    audit.analysisResults = {};
    AUDIT_PARAMETERS.forEach(p => {
        if (results[p.key]) {
            audit.analysisResults[p.key] = results[p.key];
        }
    });
    audit.analysisName = analysisName;
    audit.analysisUploadDate = new Date().toISOString();
    audit.analysisUploadedBy = getCurrentUserName();

    // Store any collected notes
    if (collectedNotes.length > 0) {
        audit.analysisNotes = collectedNotes.join(' | ');
    } else {
        audit.analysisNotes = '';
    }

    // Build compact chart data for persistence (timestamps + all param values)
    audit.analysisChartData = {
        sensorA: parsed.sensorA,
        sensorB: parsed.sensorB,
        trimIndex: parsed.trimIndex,
        rows: parsed.allRows.map(r => ({
            t: r.timestamp.getTime(),
            v: Object.fromEntries(AUDIT_PARAMETERS.map(p => [p.key, { a: r.values[p.key]?.a, b: r.values[p.key]?.b }]).filter(([k, v]) => !isNaN(v.a) || !isNaN(v.b)))
        })),
    };

    persistAuditUpdate(auditId, {
        analysisResults: audit.analysisResults,
        analysisName: audit.analysisName,
        analysisUploadDate: audit.analysisUploadDate,
        analysisUploadedBy: audit.analysisUploadedBy,
        analysisChartData: audit.analysisChartData,
        analysisNotes: audit.analysisNotes,
    });

    // Cache in memory
    analysisDataCache[auditId] = parsed;
    analysisDataCache[auditId].regressionResults = results;

    // Build data integrity warnings for display
    const integrityWarnings = _buildDataIntegrityWarnings(parsed, audit);
    analysisDataCache[auditId].integrityWarnings = integrityWarnings;

    // Run failsafe validation checks
    const validationWarnings = runFailsafeValidation(parsed, results, 'audit');
    analysisDataCache[auditId].validationWarnings = validationWarnings;

    // Advance status based on DQO results
    const allPass = AUDIT_PARAMETERS.filter(p => audit.analysisResults[p.key]).every(p => audit.analysisResults[p.key]?.pass) && AUDIT_PARAMETERS.some(p => audit.analysisResults[p.key]);
    if (audit.status === 'Finished, Analysis Pending') {
        const oldStatus = audit.status;
        const newStatus = allPass ? 'Complete' : 'Finished, Analysis Pending';
        audit.status = newStatus;
        persistAuditUpdate(auditId, { status: newStatus });

        if (allPass) {
            // Update sensor statuses (same as advanceAuditStatus)
            const auditStatusPrefix = 'Audit: ';
            const communityPod = sensors.find(x => x.id === audit.communityPodId);
            const auditPod = sensors.find(x => x.id === audit.auditPodId);
            if (communityPod) {
                communityPod.status = getStatusArray(communityPod).filter(st => !st.startsWith(auditStatusPrefix));
                if (communityPod.status.length === 0) communityPod.status = ['Online'];
                persistSensor(communityPod);
            }
            if (auditPod) {
                auditPod.status = getStatusArray(auditPod).filter(st => st !== 'Auditing a Community');
                if (auditPod.status.length === 0) auditPod.status = ['Online'];
                persistSensor(auditPod);
            }
            buildSensorSidebar();
        }

        const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || '';
        const dqoNote = allPass
            ? `Audit analysis complete: all parameters pass DQO. "${oldStatus}" \u2192 "Audit Complete" for ${communityName}.`
            : `Audit analysis uploaded for ${communityName}: one or more parameters fail DQO. Review required.`;
        createNote('Audit', dqoNote, {
            sensors: [audit.auditPodId, audit.communityPodId], communities: [audit.communityId] });
        updateSidebarAuditCount();
    }

    // Render
    document.getElementById('analysis-modal-title').textContent = analysisName;
    renderAnalysisResults(auditId, parsed);

    // Update audit detail if open
    if (document.getElementById('view-audits')?.classList.contains('active')) renderAuditsView();
}

function parseAuditData(rows, audit) {
    if (!rows || rows.length < 10) return null;

    // Row 0 or 1 = headers. Find the header row (row with text like "AMBTEMP", "CO", etc.)
    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
        const rowStr = rows[i].join(' ').toUpperCase();
        if ((rowStr.includes('CO_PPB') || rowStr.includes('PM25') || rowStr.includes('PM10') || rowStr.includes('AMBTEMP') || rowStr.includes('OZONE')) && rowStr.includes('MOD')) {
            headerRowIdx = i;
            break;
        }
    }

    const headers = rows[headerRowIdx].map(h => String(h).trim());

    // Find the two sensor IDs from column headers
    // Pattern: "Quant_MOD00471 CO_PPB 001h" or "MOD-00471_co" etc.
    const sensorIds = new Set();
    const sensorPattern = /(?:Quant_)?(MOD[-_]*\d{3,6})/i;
    headers.forEach(h => {
        const m = h.match(sensorPattern);
        if (m) sensorIds.add(m[1].replace(/[-_]/g, '').toUpperCase());
    });

    if (sensorIds.size < 2) return null;
    const sensorList = [...sensorIds];

    // Determine which is sensor A (audit pod) and B (community pod)
    const auditPodNorm = audit.auditPodId.replace(/[-_\s]/g, '').toUpperCase();
    const communityPodNorm = audit.communityPodId.replace(/[-_\s]/g, '').toUpperCase();

    let sensorA = null, sensorB = null;
    for (const sid of sensorList) {
        if (sid.includes(auditPodNorm.replace('MOD', '')) || auditPodNorm.includes(sid.replace('MOD', ''))) sensorA = sid;
        else if (sid.includes(communityPodNorm.replace('MOD', '')) || communityPodNorm.includes(sid.replace('MOD', ''))) sensorB = sid;
    }
    // Fallback: just assign in order
    if (!sensorA) sensorA = sensorList[0];
    if (!sensorB) sensorB = sensorList[1];

    // Map columns to parameters for each sensor
    function findParamCols(sensorNorm) {
        const cols = {};
        headers.forEach((h, idx) => {
            const hNorm = h.replace(/[-_]/g, '').toUpperCase();
            if (!hNorm.includes(sensorNorm.replace('MOD', '')) && !hNorm.includes(sensorNorm)) return;
            for (const [paramKey, patterns] of Object.entries(PARAM_COLUMN_MAP)) {
                for (const pat of patterns) {
                    if (pat.test(h)) { cols[paramKey] = idx; break; }
                }
            }
        });
        return cols;
    }

    const colsA = findParamCols(sensorA);
    const colsB = findParamCols(sensorB);

    // Skip sub-header rows (like "Final Value")
    let dataStart = headerRowIdx + 1;
    for (let i = dataStart; i < Math.min(dataStart + 3, rows.length); i++) {
        const firstVal = String(rows[i][0] || '').toLowerCase();
        if (firstVal.includes('final') || firstVal.includes('value') || firstVal.includes('unit') || firstVal === '') {
            dataStart = i + 1;
        } else {
            break;
        }
    }

    // Parse timestamps and data
    const allRows = [];
    for (let i = dataStart; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 2) continue;
        const tsRaw = row[0];
        if (tsRaw === '' || tsRaw === null || tsRaw === undefined) continue;

        // Parse timestamp - could be Excel serial number or date string
        let ts;
        const numVal = Number(tsRaw);
        if (!isNaN(numVal) && numVal > 40000 && numVal < 60000) {
            // Excel serial date to JS date
            ts = new Date((numVal - 25569) * 86400 * 1000);
        } else {
            ts = new Date(tsRaw);
        }
        if (isNaN(ts.getTime())) continue;

        const entry = { timestamp: ts, tsRaw: numVal || tsRaw, values: {} };
        for (const paramKey of Object.keys(PARAM_COLUMN_MAP)) {
            const vA = colsA[paramKey] !== undefined ? parseFloat(row[colsA[paramKey]]) : NaN;
            const vB = colsB[paramKey] !== undefined ? parseFloat(row[colsB[paramKey]]) : NaN;
            entry.values[paramKey] = { a: vA, b: vB };
        }
        allRows.push(entry);
    }

    if (allRows.length < 5) return null;

    // Invalidate PM10 values above 1000 µg/m³ (instrument artifacts)
    for (const row of allRows) {
        if (row.values.pm10) {
            if (row.values.pm10.a > 1000) row.values.pm10.a = NaN;
            if (row.values.pm10.b > 1000) row.values.pm10.b = NaN;
        }
    }

    // Sort by timestamp
    allRows.sort((a, b) => a.timestamp - b.timestamp);

    // Find the 24-hour trim point
    const firstTs = allRows[0].timestamp.getTime();
    const trimCutoff = firstTs + 24 * 60 * 60 * 1000;
    const trimIndex = allRows.findIndex(r => r.timestamp.getTime() >= trimCutoff);

    // Build descriptive labels: "Ninilchik Community Pod MOD-00660"
    const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || audit.communityId;
    const auditPodSensor = sensors.find(s => s.id === audit.auditPodId);
    const communityPodSensor = sensors.find(s => s.id === audit.communityPodId);
    const auditPodLocation = auditPodSensor?.community ? (COMMUNITIES.find(c => c.id === auditPodSensor.community)?.name || '') : '';
    const labelA = `${auditPodLocation ? auditPodLocation + ' ' : ''}${auditPodSensor?.type || 'Audit Pod'} ${audit.auditPodId}`.trim();
    const labelB = `${communityName} ${communityPodSensor?.type || 'Community Pod'} ${audit.communityPodId}`.trim();
    // Short labels for chart titles: "Kodiak Pod 660" / "Audit Pod 471"
    const shortA = `${auditPodSensor?.type || 'Audit Pod'} ${shortSensorId(audit.auditPodId)}`;
    const shortB = `${communityName} Pod ${shortSensorId(audit.communityPodId)}`;

    return {
        sensorA: { id: sensorA, label: labelA, short: shortA },
        sensorB: { id: sensorB, label: labelB, short: shortB },
        allRows,
        trimIndex: trimIndex >= 0 ? trimIndex : 0,
        trimmedRows: trimIndex >= 0 ? allRows.slice(trimIndex) : allRows,
        headers,
        colsA,
        colsB,
    };
}

function runLinearRegression(xArr, yArr) {
    // Filter to only paired non-NaN values
    const pairs = [];
    for (let i = 0; i < xArr.length; i++) {
        if (!isNaN(xArr[i]) && !isNaN(yArr[i]) && isFinite(xArr[i]) && isFinite(yArr[i])) {
            pairs.push({ x: xArr[i], y: yArr[i] });
        }
    }
    const n = pairs.length;
    if (n < 3) return null;

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (const p of pairs) {
        sumX += p.x; sumY += p.y;
        sumXY += p.x * p.y;
        sumX2 += p.x * p.x;
        sumY2 += p.y * p.y;
    }

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return null;

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    // R-squared
    const meanY = sumY / n;
    let ssTot = 0, ssRes = 0;
    const residuals = [];
    for (const p of pairs) {
        const predicted = slope * p.x + intercept;
        const res = p.y - predicted;
        residuals.push(res);
        ssRes += res * res;
        ssTot += (p.y - meanY) * (p.y - meanY);
    }
    const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

    // SD of residuals
    const meanRes = residuals.reduce((a, b) => a + b, 0) / n;
    const sdRes = Math.sqrt(residuals.reduce((a, r) => a + (r - meanRes) * (r - meanRes), 0) / (n - 1));

    // RMSE
    const rmse = Math.sqrt(ssRes / n);

    return {
        slope: Math.round(slope * 10000) / 10000,
        intercept: Math.round(intercept * 10000) / 10000,
        r2: Math.round(r2 * 10000) / 10000,
        sd: Math.round(sdRes * 10000) / 10000,
        rmse: Math.round(rmse * 10000) / 10000,
        n,
        pairs,
    };
}

function checkDQO(result) {
    if (!result) return { r2: false, slope: false, intercept: false, sd: false, rmse: false, pass: false };
    const T = DQO_THRESHOLDS;
    const dqo = {
        r2: result.r2 >= T.r2.min,
        slope: result.slope >= T.slope.min && result.slope <= T.slope.max,
        intercept: result.intercept >= T.intercept.min && result.intercept <= T.intercept.max,
        sd: result.sd <= T.sd.max,
        rmse: result.rmse <= T.rmse.max,
    };
    dqo.pass = dqo.r2 && dqo.slope && dqo.intercept && dqo.sd && dqo.rmse;
    return dqo;
}

function rebuildCacheFromSaved(audit) {
    const cd = audit.analysisChartData;
    if (!cd || !cd.rows || !cd.rows.length) return null;

    const allRows = cd.rows.map(r => ({
        timestamp: new Date(r.t),
        values: Object.fromEntries(AUDIT_PARAMETERS.map(p => [p.key, r.v?.[p.key] || { a: NaN, b: NaN }])),
    }));

    const trimIndex = cd.trimIndex || 0;
    const parsed = {
        sensorA: cd.sensorA,
        sensorB: cd.sensorB,
        allRows,
        trimIndex,
        trimmedRows: allRows.slice(trimIndex),
    };

    // Rebuild regression results — reconstruct pairs from row data if missing, re-evaluate DQO
    const savedResults = audit.analysisResults || {};
    AUDIT_PARAMETERS.forEach(p => {
        const r = savedResults[p.key];
        if (r && !r.pairs) {
            // Reconstruct pairs with timestamps from trimmed row data
            const pairs = [];
            for (const row of parsed.trimmedRows) {
                const a = row.values[p.key]?.a;
                const b = row.values[p.key]?.b;
                if (!isNaN(a) && !isNaN(b) && isFinite(a) && isFinite(b)) {
                    pairs.push({ x: a, y: b, t: row.timestamp?.getTime?.() || row.timestamp });
                }
            }
            r.pairs = pairs;
        }
        // Re-evaluate DQO
        if (r) {
            r.dqo = checkDQO(r);
            r.pass = r.dqo.pass;
        }
    });
    parsed.regressionResults = savedResults;

    return parsed;
}

function runAllAnalyses(parsed) {
    const results = {};
    for (const param of AUDIT_PARAMETERS) {
        const xArr = parsed.trimmedRows.map(r => r.values[param.key]?.a);
        const yArr = parsed.trimmedRows.map(r => r.values[param.key]?.b);
        const tsArr = parsed.trimmedRows.map(r => r.timestamp);
        const reg = runLinearRegression(xArr, yArr);
        if (reg) {
            // Attach timestamps to pairs for tooltip display
            let tIdx = 0;
            for (let i = 0; i < xArr.length; i++) {
                if (!isNaN(xArr[i]) && !isNaN(yArr[i]) && isFinite(xArr[i]) && isFinite(yArr[i])) {
                    if (reg.pairs[tIdx]) reg.pairs[tIdx].t = tsArr[i]?.getTime?.() || tsArr[i];
                    tIdx++;
                }
            }
            const dqo = checkDQO(reg);
            results[param.key] = { ...reg, dqo, pass: dqo.pass };
        }
    }
    return results;
}

function renderAnalysisResults(auditId, parsed) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    const results = audit.analysisResults || {};

    // Destroy previous charts
    analysisChartInstances.forEach(c => { try { c.destroy(); } catch(e) {} });
    analysisChartInstances = [];

    const trimCount = parsed.trimIndex;
    const totalCount = parsed.allRows.length;
    const analysisCount = parsed.trimmedRows.length;
    const overallPass = AUDIT_PARAMETERS.every(p => results[p.key]?.pass);

    // Build integrity warnings (from cache or compute fresh)
    let integrityWarnings = analysisDataCache[auditId]?.integrityWarnings;
    if (!integrityWarnings) {
        integrityWarnings = _buildDataIntegrityWarnings(parsed, audit);
        if (analysisDataCache[auditId]) analysisDataCache[auditId].integrityWarnings = integrityWarnings;
    }
    const warningsHtml = _renderIntegrityWarnings(integrityWarnings);

    // Build failsafe validation report (from cache or compute fresh)
    let validationWarnings = analysisDataCache[auditId]?.validationWarnings;
    if (!validationWarnings) {
        validationWarnings = runFailsafeValidation(parsed, results, 'audit');
        if (analysisDataCache[auditId]) analysisDataCache[auditId].validationWarnings = validationWarnings;
    }
    const validationHtml = renderValidationReport(validationWarnings);

    const body = document.getElementById('audit-analysis-body');
    body.innerHTML = `
        <div style="margin-top:16px">
            <span class="analysis-trim-note">First 24 hours excluded from DQO analysis (${trimCount} of ${totalCount} rows trimmed) \u2014 regression and DQO calculated on ${analysisCount} rows</span>
            ${audit.analysisUploadDate ? `<span style="float:right;font-size:11px;color:var(--slate-400)">Uploaded ${formatDate(audit.analysisUploadDate)} by ${escapeHtml(audit.analysisUploadedBy || '')}</span>` : ''}
        </div>
        ${audit.analysisNotes ? `<div style="margin-top:8px;font-size:12px;color:var(--slate-500);background:var(--slate-50);padding:8px 12px;border-radius:6px;border-left:3px solid var(--gold)"><strong>Analysis Note:</strong> ${escapeHtml(audit.analysisNotes)}</div>` : ''}
        <div class="analysis-tabs">
            <button class="analysis-tab active" onclick="switchAnalysisTab(this, 'analysis')">Analysis</button>
            <button class="analysis-tab" onclick="switchAnalysisTab(this, 'rawdata')">Raw Data</button>
        </div>
        <div id="analysis-panel-analysis" class="analysis-tab-panel active">
            <div id="analysis-section-warnings">${warningsHtml}${validationHtml}</div>
            <div id="analysis-section-dqo"></div>
            <div id="analysis-section-timeseries" style="margin-top:28px"></div>
            <div id="analysis-section-scatter" style="margin-top:28px"></div>
        </div>
        <div id="analysis-panel-rawdata" class="analysis-tab-panel"></div>
        <div style="margin-top:16px;display:flex;justify-content:space-between;align-items:center">
            <button class="btn btn-primary" onclick="generateAuditReport('${auditId}')">Generate Report</button>
            <button class="btn" onclick="rerunAnalysisUpload('${auditId}')">Re-upload Data</button>
        </div>
    `;

    // DQO Summary — inline at top
    renderDQOSection(results, overallPass);

    // Timeseries — below DQO
    renderTimeSeriesSection(auditId, parsed);

    // Scatter/Regression Plots — below time series (use cached full results with pairs data for charts)
    const chartResults = parsed.regressionResults || results;
    renderScatterSection(auditId, parsed, chartResults);

    // Raw Data — separate tab
    renderRawDataPanel(parsed);
}

function switchAnalysisTab(btn, panelKey) {
    btn.closest('.analysis-tabs').querySelectorAll('.analysis-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const container = document.getElementById('audit-analysis-body');
    container.querySelectorAll('.analysis-tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('analysis-panel-' + panelKey).classList.add('active');
}

function rerunAnalysisUpload(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    // Clear cache first so beginAnalysis doesn't re-render full results
    delete analysisDataCache[auditId];
    // Destroy any active charts
    analysisChartInstances.forEach(c => { try { c.destroy(); } catch(e) {} });
    analysisChartInstances = [];
    const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || audit.communityId;
    const defaultName = audit.analysisName || `Audit ${audit.auditPodId} \u2014 ${communityName} ${audit.communityPodId}`;
    document.getElementById('analysis-modal-title').textContent = 'Re-upload Audit Data';
    document.getElementById('audit-analysis-body').innerHTML = `
        <div class="analysis-instructions">
            <strong>Data Preparation Instructions:</strong>
            <ol>
                <li>Pull data from the audit pod and local pod from AirVision</li>
                <li>Open the file and clean up: remove invalidated data</li>
                <li>Trim start and end of dataset to the start and end of the audit period</li>
                <li><strong>Do not remove the first 24 hours</strong> \u2014 the app will automatically exclude them from regression analysis</li>
            </ol>
        </div>
        <label style="font-size:12px;font-weight:600;color:var(--slate-500);text-transform:uppercase;letter-spacing:0.5px">Analysis Name</label>
        <input type="text" class="analysis-name-input" id="analysis-name-input" value="${escapeHtml(defaultName)}">
        <div class="analysis-upload-zone" id="analysis-drop-zone" onclick="this.querySelector('input[type=file]').click()">
            <div class="analysis-upload-icon">&#128196;</div>
            <div class="analysis-upload-text">Click to upload Excel file (.xls or .xlsx)</div>
            <div class="analysis-upload-hint">This will replace the existing analysis results</div>
            <input type="file" accept=".xls,.xlsx" onchange="handleAnalysisUpload('${auditId}', this.files[0])">
        </div>
    `;
}

function renderSavedAnalysisView(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    const results = audit.analysisResults || {};

    const body = document.getElementById('audit-analysis-body');
    body.innerHTML = `
        <div style="margin-top:16px">
            ${audit.analysisUploadDate ? `<span style="font-size:11px;color:var(--slate-400)">Uploaded ${formatDate(audit.analysisUploadDate)} by ${escapeHtml(audit.analysisUploadedBy || '')}</span>` : ''}
            ${audit.analysisNotes ? `<div style="margin-top:8px;font-size:12px;color:var(--slate-500);background:var(--slate-50);padding:8px 12px;border-radius:6px;border-left:3px solid var(--gold)"><strong>Analysis Note:</strong> ${escapeHtml(audit.analysisNotes)}</div>` : ''}
        </div>
        <div style="overflow-x:auto;margin-top:16px">
        <table class="dqo-summary-table">
            <thead><tr>
                <th scope="col">Parameter</th>
                <th>R\u00B2</th>
                <th>Slope</th>
                <th>Intercept</th>
                <th>SD</th>
                <th>RMSE</th>
                <th>n</th>
                <th>Result</th>
            </tr></thead>
            <tbody>
                ${AUDIT_PARAMETERS.map(p => {
                    const r = results[p.key];
                    const T = DQO_THRESHOLDS;
                    if (!r) return `<tr><td>${p.labelHtml} (${p.unit})</td><td colspan="7" style="color:var(--slate-400);font-family:var(--font-sans)">No data</td></tr>`;
                    const d = r.dqo || {};
                    const cls = (pass) => pass ? 'dqo-cell-pass' : 'dqo-cell-fail';
                    return `<tr>
                        <td>${p.labelHtml} (${p.unit})</td>
                        <td class="${cls(d.r2)}">${r.r2} <span class="dqo-thresh">(\u2265 ${T.r2.min})</span></td>
                        <td class="${cls(d.slope)}">${r.slope} <span class="dqo-thresh">(${T.slope.min}\u2013${T.slope.max})</span></td>
                        <td class="${cls(d.intercept)}">${r.intercept} <span class="dqo-thresh">(${T.intercept.min} to ${T.intercept.max})</span></td>
                        <td class="${cls(d.sd)}">${r.sd} <span class="dqo-thresh">(\u2264 ${T.sd.max})</span></td>
                        <td class="${cls(d.rmse)}">${r.rmse} <span class="dqo-thresh">(\u2264 ${T.rmse.max})</span></td>
                        <td style="text-align:center">${r.n || '\u2014'}</td>
                        <td>${r.pass ? '<span class="dqo-pass">PASS</span>' : '<span class="dqo-fail">FAIL</span>'}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
        </div>
        <div class="analysis-dqo-thresholds"><span style="font-size:10px">DQO Thresholds: R\u00B2 \u2265 0.70, Slope 0.65\u20131.35, Intercept \u00B15, SD \u2264 5, RMSE \u2264 7.</span></div>
        <p style="font-size:13px;color:var(--slate-400);margin-top:16px">To view scatter plots, time series, and raw data, re-upload the original Excel file.</p>
        <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center">
            <button class="btn btn-primary" onclick="generateAuditReport('${auditId}')">Generate Report</button>
            <button class="btn" onclick="rerunAnalysisUpload('${auditId}')">Re-upload Data for Charts</button>
        </div>
    `;
}

function renderDQOSection(results, overallPass) {
    const el = document.getElementById('analysis-section-dqo');

    el.innerHTML = `
        <div style="overflow-x:auto">
        <table class="dqo-summary-table">
            <thead><tr>
                <th scope="col">Parameter</th>
                <th>R\u00B2</th>
                <th>Slope</th>
                <th>Intercept</th>
                <th>SD</th>
                <th>RMSE</th>
                <th>n</th>
                <th>Result</th>
            </tr></thead>
            <tbody>
                ${AUDIT_PARAMETERS.map(p => {
                    const r = results[p.key];
                    const T = DQO_THRESHOLDS;
                    if (!r) return `<tr><td>${p.labelHtml} (${p.unit})</td><td colspan="7" style="color:var(--slate-400);font-family:var(--font-sans)">No data</td></tr>`;
                    const d = r.dqo || {};
                    const cls = (pass) => pass ? 'dqo-cell-pass' : 'dqo-cell-fail';
                    return `<tr>
                        <td>${p.labelHtml} (${p.unit})</td>
                        <td class="${cls(d.r2)}">${r.r2} <span class="dqo-thresh">(\u2265 ${T.r2.min})</span></td>
                        <td class="${cls(d.slope)}">${r.slope} <span class="dqo-thresh">(${T.slope.min}\u2013${T.slope.max})</span></td>
                        <td class="${cls(d.intercept)}">${r.intercept} <span class="dqo-thresh">(${T.intercept.min} to ${T.intercept.max})</span></td>
                        <td class="${cls(d.sd)}">${r.sd} <span class="dqo-thresh">(\u2264 ${T.sd.max})</span></td>
                        <td class="${cls(d.rmse)}">${r.rmse} <span class="dqo-thresh">(\u2264 ${T.rmse.max})</span></td>
                        <td style="text-align:center">${r.n || '\u2014'}</td>
                        <td>${r.pass ? '<span class="dqo-pass">PASS</span>' : '<span class="dqo-fail">FAIL</span>'}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
        </div>
        <div class="analysis-dqo-thresholds"><span style="font-size:10px">DQO Thresholds: R\u00B2 \u2265 0.70, Slope 0.65\u20131.35, Intercept \u00B15, SD \u2264 5, RMSE \u2264 7. PM<sub>10</sub> values &gt; 1000 \u00B5g/m\u00B3 invalidated before analysis.</span></div>
    `;
}

function renderScatterSection(auditId, parsed, results) {
    const el = document.getElementById('analysis-section-scatter');
    const audit = audits.find(a => a.id === auditId);
    const auditDateRange = audit?.scheduledStart ? `${formatDate(audit.scheduledStart)} \u2013 ${formatDate(audit.scheduledEnd)}` : '';
    el.innerHTML = `
        <h3 class="analysis-section-heading">Regression Plots</h3>
        <div class="analysis-chart-grid">
        ${AUDIT_PARAMETERS.map(p => {
            const r = results[p.key];
            const eqSign = r ? (r.intercept >= 0 ? '+' : '\u2212') : '';
            const eqText = r ? `y = ${r.slope}x ${eqSign} ${Math.abs(r.intercept)},&nbsp;&nbsp;&nbsp;&nbsp; R\u00B2 = ${r.r2}` : '';
            return `<div class="analysis-chart-card">
            <div class="chart-title-editable" onclick="editChartTitle(this)">${parsed.sensorB.short} and ${parsed.sensorA.short}: <strong>${p.labelHtml}</strong></div>
            <div class="chart-subtitle-editable" onclick="editChartTitle(this)">${auditDateRange}. Hourly data, first 24 hours removed</div>
            <div class="chart-axis-label chart-axis-y" onclick="editChartTitle(this)">${parsed.sensorB.short} ${p.label} (${p.unit}) <span class="chart-scale-btn" onclick="event.stopPropagation(); editChartAxis('scatter-${auditId}-${p.key}', 'y', this)">&#9998;</span></div>
            <div class="chart-canvas-wrap"><canvas id="scatter-${auditId}-${p.key}"></canvas></div>
            <div class="chart-axis-label chart-axis-x" onclick="editChartTitle(this)">${parsed.sensorA.short} ${p.label} (${p.unit}) <span class="chart-scale-btn" onclick="event.stopPropagation(); editChartAxis('scatter-${auditId}-${p.key}', 'x', this)">&#9998;</span></div>
            <div class="chart-equation">${eqText}</div>
        </div>`; }).join('')}
    </div>`;

    requestAnimationFrame(() => {
        AUDIT_PARAMETERS.forEach(p => {
            const r = results[p.key];
            if (!r || !r.pairs) return;
            createScatterChart(`scatter-${auditId}-${p.key}`, r, p, parsed);
        });
    });
}

function createScatterChart(canvasId, regression, param, parsed) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const xVals = regression.pairs.map(p => p.x);
    const minX = Math.min(...xVals);
    const maxX = Math.max(...xVals);

    const chart = new Chart(canvas, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    data: regression.pairs,
                    backgroundColor: 'rgba(27,42,74,0.4)',
                    borderColor: 'rgba(27,42,74,0.5)',
                    pointRadius: 3,
                    pointHitRadius: 10,
                    pointHoverRadius: 6,
                },
                {
                    data: [
                        { x: minX, y: regression.slope * minX + regression.intercept },
                        { x: maxX, y: regression.slope * maxX + regression.intercept },
                    ],
                    type: 'line',
                    borderColor: '#C9A84C',
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHitRadius: 0,
                    pointHoverRadius: 0,
                    fill: false,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true,
                    filter: (tooltipItem) => tooltipItem.datasetIndex === 0,
                    callbacks: {
                        title: (items) => {
                            if (!items.length) return '';
                            const raw = items[0].raw;
                            if (raw?.t) {
                                const d = new Date(raw.t);
                                return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: AK_TZ });
                            }
                            return '';
                        },
                        label: (ctx) => `x: ${ctx.parsed.x}  y: ${ctx.parsed.y}`,
                    },
                    backgroundColor: '#1B2A4A',
                    titleFont: { size: 11, family: "'DM Sans', sans-serif" },
                    bodyFont: { size: 12, family: "'JetBrains Mono', monospace" },
                    displayColors: false,
                    padding: 10,
                    cornerRadius: 6,
                    caretSize: 6,
                },
            },
            hover: { mode: 'nearest', intersect: false, axis: 'xy' },
            interaction: { mode: 'nearest', intersect: false, axis: 'xy' },
            scales: {
                x: { grid: { display: false }, ticks: { font: { size: 12 } } },
                y: { grid: { display: false }, ticks: { font: { size: 12 } } },
            },
        },
    });
    analysisChartInstances.push(chart);
}

function renderTimeSeriesSection(auditId, parsed) {
    const el = document.getElementById('analysis-section-timeseries');
    const pmParams = AUDIT_PARAMETERS.filter(p => p.hasTimeSeries);
    const audit = audits.find(a => a.id === auditId);
    const auditDateRange = audit?.scheduledStart ? `${formatDate(audit.scheduledStart)} \u2013 ${formatDate(audit.scheduledEnd)}` : '';
    el.innerHTML = `
        <h3 class="analysis-section-heading">PM Timeseries</h3>
        <div class="analysis-chart-grid" style="grid-template-columns:1fr">
        ${pmParams.map(p => `<div class="analysis-chart-card">
            <div class="chart-title-editable" onclick="editChartTitle(this)">${parsed.sensorB.short} and ${parsed.sensorA.short}: <strong>${p.labelHtml}</strong></div>
            <div class="chart-subtitle-editable" onclick="editChartTitle(this)">${auditDateRange}. Hourly data, first 24 hours removed</div>
            <div class="chart-axis-label chart-axis-y" onclick="editChartTitle(this)">${p.labelHtml} (${p.unit}) <span class="chart-scale-btn" onclick="event.stopPropagation(); editChartAxis('ts-${auditId}-${p.key}', 'y', this)">&#9998;</span></div>
            <div class="chart-canvas-wrap"><canvas id="ts-${auditId}-${p.key}"></canvas></div>
            <div class="chart-ts-legend">
                <span class="chart-ts-legend-item"><span style="background:#1B2A4A"></span> ${parsed.sensorA.short}</span>
                <span class="chart-ts-legend-item"><span style="background:#C9A84C"></span> ${parsed.sensorB.short}</span>
            </div>
        </div>`).join('')}
    </div>`;

    requestAnimationFrame(() => {
        pmParams.forEach(p => {
            createTimeSeriesChart(`ts-${auditId}-${p.key}`, parsed, p, audit);
        });
    });
}

function createTimeSeriesChart(canvasId, parsed, param, audit) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    // Use only trimmed data (first 24h removed)
    const rows = parsed.trimmedRows;
    const labels = rows.map(r => r.timestamp);
    const seriesA = rows.map(r => { const v = r.values[param.key]?.a; return isNaN(v) ? null : v; });
    const seriesB = rows.map(r => { const v = r.values[param.key]?.b; return isNaN(v) ? null : v; });

    const allVals = [...seriesA, ...seriesB].filter(v => v !== null && isFinite(v));
    const yMin = allVals.length > 0 ? Math.min(...allVals) : 0;
    const yMax = allVals.length > 0 ? Math.max(...allVals) : 10;
    const yPad = (yMax - yMin) * 0.05 || 1;

    const chart = new Chart(canvas, {
        type: 'line',
        data: { labels, datasets: [
            { data: seriesA, borderColor: '#1B2A4A', borderWidth: 1.5, pointRadius: 0, pointHitRadius: 5, tension: 0.2, fill: false },
            { data: seriesB, borderColor: '#C9A84C', borderWidth: 1.5, pointRadius: 0, pointHitRadius: 5, tension: 0.2, fill: false },
        ]},
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { type: 'time', time: { unit: 'day', displayFormats: { day: 'MMM d', hour: 'MMM d HH:mm' } }, grid: { display: false }, ticks: { font: { size: 12 } } },
                y: {
                    min: Math.max(0, yMin - yPad),
                    max: yMax + yPad,
                    grid: { display: false },
                    ticks: { font: { size: 12 } },
                },
            },
            interaction: { mode: 'index', intersect: false },
        },
    });
    analysisChartInstances.push(chart);
}

function editChartTitle(el) {
    if (el.querySelector('input')) return;
    const origHtml = el.innerHTML;
    const currentText = el.textContent.trim();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentText;
    input.className = el.classList.contains('chart-subtitle-editable') ? 'chart-subtitle-input' : 'chart-title-input';
    el.innerHTML = '';
    el.appendChild(input);
    input.focus();
    input.select();

    const finish = () => {
        const newText = input.value.trim();
        el.innerHTML = newText ? escapeHtml(newText) : origHtml;
        el.onclick = () => editChartTitle(el);
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = ''; input.blur(); }
    });
}

function editChartAxis(canvasId, axis, btn) {
    // Close any existing popover
    document.querySelectorAll('.axis-popover').forEach(p => p.remove());

    const chart = analysisChartInstances.find(c => c.canvas?.id === canvasId);
    if (!chart || !chart.scales[axis]) return;
    const scale = chart.scales[axis];
    const label = axis === 'y' ? 'Y' : 'X';

    const pop = document.createElement('div');
    pop.className = 'axis-popover';
    pop.innerHTML = `
        <div class="axis-popover-row">
            <label>Min</label>
            <input type="number" id="axis-pop-min" value="${Math.round(scale.min * 100) / 100}" step="any">
            <label>Max</label>
            <input type="number" id="axis-pop-max" value="${Math.round(scale.max * 100) / 100}" step="any">
            <button class="axis-popover-apply" onclick="applyAxisEdit('${canvasId}','${axis}')">Apply</button>
            <button class="axis-popover-close" onclick="this.closest('.axis-popover').remove()">&times;</button>
        </div>
    `;

    // Position near the axis that was clicked
    const card = btn.closest('.analysis-chart-card');
    if (axis === 'y') {
        pop.style.left = '72px';
        pop.style.top = '50%';
        pop.style.transform = 'translateY(-50%)';
    } else {
        pop.style.left = '50%';
        pop.style.top = 'auto';
        pop.style.bottom = '36px';
        pop.style.transform = 'translateX(-50%)';
    }
    card.appendChild(pop);
    pop.querySelector('#axis-pop-min').focus();
    pop.querySelector('#axis-pop-min').select();

    // Enter key applies
    pop.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') applyAxisEdit(canvasId, axis);
        if (e.key === 'Escape') pop.remove();
    });
}

function applyAxisEdit(canvasId, axis) {
    const chart = analysisChartInstances.find(c => c.canvas?.id === canvasId);
    if (!chart) return;
    const pop = document.querySelector('.axis-popover');
    if (!pop) return;
    const min = parseFloat(pop.querySelector('#axis-pop-min').value);
    const max = parseFloat(pop.querySelector('#axis-pop-max').value);
    if (!isNaN(min)) chart.options.scales[axis].min = min;
    if (!isNaN(max)) chart.options.scales[axis].max = max;
    chart.update();
    pop.remove();
}

function renderRawDataPanel(parsed) {
    const panel = document.getElementById('analysis-panel-rawdata');
    const paramKeys = Object.keys(PARAM_COLUMN_MAP);
    const paramLabels = AUDIT_PARAMETERS.reduce((m, p) => { m[p.key] = `${p.label} (${p.unit})`; return m; }, {});

    let tableHtml = `<div class="analysis-raw-wrap"><table class="analysis-raw-table"><thead><tr>
        <th>Date/Time</th>
        ${paramKeys.map(k => `<th>${parsed.sensorA.label}<br>${paramLabels[k] || k}</th><th>${parsed.sensorB.label}<br>${paramLabels[k] || k}</th>`).join('')}
    </tr></thead><tbody>`;

    const maxRows = Math.min(parsed.allRows.length, 500);
    for (let i = 0; i < maxRows; i++) {
        const r = parsed.allRows[i];
        const isTrimmed = i < parsed.trimIndex;
        const dateStr = r.timestamp.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: AK_TZ });
        tableHtml += `<tr class="${isTrimmed ? 'trimmed-row' : ''}">
            <td>${dateStr}${isTrimmed ? ' *' : ''}</td>
            ${paramKeys.map(k => {
                const va = r.values[k]?.a;
                const vb = r.values[k]?.b;
                return `<td>${isNaN(va) ? '—' : va}</td><td>${isNaN(vb) ? '—' : vb}</td>`;
            }).join('')}
        </tr>`;
    }
    tableHtml += '</tbody></table></div>';

    if (parsed.allRows.length > 500) {
        tableHtml += `<p style="font-size:12px;color:var(--slate-400);margin-top:8px">Showing first 500 of ${parsed.allRows.length} rows.</p>`;
    }

    panel.innerHTML = `
        <span class="analysis-trim-note">* Faded rows = first 24 hours (excluded from regression)</span>
        ${tableHtml}
    `;
}

// ===== AUDIT LISTS IN COMMUNITY / SENSOR VIEWS =====
function activateCommunityTab(tabName) {
    const container = document.getElementById('view-community');
    if (!container) return;
    container.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    container.querySelectorAll('.tab-content').forEach(tc => tc.classList.toggle('active', tc.id === 'tab-' + tabName));
}

function renderCommunityOverview(communityId) {
    const dashboard = document.getElementById('community-overview-dashboard');
    if (!dashboard) return;

    // Include child communities in all queries
    const children = getChildCommunities(communityId);
    const allCommunityIds = [communityId, ...children.map(c => c.id)];

    // Sensor summary
    const commSensors = sensors.filter(s => allCommunityIds.includes(s.community));
    const sensorHtml = commSensors.length > 0
        ? commSensors.slice(0, 4).map(s => `<div class="ov-sensor-card" onclick="showSensorDetail('${s.id}')">
            <div class="ov-sensor-left">
                <div class="ov-sensor-id">${s.id}</div>
                <div class="ov-sensor-type">${s.type || 'Unassigned'}</div>
            </div>
            <div class="ov-sensor-right">
                <div>${renderStatusBadges(s, false)}</div>
                ${s.location ? `<div class="ov-sensor-field">${escapeHtml(s.location)}</div>` : ''}
                ${s.dateInstalled ? `<div class="ov-sensor-field">Installed ${formatDate(s.dateInstalled)}</div>` : ''}
            </div>
        </div>`).join('')
        : '<p class="ov-empty">No sensors assigned</p>';

    // Recent history (3 items) — only notes explicitly tagged to this community
    const commNotes = notes.filter(n => {
        return n.taggedCommunities && n.taggedCommunities.some(id => allCommunityIds.includes(id));
    }).sort((a, b) => (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || '')).slice(0, 3);
    const historyHtml = commNotes.length > 0
        ? commNotes.map(n => `<div class="ov-timeline-item">
            <span class="ov-timeline-type">${n.type}</span>
            <span class="ov-timeline-text">${escapeHtml((n.text || '').substring(0, 100))}${(n.text || '').length > 100 ? '...' : ''}</span>
            <span class="ov-timeline-date">${formatDate(n.date || n.createdAt)}</span>
        </div>`).join('')
        : '<p class="ov-empty">No history yet</p>';

    // Recent comms (3 items)
    const commComms = comms.filter(c => allCommunityIds.includes(c.community) || (c.taggedCommunities && c.taggedCommunities.some(id => allCommunityIds.includes(id))))
        .sort((a, b) => (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || '')).slice(0, 3);
    const commsHtml = commComms.length > 0
        ? commComms.map(c => `<div class="ov-timeline-item">
            <span class="ov-timeline-type">${c.commType || c.type}</span>
            <span class="ov-timeline-text">${escapeHtml((c.text || '').substring(0, 100))}${(c.text || '').length > 100 ? '...' : ''}</span>
            <span class="ov-timeline-date">${formatDate(c.date || c.createdAt)}</span>
        </div>`).join('')
        : '<p class="ov-empty">No communications yet</p>';

    // Top contacts (2) — primary contacts first, then alphabetical
    const commContacts = contacts.filter(c => allCommunityIds.includes(c.community) && c.active !== false)
        .sort((a, b) => {
            const aP = a.primaryContact ? 0 : 1, bP = b.primaryContact ? 0 : 1;
            if (aP !== bP) return aP - bP;
            return a.name.localeCompare(b.name);
        }).slice(0, 2);
    const contactsHtml = commContacts.length > 0
        ? commContacts.map(c => `<div class="ov-contact-row" onclick="showContactDetail('${c.id}')">
            <div><strong>${escapeHtml(c.name)}</strong>${c.primaryContact ? ' <span class="contact-primary-badge">Primary</span>' : ''}</div>
            <div style="font-size:12px;color:var(--slate-400)">${escapeHtml(c.role || '')}${c.org ? ` \u00B7 ${escapeHtml(c.org)}` : ''}</div>
        </div>`).join('')
        : '<p class="ov-empty">No contacts yet</p>';

    // Most recent audit
    const communityAudits = audits.filter(a => allCommunityIds.includes(a.communityId)).sort((a, b) => (b.scheduledEnd || '').localeCompare(a.scheduledEnd || ''));
    const recentAudit = communityAudits[0];
    const auditHtml = recentAudit
        ? `<div class="ov-audit-card" onclick="openAuditDetail('${recentAudit.id}')">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font-family:var(--font-mono);font-size:12px">${recentAudit.auditPodId} \u2194 ${recentAudit.communityPodId}</span>
                <span class="audit-status-badge ${AUDIT_STATUS_CSS[recentAudit.status]}">${recentAudit.status}</span>
            </div>
            <div style="font-size:12px;color:var(--slate-400);margin-top:4px">${recentAudit.scheduledStart ? formatDate(recentAudit.scheduledStart) + ' \u2013 ' + formatDate(recentAudit.scheduledEnd) : '\u2014'}</div>
            ${Object.keys(recentAudit.analysisResults || {}).length > 0 ? `<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">${AUDIT_PARAMETERS.map(p => { const r = recentAudit.analysisResults[p.key]; if (!r) return ''; return `<span class="audit-param-badge ${r.pass ? 'pass' : 'fail'}">${p.label} ${r.pass ? '\u2713' : '\u2717'}</span>`; }).join('')}</div>` : ''}
        </div>`
        : '<p class="ov-empty">No audits yet</p>';

    dashboard.innerHTML = `
        <div class="community-overview-grid">
            <div class="ov-card">
                <h3 class="ov-card-title ov-card-clickable" onclick="activateCommunityTab('community-sensors')">Sensors <span class="ov-card-expand">&rarr;</span></h3>
                ${sensorHtml}
            </div>
            <div class="ov-card">
                <h3 class="ov-card-title ov-card-clickable" onclick="activateCommunityTab('community-contacts')">Contacts <span class="ov-card-expand">&rarr;</span></h3>
                ${contactsHtml}
            </div>
            <div class="ov-card ov-card-wide">
                <h3 class="ov-card-title ov-card-clickable" onclick="activateCommunityTab('community-history')">Recent History <span class="ov-card-expand">&rarr;</span></h3>
                ${historyHtml}
            </div>
            <div class="ov-card ov-card-wide">
                <h3 class="ov-card-title ov-card-clickable" onclick="activateCommunityTab('community-comms')">Recent Communications <span class="ov-card-expand">&rarr;</span></h3>
                ${commsHtml}
            </div>
            <div class="ov-card">
                <h3 class="ov-card-title ov-card-clickable" onclick="activateCommunityTab('community-audits')">Most Recent Audit <span class="ov-card-expand">&rarr;</span></h3>
                ${auditHtml}
            </div>
        </div>
    `;
}

function renderCommunityAudits(communityId) {
    const section = document.getElementById('community-audits-section');
    if (!section) return;

    const communityAudits = audits.filter(a => a.communityId === communityId);
    if (communityAudits.length === 0) {
        section.innerHTML = `<div class="empty-state">No audits for this community yet.
            <br><button class="btn btn-primary" style="margin-top:12px" onclick="openNewAuditModal('${communityId}')">Schedule Audit</button></div>`;
        return;
    }

    section.innerHTML = communityAudits.map(a => renderAuditListCard(a, 'community')).join('');
}

function renderSensorTickets(sensorId) {
    const section = document.getElementById('sensor-tickets-section');
    if (!section) return;

    const tickets = serviceTickets.filter(t => t.sensorId === sensorId);
    if (tickets.length === 0) {
        section.innerHTML = '<div class="empty-state">No service tickets for this sensor.</div>';
        return;
    }

    section.innerHTML = tickets.map(t => {
        const dateStr = t.createdAt ? formatDate(t.createdAt) : '';
        const isOpen = t.status !== 'Closed';

        // For open tickets, show progress notes newest-first
        let notesHtml = '';
        if (isOpen && t.progressNotes && t.progressNotes.length > 0) {
            notesHtml = `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--slate-100)">
                ${t.progressNotes.slice().reverse().map(n => `<div style="font-size:12px;margin-bottom:6px">
                    <span style="color:var(--slate-400)">${n.at ? formatDate(n.at) : ''}${n.by ? ' — ' + escapeHtml(n.by) : ''}</span>
                    <div style="color:var(--slate-600);margin-top:1px">${escapeHtml(n.text)}</div>
                </div>`).join('')}
            </div>`;
        }

        return `<div class="audit-list-card" onclick="openTicketDetail('${t.id}')">
            <div class="audit-list-card-header">
                <span style="font-weight:600;color:var(--slate-700)">${formatTicketType(t.ticketType)}</span>
                <span class="ticket-status-badge ${TICKET_STATUS_CSS[t.status] || ''}">${t.status}</span>
            </div>
            <div class="audit-list-card-meta">${dateStr}${t.createdBy ? ' by ' + escapeHtml(t.createdBy) : ''}</div>
            ${t.issueDescription ? `<div style="font-size:12px;color:var(--slate-500);margin-top:4px">${escapeHtml(t.issueDescription.substring(0, 100))}${t.issueDescription.length > 100 ? '...' : ''}</div>` : ''}
            ${notesHtml}
        </div>`;
    }).join('');
}

function renderSensorAudits(sensorId) {
    const section = document.getElementById('sensor-audits-section');
    if (!section) return;

    const sensorAudits = audits.filter(a => a.auditPodId === sensorId || a.communityPodId === sensorId);
    if (sensorAudits.length === 0) {
        section.innerHTML = '<div class="empty-state">No audits involving this sensor.</div>';
        return;
    }

    section.innerHTML = sensorAudits.map(a => {
        const role = a.auditPodId === sensorId ? 'Audit Pod' : 'Community Pod';
        return renderAuditListCard(a, 'sensor', role);
    }).join('');
}

function renderAuditListCard(audit, context, sensorRole) {
    const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || audit.communityId;
    const dateRange = audit.scheduledStart ? `${new Date(audit.scheduledStart + 'T00:00').toLocaleDateString('en-US', { timeZone: AK_TZ })} \u2013 ${new Date(audit.scheduledEnd + 'T00:00').toLocaleDateString('en-US', { timeZone: AK_TZ })}` : '\u2014';
    const hasResults = Object.keys(audit.analysisResults || {}).length > 0;

    let paramBadges = '';
    if (hasResults) {
        paramBadges = AUDIT_PARAMETERS.map(p => {
            const r = audit.analysisResults[p.key];
            if (!r) return `<span class="audit-param-badge pending">${p.label}</span>`;
            return `<span class="audit-param-badge ${r.pass ? 'pass' : 'fail'}">${p.label} ${r.pass ? '\u2713' : '\u2717'}</span>`;
        }).join('');
    }

    return `<div class="audit-list-card" onclick="openAuditDetail('${audit.id}')">
        <div class="audit-list-card-header">
            <span style="font-weight:600;color:var(--slate-700)">${context === 'sensor' ? communityName : audit.analysisName || communityName}</span>
            <span class="audit-status-badge ${AUDIT_STATUS_CSS[audit.status]}">${audit.status}</span>
        </div>
        <div class="audit-list-card-sensors">
            ${audit.auditPodId} <span style="color:var(--slate-300)">\u2194</span> ${audit.communityPodId}
            ${sensorRole ? `<span style="color:var(--slate-400);font-size:11px;margin-left:8px">(${sensorRole})</span>` : ''}
        </div>
        <div class="audit-list-card-meta">${dateRange}</div>
        ${hasResults ? `<div class="audit-list-card-results">${paramBadges}</div>` : ''}
        ${hasResults ? `<span class="analysis-view-btn" onclick="event.stopPropagation(); beginAnalysis('${audit.id}')">View Analysis \u2192</span>` : ''}
    </div>`;
}

function generateAuditReport(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    const cached = analysisDataCache[auditId];
    const results = audit.analysisResults || {};
    const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || audit.communityId;

    // Build descriptive sensor labels
    const auditPodSensor = sensors.find(s => s.id === audit.auditPodId);
    const communityPodSensor = sensors.find(s => s.id === audit.communityPodId);
    const auditPodLoc = auditPodSensor?.community ? (COMMUNITIES.find(c => c.id === auditPodSensor.community)?.name || '') : '';
    const labelA = `${auditPodLoc ? auditPodLoc + ' ' : ''}${auditPodSensor?.type || 'Audit Pod'} ${audit.auditPodId}`.trim();
    const labelB = `${communityName} ${communityPodSensor?.type || 'Community Pod'} ${audit.communityPodId}`.trim();
    const shortA = `${auditPodSensor?.type || 'Audit Pod'} ${shortSensorId(audit.auditPodId)}`;
    const shortB = `${communityName} Pod ${shortSensorId(audit.communityPodId)}`;

    const dateRange = audit.scheduledStart
        ? `${new Date(audit.scheduledStart + 'T00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: AK_TZ })} \u2013 ${new Date(audit.scheduledEnd + 'T00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: AK_TZ })}`
        : '\u2014';

    // DQO table rows — using labelHtml for subscripts
    const dqoRows = AUDIT_PARAMETERS.map(p => {
        const r = results[p.key];
        const T = DQO_THRESHOLDS;
        if (!r) return `<tr><td>${p.labelHtml} (${p.unit})</td><td colspan="7" style="color:#64748b">No data</td></tr>`;
        const d = r.dqo || {};
        const cls = (pass) => pass ? 'color:#1a7f37' : 'color:#c53030;font-weight:700';
        return `<tr>
            <td style="font-family:'DM Sans',sans-serif;font-weight:600">${p.labelHtml} (${p.unit})</td>
            <td style="${cls(d.r2)}">${r.r2} <span class="dqo-thresh">(\u2265 ${T.r2.min})</span></td>
            <td style="${cls(d.slope)}">${r.slope} <span class="dqo-thresh">(${T.slope.min}\u2013${T.slope.max})</span></td>
            <td style="${cls(d.intercept)}">${r.intercept} <span class="dqo-thresh">(${T.intercept.min} to ${T.intercept.max})</span></td>
            <td style="${cls(d.sd)}">${r.sd} <span class="dqo-thresh">(\u2264 ${T.sd.max})</span></td>
            <td style="${cls(d.rmse)}">${r.rmse} <span class="dqo-thresh">(\u2264 ${T.rmse.max})</span></td>
            <td style="text-align:center">${r.n || '\u2014'}</td>
            <td style="text-align:center">${r.pass
                ? '<span style="background:#e6f9ed;color:#1a7f37;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700">PASS</span>'
                : '<span style="background:#fde8e8;color:#c53030;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700">FAIL</span>'}</td>
        </tr>`;
    }).join('');

    // Data summary
    const trimInfo = cached
        ? `First 24 hours excluded (${cached.trimIndex} of ${cached.allRows.length} rows trimmed) \u2014 regression on ${cached.trimmedRows.length} rows`
        : `Analysis based on ${results[AUDIT_PARAMETERS[0]?.key]?.n || '\u2014'} valid hourly data pairs`;

    // Raw data table
    let rawDataHtml = '';
    if (cached) {
        const paramKeys = Object.keys(PARAM_COLUMN_MAP);
        const paramLabels = AUDIT_PARAMETERS.reduce((m, p) => { m[p.key] = `${p.labelHtml} (${p.unit})`; return m; }, {});
        rawDataHtml = `
            <div class="print-page-break">
            <div class="section-page-header">
                <div><div class="sph-title">${escapeHtml(communityName)} Sensor Audit Report</div><div class="sph-sub">${dateRange} &mdash; ${escapeHtml(labelB)} &amp; ${escapeHtml(labelA)}</div></div>
                <div class="sph-right"><div class="sph-dept"><div>ADEC Division of Air Quality</div><div>Air Monitoring &amp; Quality Assurance</div></div><img class="sph-logo" src="https://dec.alaska.gov/media/1029/dec-logo.png" alt="ADEC"></div>
            </div>
            <h2 class="section-start-heading">Hourly Data</h2>
            <p style="font-size:11px;color:#8a6d20;background:#fff8e8;display:inline-block;padding:3px 10px;border-radius:6px;margin-bottom:8px">* = first 24 hours (excluded from regression). PM<sub>10</sub> values &gt; 1000 invalidated.</p>
            <table style="width:100%;border-collapse:collapse;font-size:9px;font-family:'JetBrains Mono',monospace">
                <thead><tr style="background:#1B2A4A;color:white">
                    <th style="padding:4px 6px;text-align:left">Date/Time</th>
                    ${paramKeys.map(k => `<th style="padding:4px 6px">${escapeHtml(labelA)}<br>${paramLabels[k] || k}</th><th style="padding:4px 6px">${escapeHtml(labelB)}<br>${paramLabels[k] || k}</th>`).join('')}
                </tr></thead>
                <tbody>
                    ${cached.allRows.map((r, i) => {
                        const isTrimmed = i < cached.trimIndex;
                        const dateStr = r.timestamp.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: AK_TZ });
                        return `<tr style="${isTrimmed ? 'color:#6b7280;background:#fffbf0' : (i % 2 === 0 ? '' : 'background:#fafbfc')}">
                            <td style="padding:3px 6px;border-bottom:1px solid #e2e8f0">${dateStr}${isTrimmed ? ' *' : ''}</td>
                            ${paramKeys.map(k => {
                                const va = r.values[k]?.a;
                                const vb = r.values[k]?.b;
                                return `<td style="padding:3px 6px;border-bottom:1px solid #e2e8f0;text-align:right">${isNaN(va) ? '\u2014' : va}</td><td style="padding:3px 6px;border-bottom:1px solid #e2e8f0;text-align:right">${isNaN(vb) ? '\u2014' : vb}</td>`;
                            }).join('')}
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
            <p style="font-size:10px;color:#64748b;margin-top:4px">${cached.allRows.length} total hourly observations</p>
            </div>
        `;
    }

    // Render charts as images using existing in-page Chart.js, then build the HTML file
    const chartImages = {};
    if (cached) {
        const chartResults = cached.regressionResults || results;
        const tempContainer = document.createElement('div');
        tempContainer.style.cssText = 'position:absolute;left:-9999px;top:0;width:440px';
        document.body.appendChild(tempContainer);

        const renderChartToImage = (config) => {
            const canvas = document.createElement('canvas');
            canvas.width = 1200; canvas.height = 600;
            tempContainer.appendChild(canvas);
            const chart = new Chart(canvas, config);
            const img = canvas.toDataURL('image/png');
            chart.destroy();
            tempContainer.removeChild(canvas);
            return img;
        };

        const trimmedRows = cached.trimmedRows || cached.allRows;
        const tsLabels = trimmedRows.map(r => r.timestamp);

        // PM Time series (trimmed — first 24h removed)
        AUDIT_PARAMETERS.filter(p => p.hasTimeSeries).forEach(p => {
            const seriesA = trimmedRows.map(r => { const v = r.values[p.key]?.a; return isNaN(v) ? null : v; });
            const seriesB = trimmedRows.map(r => { const v = r.values[p.key]?.b; return isNaN(v) ? null : v; });
            chartImages['ts-' + p.key] = renderChartToImage({
                type: 'line',
                data: { labels: tsLabels, datasets: [
                    { data: seriesA, borderColor: '#1B2A4A', borderWidth: 3, pointRadius: 0, tension: 0.2, fill: false },
                    { data: seriesB, borderColor: '#C9A84C', borderWidth: 3, pointRadius: 0, tension: 0.2, fill: false },
                ]},
                options: {
                    responsive: false, animation: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { type: 'time', time: { unit: 'day', displayFormats: { day: 'MMM d' } }, grid: { display: false }, ticks: { font: { size: 32 } } },
                        y: { title: { display: true, text: p.label + ' (' + p.unit + ')', font: { size: 30, weight: '600' } }, grid: { display: false }, ticks: { font: { size: 32 } } },
                    },
                },
            });
        });

        // Scatter plots for all params
        AUDIT_PARAMETERS.forEach(p => {
            const r = chartResults[p.key];
            if (!r || !r.pairs) return;
            const xVals = r.pairs.map(pt => pt.x);
            const minX = Math.min(...xVals);
            const maxX = Math.max(...xVals);
            const eqSign = r.intercept >= 0 ? '+' : '\u2212';
            const eqLabel = `y = ${r.slope}x ${eqSign} ${Math.abs(r.intercept)}`;
            chartImages['scatter-' + p.key] = renderChartToImage({
                type: 'scatter',
                data: { datasets: [
                    { data: r.pairs, backgroundColor: 'rgba(27,42,74,0.5)', borderColor: 'rgba(27,42,74,0.6)', pointRadius: 4 },
                    { data: [{ x: minX, y: r.slope * minX + r.intercept }, { x: maxX, y: r.slope * maxX + r.intercept }], type: 'line', borderColor: '#C9A84C', borderWidth: 3, pointRadius: 0, fill: false },
                ]},
                options: {
                    responsive: false, animation: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { title: { display: true, text: shortA + ' ' + p.label + ' (' + p.unit + ')', font: { size: 38, weight: '600' } }, grid: { display: false }, ticks: { font: { size: 40 } } },
                        y: { title: { display: true, text: shortB + ' ' + p.label + ' (' + p.unit + ')', font: { size: 38, weight: '600' } }, grid: { display: false }, ticks: { font: { size: 40 } } },
                    },
                },
            });
        });

        document.body.removeChild(tempContainer);
    }

    // Build PM time series HTML
    const pmParams = AUDIT_PARAMETERS.filter(p => p.hasTimeSeries);
    const tsHtml = pmParams.map(p => chartImages['ts-' + p.key]
        ? `<div class="chart-card">
            <h3>${escapeHtml(shortB)} and ${escapeHtml(shortA)}: <strong>${p.labelHtml}</strong></h3>
            <div class="chart-sub">${dateRange}. Hourly data, first 24 hours removed</div>
            <img src="${chartImages['ts-' + p.key]}" style="width:100%" alt="Timeseries chart for ${p.label}">
            <div class="chart-legend"><span><span style="background:#1B2A4A;display:inline-block;width:20px;height:4px;border-radius:2px;vertical-align:middle"></span> ${escapeHtml(shortA)}</span><span><span style="background:#C9A84C;display:inline-block;width:20px;height:4px;border-radius:2px;vertical-align:middle"></span> ${escapeHtml(shortB)}</span></div>
        </div>` : '').join('');
    const scatterCards = AUDIT_PARAMETERS.map(p => {
        const r = (cached?.regressionResults || results)[p.key];
        const eqSign = r ? (r.intercept >= 0 ? '+' : '\u2212') : '';
        const eqText = r ? `y = ${r.slope}x ${eqSign} ${Math.abs(r.intercept)},&nbsp;&nbsp;&nbsp;&nbsp; R\u00B2 = ${r.r2}` : '';
        return chartImages['scatter-' + p.key]
        ? `<div class="chart-card">
            <h3>${escapeHtml(shortB)} and ${escapeHtml(shortA)}: <strong>${p.labelHtml}</strong></h3>
            <div class="chart-sub">${dateRange}. Hourly data, first 24 hours removed</div>
            <img src="${chartImages['scatter-' + p.key]}" style="width:100%" alt="Regression scatter plot for ${p.label}">
            <div class="chart-eq">${eqText}</div>
        </div>` : '';
    }).filter(Boolean);

    // Assemble full HTML
    const reportHtml = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Audit Report \u2014 ${escapeHtml(communityName)} ${escapeHtml(audit.auditPodId)} ${audit.scheduledStart || ''}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', sans-serif; color: #1e293b; max-width: 1000px; margin: 0 auto; line-height: 1.5; padding: 40px 48px; }
    sub { font-size: 0.8em; }

    /* Page 1 hero header */
    h1 { font-size: 26px; color: #1B2A4A; margin-bottom: 2px; }
    h2 { font-size: 16px; color: #1B2A4A; margin: 48px 0 14px; border-bottom: 2px solid #1B2A4A; padding-bottom: 6px; }
    .report-subtitle { font-size: 14px; color: #64748b; margin-bottom: 4px; line-height: 1.6; }
    .report-sensors { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #475569; }
    .report-header-bar {
        display: flex; justify-content: space-between; align-items: flex-start;
        margin-bottom: 28px; border-bottom: 3px solid #C9A84C; padding-bottom: 18px;
    }
    .report-header-right { display: flex; align-items: center; gap: 14px; }
    .report-header-info { text-align: right; font-size: 11px; color: #64748b; line-height: 1.6; }
    .report-header-logo { height: 48px; width: auto; }

    /* Print-only elements — hidden on screen, visible in print */
    .section-page-header { display: none; }
    .print-only { display: none; }

    /* Section-start headings: normal margin on screen, no top margin in print (page header provides spacing) */
    .section-start-heading { /* inherits h2 margin on screen */ }

    /* Audit details grid */
    .report-meta { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 6px 16px; font-size: 13px; margin-bottom: 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px; }
    .report-meta dt { font-weight: 600; color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
    .report-meta dd { margin: 0; color: #1e293b; padding-bottom: 6px; border-bottom: 1px solid #f1f5f9; }
    .report-meta dd:last-child, .report-meta dd:nth-last-child(2) { border-bottom: none; }
    .report-meta dd .mono { font-family: 'JetBrains Mono', monospace; font-size: 12px; }

    /* DQO table */
    .trim-note { display: inline-block; background: #fff8e8; color: #8a6d20; padding: 4px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; margin-bottom: 12px; }
    .dqo-thresh { display: block; font-size: 12px; font-weight: 500; text-transform: none; letter-spacing: 0; color: #475569; margin-top: 2px; }
    table.dqo { width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 8px; }
    table.dqo th { text-align: right; padding: 12px 16px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #475569; border-bottom: 2px solid #e2e8f0; white-space: nowrap; }
    table.dqo th:first-child { text-align: left; }
    table.dqo th:last-child { text-align: center; }
    table.dqo td { padding: 12px 16px; border-bottom: 1px solid #e2e8f0; font-family: 'JetBrains Mono', monospace; font-size: 13px; text-align: right; font-variant-numeric: tabular-nums; }
    table.dqo td:first-child { text-align: left; font-family: 'DM Sans', sans-serif; font-weight: 600; font-size: 14px; }
    table.dqo td:last-child { text-align: center; }
    table.dqo tbody tr:nth-child(even) { background: #fafbfc; }
    .thresholds { font-size: 14px; color: #334155; margin-top: 12px; margin-bottom: 0; line-height: 1.7; }

    /* Chart cards and grid */
    .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; margin-bottom: 0; }
    .chart-card { border: 1px solid #cbd5e1; border-radius: 10px; padding: 16px; }
    .chart-card h3 { font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 500; color: #1e293b; margin-bottom: 2px; }
    .chart-card h3 strong { font-weight: 700; }
    .chart-card .chart-sub { font-family: 'DM Sans', sans-serif; font-size: 12px; color: #64748b; margin-bottom: 8px; }
    .chart-card img { width: 100%; display: block; }
    .chart-card .chart-eq { font-family: 'DM Sans', sans-serif; font-size: 13px; color: #334155; text-align: center; margin-top: 8px; }
    .chart-card .chart-legend { display: flex; justify-content: center; gap: 32px; font-family: 'DM Sans', sans-serif; font-size: 13px; color: #334155; margin-top: 8px; white-space: nowrap; }
    .chart-card .chart-legend span { display: inline-flex; align-items: center; gap: 6px; }

    /* Report footer */
    .report-footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center; }

    /* Print controls (screen only) */
    .print-controls { margin-bottom: 20px; display: flex; align-items: center; gap: 16px; }
    .print-controls button { padding: 10px 24px; font-size: 14px; font-family: 'DM Sans', sans-serif; font-weight: 600; background: #1B2A4A; color: white; border: none; border-radius: 8px; cursor: pointer; }
    .print-controls label { font-size: 13px; color: #64748b; display: flex; align-items: center; gap: 6px; cursor: pointer; }

    .report-section { break-inside: avoid; page-break-inside: avoid; }

    @media print {
        @page { margin: 1in; }
        body { margin: 0; max-width: none; padding: 0; }
        .no-print { display: none !important; }
        .print-only { display: block; }

        /* Section page headers — shown in print at each forced page break */
        .section-page-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 0 0 8px 0; margin-bottom: 20px;
            border-bottom: 2px solid #C9A84C;
        }
        .section-page-header .sph-title { font-size: 11px; font-weight: 700; color: #1B2A4A; letter-spacing: 0.2px; }
        .section-page-header .sph-sub { font-size: 9px; color: #64748b; margin-top: 2px; }
        .section-page-header .sph-right { display: flex; align-items: center; gap: 10px; }
        .section-page-header .sph-dept { font-size: 8px; color: #64748b; text-align: right; line-height: 1.5; }
        .section-page-header .sph-logo { height: 22px; width: auto; }

        /* Forced page breaks before sections that start new pages */
        .print-page-break { break-before: page; page-break-before: always; }

        /* Section-start headings lose top margin in print — the page header provides spacing */
        .section-start-heading { margin-top: 0 !important; }

        /* Scrunch timeseries charts to fit stacked on one page */
        .chart-grid[style*="grid-template-columns:1fr"] .chart-card { padding: 10px; }
        .chart-grid[style*="grid-template-columns:1fr"] .chart-card img { max-height: 280px; object-fit: contain; }
        .chart-grid[style*="grid-template-columns:1fr"] { gap: 10px; margin-top: 10px; }
        .chart-grid[style*="grid-template-columns:1fr"] .chart-legend { margin-top: 4px; font-size: 11px; }
        .chart-grid[style*="grid-template-columns:1fr"] .chart-sub { margin-bottom: 4px; }

        /* Page 1 hero header */
        .report-header-bar { break-inside: avoid; page-break-inside: avoid; }

        h2 { break-after: avoid; page-break-after: avoid; margin-top: 24px; }
        h1 { margin-top: 0; }
        .report-section { break-inside: avoid; page-break-inside: avoid; }
        .chart-card { break-inside: avoid; page-break-inside: avoid; }
        .chart-grid { break-before: avoid; page-break-before: avoid; }
        .report-meta { break-inside: avoid; page-break-inside: avoid; }
        table.dqo { break-inside: avoid; page-break-inside: avoid; }
        .thresholds { break-before: avoid; page-break-before: avoid; }
        table.dqo tbody tr:nth-child(even), .chart-legend, .chart-eq, .chart-sub, .trim-note { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
</style>
</head><body>

    <div class="report-header-bar">
        <div>
            <h1>${escapeHtml(communityName)} Sensor Audit Report</h1>
            <div class="report-subtitle">${dateRange}</div>
            <div class="report-sensors">${escapeHtml(labelB)} and ${escapeHtml(labelA)}</div>
        </div>
        <div class="report-header-right">
            <div class="report-header-info">
                <div style="font-weight:600">ADEC Division of Air Quality</div>
                <div>Air Monitoring and Quality Assurance</div>
                <div style="margin-top:4px">${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: AK_TZ })}</div>
            </div>
            <img class="report-header-logo" src="https://dec.alaska.gov/media/1029/dec-logo.png" alt="ADEC Logo" onerror="this.style.display='none'">
        </div>
    </div>

    <section class="report-section">
    <h2>Audit Details</h2>
    <dl class="report-meta">
        <dt>Community</dt><dd>${escapeHtml(communityName)}</dd>
        <dt>Audit Period</dt><dd>${dateRange}</dd>
        <dt>Community Pod ID</dt><dd><span class="mono">${escapeHtml(audit.communityPodId)}</span></dd>
        <dt>Audit Pod ID</dt><dd><span class="mono">${escapeHtml(audit.auditPodId)}</span></dd>
        <dt>Community Pod Location</dt><dd>${escapeHtml(communityPodSensor?.location || '\u2014')}</dd>
        <dt>Installation / Removal By</dt><dd>${escapeHtml(audit.conductedBy || '\u2014')}</dd>
        ${(audit.progressNotes || []).length > 0 ? `<dt>Notes</dt><dd style="grid-column:span 3">${audit.progressNotes.map(n => escapeHtml(n.text) + (n.by ? ' — ' + escapeHtml(n.by) : '')).join('<br>')}</dd>` : ''}
    </dl>
    </section>

    <section class="report-section">
    <h2>Data Quality Objectives (DQO) Summary</h2>
    <span class="trim-note">${trimInfo}</span>
    <table class="dqo">
        <thead><tr>
            <th scope="col">Parameter</th>
            <th>R\u00B2</th>
            <th>Slope</th>
            <th>Intercept</th>
            <th>SD</th>
            <th>RMSE</th>
            <th>n</th>
            <th>Result</th>
        </tr></thead>
        <tbody>${dqoRows}</tbody>
    </table>
    ${audit.analysisNotes ? '<div class="thresholds" style="margin-bottom:8px"><strong>Analysis Note:</strong> ' + escapeHtml(audit.analysisNotes) + '</div>' : ''}
    <div class="thresholds">DQO Thresholds (all parameters): R\u00B2 \u2265 0.70, Slope 0.65\u20131.35, Intercept \u00B15, SD \u2264 5, RMSE \u2264 7. PM<sub>10</sub> values exceeding 1000 \u00B5g/m\u00B3 were invalidated prior to analysis.</div>
    </section>

    ${tsHtml ? `
    <div class="print-page-break">
        <div class="section-page-header">
            <div><div class="sph-title">${escapeHtml(communityName)} Sensor Audit Report</div><div class="sph-sub">${dateRange} &mdash; ${escapeHtml(labelB)} &amp; ${escapeHtml(labelA)}</div></div>
            <div class="sph-right"><div class="sph-dept"><div>ADEC Division of Air Quality</div><div>Air Monitoring &amp; Quality Assurance</div></div><img class="sph-logo" src="https://dec.alaska.gov/media/1029/dec-logo.png" alt="ADEC" onerror="this.style.display='none'"></div>
        </div>
        <h2 class="section-start-heading">PM Timeseries</h2>
        <div class="chart-grid" style="grid-template-columns:1fr">${tsHtml}</div>
    </div>` : ''}

    ${scatterCards.length > 0 ? (() => {
        const sphHeader = '<div class="section-page-header"><div><div class="sph-title">' + escapeHtml(communityName) + ' Sensor Audit Report</div><div class="sph-sub">' + dateRange + ' &mdash; ' + escapeHtml(labelB) + ' &amp; ' + escapeHtml(labelA) + '</div></div><div class="sph-right"><div class="sph-dept"><div>ADEC Division of Air Quality</div><div>Air Monitoring &amp; Quality Assurance</div></div><img class="sph-logo" src="https://dec.alaska.gov/media/1029/dec-logo.png" alt="ADEC"></div></div>';
        let out = '';
        for (let i = 0; i < scatterCards.length; i += 4) {
            if (i === 0) {
                out += '<h2>Regression Plots</h2>';
                out += '<div class="chart-grid">' + scatterCards.slice(i, i + 4).join('') + '</div>';
            } else {
                out += '<div class="print-page-break">';
                out += sphHeader;
                out += '<h2 class="print-only section-start-heading">Regression Plots (continued)</h2>';
                out += '<div class="chart-grid">' + scatterCards.slice(i, i + 4).join('') + '</div>';
                out += '</div>';
            }
        }
        return out;
    })() : ''}

    <div id="report-dataset-section">${rawDataHtml}</div>

    <div class="report-footer">
        ADEC \u2014 Sensor Collocation Audit \u2014 ${escapeHtml(communityName)} \u2014 ${dateRange}
    </div>

    <div class="no-print print-controls" style="position:fixed;bottom:20px;right:20px;background:white;padding:12px 20px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,0.15);border:1px solid #e2e8f0">
        <label><input type="checkbox" checked onchange="document.getElementById('report-dataset-section').style.display=this.checked?'':'none'"> Include dataset</label>
        <button onclick="window.print()">Print / Save as PDF</button>
    </div>
</body></html>`;

    // Download as HTML file
    const blob = new Blob([reportHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const fileName = `Audit_${communityName.replace(/\s+/g, '_')}_${audit.auditPodId}_${audit.scheduledStart || 'undated'}.html`;
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function renderAuditPhotos(auditId, communityId) {
    const files = (communityFiles[communityId] || []).filter(f =>
        f.storagePath && f.storagePath.startsWith(auditId + '/') && f.type && f.type.startsWith('image/')
    );
    if (files.length === 0) return '<p style="font-size:12px;color:var(--slate-400)">No photos yet.</p>';
    // Return placeholder grid, then load signed URLs async
    setTimeout(() => loadAuditPhotoUrls(auditId, communityId, files), 0);
    return files.map((f, i) => `<div class="audit-photo-thumb">
        <img id="audit-photo-${auditId}-${i}" src="" alt="${escapeHtml(f.name)}" style="background:var(--slate-100)" onclick="openStorageFile('${f.storagePath}')">
        <button class="audit-photo-delete" onclick="deleteAuditPhoto('${communityId}', '${f.id}', '${f.storagePath}', '${auditId}')" title="Delete">&times;</button>
    </div>`).join('');
}

async function loadAuditPhotoUrls(auditId, communityId, files) {
    for (let i = 0; i < files.length; i++) {
        try {
            const url = await db.getSignedUrl(files[i].storagePath);
            const img = document.getElementById(`audit-photo-${auditId}-${i}`);
            if (img) img.src = url;
        } catch(e) { /* file may not exist */ }
    }
}

async function deleteAuditPhoto(communityId, fileId, storagePath, auditId) {
    showConfirm('Delete Photo', 'Delete this photo? This cannot be undone.', async () => {
        try {
            await supa.storage.from('community-files').remove([storagePath]);
            await supa.from('community_files').delete().eq('id', fileId);
            const arr = communityFiles[communityId];
            if (arr) {
                const idx = arr.findIndex(f => f.id === fileId);
                if (idx >= 0) arr.splice(idx, 1);
            }
        } catch (err) { handleSaveError(err); }
        const grid = document.getElementById('audit-photos-grid');
        if (grid) grid.innerHTML = renderAuditPhotos(auditId, communityId);
    }, { danger: true });
}

async function uploadAuditPhotos(auditId, communityId, files) {
    // Build a display name from the audit's scheduled dates
    const audit = audits.find(a => a.id === auditId);
    let displayName = 'Audit Setup';
    if (audit && audit.scheduledStart && audit.scheduledEnd) {
        const startD = new Date(audit.scheduledStart + 'T00:00:00');
        const endD = new Date(audit.scheduledEnd + 'T00:00:00');
        const startStr = startD.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: AK_TZ });
        const endStr = endD.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: AK_TZ });
        displayName = `Audit Setup ${startStr} - ${endStr}`;
    }
    for (const file of files) {
        try {
            const path = `${auditId}/${Date.now()}_${file.name}`;
            await supa.storage.from('community-files').upload(path, file);
            const { data: fileData } = await supa.from('community_files').insert({
                community_id: communityId, file_name: displayName, file_type: file.type,
                storage_path: path, uploaded_by: currentUserId,
            }).select();
            if (!communityFiles[communityId]) communityFiles[communityId] = [];
            communityFiles[communityId].push({ id: fileData?.[0]?.id || generateId('f'), name: displayName, type: file.type, storagePath: path, date: nowDatetime() });
        } catch (err) { handleSaveError(err); }
    }
    // Refresh the photo grid inline instead of reopening the whole modal
    const grid = document.getElementById('audit-photos-grid');
    if (grid) grid.innerHTML = renderAuditPhotos(auditId, communityId);
}

// ===== COLLOCATION SYSTEM =====
const COLLOC_STATUSES = ['In Progress', 'Finished, Analysis Pending', 'Complete'];
const COLLOC_STATUS_CSS = {
    'In Progress': 'cs-in-progress',
    'Finished, Analysis Pending': 'cs-analysis',
    'Complete': 'cs-verified'
};

function persistCollocationUpdate(id, updates) {
    return db.updateCollocation(id, updates).catch(handleSaveError);
}

function updateSidebarCollocationCount() {
    const el = document.getElementById('sidebar-colloc-count');
    if (!el) return;
    const count = collocations.filter(c => c.status !== 'Complete').length;
    el.textContent = count > 0 ? `(${count})` : '';
}

function getActiveCollocationsForSensor(sensorId) {
    return collocations.filter(c => c.sensorIds.includes(sensorId) && c.status !== 'Complete');
}

function renderCollocationsView() {
    const container = document.getElementById('collocations-pipeline');
    if (!container) return;

    const statusGroups = {};
    COLLOC_STATUSES.forEach(s => statusGroups[s] = []);
    collocations.forEach(c => {
        if (statusGroups[c.status]) statusGroups[c.status].push(c);
    });

    container.innerHTML = COLLOC_STATUSES.map(status => {
        const items = statusGroups[status];
        return `<div class="audit-pipeline-column">
            <div class="audit-pipeline-header"><span class="audit-status-badge ${COLLOC_STATUS_CSS[status]}">${status}</span> <span style="color:var(--slate-400);font-size:12px">(${items.length})</span></div>
            ${items.length === 0 ? '<div class="empty-state" style="font-size:12px">None</div>' : items.map(c => renderCollocationCard(c)).join('')}
        </div>`;
    }).join('');
}

function renderCollocationCard(colloc) {
    const communityName = COMMUNITIES.find(c => c.id === colloc.locationId)?.name || colloc.locationId;
    const dateRange = colloc.startDate ? `${formatDate(colloc.startDate)}${colloc.endDate && colloc.endDate !== 'TBD' ? ' – ' + formatDate(colloc.endDate) : colloc.endDate === 'TBD' ? ' – TBD' : ''}` : '';
    const sensorList = (colloc.sensorIds || []).map(id => shortSensorId(id)).join(', ');
    const hasResults = Object.keys(colloc.analysisResults || {}).length > 0;

    return `<div class="audit-list-card" onclick="openCollocationDetail('${colloc.id}')">
        <div class="audit-list-card-header">
            <span style="font-weight:600;color:var(--slate-700)">${escapeHtml(communityName)}</span>
            <span class="audit-status-badge ${COLLOC_STATUS_CSS[colloc.status]}">${colloc.status}</span>
        </div>
        <div class="audit-list-card-meta">${dateRange}</div>
        <div style="font-size:12px;color:var(--slate-500);margin-top:4px">Sensors: ${escapeHtml(sensorList) || '—'}</div>
        ${hasResults ? '<div style="font-size:11px;color:var(--green);margin-top:4px">Analysis complete</div>' : ''}
    </div>`;
}

function openCollocationDetail(collocId) {
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc) return;
    const communityName = COMMUNITIES.find(c => c.id === colloc.locationId)?.name || colloc.locationId;
    const statusIndex = COLLOC_STATUSES.indexOf(colloc.status);
    const nextStatus = statusIndex < COLLOC_STATUSES.length - 1 ? COLLOC_STATUSES[statusIndex + 1] : null;
    const isComplete = colloc.status === 'Complete';
    const showAnalysis = statusIndex >= 1; // Complete or later

    const progressHtml = COLLOC_STATUSES.map((st, i) => {
        const state = i < statusIndex ? 'completed' : i === statusIndex ? 'current' : 'pending';
        return `<div class="ticket-step ${state}"><div class="ticket-step-dot"></div><div class="ticket-step-label">${st}</div></div>`;
    }).join('');

    const sensorList = (colloc.sensorIds || []).map(id => `<a href="#" onclick="closeModal('modal-collocation-detail'); showSensorDetail('${id}'); return false;" style="color:var(--navy-500)">${id}</a>`).join(', ');

    const hasResults = Object.keys(colloc.analysisResults || {}).length > 0;

    document.getElementById('collocation-detail-title').textContent = `Collocation: ${communityName}`;
    document.getElementById('collocation-detail-body').innerHTML = `
        <div style="padding:12px 28px 0"><div class="ticket-steps ticket-steps-detail">${progressHtml}</div></div>
        <div class="ticket-detail-actions" style="border-top:none">
            ${!isComplete && nextStatus ? `<button class="btn btn-primary" onclick="advanceCollocationStatus('${colloc.id}')">Advance to: ${nextStatus}</button>` : ''}
            ${statusIndex > 0 && !isComplete ? `<a class="undo-link" onclick="revertCollocationStatus('${colloc.id}')">Undo</a>` : ''}
            ${showAnalysis ? `<button class="btn" onclick="beginCollocationAnalysis('${colloc.id}')">${hasResults ? 'View Analysis' : 'Upload Data'}</button>` : ''}
            ${hasResults ? `<button class="btn" onclick="reuploadCollocationData('${colloc.id}')">Re-upload Data</button>` : ''}
            <span class="action-spacer"></span>
            <button class="btn" onclick="closeModal('modal-collocation-detail')">Done</button>
        </div>
        <div class="ticket-detail-grid">
            <div class="ticket-field"><label>Location</label><p><a href="#" onclick="closeModal('modal-collocation-detail'); showCommunity('${colloc.locationId}'); return false;" style="color:var(--navy-500)">${escapeHtml(communityName)}</a></p></div>
            <div class="ticket-field"><label>Status</label><p><span class="audit-status-badge ${COLLOC_STATUS_CSS[colloc.status]}">${colloc.status}</span></p></div>
            <div class="ticket-field"><label>Start Date</label>${!isComplete ? `<input class="ticket-edit-input" type="date" value="${colloc.startDate}" onblur="saveCollocationField('${colloc.id}','startDate',this.value)">` : `<p>${formatDate(colloc.startDate) || '—'}</p>`}</div>
            <div class="ticket-field"><label>End Date</label>${!isComplete ? `<input class="ticket-edit-input" type="date" value="${colloc.endDate === 'TBD' ? '' : colloc.endDate}" onblur="saveCollocationField('${colloc.id}','endDate',this.value)">` : `<p>${colloc.endDate === 'TBD' ? 'TBD' : formatDate(colloc.endDate) || '—'}</p>`}</div>
            <div class="ticket-field full-width"><label>Sensors</label><p>${sensorList || '—'}</p></div>
            <div class="ticket-field"><label>Conducted By</label>${!isComplete ? `<input class="ticket-edit-input" value="${escapeHtml(colloc.conductedBy)}" onblur="saveCollocationField('${colloc.id}','conductedBy',this.value)">` : `<p>${escapeHtml(colloc.conductedBy) || '—'}</p>`}</div>
            ${renderProgressNotesSection(colloc.progressNotes, colloc.id, 'addCollocationProgressNote')}
            ${hasResults ? `<div class="ticket-field full-width"><label>Analysis</label><p style="color:var(--green)">Analysis uploaded ${formatDate(colloc.analysisUploadDate)} by ${escapeHtml(colloc.analysisUploadedBy)}</p></div>` : ''}
        </div>
        <div style="padding:16px 28px;border-top:1px solid var(--slate-100);text-align:right">
            <button class="btn btn-sm btn-danger" onclick="deleteCollocation('${colloc.id}')" style="font-size:11px;opacity:0.7">Delete Collocation</button>
        </div>`;
    openModal('modal-collocation-detail');
}

function saveCollocationField(collocId, field, value) {
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc || colloc[field] === value) return;
    colloc[field] = value;
    persistCollocationUpdate(collocId, { [field]: value });
}

function advanceCollocationStatus(collocId) {
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc) return;
    const idx = COLLOC_STATUSES.indexOf(colloc.status);
    if (idx >= COLLOC_STATUSES.length - 1) return;
    const oldStatus = colloc.status;
    const newStatus = COLLOC_STATUSES[idx + 1];
    colloc.status = newStatus;
    persistCollocationUpdate(collocId, { status: newStatus });

    // Update sensor statuses
    if (newStatus === 'Finished, Analysis Pending' || newStatus === 'Complete') {
        colloc.sensorIds.forEach(sId => {
            const s = sensors.find(x => x.id === sId);
            if (s) {
                const statuses = getStatusArray(s).filter(st => st !== 'Collocation');
                s.status = statuses.length > 0 ? statuses : ['Online'];
                persistSensor(s);
            }
        });
        buildSensorSidebar();
    }

    createNote('Collocation', `Collocation at ${getCommunityName(colloc.locationId)} advanced: "${oldStatus}" → "${newStatus}".`, {
        sensors: colloc.sensorIds,
        communities: [colloc.locationId],
    });

    openCollocationDetail(collocId);
    updateSidebarCollocationCount();
    if (document.getElementById('view-collocations')?.classList.contains('active')) renderCollocationsView();
}

function revertCollocationStatus(collocId) {
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc) return;
    const idx = COLLOC_STATUSES.indexOf(colloc.status);
    if (idx <= 0) return;
    const oldStatus = colloc.status;
    const newStatus = COLLOC_STATUSES[idx - 1];
    colloc.status = newStatus;
    persistCollocationUpdate(collocId, { status: newStatus });

    // Re-add Collocation status if reverting back to In Progress
    if (newStatus === 'In Progress') {
        colloc.sensorIds.forEach(sId => {
            const s = sensors.find(x => x.id === sId);
            if (s) {
                const statuses = getStatusArray(s);
                if (!statuses.includes('Collocation')) {
                    s.status = [...statuses, 'Collocation'];
                    persistSensor(s);
                }
            }
        });
        buildSensorSidebar();
    }

    createNote('Collocation', `Collocation at ${getCommunityName(colloc.locationId)} reverted: "${oldStatus}" → "${newStatus}".`, {
        sensors: colloc.sensorIds,
        communities: [colloc.locationId],
    });

    openCollocationDetail(collocId);
    updateSidebarCollocationCount();
    if (document.getElementById('view-collocations')?.classList.contains('active')) renderCollocationsView();
}

async function deleteCollocation(collocId) {
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc) return;
    const communityName = getCommunityName(colloc.locationId);

    showConfirm('Delete Collocation', `Delete this collocation at ${communityName} permanently?<br><br>This will delete all collocation data, analysis results, and associated notes. This cannot be undone.`, async () => {
        const idx = collocations.indexOf(colloc);
        if (idx >= 0) collocations.splice(idx, 1);

        // Delete auto-generated collocation notes
        await deleteAutoNotes('Collocation', colloc.sensorIds);

        // Remove Collocation status from sensors
        colloc.sensorIds.forEach(sId => {
            const s = sensors.find(x => x.id === sId);
            if (s) {
                const statuses = getStatusArray(s).filter(st => st !== 'Collocation');
                s.status = statuses.length > 0 ? statuses : ['Online'];
                persistSensor(s);
            }
        });

        try { await db.deleteCollocation(collocId); } catch (err) { console.error('Delete collocation error:', err); }

        closeModal('modal-collocation-detail');
        buildSensorSidebar();
        updateSidebarCollocationCount();
        if (document.getElementById('view-collocations')?.classList.contains('active')) renderCollocationsView();
        refreshCurrentView();
    }, { danger: true });
}

function renderSensorCollocations(sensorId) {
    const section = document.getElementById('sensor-collocations-section');
    if (!section) return;

    let html = '';

    // Collocation records from the collocations table — clickable cards
    const sensorCollocs = collocations.filter(c => c.sensorIds.includes(sensorId))
        .sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
    html += sensorCollocs.map(c => {
        const communityName = COMMUNITIES.find(x => x.id === c.locationId)?.name || c.locationId;
        const dateRange = c.startDate ? `${formatDate(c.startDate)}${c.endDate && c.endDate !== 'TBD' ? ' – ' + formatDate(c.endDate) : ''}` : '—';
        const hasResults = Object.keys(c.analysisResults || {}).length > 0;
        return `<div class="audit-list-card" onclick="openCollocationDetail('${c.id}')" style="cursor:pointer">
            <div class="audit-list-card-header">
                <span style="font-weight:600;color:var(--slate-700)">${escapeHtml(communityName)}</span>
                <span class="audit-status-badge ${COLLOC_STATUS_CSS[c.status]}">${c.status}</span>
            </div>
            <div class="audit-list-card-meta">${dateRange}</div>
            <div style="font-size:12px;color:var(--slate-500);margin-top:4px">Sensors: ${c.sensorIds.map(id => shortSensorId(id)).join(', ')}</div>
            ${hasResults ? `<div style="font-size:11px;color:var(--green);margin-top:4px">Analysis complete · <a onclick="event.stopPropagation(); beginCollocationAnalysis('${c.id}')">View Analysis &rarr;</a></div>` : ''}
        </div>`;
    }).join('');

    // Initial collocation from Salesforce data (rendered directly, no DB dependency)
    const initialColloc = INITIAL_COLLOCATION_DATA[sensorId];
    if (initialColloc) {
        if (sensorCollocs.length > 0) html += '<div style="border-top:1px solid var(--slate-100);margin-top:12px;padding-top:12px"><div style="font-size:11px;font-weight:600;color:var(--slate-400);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Historical Collocations</div></div>';
        html += `<div class="audit-list-card" style="cursor:default;opacity:0.8">
            <div class="audit-list-card-header">
                <span style="font-weight:600;color:var(--slate-700)">Initial Collocation</span>
            </div>
            <div style="font-size:13px;color:var(--slate-600);margin-top:4px">${escapeHtml(initialColloc)}</div>
            <div class="audit-list-card-meta">${formatDate(_parseCollocStartDate(initialColloc))} — Logged by System (Salesforce Import)</div>
        </div>`;
    }

    if (!html) {
        section.innerHTML = '<div class="empty-state">No collocations involving this sensor.</div>';
        return;
    }
    section.innerHTML = html;
}

// ===== COLLOCATION ANALYSIS ENGINE =====
let collocAnalysisCache = {};

// AUDIT_PARAMETERS removed — use AUDIT_PARAMETERS instead

function reuploadCollocationData(collocId) {
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc) return;
    // Clear cache and results so beginCollocationAnalysis shows upload form
    delete collocAnalysisCache[collocId];
    colloc.analysisResults = {};
    colloc.analysisChartData = null;
    colloc.analysisName = '';
    colloc.analysisUploadDate = null;
    colloc.analysisUploadedBy = '';
    beginCollocationAnalysis(collocId);
}

function beginCollocationAnalysis(collocId) {
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc) return;
    purgeAnalysisPlots();
    const communityName = getCommunityName(colloc.locationId);
    const hasResults = Object.keys(colloc.analysisResults || {}).length > 0;

    // Close the collocation detail modal first so the analysis modal is visible
    closeModal('modal-collocation-detail');

    if (hasResults && collocAnalysisCache[collocId]) {
        document.getElementById('analysis-modal-title').textContent = colloc.analysisName || `Collocation Analysis: ${communityName}`;
        openModal('modal-audit-analysis');
        setTimeout(() => renderCollocationAnalysisResults(collocId, collocAnalysisCache[collocId]), 50);
        return;
    }

    if (hasResults && colloc.analysisChartData) {
        collocAnalysisCache[collocId] = rebuildCollocCacheFromSaved(colloc);
        if (collocAnalysisCache[collocId]) {
            document.getElementById('analysis-modal-title').textContent = colloc.analysisName || `Collocation Analysis: ${communityName}`;
            openModal('modal-audit-analysis');
            setTimeout(() => renderCollocationAnalysisResults(collocId, collocAnalysisCache[collocId]), 50);
            return;
        }
    }

    if (hasResults) {
        document.getElementById('analysis-modal-title').textContent = colloc.analysisName || `Collocation Analysis: ${communityName}`;
        openModal('modal-audit-analysis');
        setTimeout(() => renderCollocationSavedView(collocId), 50);
        return;
    }

    // Upload flow
    const sensorShorts = colloc.sensorIds.map(id => shortSensorId(id)).join(', ');
    const defaultName = `Collocation at ${communityName}: ${sensorShorts}, ${colloc.startDate || ''} to ${colloc.endDate || ''}`;
    document.getElementById('analysis-modal-title').textContent = 'New Collocation Analysis';

    // Build permanent pod dropdown from sensors with type "Permanent Pod"
    const permaPods = sensors.filter(s => s.type === 'Permanent Pod').sort((a, b) => a.id.localeCompare(b.id));
    const permaOptions = permaPods.map(s => `<option value="${s.id}">${s.id} (${getCommunityName(s.community)})</option>`).join('');

    // Body was already cleared by purgeAnalysisPlots; use requestAnimationFrame
    // to let the browser fully flush the empty state before injecting new content
    const body = document.getElementById('audit-analysis-body');
    requestAnimationFrame(() => {
        body.innerHTML = `
            <div class="analysis-instructions">
                <strong>Data Preparation Instructions:</strong>
                <ol>
                    <li>Export hourly data from AirVision for the BAM, permanent pod, and all community pods</li>
                    <li>When selecting regulatory site data, use <strong>PM2.5 and PM10 local conditions</strong></li>
                    <li>Clean up: remove any invalidated data</li>
                    <li>Trim to the collocation period dates</li>
                    <li><strong>Do not remove the first 24 hours</strong> — the app will automatically exclude them from regression</li>
                </ol>
            </div>
            <label style="font-size:12px;font-weight:600;color:var(--slate-500);text-transform:uppercase;letter-spacing:0.5px">Analysis Name</label>
            <input type="text" class="analysis-name-input" id="colloc-analysis-name" value="${escapeHtml(defaultName)}">
            <div style="display:flex;gap:12px;margin-top:12px">
                <div style="flex:1">
                    <label style="font-size:12px;font-weight:600;color:var(--slate-500);text-transform:uppercase;letter-spacing:0.5px">Regulatory Data Source</label>
                    <select id="colloc-bam-source" style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid var(--slate-200);font-size:14px;font-family:var(--font-sans)">
                        <option value="Garden">Garden BAM</option>
                        <option value="NCore">NCore BAM</option>
                        <option value="Floyd Dryden">Floyd Dryden BAM</option>
                    </select>
                </div>
                <div style="flex:1">
                    <label style="font-size:12px;font-weight:600;color:var(--slate-500);text-transform:uppercase;letter-spacing:0.5px">Permanent Pod</label>
                    <select id="colloc-perma-pod" style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid var(--slate-200);font-size:14px;font-family:var(--font-sans)">
                        <option value="">— None —</option>
                        ${permaOptions}
                    </select>
                </div>
            </div>
            <div class="analysis-upload-zone" id="analysis-drop-zone" onclick="this.querySelector('input[type=file]').click()" style="margin-top:16px">
                <div class="analysis-upload-icon">&#128196;</div>
                <div class="analysis-upload-text">Click to upload Excel file (.xls or .xlsx)</div>
                <div class="analysis-upload-hint">Hourly data with BAM, permanent pod, and community pod columns</div>
                <input type="file" accept=".xls,.xlsx" onchange="handleCollocationUpload('${collocId}', this.files[0])">
            </div>
        `;
    });
    openModal('modal-audit-analysis');
}

function handleCollocationUpload(collocId, file) {
    if (!file) return;
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc) return;

    const analysisName = document.getElementById('colloc-analysis-name')?.value || '';
    const bamSource = document.getElementById('colloc-bam-source')?.value || 'Garden';
    const permaPodId = document.getElementById('colloc-perma-pod')?.value || '';

    const body = document.getElementById('audit-analysis-body');
    body.innerHTML = '<div class="analysis-processing">Processing data... parsing Excel file and running regression analysis.</div>';

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const sheetName = wb.SheetNames.find(n => /hour|data|sheet1/i.test(n)) || wb.SheetNames[0];
            const sheet = wb.Sheets[sheetName];
            const jsonRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            const parsed = parseCollocationData(jsonRows, colloc, bamSource, permaPodId);
            if (!parsed) {
                body.innerHTML = '<div class="analysis-processing" style="color:var(--aurora-rose)">Could not parse the uploaded file. Make sure it contains hourly data with BAM and pod columns.</div>';
                return;
            }

            finalizeCollocationAnalysis(collocId, colloc, parsed, analysisName, bamSource, permaPodId, body);
        } catch (err) {
            console.error('Collocation analysis error:', err);
            body.innerHTML = `<div class="analysis-processing" style="color:var(--aurora-rose)">Error processing file: ${escapeHtml(err.message)}</div>`;
        }
    };
    reader.readAsArrayBuffer(file);
}

function parseCollocationData(rows, colloc, bamSource, permaPodId) {
    if (!rows || rows.length < 10) return null;

    // Find header row
    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
        const rowStr = rows[i].join(' ').toUpperCase();
        if ((rowStr.includes('PM25') || rowStr.includes('PM10') || rowStr.includes('CO_PPB')) && (rowStr.includes('MOD') || rowStr.includes('GARDEN') || rowStr.includes('NCORE') || rowStr.includes('FLOYD'))) {
            headerRowIdx = i;
            break;
        }
    }
    const headers = rows[headerRowIdx].map(h => String(h).trim());

    // Identify BAM columns
    const bamLabel = bamSource + ' BAM';
    const bamCols = {};
    headers.forEach((h, idx) => {
        const hUpper = h.toUpperCase();
        // Match "Garden PM10L", "Garden PM25L", "NCore PM10L", etc.
        if (hUpper.includes(bamSource.toUpperCase().replace(' ', '')) || hUpper.includes(bamSource.toUpperCase())) {
            if (/PM10/i.test(h)) bamCols.pm10 = idx;
            else if (/PM25|PM2[\._]?5/i.test(h)) bamCols.pm25 = idx;
        }
    });

    // Identify pod columns — group by sensor ID
    const sensorPattern = /(?:Quant_)?(MOD[-_]?\d{3,6}[-_]?(?:PM[-_]?\d+)?)/i;
    const podMap = {}; // normalized sensor ID -> { pm25: colIdx, pm10: colIdx, co: colIdx, ... }
    headers.forEach((h, idx) => {
        const m = h.match(sensorPattern);
        if (!m) return;
        // Normalize: MOD00445 -> MOD-00445
        let rawId = m[1].replace(/[-_]/g, '');
        // Convert to standard format
        if (rawId.match(/^MOD\d{5}$/i)) {
            rawId = 'MOD-' + rawId.substring(3);
        } else if (rawId.match(/^MOD\d{3,4}$/i)) {
            rawId = 'MOD-00' + rawId.substring(3);
        } else if (rawId.match(/^MODXPM\d+$/i)) {
            const num = rawId.replace(/^MODXPM/i, '');
            rawId = 'MOD-X-PM-' + num.padStart(5, '0');
        } else {
            // Try to find matching sensor
            const found = sensors.find(s => s.id.replace(/[-_]/g, '').toUpperCase() === rawId.toUpperCase());
            if (found) rawId = found.id;
        }

        if (!podMap[rawId]) podMap[rawId] = {};
        // Match parameter from column name
        const hUpper = h.toUpperCase();
        // Skip CO_PPM (only want CO_PPB), skip PM1, skip RH, skip TEMP
        if (hUpper.includes('CO_PPM') || /\bPM1[\b_ ]/.test(hUpper) || /\bPM1$/.test(hUpper) ||
            /AMBTEMP|_TEMP_|_TEMP\b|TEMP_C|TEMP_F/.test(hUpper) ||
            /RELHUMID|\bRH[_%\s]|\bRH$/.test(hUpper)) return;

        for (const [paramKey, patterns] of Object.entries(PARAM_COLUMN_MAP)) {
            for (const pat of patterns) {
                if (pat.test(h)) { podMap[rawId][paramKey] = idx; break; }
            }
        }
    });

    // Separate permanent pod from community pods
    // Only include pods that are in the collocation's sensor list (if available)
    const permaPod = permaPodId ? podMap[permaPodId] || null : null;
    const permaPodLabel = permaPodId || '';
    const collocSensorIds = (colloc.sensorIds || []).map(id => id.replace(/[-_]/g, '').toUpperCase());
    const communityPods = {};
    for (const [id, cols] of Object.entries(podMap)) {
        if (id === permaPodId) continue;
        // If collocation has sensor IDs defined, only include matching pods
        if (collocSensorIds.length > 0) {
            const idNorm = id.replace(/[-_]/g, '').toUpperCase();
            const isInColloc = collocSensorIds.some(sid => sid === idNorm || sid.includes(idNorm.replace('MOD', '')) || idNorm.includes(sid.replace('MOD', '')));
            if (!isInColloc) continue;
        }
        communityPods[id] = cols;
    }

    // Skip sub-header rows
    let dataStart = headerRowIdx + 1;
    for (let i = dataStart; i < Math.min(dataStart + 3, rows.length); i++) {
        const firstVal = String(rows[i][0] || '').toLowerCase();
        if (firstVal.includes('final') || firstVal.includes('value') || firstVal.includes('unit') || firstVal === 'date' || firstVal === '') {
            dataStart = i + 1;
        } else break;
    }

    // Parse data rows
    const allRows = [];
    for (let i = dataStart; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 2) continue;
        const tsRaw = row[0];
        if (tsRaw === '' || tsRaw === null || tsRaw === undefined) continue;

        let ts;
        const numVal = Number(tsRaw);
        if (!isNaN(numVal) && numVal > 40000 && numVal < 60000) {
            ts = new Date((numVal - 25569) * 86400 * 1000);
        } else {
            ts = new Date(tsRaw);
        }
        if (isNaN(ts.getTime())) continue;

        const entry = { timestamp: ts, bam: {}, perma: {}, pods: {} };

        // BAM values (PM only)
        for (const key of ['pm25', 'pm10']) {
            entry.bam[key] = bamCols[key] !== undefined ? parseFloat(row[bamCols[key]]) : NaN;
        }

        // Permanent pod values
        if (permaPod) {
            for (const key of Object.keys(PARAM_COLUMN_MAP)) {
                entry.perma[key] = permaPod[key] !== undefined ? parseFloat(row[permaPod[key]]) : NaN;
            }
        }

        // Community pod values
        for (const [podId, cols] of Object.entries(communityPods)) {
            entry.pods[podId] = {};
            for (const key of Object.keys(PARAM_COLUMN_MAP)) {
                entry.pods[podId][key] = cols[key] !== undefined ? parseFloat(row[cols[key]]) : NaN;
            }
        }

        allRows.push(entry);
    }

    if (allRows.length < 5) return null;

    // Invalidate PM10 > 1000
    for (const row of allRows) {
        if (row.bam.pm10 > 1000) row.bam.pm10 = NaN;
        if (row.perma.pm10 > 1000) row.perma.pm10 = NaN;
        for (const podId of Object.keys(row.pods)) {
            if (row.pods[podId].pm10 > 1000) row.pods[podId].pm10 = NaN;
        }
    }

    allRows.sort((a, b) => a.timestamp - b.timestamp);

    // 24-hour trim
    const firstTs = allRows[0].timestamp.getTime();
    const trimCutoff = firstTs + 24 * 60 * 60 * 1000;
    const trimIndex = allRows.findIndex(r => r.timestamp.getTime() >= trimCutoff);

    // Determine which pods are X-PM (PM only, no gas)
    const podIds = Object.keys(communityPods);
    const isPmOnly = {};
    podIds.forEach(id => {
        isPmOnly[id] = /X[-_]?PM/i.test(id) || /MOD[-_]?X[-_]?PM/i.test(id);
    });

    return {
        bamSource, bamLabel, permaPodId: permaPodLabel, permaPod: !!permaPod,
        podIds, isPmOnly, allRows,
        trimIndex: trimIndex >= 0 ? trimIndex : 0,
        trimmedRows: trimIndex >= 0 ? allRows.slice(trimIndex) : allRows,
    };
}

function runCollocationAnalysis(parsed) {
    const results = { bamVsPods: {}, bamVsPerma: {}, permaVsPods: {}, interPod: {} };
    const trimmed = parsed.trimmedRows;

    // BAM vs each pod (PM only)
    for (const podId of parsed.podIds) {
        results.bamVsPods[podId] = {};
        for (const key of ['pm25', 'pm10']) {
            const x = trimmed.map(r => Number(r.bam?.[key] ?? NaN));
            const y = trimmed.map(r => Number(r.pods?.[podId]?.[key] ?? NaN));
            const reg = runLinearRegression(x, y);
            if (reg) {
                const dqo = checkDQO(reg);
                results.bamVsPods[podId][key] = { ...reg, dqo, pass: dqo.pass };
            }
        }
    }

    // BAM vs permanent pod (PM only)
    if (parsed.permaPod) {
        results.bamVsPerma = {};
        for (const key of ['pm25', 'pm10']) {
            const x = trimmed.map(r => Number(r.bam?.[key] ?? NaN));
            const y = trimmed.map(r => Number(r.perma?.[key] ?? NaN));
            const reg = runLinearRegression(x, y);
            if (reg) {
                const dqo = checkDQO(reg);
                results.bamVsPerma[key] = { ...reg, dqo, pass: dqo.pass };
            }
        }
    }

    // Permanent pod vs each pod (all params for regular pods, PM only for X-PM)
    if (parsed.permaPod) {
        for (const podId of parsed.podIds) {
            results.permaVsPods[podId] = {};
            const params = parsed.isPmOnly[podId] ? ['pm25', 'pm10'] : AUDIT_PARAMETERS.map(p => p.key);
            for (const key of params) {
                const x = trimmed.map(r => Number(r.perma?.[key] ?? NaN));
                const y = trimmed.map(r => Number(r.pods?.[podId]?.[key] ?? NaN));
                const reg = runLinearRegression(x, y);
                if (reg) {
                    const dqo = checkDQO(reg);
                    results.permaVsPods[podId][key] = { ...reg, dqo, pass: dqo.pass };
                }
            }
        }
    }

    return results;
}

function finalizeCollocationAnalysis(collocId, colloc, parsed, analysisName, bamSource, permaPodId, body) {
    body.innerHTML = '<div class="analysis-processing">Running regression analysis...</div>';

    const results = runCollocationAnalysis(parsed);

    // Flatten results for storage — store per-pod results keyed by comparison type
    colloc.analysisResults = {};
    for (const podId of parsed.podIds) {
        const podResults = {};
        // BAM comparisons (PM)
        for (const key of ['pm25', 'pm10']) {
            if (results.bamVsPods[podId]?.[key]) {
                podResults[`bam_${key}`] = results.bamVsPods[podId][key];
            }
        }
        // Perma pod comparisons
        if (results.permaVsPods[podId]) {
            for (const [key, val] of Object.entries(results.permaVsPods[podId])) {
                podResults[`perma_${key}`] = val;
            }
        }
        colloc.analysisResults[podId] = podResults;
    }
    // BAM vs perma pod
    if (results.bamVsPerma) {
        colloc.analysisResults['_bamVsPerma'] = results.bamVsPerma;
    }

    colloc.analysisName = analysisName;
    colloc.analysisUploadDate = new Date().toISOString();
    colloc.analysisUploadedBy = getCurrentUserName();
    colloc.bamSource = bamSource;
    colloc.permanentPodId = permaPodId;

    // Save compact chart data
    colloc.analysisChartData = {
        bamSource, permaPodId, podIds: parsed.podIds, isPmOnly: parsed.isPmOnly,
        trimIndex: parsed.trimIndex,
        rows: parsed.allRows.map(r => ({
            t: r.timestamp.getTime(),
            bam: r.bam, perma: r.perma, pods: r.pods,
        })),
    };

    persistCollocationUpdate(collocId, {
        analysisResults: colloc.analysisResults,
        analysisName: colloc.analysisName,
        analysisUploadDate: colloc.analysisUploadDate,
        analysisUploadedBy: colloc.analysisUploadedBy,
        analysisChartData: colloc.analysisChartData,
        bamSource: colloc.bamSource,
        permanentPodId: colloc.permanentPodId,
    });

    parsed.regressionResults = results;
    collocAnalysisCache[collocId] = parsed;

    // Run failsafe validation checks
    const validationWarnings = runFailsafeValidation(parsed, results, 'collocation');
    collocAnalysisCache[collocId].validationWarnings = validationWarnings;

    // Auto-advance status and remove Collocation tag from sensors
    if (colloc.status === 'Finished, Analysis Pending') {
        colloc.status = 'Complete';
        persistCollocationUpdate(collocId, { status: 'Complete' });
        colloc.sensorIds.forEach(sId => {
            const s = sensors.find(x => x.id === sId);
            if (s) {
                const statuses = getStatusArray(s).filter(st => st !== 'Collocation');
                s.status = statuses.length > 0 ? statuses : ['Online'];
                persistSensor(s);
            }
        });
        buildSensorSidebar();
        updateSidebarCollocationCount();
    }

    renderCollocationAnalysisResults(collocId, parsed);
}

function rebuildCollocCacheFromSaved(colloc) {
    const cd = colloc.analysisChartData;
    if (!cd || !cd.rows?.length) return null;

    const allRows = cd.rows.map(r => {
        // Ensure all nested objects exist and numeric values are proper numbers
        const bam = r.bam || {};
        const perma = r.perma || {};
        const pods = {};
        for (const [id, vals] of Object.entries(r.pods || {})) {
            pods[id] = {};
            for (const [k, v] of Object.entries(vals || {})) {
                pods[id][k] = (v === null || v === undefined || v === '') ? NaN : Number(v);
            }
        }
        return {
            timestamp: new Date(r.t),
            bam: { pm25: bam.pm25 != null ? Number(bam.pm25) : NaN, pm10: bam.pm10 != null ? Number(bam.pm10) : NaN },
            perma: Object.fromEntries(Object.entries(perma).map(([k, v]) => [k, v != null ? Number(v) : NaN])),
            pods,
        };
    });

    const trimIndex = cd.trimIndex || 0;
    const parsed = {
        bamSource: cd.bamSource, bamLabel: (cd.bamSource || 'BAM') + ' BAM',
        permaPodId: cd.permaPodId || '', permaPod: !!cd.permaPodId,
        podIds: cd.podIds || [], isPmOnly: cd.isPmOnly || {},
        allRows, trimIndex,
        trimmedRows: allRows.slice(trimIndex),
    };
    parsed.regressionResults = runCollocationAnalysis(parsed);
    return parsed;
}

// Store current collocation analysis context for lazy rendering
let _collocRenderCtx = null;

function renderCollocationAnalysisResults(collocId, parsed) {
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc) return;

    try {
        const results = parsed.regressionResults || {};
        const communityName = getCommunityName(colloc.locationId);

        analysisChartInstances.forEach(c => { try { c.destroy(); } catch(e) {} });
        analysisChartInstances = [];

        const trimCount = parsed.trimIndex;
        const totalCount = parsed.allRows.length;
        const analysisCount = parsed.trimmedRows.length;
        const bamLabel = parsed.bamLabel;
        const permaShort = parsed.permaPodId ? shortSensorId(parsed.permaPodId) : '';
        const titleParts = [bamLabel];
        if (permaShort) titleParts.push(permaShort + ' (Permanent Pod)');
        titleParts.push(...parsed.podIds.map(id => shortSensorId(id)));

        // Store context for lazy rendering
        _collocRenderCtx = { collocId, parsed, results, colloc };

        // Build failsafe validation report (from cache or compute fresh)
        let collocValidationWarnings = collocAnalysisCache[collocId]?.validationWarnings;
        if (!collocValidationWarnings) {
            collocValidationWarnings = runFailsafeValidation(parsed, results, 'collocation');
            if (collocAnalysisCache[collocId]) collocAnalysisCache[collocId].validationWarnings = collocValidationWarnings;
        }
        const collocValidationHtml = renderValidationReport(collocValidationWarnings);

        const body = document.getElementById('audit-analysis-body');
        body.innerHTML = `
            <div class="colloc-report-view">
                <div class="colloc-title-block">
                    <div class="colloc-title-label">${escapeHtml(communityName)} Collocation Analysis</div>
                    <div class="colloc-title-main">${titleParts.map(t => escapeHtml(t)).join(' &bull; ')}</div>
                    <div class="colloc-title-dates">${colloc.startDate ? formatDate(colloc.startDate) : ''} &ndash; ${colloc.endDate && colloc.endDate !== 'TBD' ? formatDate(colloc.endDate) : 'TBD'}</div>
                    <div style="font-size:12px;color:#888;margin-top:4px">First 24 hours excluded (${trimCount} of ${totalCount} hourly rows trimmed) &mdash; analysis on ${analysisCount} rows</div>
                </div>

                ${collocValidationHtml}

                <div class="colloc-section-header"><h2>Time Series Collocation Results</h2></div>
                <div id="colloc-ts-tabset"></div>

                <div class="colloc-section-header"><h2>Multi-Sensor Regression Analysis</h2></div>
                <div id="colloc-reg-tabset"></div>

                <div style="margin-top:24px;display:flex;justify-content:space-between;align-items:center">
                    <button class="btn btn-primary" onclick="generateCollocationReport('${collocId}')">Save as HTML</button>
                    <button class="btn" onclick="reuploadCollocationData('${collocId}')">Re-upload Data</button>
                </div>
            </div>
        `;

        // Build tab HTML first (no charts yet), then render visible charts
        _buildCollocTSTabs(parsed, colloc);
        _buildCollocRegTabs(parsed, results);

        // Render charts after modal is fully visible and DOM settled
        setTimeout(() => {
            try {
                // Render first TS chart
                _renderCollocTSChart(parsed, AUDIT_PARAMETERS[0].key);
                // Render first regression tab
                _renderFirstVisibleRegTab(parsed, results);
            } catch (err) { console.error('Chart render error:', err, err.stack); }
        }, 500);

    } catch (err) {
        console.error('Analysis render error:', err);
        document.getElementById('audit-analysis-body').innerHTML = `<div style="padding:20px;color:#c53030">Error rendering analysis: ${escapeHtml(err.message)}<br><br><button class="btn" onclick="reuploadCollocationData('${collocId}')">Re-upload Data</button></div>`;
    }
}

// ===== COLLOCATION PLOTLY RENDERING =====
const COLLOC_COLORS = { BAM: '#e53e3e', PERMA: '#2563eb' };
const COLLOC_POD_COLORS = ['#d97706', '#15803d', '#7c3aed', '#0891b2', '#be185d', '#4338ca', '#b45309', '#059669'];

function _collocNiceDtick(lo, hi) {
    const range = hi - lo;
    if (range <= 0) return 1;
    const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    for (const c of candidates) { if (range / c <= 8) return c; }
    return Math.pow(10, Math.floor(Math.log10(range)));
}

function _collocPodColor(idx) { return COLLOC_POD_COLORS[idx % COLLOC_POD_COLORS.length]; }

function _getCollocDates(parsed) {
    return parsed.allRows.map(r => {
        const p = new Intl.DateTimeFormat('en-US', { timeZone: AK_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(r.timestamp);
        const get = type => (p.find(x => x.type === type) || {}).value || '00';
        return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
    });
}

function _buildCollocTSTabs(parsed, colloc) {
    const container = document.getElementById('colloc-ts-tabset');
    const hasGas = parsed.podIds.some(id => !parsed.isPmOnly[id]);
    const params = hasGas ? AUDIT_PARAMETERS : AUDIT_PARAMETERS.filter(p => p.key === 'pm25' || p.key === 'pm10');

    let tabsHtml = '<ul class="colloc-nav-tabs">';
    let panelsHtml = '';

    params.forEach((p, i) => {
        const active = i === 0 ? ' active' : '';
        tabsHtml += `<li><button class="colloc-nav-link${active}" onclick="_switchCollocTabLazy('colloc-ts', '${p.key}', this, 'ts')">${p.labelHtml}</button></li>`;
        panelsHtml += `<div id="colloc-ts-tab-${p.key}" class="colloc-tab-pane${active}">
            <div class="colloc-plot-title"><h3>${p.labelHtml} Hourly Collocation Results</h3></div>
            <div class="colloc-plot-subtitle">Collocation Dates: ${colloc.startDate ? formatDate(colloc.startDate) : ''} &ndash; ${colloc.endDate && colloc.endDate !== 'TBD' ? formatDate(colloc.endDate) : 'TBD'}</div>
            <div id="colloc-ts-plot-${p.key}" style="width:100%;height:420px"></div>
        </div>`;
    });
    tabsHtml += '</ul>';
    container.innerHTML = tabsHtml + '<div class="colloc-tab-content">' + panelsHtml + '</div>';
}

function _renderCollocTSChart(parsed, paramKey) {
    const plotId = `colloc-ts-plot-${paramKey}`;
    const el = document.getElementById(plotId);
    if (!el) return;

    const hasBam = parsed.allRows.some(r => !isNaN(Number(r.bam?.pm25)) || !isNaN(Number(r.bam?.pm10)));
    const paramLabels = { pm25: 'PM₂.₅ (µg/m³)', pm10: 'PM₁₀ (µg/m³)', co: 'CO (ppb)', no: 'NO (ppb)', no2: 'NO₂ (ppb)', o3: 'O₃ (ppb)' };
    const dates = _getCollocDates(parsed);
    const traces = [];

    if (hasBam && (paramKey === 'pm25' || paramKey === 'pm10')) {
        traces.push({ x: dates, y: parsed.allRows.map(r => { const v = Number(r.bam?.[paramKey]); return isNaN(v) ? null : v; }), name: parsed.bamLabel, type: 'scatter', mode: 'lines', line: { color: COLLOC_COLORS.BAM, width: 2.5 }, connectgaps: false });
    }
    if (parsed.permaPod) {
        const vals = parsed.allRows.map(r => { const v = Number(r.perma?.[paramKey]); return isNaN(v) ? null : v; });
        if (vals.some(v => v !== null)) traces.push({ x: dates, y: vals, name: shortSensorId(parsed.permaPodId) + ' (Perma)', type: 'scatter', mode: 'lines', line: { color: COLLOC_COLORS.PERMA, width: 2 }, connectgaps: false });
    }
    parsed.podIds.forEach((podId, idx) => {
        if (parsed.isPmOnly[podId] && paramKey !== 'pm25' && paramKey !== 'pm10') return;
        const vals = parsed.allRows.map(r => { const v = Number(r.pods?.[podId]?.[paramKey]); return isNaN(v) ? null : v; });
        if (!vals.some(v => v !== null)) return;
        traces.push({ x: dates, y: vals, name: shortSensorId(podId), type: 'scatter', mode: 'lines', line: { color: _collocPodColor(idx), width: 1.5 }, connectgaps: false });
    });

    const allY = traces.flatMap(t => t.y.filter(v => v !== null));
    const yMin = allY.length > 0 ? allY.reduce((a, b) => Math.min(a, b), Infinity) : 0;
    const yMax = allY.length > 0 ? allY.reduce((a, b) => Math.max(a, b), -Infinity) : 1;
    const dt = _collocNiceDtick(yMin, yMax);

    try {
        Plotly.newPlot(plotId, traces, {
            margin: { t: 8, b: 45, l: 80, r: 15 },
            xaxis: { title: 'Date', type: 'date', gridcolor: '#ddd' },
            yaxis: { title: { text: paramLabels[paramKey], standoff: 10 }, gridcolor: '#ddd', range: [Math.floor(yMin / dt) * dt, Math.ceil(yMax / dt) * dt], dtick: dt, tickfont: { size: 11 } },
            legend: { orientation: 'h', y: 1.12, x: 0.5, xanchor: 'center', font: { size: 12 } },
            plot_bgcolor: '#fff', paper_bgcolor: 'rgba(0,0,0,0)',
            font: { family: 'Segoe UI, system-ui, sans-serif', size: 12 },
            hovermode: 'x unified',
        }, { responsive: true, displayModeBar: false });
    } catch (err) { console.error('TS chart error for', paramKey, err); }
}

function _switchCollocTabLazy(group, name, btn, chartType) {
    const tabset = btn.closest('#' + group + '-tabset') || btn.closest('[id$="-tabset"]');
    if (!tabset) return;
    tabset.querySelectorAll('.colloc-tab-pane').forEach(el => el.classList.remove('active'));
    tabset.querySelectorAll('.colloc-nav-link').forEach(el => el.classList.remove('active'));
    const pane = tabset.querySelector('#' + group + '-tab-' + name);
    if (pane) pane.classList.add('active');
    btn.classList.add('active');

    // Lazy render chart after tab is visible
    if (!_collocRenderCtx) return;
    const { parsed, results, colloc } = _collocRenderCtx;
    setTimeout(() => {
        try {
            if (chartType === 'ts') {
                _renderCollocTSChart(parsed, name);
            } else if (chartType === 'reg') {
                _renderCollocRegChart(parsed, results, name);
            }
            window.dispatchEvent(new Event('resize'));
        } catch (err) { console.error('Lazy chart render error:', err); }
    }, 50);
}

function _renderFirstVisibleRegTab(parsed, results) {
    const hasBam = Object.keys(results.bamVsPods || {}).length > 0;
    const firstTab = hasBam ? 'bam' : 'quants-pm';
    _renderCollocRegChart(parsed, results, firstTab);
}

function _buildCollocRegTabs(parsed, results) {
    const container = document.getElementById('colloc-reg-tabset');
    const hasBam = Object.keys(results.bamVsPods || {}).length > 0;
    const hasPerma = Object.keys(results.permaVsPods || {}).length > 0;
    const hasGas = parsed.podIds.some(id => !parsed.isPmOnly[id]);
    const trimmed = parsed.trimmedRows;

    let tabsHtml = '<ul class="colloc-nav-tabs">';
    let panelsHtml = '';
    let tabIdx = 0;

    // Tab: Pods vs BAM
    if (hasBam) {
        const active = tabIdx === 0 ? ' active' : '';
        tabsHtml += `<li><button class="colloc-nav-link${active}" onclick="_switchCollocTabLazy('colloc-reg', 'bam', this, 'reg')">Pods vs ${parsed.bamLabel}</button></li>`;
        panelsHtml += `<div id="colloc-reg-tab-bam" class="colloc-tab-pane${active}">`;
        for (const key of ['pm25', 'pm10']) {
            const p = AUDIT_PARAMETERS.find(x => x.key === key);
            panelsHtml += `<div class="colloc-reg-param-title">${p.labelHtml} &mdash; All Sensors vs ${parsed.bamLabel}</div>`;
            panelsHtml += `<div id="colloc-reg-bam-${key}" style="width:100%;height:360px"></div>`;
        }
        panelsHtml += '</div>';
        tabIdx++;
    }

    // Tab: Quants PM — pods vs permanent pod for PM (or inter-pod if no perma)
    const podShortList = parsed.podIds.map(id => shortSensorId(id)).join(', ');
    const permaShort = parsed.permaPodId ? shortSensorId(parsed.permaPodId) : '';
    if (hasPerma) {
        tabsHtml += `<li><button class="colloc-nav-link" onclick="_switchCollocTabLazy('colloc-reg', 'quants-pm', this, 'reg')">Quants PM</button></li>`;
        panelsHtml += `<div id="colloc-reg-tab-quants-pm" class="colloc-tab-pane">`;
        for (const key of ['pm25', 'pm10']) {
            const p = AUDIT_PARAMETERS.find(x => x.key === key);
            panelsHtml += `<div class="colloc-reg-param-title">${p.labelHtml} &mdash; Pods ${podShortList} vs ${permaShort}</div>`;
            panelsHtml += `<div id="colloc-reg-quants-pm-${key}" style="width:100%;height:360px"></div>`;
        }
        panelsHtml += '</div>';

        // Quants Gaseous — pods vs permanent pod for gas
        if (hasGas) {
            tabsHtml += `<li><button class="colloc-nav-link" onclick="_switchCollocTabLazy('colloc-reg', 'quants-gas', this, 'reg')">Quants Gaseous</button></li>`;
            panelsHtml += `<div id="colloc-reg-tab-quants-gas" class="colloc-tab-pane">`;
            for (const key of ['co', 'no', 'no2', 'o3']) {
                const p = AUDIT_PARAMETERS.find(x => x.key === key);
                panelsHtml += `<div class="colloc-reg-param-title">${p.labelHtml} &mdash; Pods ${podShortList} vs ${permaShort}</div>`;
                panelsHtml += `<div id="colloc-reg-quants-gas-${key}" style="width:100%;height:360px"></div>`;
            }
            panelsHtml += '</div>';
        }
    } else if (parsed.podIds.length >= 2) {
        // No permanent pod — do inter-pod comparisons
        tabsHtml += `<li><button class="colloc-nav-link" onclick="_switchCollocTabLazy('colloc-reg', 'quants-pm', this, 'reg')">Quants PM</button></li>`;
        panelsHtml += `<div id="colloc-reg-tab-quants-pm" class="colloc-tab-pane">`;
        for (const key of ['pm25', 'pm10']) {
            const p = AUDIT_PARAMETERS.find(x => x.key === key);
            panelsHtml += `<div class="colloc-reg-param-title">${p.labelHtml} &mdash; Inter-Pod Comparisons</div>`;
            panelsHtml += `<div id="colloc-reg-quants-pm-${key}" style="width:100%;height:360px"></div>`;
        }
        panelsHtml += '</div>';

        if (hasGas) {
            tabsHtml += `<li><button class="colloc-nav-link" onclick="_switchCollocTabLazy('colloc-reg', 'quants-gas', this, 'reg')">Quants Gaseous</button></li>`;
        panelsHtml += `<div id="colloc-reg-tab-quants-gas" class="colloc-tab-pane">`;
        for (const key of ['co', 'no', 'no2', 'o3']) {
            const p = AUDIT_PARAMETERS.find(x => x.key === key);
            panelsHtml += `<div class="colloc-reg-param-title">${p.labelHtml} &mdash; Inter-Pod Comparisons</div>`;
            panelsHtml += `<div id="colloc-reg-quants-gas-${key}" style="width:100%;height:360px"></div>`;
        }
        panelsHtml += '</div>';
        }
    }

    // Tab: Data Sheet
    tabsHtml += `<li><button class="colloc-nav-link" onclick="_switchCollocTabLazy('colloc-reg', 'data', this, 'reg')">Data Sheet</button></li>`;
    panelsHtml += `<div id="colloc-reg-tab-data" class="colloc-tab-pane"><div id="colloc-data-sheet"></div></div>`;

    tabsHtml += '</ul>';
    container.innerHTML = tabsHtml + '<div class="colloc-tab-content">' + panelsHtml + '</div>';

    // Render data sheet immediately (it's just a table, not Plotly)
    _renderCollocDataSheet(parsed);
}

function _renderCollocRegChart(parsed, results, tabName) {
    const trimmed = parsed.trimmedRows;
    const hasBam = Object.keys(results.bamVsPods || {}).length > 0;
    const hasPerma = Object.keys(results.permaVsPods || {}).length > 0;
    const hasGas = parsed.podIds.some(id => !parsed.isPmOnly[id]);

    function buildRegRow(divId, paramKey, paramLabel, podIds, refKey, refLabel, getRefVal, getPodVal) {
        const el = document.getElementById(divId);
        if (!el) return;
        const activePods = podIds.filter(id => {
            let hasData = false;
            trimmed.forEach(r => {
                const x = getRefVal(r, paramKey), y = getPodVal(r, id, paramKey);
                if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) hasData = true;
            });
            return hasData;
        });
        if (activePods.length === 0) { el.innerHTML = '<div style="text-align:center;color:#888;padding:40px">No valid data pairs</div>'; return; }

        const nPlots = activePods.length;
        const xGap = 0.08;
        const colW = (1 - xGap * (nPlots - 1)) / nPlots;
        const traces = [];
        const annotations = [];
        const layout = {
            margin: { t: 38, b: 55, l: 70, r: 15 },
            plot_bgcolor: '#fff', paper_bgcolor: 'rgba(0,0,0,0)',
            font: { family: 'Segoe UI, system-ui, sans-serif', size: 11 },
            showlegend: false, annotations,
        };

        activePods.forEach((podId, idx) => {
            const xArr = [], yArr = [];
            trimmed.forEach(r => {
                const x = getRefVal(r, paramKey), y = getPodVal(r, podId, paramKey);
                if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) { xArr.push(x); yArr.push(y); }
            });
            if (xArr.length < 3) return;

            const reg = runLinearRegression(xArr, yArr);
            if (!reg) return;

            const xax = idx === 0 ? 'x' : 'x' + (idx + 1);
            const yax = idx === 0 ? 'y' : 'y' + (idx + 1);
            const suffix = idx === 0 ? '' : '' + (idx + 1);
            const x0 = idx * (colW + xGap), x1 = x0 + colW;

            const xLo = Math.min(...xArr), xHi = Math.max(...xArr);
            const xDt = _collocNiceDtick(xLo, xHi);
            const yLo = Math.min(...yArr), yHi = Math.max(...yArr);
            const yDt = _collocNiceDtick(yLo, yHi);

            const xDef = { domain: [x0, x1], title: refLabel, gridcolor: '#eee', zeroline: false, range: [Math.floor(xLo / xDt) * xDt, Math.ceil(xHi / xDt) * xDt], dtick: xDt, tickfont: { size: 10 } };
            const yDef = { domain: [0, 1], title: idx === 0 ? paramLabel : '', gridcolor: '#eee', zeroline: false, range: [Math.floor(yLo / yDt) * yDt, Math.ceil(yHi / yDt) * yDt], dtick: yDt, tickfont: { size: 10 } };
            if (idx > 0) { xDef.anchor = yax; yDef.anchor = xax; }
            layout['xaxis' + suffix] = xDef;
            layout['yaxis' + suffix] = yDef;

            // Scatter points
            traces.push({ x: xArr, y: yArr, type: 'scatter', mode: 'markers', marker: { color: _collocPodColor(parsed.podIds.indexOf(podId)), size: 4, opacity: 0.4 }, xaxis: xax, yaxis: yax, showlegend: false, hoverinfo: 'x+y' });

            // Regression line
            traces.push({ x: [xLo, xHi], y: [reg.slope * xLo + reg.intercept, reg.slope * xHi + reg.intercept], type: 'scatter', mode: 'lines', line: { color: '#0a1628', width: 2.5 }, xaxis: xax, yaxis: yax, showlegend: false, hoverinfo: 'skip' });

            // Title annotation
            annotations.push({ text: `<b>${shortSensorId(podId)} vs ${refKey}</b>`, xref: xax + ' domain', yref: yax + ' domain', x: 0.5, y: 1.08, showarrow: false, font: { size: 12, color: '#0a1628' } });

            // Stats annotation with DQO coloring
            const slopeColor = (reg.slope >= 0.65 && reg.slope <= 1.35) ? '#2ca02c' : '#d62728';
            const intColor = (reg.intercept >= -5 && reg.intercept <= 5) ? '#2ca02c' : '#d62728';
            const r2Color = (reg.r2 >= 0.7) ? '#2ca02c' : '#d62728';
            const sign = reg.intercept >= 0 ? ' + ' : ' \u2212 ';
            const eqText = `y = <span style="color:${slopeColor}">${reg.slope.toFixed(3)}</span>x${sign}<span style="color:${intColor}">${Math.abs(reg.intercept).toFixed(2)}</span>`;
            const r2text = `<span style="color:${r2Color}">R\u00b2 = ${reg.r2.toFixed(4)}</span>  (n=${reg.n})`;
            annotations.push({ text: eqText + '<br>' + r2text, xref: xax + ' domain', yref: yax + ' domain', x: 0.03, y: 0.97, showarrow: false, font: { size: 10.5, color: '#444' }, align: 'left', bgcolor: 'rgba(255,255,255,0.92)', borderpad: 3 });
        });

        Plotly.newPlot(divId, traces, layout, { responsive: true, displayModeBar: false });
    }

    // Only render charts for the requested tab
    if (tabName === 'bam' && hasBam) {
        for (const key of ['pm25', 'pm10']) {
            const p = AUDIT_PARAMETERS.find(x => x.key === key);
            const allPods = parsed.permaPod ? [parsed.permaPodId, ...parsed.podIds] : [...parsed.podIds];
            buildRegRow(`colloc-reg-bam-${key}`, key, p.label, allPods, parsed.bamLabel,
                `${parsed.bamLabel} ${p.label}`,
                (r, k) => r.bam[k],
                (r, podId, k) => podId === parsed.permaPodId ? r.perma[k] : (r.pods[podId]?.[k] ?? NaN));
        }
    } else if (tabName === 'quants-pm') {
        if (hasPerma) {
            for (const key of ['pm25', 'pm10']) {
                const p = AUDIT_PARAMETERS.find(x => x.key === key);
                buildRegRow(`colloc-reg-quants-pm-${key}`, key, p.label, parsed.podIds, shortSensorId(parsed.permaPodId),
                    `${shortSensorId(parsed.permaPodId)} ${p.label}`,
                    (r, k) => r.perma[k], (r, podId, k) => r.pods[podId]?.[k] ?? NaN);
            }
        } else {
            const pmPairs = [];
            for (let i = 0; i < parsed.podIds.length; i++) for (let j = i + 1; j < parsed.podIds.length; j++) pmPairs.push({ ref: parsed.podIds[i], pod: parsed.podIds[j] });
            for (const key of ['pm25', 'pm10']) {
                const p = AUDIT_PARAMETERS.find(x => x.key === key);
                buildInterPodRegRow(`colloc-reg-quants-pm-${key}`, key, p.label, pmPairs, trimmed, parsed);
            }
        }
    } else if (tabName === 'quants-gas' && hasGas) {
        if (hasPerma) {
            const gasPods = parsed.podIds.filter(id => !parsed.isPmOnly[id]);
            for (const key of ['co', 'no', 'no2', 'o3']) {
                const p = AUDIT_PARAMETERS.find(x => x.key === key);
                buildRegRow(`colloc-reg-quants-gas-${key}`, key, p.label, gasPods, shortSensorId(parsed.permaPodId),
                    `${shortSensorId(parsed.permaPodId)} ${p.label}`,
                    (r, k) => r.perma[k], (r, podId, k) => r.pods[podId]?.[k] ?? NaN);
            }
        } else {
            const gasPods = parsed.podIds.filter(id => !parsed.isPmOnly[id]);
            const gasPairs = [];
            for (let i = 0; i < gasPods.length; i++) for (let j = i + 1; j < gasPods.length; j++) gasPairs.push({ ref: gasPods[i], pod: gasPods[j] });
            for (const key of ['co', 'no', 'no2', 'o3']) {
                const p = AUDIT_PARAMETERS.find(x => x.key === key);
                buildInterPodRegRow(`colloc-reg-quants-gas-${key}`, key, p.label, gasPairs, trimmed, parsed);
            }
        }
    }
    // Data sheet tab doesn't need Plotly rendering
}

function buildInterPodRegRow(divId, paramKey, paramLabel, pairs, trimmed, parsed) {
    const el = document.getElementById(divId);
    if (!el) return;

    // Filter to pairs with actual data
    const activePairs = pairs.filter(pair => {
        let hasData = false;
        trimmed.forEach(r => {
            const x = _getCollocVal(r, pair.ref, paramKey, parsed);
            const y = _getCollocVal(r, pair.pod, paramKey, parsed);
            if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) hasData = true;
        });
        return hasData;
    });
    if (activePairs.length === 0) { el.innerHTML = '<div style="text-align:center;color:#888;padding:40px">No valid data pairs</div>'; return; }

    const nPlots = activePairs.length;
    const xGap = 0.08;
    const colW = (1 - xGap * (nPlots - 1)) / nPlots;
    const traces = [];
    const annotations = [];
    const layout = {
        margin: { t: 38, b: 55, l: 70, r: 15 },
        plot_bgcolor: '#fff', paper_bgcolor: 'rgba(0,0,0,0)',
        font: { family: 'Segoe UI, system-ui, sans-serif', size: 11 },
        showlegend: false, annotations,
    };

    const pairColors = ['#D55E00', '#009E73', '#CC79A7', '#0072B2', '#E69F00', '#56B4E9'];

    activePairs.forEach((pair, idx) => {
        const xArr = [], yArr = [];
        trimmed.forEach(r => {
            const x = _getCollocVal(r, pair.ref, paramKey, parsed);
            const y = _getCollocVal(r, pair.pod, paramKey, parsed);
            if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) { xArr.push(x); yArr.push(y); }
        });
        if (xArr.length < 3) return;
        const reg = runLinearRegression(xArr, yArr);
        if (!reg) return;

        const xax = idx === 0 ? 'x' : 'x' + (idx + 1);
        const yax = idx === 0 ? 'y' : 'y' + (idx + 1);
        const suffix = idx === 0 ? '' : '' + (idx + 1);
        const x0 = idx * (colW + xGap), x1 = x0 + colW;
        const xLo = Math.min(...xArr), xHi = Math.max(...xArr);
        const xDt = _collocNiceDtick(xLo, xHi);
        const yLo = Math.min(...yArr), yHi = Math.max(...yArr);
        const yDt = _collocNiceDtick(yLo, yHi);

        const xDef = { domain: [x0, x1], title: `${shortSensorId(pair.ref)} ${paramLabel}`, gridcolor: '#eee', zeroline: false, range: [Math.floor(xLo / xDt) * xDt, Math.ceil(xHi / xDt) * xDt], dtick: xDt, tickfont: { size: 10 } };
        const yDef = { domain: [0, 1], title: idx === 0 ? paramLabel : '', gridcolor: '#eee', zeroline: false, range: [Math.floor(yLo / yDt) * yDt, Math.ceil(yHi / yDt) * yDt], dtick: yDt, tickfont: { size: 10 } };
        if (idx > 0) { xDef.anchor = yax; yDef.anchor = xax; }
        layout['xaxis' + suffix] = xDef;
        layout['yaxis' + suffix] = yDef;

        const color = pairColors[idx % pairColors.length];
        traces.push({ x: xArr, y: yArr, type: 'scatter', mode: 'markers', marker: { color, size: 4, opacity: 0.4 }, xaxis: xax, yaxis: yax, showlegend: false, hoverinfo: 'x+y' });
        traces.push({ x: [xLo, xHi], y: [reg.slope * xLo + reg.intercept, reg.slope * xHi + reg.intercept], type: 'scatter', mode: 'lines', line: { color: '#0a1628', width: 2.5 }, xaxis: xax, yaxis: yax, showlegend: false, hoverinfo: 'skip' });

        annotations.push({ text: `<b>${shortSensorId(pair.pod)} vs ${shortSensorId(pair.ref)}</b>`, xref: xax + ' domain', yref: yax + ' domain', x: 0.5, y: 1.08, showarrow: false, font: { size: 12, color: '#0a1628' } });

        const slopeColor = (reg.slope >= 0.65 && reg.slope <= 1.35) ? '#2ca02c' : '#d62728';
        const intColor = (reg.intercept >= -5 && reg.intercept <= 5) ? '#2ca02c' : '#d62728';
        const r2Color = (reg.r2 >= 0.7) ? '#2ca02c' : '#d62728';
        const sign = reg.intercept >= 0 ? ' + ' : ' \u2212 ';
        const eqText = `y = <span style="color:${slopeColor}">${reg.slope.toFixed(3)}</span>x${sign}<span style="color:${intColor}">${Math.abs(reg.intercept).toFixed(2)}</span>`;
        const r2text = `<span style="color:${r2Color}">R\u00b2 = ${reg.r2.toFixed(4)}</span>  (n=${reg.n})`;
        annotations.push({ text: eqText + '<br>' + r2text, xref: xax + ' domain', yref: yax + ' domain', x: 0.03, y: 0.97, showarrow: false, font: { size: 10.5, color: '#444' }, align: 'left', bgcolor: 'rgba(255,255,255,0.92)', borderpad: 3 });
    });

    Plotly.newPlot(divId, traces, layout, { responsive: true, displayModeBar: false });
}

function _getCollocVal(row, sensorId, paramKey, parsed) {
    if (sensorId === parsed.permaPodId) return Number(row.perma?.[paramKey] ?? NaN);
    return Number(row.pods?.[sensorId]?.[paramKey] ?? NaN);
}


function _renderCollocDataSheet(parsed) {
    const container = document.getElementById('colloc-data-sheet');
    if (!container) return;

    const params = ['pm25', 'pm10', 'co', 'no', 'no2', 'o3'];
    const labels = { pm25: 'PM2.5', pm10: 'PM10', co: 'CO', no: 'NO', no2: 'NO2', o3: 'O3' };
    const hasBam = parsed.allRows.some(r => !isNaN(r.bam.pm25) || !isNaN(r.bam.pm10));

    let headerHtml = '<th>Date</th>';
    if (hasBam) headerHtml += '<th>BAM PM2.5</th><th>BAM PM10</th>';
    if (parsed.permaPod) {
        for (const key of params) {
            if (parsed.allRows.some(r => !isNaN(r.perma[key]))) {
                headerHtml += `<th>${shortSensorId(parsed.permaPodId)} ${labels[key]}</th>`;
            }
        }
    }
    for (const podId of parsed.podIds) {
        const podParams = parsed.isPmOnly[podId] ? ['pm25', 'pm10'] : params;
        for (const key of podParams) headerHtml += `<th>${shortSensorId(podId)} ${labels[key]}</th>`;
    }

    let rowsHtml = '';
    for (let i = 0; i < parsed.allRows.length; i++) {
        const row = parsed.allRows[i];
        const isTrimmed = i < parsed.trimIndex;
        const dateStr = row.timestamp.toLocaleString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: AK_TZ });
        const rowStyle = isTrimmed ? ' style="background:#fff8e8;opacity:0.5"' : '';
        let cells = `<td style="text-align:left;font-weight:500">${dateStr}${isTrimmed ? ' *' : ''}</td>`;
        if (hasBam) {
            for (const k of ['pm25', 'pm10']) {
                const v = Number(row.bam?.[k]);
                cells += `<td${isNaN(v) ? ' class="red"' : ''}>${isNaN(v) ? '' : v.toFixed(1)}</td>`;
            }
        }
        if (parsed.permaPod) {
            for (const key of params) {
                if (!parsed.allRows.some(r => !isNaN(Number(r.perma?.[key])))) continue;
                const v = Number(row.perma?.[key]);
                cells += `<td${isNaN(v) ? ' class="red"' : ''}>${isNaN(v) ? '' : v.toFixed(3)}</td>`;
            }
        }
        for (const podId of parsed.podIds) {
            const podParams = parsed.isPmOnly[podId] ? ['pm25', 'pm10'] : params;
            for (const key of podParams) {
                const v = Number(row.pods?.[podId]?.[key]);
                cells += `<td${isNaN(v) ? ' class="red"' : ''}>${isNaN(v) ? '' : v.toFixed(3)}</td>`;
            }
        }
        rowsHtml += `<tr${rowStyle}>${cells}</tr>`;
    }

    container.innerHTML = `
        <div style="margin:8px 0 4px;font-size:13px;color:#555;line-height:1.6">
            <span style="display:inline-block;width:14px;height:14px;background:#fff8e8;border:1px solid #d4a84b;vertical-align:middle;margin-right:4px;border-radius:2px"></span>
            Yellow-shaded rows (*) are the first 24 hours — excluded from regression analysis.<br>
            <span style="display:inline-block;width:14px;height:14px;background:#ffe0e0;border:2px solid #e53e3e;vertical-align:middle;margin-right:4px;border-radius:2px"></span>
            Red-highlighted cells indicate missing or flagged data, also excluded from analysis.
        </div>
        <div style="overflow:auto;max-height:70vh;border:1px solid #ccc;border-radius:6px;margin-top:10px">
            <table style="border-collapse:collapse;font-size:11px;white-space:nowrap">
                <thead><tr>${headerHtml}</tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>`;
}

function renderCollocationSavedView(collocId) {
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc) return;
    const body = document.getElementById('audit-analysis-body');
    body.innerHTML = `<div style="padding:20px;text-align:center;color:var(--slate-400)">
        <p>Analysis results saved. Re-upload the data file to view full charts.</p>
        <button class="btn" style="margin-top:12px" onclick="reuploadCollocationData('${collocId}')">Re-upload Data</button>
    </div>`;
}

function generateCollocationReport(collocId) {
    const colloc = collocations.find(c => c.id === collocId);
    if (!colloc) return;
    const parsed = collocAnalysisCache[collocId];
    if (!parsed) { showAlert('Error', 'No analysis data available. Try re-uploading.'); return; }

    const communityName = getCommunityName(colloc.locationId);
    const bamLabel = parsed.bamLabel;
    const trimmed = parsed.trimmedRows;
    const results = parsed.regressionResults || {};

    // Build filename: NCore_Collocation_Analysis_443_651_652_Mar13_Apr1_2026.html
    const podNums = parsed.podIds.map(id => id.replace(/\D/g, '').replace(/^0+/, ''));
    const startD = colloc.startDate ? new Date(colloc.startDate + 'T12:00:00') : null;
    const endD = colloc.endDate && colloc.endDate !== 'TBD' ? new Date(colloc.endDate + 'T12:00:00') : null;
    const fmtShort = d => d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: AK_TZ }).replace(/ /g, '') : '';
    const fmtYear = d => d ? d.toLocaleDateString('en-US', { year: 'numeric', timeZone: AK_TZ }) : '';
    const siteName = (colloc.bamSource || communityName).replace(/\s+/g, '');
    const endPart = endD ? `_${fmtShort(endD)}` : '';
    const filename = `${siteName}_Collocation_Analysis_${podNums.join('_')}_${fmtShort(startD)}${endPart}_${fmtYear(endD || startD)}.html`;

    // Build title parts
    const titleParts = [bamLabel];
    if (parsed.permaPodId) titleParts.push(shortSensorId(parsed.permaPodId) + ' (Permanent Pod)');
    titleParts.push(...parsed.podIds.map(id => shortSensorId(id)));
    const dateRange = `${startD ? formatDate(colloc.startDate) : ''} &ndash; ${endD ? formatDate(colloc.endDate) : 'TBD'}`;

    // Format dates for Plotly as ISO strings in Alaska time
    const dates = parsed.allRows.map(r => {
        const p = new Intl.DateTimeFormat('en-US', { timeZone: AK_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(r.timestamp);
        const get = type => (p.find(x => x.type === type) || {}).value || '00';
        return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
    });

    // Serialize all the data needed for the report
    const paramLabels = { pm25: 'PM₂.₅ (µg/m³)', pm10: 'PM₁₀ (µg/m³)', co: 'CO (ppb)', no: 'NO (ppb)', no2: 'NO₂ (ppb)', o3: 'O₃ (ppb)' };
    const paramHtml = { pm25: 'PM<sub>2.5</sub>', pm10: 'PM<sub>10</sub>', co: 'CO', no: 'NO', no2: 'NO<sub>2</sub>', o3: 'O<sub>3</sub>' };
    const hasGas = parsed.podIds.some(id => !parsed.isPmOnly[id]);
    const tsParams = hasGas ? ['pm25', 'pm10', 'co', 'no', 'no2', 'o3'] : ['pm25', 'pm10'];

    // Build DATA object for the report JS
    const reportData = {
        dates, bamLabel,
        permaPodId: parsed.permaPodId, permaShort: parsed.permaPodId ? shortSensorId(parsed.permaPodId) : '',
        podIds: parsed.podIds, podShorts: parsed.podIds.map(id => shortSensorId(id)),
        isPmOnly: parsed.isPmOnly,
        bam: { pm25: parsed.allRows.map(r => isNaN(r.bam.pm25) ? null : r.bam.pm25), pm10: parsed.allRows.map(r => isNaN(r.bam.pm10) ? null : r.bam.pm10) },
        perma: {},
        pods: {},
    };
    if (parsed.permaPod) {
        tsParams.forEach(k => { reportData.perma[k] = parsed.allRows.map(r => isNaN(r.perma[k]) ? null : r.perma[k]); });
    }
    parsed.podIds.forEach(id => {
        reportData.pods[id] = {};
        const keys = parsed.isPmOnly[id] ? ['pm25', 'pm10'] : tsParams;
        keys.forEach(k => { reportData.pods[id][k] = parsed.allRows.map(r => isNaN(r.pods[id]?.[k]) ? null : r.pods[id][k]); });
    });

    // Build regression data
    const regData = { bamVsPods: {}, bamVsPerma: {}, permaVsPods: {}, interPod: {} };
    // BAM vs pods
    parsed.podIds.forEach(podId => {
        regData.bamVsPods[podId] = {};
        ['pm25', 'pm10'].forEach(k => {
            const xArr = [], yArr = [];
            trimmed.forEach(r => {
                const x = r.bam[k], y = r.pods[podId]?.[k];
                if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) { xArr.push(x); yArr.push(y); }
            });
            const reg = runLinearRegression(xArr, yArr);
            if (reg) regData.bamVsPods[podId][k] = { x: xArr, y: yArr, ...reg };
        });
    });
    // BAM vs perma
    if (parsed.permaPod) {
        ['pm25', 'pm10'].forEach(k => {
            const xArr = [], yArr = [];
            trimmed.forEach(r => {
                const x = r.bam[k], y = r.perma[k];
                if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) { xArr.push(x); yArr.push(y); }
            });
            const reg = runLinearRegression(xArr, yArr);
            if (reg) regData.bamVsPerma[k] = { x: xArr, y: yArr, ...reg };
        });
    }
    // Perma vs pods
    if (parsed.permaPod) {
        parsed.podIds.forEach(podId => {
            regData.permaVsPods[podId] = {};
            const keys = parsed.isPmOnly[podId] ? ['pm25', 'pm10'] : tsParams;
            keys.forEach(k => {
                const xArr = [], yArr = [];
                trimmed.forEach(r => {
                    const x = r.perma[k], y = r.pods[podId]?.[k];
                    if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) { xArr.push(x); yArr.push(y); }
                });
                const reg = runLinearRegression(xArr, yArr);
                if (reg) regData.permaVsPods[podId][k] = { x: xArr, y: yArr, ...reg };
            });
        });
    }
    // Inter-pod pairs
    const allPodIds = parsed.permaPod ? [parsed.permaPodId, ...parsed.podIds] : [...parsed.podIds];
    for (let i = 0; i < allPodIds.length; i++) {
        for (let j = i + 1; j < allPodIds.length; j++) {
            const pairKey = `${allPodIds[j]}_vs_${allPodIds[i]}`;
            regData.interPod[pairKey] = {};
            const keys = (parsed.isPmOnly[allPodIds[i]] || parsed.isPmOnly[allPodIds[j]]) ? ['pm25', 'pm10'] : tsParams;
            keys.forEach(k => {
                const xArr = [], yArr = [];
                const getVal = (r, id) => id === parsed.permaPodId ? (r.perma[k] ?? NaN) : (r.pods[id]?.[k] ?? NaN);
                trimmed.forEach(r => {
                    const x = getVal(r, allPodIds[i]), y = getVal(r, allPodIds[j]);
                    if (!isNaN(x) && !isNaN(y) && isFinite(x) && isFinite(y)) { xArr.push(x); yArr.push(y); }
                });
                const reg = runLinearRegression(xArr, yArr);
                if (reg) regData.interPod[pairKey][k] = { x: xArr, y: yArr, ...reg, refId: allPodIds[i], podId: allPodIds[j] };
            });
        }
    }

    // Build data table HTML
    const params = ['pm25', 'pm10', 'co', 'no', 'no2', 'o3'];
    const paramNames = { pm25: 'PM2.5', pm10: 'PM10', co: 'CO', no: 'NO', no2: 'NO2', o3: 'O3' };
    let tableHeader = '<th>Date</th><th>BAM PM2.5</th><th>BAM PM10</th>';
    if (parsed.permaPod) tsParams.forEach(k => { tableHeader += `<th>${reportData.permaShort} ${paramNames[k]}</th>`; });
    parsed.podIds.forEach(id => {
        const keys = parsed.isPmOnly[id] ? ['pm25', 'pm10'] : tsParams;
        keys.forEach(k => { tableHeader += `<th>${shortSensorId(id)} ${paramNames[k]}</th>`; });
    });
    let tableRows = '';
    parsed.allRows.forEach((r, i) => {
        const isTrimmed = i < parsed.trimIndex;
        const style = isTrimmed ? ' style="background:#fff8e8;opacity:0.5"' : '';
        let cells = `<td>${dates[i]}${isTrimmed ? ' *' : ''}</td>`;
        cells += `<td${isNaN(r.bam.pm25) ? ' class="red"' : ''}>${isNaN(r.bam.pm25) ? '' : r.bam.pm25.toFixed(1)}</td>`;
        cells += `<td${isNaN(r.bam.pm10) ? ' class="red"' : ''}>${isNaN(r.bam.pm10) ? '' : r.bam.pm10.toFixed(1)}</td>`;
        if (parsed.permaPod) tsParams.forEach(k => {
            const v = r.perma[k]; cells += `<td${isNaN(v) ? ' class="red"' : ''}>${isNaN(v) ? '' : v.toFixed(3)}</td>`;
        });
        parsed.podIds.forEach(id => {
            const keys = parsed.isPmOnly[id] ? ['pm25', 'pm10'] : tsParams;
            keys.forEach(k => {
                const v = r.pods[id]?.[k]; cells += `<td${isNaN(v) ? ' class="red"' : ''}>${isNaN(v) ? '' : v.toFixed(3)}</td>`;
            });
        });
        tableRows += `<tr${style}>${cells}</tr>\n`;
    });

    const reportHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(communityName)} Collocation Analysis</title>
<script src="https://cdn.plot.ly/plotly-2.35.0.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #f5f5f0; color: #1a1a2e; padding: 30px 35px 60px; }
  .title-block { text-align: center; margin-bottom: 35px; }
  .title-block .label { font-size: 14px; font-weight: 400; color: #888; margin-bottom: 2px; letter-spacing: 0.5px; }
  .title-block .main { font-size: 24px; font-weight: 700; color: #0a1628; margin: 4px 0; }
  .title-block .dates { font-size: 14px; font-weight: 400; color: #888; }
  .section-header { text-align: center; margin: 50px 0 8px; padding-bottom: 8px; border-bottom: 2px solid #0a1628; }
  .section-header h2 { font-size: 21px; color: #0a1628; }
  .plot-title { text-align: center; margin: 20px 0 2px; }
  .plot-title h3 { font-size: 15px; font-weight: 600; color: #0a1628; }
  .plot-subtitle { text-align: center; font-size: 11.5px; color: #888; margin-bottom: 6px; }
  .ts-plot { width: 100%; height: 420px; margin-bottom: 10px; }
  .reg-grid { width: 100%; height: 360px; margin-bottom: 10px; }
  .reg-param-title { text-align: center; font-size: 14px; font-weight: 600; color: #0a1628; margin: 18px 0 4px; }
  .panel-tabset { margin-top: 12px; }
  .nav-tabs { display: flex; list-style: none; border-bottom: 2px solid #ddd; padding: 0; margin: 0; gap: 2px; }
  .nav-tabs .nav-item { margin: 0; }
  .nav-tabs .nav-link { display: block; padding: 9px 22px; font-size: 13px; font-weight: 600; color: #667; text-decoration: none; border: 1px solid transparent; border-bottom: none; border-radius: 6px 6px 0 0; cursor: pointer; background: transparent; font-family: inherit; transition: all 0.15s; }
  .nav-tabs .nav-link:hover { color: #0a1628; background: #eee; }
  .nav-tabs .nav-link.active { color: #0a1628; background: #fff; border-color: #ddd; border-bottom: 2px solid #fff; margin-bottom: -2px; }
  .tab-content > .tab-pane { display: none; }
  .tab-content > .tab-pane.active { display: block; }
  .data-table-wrap { overflow: auto; max-height: 70vh; border: 1px solid #ccc; border-radius: 6px; margin-top: 10px; }
  .data-table { border-collapse: collapse; font-size: 11px; white-space: nowrap; }
  .data-table th { background: #0a1628; color: #c8a84e; padding: 7px 9px; position: sticky; top: 0; z-index: 10; font-weight: 600; border-right: 1px solid #1a2a40; }
  .data-table td { padding: 3px 9px; border-bottom: 1px solid #eee; border-right: 1px solid #f0f0f0; text-align: right; }
  .data-table td:first-child { text-align: left; font-weight: 500; }
  .data-table tr:hover td { background: #f0f0e8; }
  .data-table td.red { background: #ffe0e0; border: 2px solid #e53e3e; }
  .data-legend { margin: 8px 0 4px; font-size: 13px; color: #555; line-height: 1.6; }
  .data-legend .swatch { display: inline-block; width: 14px; height: 14px; vertical-align: middle; margin-right: 4px; border-radius: 2px; }
</style>
</head>
<body>
<div class="title-block">
  <div class="label">${escapeHtml(communityName)} Collocation Analysis</div>
  <div class="main">${titleParts.map(t => escapeHtml(t)).join(' &bull; ')}</div>
  <div class="dates">${dateRange}</div>
</div>
<div class="section-header"><h2>Time Series Collocation Results</h2></div>
<div class="panel-tabset" id="ts-tabset">
  <ul class="nav nav-tabs" role="tablist">
    ${tsParams.map((k, i) => `<li class="nav-item"><button class="nav-link${i === 0 ? ' active' : ''}" onclick="switchTab('ts','${k}',this)">${paramHtml[k]}</button></li>`).join('\n    ')}
  </ul>
  <div class="tab-content">
    ${tsParams.map((k, i) => `<div id="ts-tab-${k}" class="tab-pane${i === 0 ? ' active' : ''}">
      <div class="plot-title"><h3>${paramHtml[k]} Hourly Collocation Results</h3></div>
      <div class="plot-subtitle">Collocation Dates: ${dateRange}</div>
      <div id="ts-${k}-plot" class="ts-plot"></div>
    </div>`).join('\n    ')}
  </div>
</div>
<div class="section-header"><h2>Multi-Sensor Regression Analysis</h2></div>
<div class="panel-tabset" id="reg-tabset">
  <ul class="nav nav-tabs" role="tablist">
    <li class="nav-item"><button class="nav-link active" onclick="switchTab('reg','bam',this)">Pods vs ${escapeHtml(bamLabel)}</button></li>
    ${parsed.permaPod ? `<li class="nav-item"><button class="nav-link" onclick="switchTab('reg','perma',this)">Pods vs ${escapeHtml(reportData.permaShort)}</button></li>` : ''}
    <li class="nav-item"><button class="nav-link" onclick="switchTab('reg','inter-pm',this)">Quants PM</button></li>
    ${hasGas ? `<li class="nav-item"><button class="nav-link" onclick="switchTab('reg','inter-gas',this)">Quants Gaseous</button></li>` : ''}
    <li class="nav-item"><button class="nav-link" onclick="switchTab('reg','data',this)">Data Sheet</button></li>
  </ul>
  <div class="tab-content">
    <div id="reg-tab-bam" class="tab-pane active">
      ${['pm25', 'pm10'].map(k => `<div class="reg-param-title">${paramHtml[k]} &mdash; All Sensors vs ${escapeHtml(bamLabel)}</div><div id="reg-bam-${k}" class="reg-grid"></div>`).join('\n      ')}
    </div>
    ${parsed.permaPod ? `<div id="reg-tab-perma" class="tab-pane">
      ${tsParams.map(k => `<div class="reg-param-title">${paramHtml[k]} &mdash; Pods vs ${escapeHtml(reportData.permaShort)}</div><div id="reg-perma-${k}" class="reg-grid"></div>`).join('\n      ')}
    </div>` : ''}
    <div id="reg-tab-inter-pm" class="tab-pane">
      ${['pm25', 'pm10'].map(k => `<div class="reg-param-title">${paramHtml[k]} &mdash; Inter-Pod Comparisons</div><div id="reg-inter-pm-${k}" class="reg-grid"></div>`).join('\n      ')}
    </div>
    ${hasGas ? `<div id="reg-tab-inter-gas" class="tab-pane">
      ${['co', 'no', 'no2', 'o3'].map(k => `<div class="reg-param-title">${paramHtml[k]} &mdash; Inter-Pod Comparisons</div><div id="reg-inter-gas-${k}" class="reg-grid"></div>`).join('\n      ')}
    </div>` : ''}
    <div id="reg-tab-data" class="tab-pane">
      <div class="data-legend">
        <span class="swatch" style="background:#fff8e8;border:1px solid #d4a84b"></span> Yellow rows (*) = first 24 hours, excluded from analysis.<br>
        <span class="swatch" style="background:#ffe0e0;border:2px solid #e53e3e"></span> Red cells = missing/flagged data, excluded from analysis.
      </div>
      <div class="data-table-wrap"><table class="data-table"><thead><tr>${tableHeader}</tr></thead><tbody>${tableRows}</tbody></table></div>
    </div>
  </div>
</div>
<script>
var DATA = ${JSON.stringify(reportData)};
var REG = ${JSON.stringify(regData)};
var PARAMS = ${JSON.stringify(tsParams)};
var paramLabels = ${JSON.stringify(paramLabels)};

function switchTab(group, name, btn) {
  var tabset = document.getElementById(group + '-tabset');
  tabset.querySelectorAll('.tab-pane').forEach(function(el) { el.classList.remove('active'); });
  tabset.querySelectorAll('.nav-link').forEach(function(el) { el.classList.remove('active'); });
  document.getElementById(group + '-tab-' + name).classList.add('active');
  btn.classList.add('active');
  setTimeout(function() { window.dispatchEvent(new Event('resize')); }, 80);
}

function niceDtick(lo, hi) {
  var range = hi - lo; if (range <= 0) return 1;
  var c = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  for (var i = 0; i < c.length; i++) { if (range / c[i] <= 8) return c[i]; }
  return Math.pow(10, Math.floor(Math.log10(range)));
}

var podColors = ['#d97706', '#15803d', '#7c3aed', '#0891b2', '#be185d', '#4338ca', '#b45309', '#059669'];
var pairColors = ['#D55E00', '#009E73', '#CC79A7', '#0072B2', '#E69F00', '#56B4E9'];

// Time series
PARAMS.forEach(function(pk, pi) {
  var traces = [];
  if (pk === 'pm25' || pk === 'pm10') {
    traces.push({ x: DATA.dates, y: DATA.bam[pk], name: DATA.bamLabel, type: 'scatter', mode: 'lines', line: {color: '#e53e3e', width: 2.5}, connectgaps: false });
  }
  if (DATA.permaPodId && DATA.perma[pk]) {
    traces.push({ x: DATA.dates, y: DATA.perma[pk], name: DATA.permaShort + ' (Perma)', type: 'scatter', mode: 'lines', line: {color: '#2563eb', width: 2}, connectgaps: false });
  }
  DATA.podIds.forEach(function(id, idx) {
    if (DATA.pods[id] && DATA.pods[id][pk]) {
      traces.push({ x: DATA.dates, y: DATA.pods[id][pk], name: DATA.podShorts[idx], type: 'scatter', mode: 'lines', line: {color: podColors[idx % podColors.length], width: 1.5}, connectgaps: false });
    }
  });
  var allY = []; traces.forEach(function(t) { t.y.forEach(function(v) { if (v !== null) allY.push(v); }); });
  var yMin = allY.length > 0 ? allY.reduce(function(a, b) { return Math.min(a, b); }, Infinity) : 0;
  var yMax = allY.length > 0 ? allY.reduce(function(a, b) { return Math.max(a, b); }, -Infinity) : 1;
  var dt = niceDtick(yMin, yMax);
  Plotly.newPlot('ts-' + pk + '-plot', traces, {
    margin: {t: 8, b: 45, l: 80, r: 15}, xaxis: {title: 'Date', type: 'date', gridcolor: '#ddd'},
    yaxis: {title: {text: paramLabels[pk], standoff: 10}, gridcolor: '#ddd', range: [Math.floor(yMin/dt)*dt, Math.ceil(yMax/dt)*dt], dtick: dt, tickfont: {size: 11}},
    legend: {orientation: 'h', y: 1.12, x: 0.5, xanchor: 'center', font: {size: 12}},
    plot_bgcolor: '#fff', paper_bgcolor: 'rgba(0,0,0,0)', font: {family: 'Segoe UI, system-ui, sans-serif', size: 12}, hovermode: 'x unified'
  }, {responsive: true, displayModeBar: false});
});

// Regression helper
function buildRegRow(divId, paramKey, sensorList, refLabel, getRegData) {
  var el = document.getElementById(divId); if (!el) return;
  var active = sensorList.filter(function(sid) { var rd = getRegData(sid, paramKey); return rd && rd.x && rd.x.length > 2; });
  if (active.length === 0) return;
  var n = active.length, xGap = 0.08, colW = (1 - xGap*(n-1))/n;
  var traces = [], annotations = [];
  var layout = { margin: {t:38,b:55,l:70,r:15}, plot_bgcolor:'#fff', paper_bgcolor:'rgba(0,0,0,0)', font:{family:'Segoe UI,system-ui,sans-serif',size:11}, showlegend:false, annotations:annotations };
  active.forEach(function(sid, idx) {
    var rd = getRegData(sid, paramKey); if (!rd) return;
    var xax = idx===0?'x':'x'+(idx+1), yax = idx===0?'y':'y'+(idx+1), suffix = idx===0?'':''+(idx+1);
    var x0 = idx*(colW+xGap), x1 = x0+colW;
    var xLo=Math.min.apply(null,rd.x), xHi=Math.max.apply(null,rd.x), xDt=niceDtick(xLo,xHi);
    var yLo=Math.min.apply(null,rd.y), yHi=Math.max.apply(null,rd.y), yDt=niceDtick(yLo,yHi);
    layout['xaxis'+suffix] = {domain:[x0,x1], title:refLabel, gridcolor:'#eee', zeroline:false, range:[Math.floor(xLo/xDt)*xDt,Math.ceil(xHi/xDt)*xDt], dtick:xDt, tickfont:{size:10}};
    layout['yaxis'+suffix] = {domain:[0,1], title:idx===0?paramLabels[paramKey]:'', gridcolor:'#eee', zeroline:false, range:[Math.floor(yLo/yDt)*yDt,Math.ceil(yHi/yDt)*yDt], dtick:yDt, tickfont:{size:10}};
    if (idx>0) { layout['xaxis'+suffix].anchor=yax; layout['yaxis'+suffix].anchor=xax; }
    traces.push({x:rd.x,y:rd.y,type:'scatter',mode:'markers',marker:{color:podColors[DATA.podIds.indexOf(sid)%podColors.length]||'#666',size:4,opacity:0.4},xaxis:xax,yaxis:yax,showlegend:false,hoverinfo:'x+y'});
    traces.push({x:[xLo,xHi],y:[rd.slope*xLo+rd.intercept,rd.slope*xHi+rd.intercept],type:'scatter',mode:'lines',line:{color:'#0a1628',width:2.5},xaxis:xax,yaxis:yax,showlegend:false,hoverinfo:'skip'});
    var sLabel = typeof sid === 'string' && sid.includes('_vs_') ? sid.replace(/_vs_/,' vs ') : (DATA.podShorts[DATA.podIds.indexOf(sid)] || sid);
    annotations.push({text:'<b>'+sLabel+' vs '+refLabel.split(' ')[0]+'</b>',xref:xax+' domain',yref:yax+' domain',x:0.5,y:1.08,showarrow:false,font:{size:12,color:'#0a1628'}});
    var sc=(rd.slope>=0.65&&rd.slope<=1.35)?'#2ca02c':'#d62728';
    var ic=(rd.intercept>=-5&&rd.intercept<=5)?'#2ca02c':'#d62728';
    var rc=(rd.r2>=0.7)?'#2ca02c':'#d62728';
    var sign=rd.intercept>=0?' + ':' \\u2212 ';
    annotations.push({text:'y = <span style="color:'+sc+'">'+rd.slope.toFixed(3)+'</span>x'+sign+'<span style="color:'+ic+'">'+Math.abs(rd.intercept).toFixed(2)+'</span><br><span style="color:'+rc+'">R\\u00b2 = '+rd.r2.toFixed(4)+'</span>  (n='+rd.n+')',xref:xax+' domain',yref:yax+' domain',x:0.03,y:0.97,showarrow:false,font:{size:10.5,color:'#444'},align:'left',bgcolor:'rgba(255,255,255,0.92)',borderpad:3});
  });
  Plotly.newPlot(divId, traces, layout, {responsive:true, displayModeBar:false});
}

// BAM regression
var bamPods = ${JSON.stringify(parsed.permaPod ? [parsed.permaPodId, ...parsed.podIds] : [...parsed.podIds])};
['pm25','pm10'].forEach(function(k) {
  buildRegRow('reg-bam-'+k, k, bamPods, '${escapeHtml(bamLabel)} '+paramLabels[k].split(' ')[0], function(sid,pk) { return sid==='${parsed.permaPodId}'?REG.bamVsPerma[pk]:REG.bamVsPods[sid]&&REG.bamVsPods[sid][pk]; });
});

// Perma pod regression
${parsed.permaPod ? `PARAMS.forEach(function(k) {
  buildRegRow('reg-perma-'+k, k, ${JSON.stringify(parsed.podIds)}, '${escapeHtml(reportData.permaShort)} '+paramLabels[k].split(' ')[0], function(sid,pk) { return REG.permaVsPods[sid]&&REG.permaVsPods[sid][pk]; });
});` : ''}

// Inter-pod regression helper
function buildInterRegRow(divId, paramKey, pairs) {
  var el = document.getElementById(divId); if (!el) return;
  var active = pairs.filter(function(pk) { var rd = REG.interPod[pk]; return rd && rd[paramKey] && rd[paramKey].x.length > 2; });
  if (active.length === 0) return;
  var n = active.length, xGap = 0.08, colW = (1 - xGap*(n-1))/n;
  var traces = [], annotations = [];
  var layout = { margin:{t:38,b:55,l:70,r:15}, plot_bgcolor:'#fff', paper_bgcolor:'rgba(0,0,0,0)', font:{family:'Segoe UI,system-ui,sans-serif',size:11}, showlegend:false, annotations:annotations };
  active.forEach(function(pk, idx) {
    var rd = REG.interPod[pk][paramKey]; if (!rd) return;
    var xax=idx===0?'x':'x'+(idx+1), yax=idx===0?'y':'y'+(idx+1), suffix=idx===0?'':''+(idx+1);
    var x0=idx*(colW+xGap);
    var xLo=Math.min.apply(null,rd.x),xHi=Math.max.apply(null,rd.x),xDt=niceDtick(xLo,xHi);
    var yLo=Math.min.apply(null,rd.y),yHi=Math.max.apply(null,rd.y),yDt=niceDtick(yLo,yHi);
    layout['xaxis'+suffix]={domain:[x0,x0+colW],title:pk.split('_vs_')[1],gridcolor:'#eee',zeroline:false,range:[Math.floor(xLo/xDt)*xDt,Math.ceil(xHi/xDt)*xDt],dtick:xDt,tickfont:{size:10}};
    layout['yaxis'+suffix]={domain:[0,1],title:idx===0?paramLabels[paramKey]:'',gridcolor:'#eee',zeroline:false,range:[Math.floor(yLo/yDt)*yDt,Math.ceil(yHi/yDt)*yDt],dtick:yDt,tickfont:{size:10}};
    if(idx>0){layout['xaxis'+suffix].anchor=yax;layout['yaxis'+suffix].anchor=xax;}
    traces.push({x:rd.x,y:rd.y,type:'scatter',mode:'markers',marker:{color:pairColors[idx%pairColors.length],size:4,opacity:0.4},xaxis:xax,yaxis:yax,showlegend:false,hoverinfo:'x+y'});
    traces.push({x:[xLo,xHi],y:[rd.slope*xLo+rd.intercept,rd.slope*xHi+rd.intercept],type:'scatter',mode:'lines',line:{color:'#0a1628',width:2.5},xaxis:xax,yaxis:yax,showlegend:false,hoverinfo:'skip'});
    annotations.push({text:'<b>'+pk.replace(/_vs_/,' vs ')+'</b>',xref:xax+' domain',yref:yax+' domain',x:0.5,y:1.08,showarrow:false,font:{size:12,color:'#0a1628'}});
    var sc=(rd.slope>=0.65&&rd.slope<=1.35)?'#2ca02c':'#d62728';
    var ic=(rd.intercept>=-5&&rd.intercept<=5)?'#2ca02c':'#d62728';
    var rc=(rd.r2>=0.7)?'#2ca02c':'#d62728';
    var sign=rd.intercept>=0?' + ':' \\u2212 ';
    annotations.push({text:'y = <span style="color:'+sc+'">'+rd.slope.toFixed(3)+'</span>x'+sign+'<span style="color:'+ic+'">'+Math.abs(rd.intercept).toFixed(2)+'</span><br><span style="color:'+rc+'">R\\u00b2 = '+rd.r2.toFixed(4)+'</span>  (n='+rd.n+')',xref:xax+' domain',yref:yax+' domain',x:0.03,y:0.97,showarrow:false,font:{size:10.5,color:'#444'},align:'left',bgcolor:'rgba(255,255,255,0.92)',borderpad:3});
  });
  Plotly.newPlot(divId, traces, layout, {responsive:true, displayModeBar:false});
}

var interPairs = Object.keys(REG.interPod);
var pmPairs = interPairs; // all pairs have PM
var gasPairs = interPairs.filter(function(pk) { return REG.interPod[pk].co || REG.interPod[pk].no; });
['pm25','pm10'].forEach(function(k) { buildInterRegRow('reg-inter-pm-'+k, k, pmPairs); });
['co','no','no2','o3'].forEach(function(k) { buildInterRegRow('reg-inter-gas-'+k, k, gasPairs); });
<\/script>
</body>
</html>`;

    const blob = new Blob([reportHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showSuccessToast('Report saved as ' + filename);
}

// ===== USER GUIDE =====
function renderUserGuide() {
    const container = document.getElementById('user-guide-content');
    if (!container) return;
    if (container.dataset.loaded) return;
    container.dataset.loaded = '1';
    // Use an iframe so the guide renders with its full standalone styles
    container.innerHTML = '<iframe src="user-guide.html" style="width:100%;height:calc(100vh - 180px);border:none;border-radius:8px;background:#fff" title="User Guide"></iframe>';
}

function exportUserGuide() {
    fetch('user-guide.html')
        .then(r => r.text())
        .then(html => {
            const blob = new Blob([html], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'ADEC_Sensor_Network_Tracker_User_Guide.html';
            a.click();
            URL.revokeObjectURL(url);
            showSuccessToast('User guide exported');
        })
        .catch(() => showAlert('Error', 'Could not export user guide.'));
}

// ===== MOBILE SIDEBAR =====
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('mobile-open');
    document.getElementById('sidebar-overlay').classList.toggle('visible');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebar-overlay').classList.remove('visible');
}

// ===== BATCH IMPORT =====
async function importSensors(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws);

        let imported = 0;
        let skipped = 0;

        for (const row of rows) {
            const id = row['Sensor ID'] || row['sensor_id'] || row['id'];
            if (!id) { skipped++; continue; }
            if (sensors.find(s => s.id === id)) { skipped++; continue; }

            const sensor = {
                id: String(id).trim(),
                soaTagId: String(row['SOA Tag ID'] || row['soa_tag_id'] || '').trim(),
                type: row['Type'] || row['type'] || 'Community Pod',
                status: [],
                community: '',
                location: String(row['Location'] || row['location'] || '').trim(),
                datePurchased: String(row['Purchase Date'] || row['date_purchased'] || '').trim(),
                collocationDates: String(row['Initial Collocation'] || row['collocation_dates'] || '').trim(),
                dateInstalled: '',
            };

            // Try to match community by name
            const commName = row['Community'] || row['community'] || '';
            if (commName) {
                const match = COMMUNITIES.find(c => c.name.toLowerCase() === String(commName).toLowerCase().trim());
                if (match) sensor.community = match.id;
            }

            // Parse status
            const statusStr = row['Status'] || row['status'] || '';
            if (statusStr) {
                sensor.status = String(statusStr).split(';').map(s => s.trim()).filter(Boolean);
            }

            // Check SOA Tag ID uniqueness
            if (sensor.soaTagId) {
                const soaDup = sensors.find(s => s.soaTagId === sensor.soaTagId);
                if (soaDup) {
                    skipped++;
                    continue;
                }
            }

            sensors.push(sensor);
            persistSensor(sensor);
            imported++;
        }

        showAlert('Import Complete', `${imported} sensors added, ${skipped} skipped (duplicate ID, duplicate SOA Tag, or missing ID).`);
        event.target.value = '';
        renderSensors();
        buildSensorSidebar();
    } catch (err) {
        showAlert('Error', 'Import failed: ' + err.message);
        console.error('Import error:', err);
    }
}

// ===== INIT =====

(async function init() {
    try {
    // Handle query-param based auth tokens (email confirmation links)
    const params = new URLSearchParams(window.location.search);
    if (params.has('token_hash')) {
        try {
            await supa.auth.verifyOtp({
                token_hash: params.get('token_hash'),
                type: params.get('type'),
            });
        } catch (otpErr) {
            console.warn('OTP verification failed (link may be expired):', otpErr);
        }
        window.history.replaceState(null, '', window.location.pathname);
    }

    // Let Supabase client process any hash-fragment tokens BEFORE we clear them.
    let session = null;
    try {
        session = await db.getSession();
    } catch(sessionErr) {
        // JWT may reference a deleted user — clear stale session and continue
        console.warn('Session check failed:', sessionErr);
        await supa.auth.signOut().catch(() => {});
    }

    // Clean up any hash fragments after getSession has consumed them
    if (window.location.hash) {
        window.history.replaceState(null, '', window.location.pathname);
    }
    if (session) {
        // Existing user — check if MFA was recently verified
        const mfaVerifiedAt = sessionStorage.getItem('mfa_verified_at');
        const mfaVerifiedUser = sessionStorage.getItem('mfa_verified_user');
        const mfaStillValid = mfaVerifiedAt
            && mfaVerifiedUser === session.user.id
            && (Date.now() - parseInt(mfaVerifiedAt)) < INACTIVITY_LIMIT;

        if (mfaStillValid) {
            await enterApp();
        } else {
            await checkMfaAndProceed();
        }
    } else {
        showLoginScreen();
    }
    } catch (err) {
        console.error('Init error:', err);
        showLoginScreen();
    }

    // Set up mention autocomplete textareas
    const pairs = [
        ['note-text-input', 'note-mention-dropdown'],
        ['move-additional-info', 'move-mention-dropdown'],
        ['status-change-info', 'status-mention-dropdown'],
        ['comm-text-input', 'comm-mention-dropdown'],
    ];
    pairs.forEach(([textareaId, dropdownId]) => {
        const ta = document.getElementById(textareaId);
        const dd = document.getElementById(dropdownId);
        if (ta && dd) setupMentionAutocomplete(ta, dd);
    });
})();
