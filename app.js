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
let communityParents = {}; // childId -> parentId
let currentUserRole = 'user'; // 'admin' or 'user' — loaded from profile on login
let mfaRequired = true; // global setting, admin-configurable

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
    results.forEach((r, i) => { if (r.status === 'rejected') console.warn('Data load warning:', r.reason); });

    // Communities
    COMMUNITIES = communitiesData.map(c => ({ id: c.id, name: c.name }));
    communityParents = {};
    communitiesData.forEach(c => {
        if (c.parent_id) communityParents[c.id] = c.parent_id;
    });

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
    return prefix + Date.now() + Math.random().toString(36).slice(2, 6);
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
let recentActivity = loadData('recentActivity', { communities: [], contacts: [], sensors: [] });

function trackRecent(type, id, action) {
    // type: 'communities' | 'contacts' | 'sensors'
    // action: 'viewed' | 'edited'
    const list = recentActivity[type] || [];
    // Remove existing entry for this id
    const filtered = list.filter(item => item.id !== id);
    // Add to front
    filtered.unshift({ id, action, time: new Date().toISOString() });
    // Keep only 5
    recentActivity[type] = filtered.slice(0, 5);
    saveData('recentActivity', recentActivity);
}

// ===== USER SYSTEM (Supabase Auth) =====
let currentUser = null;
let currentUserId = null;

function showLoginScreen() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    hideAllAuthForms();
    document.getElementById('login-form-section').style.display = '';
}

function showSignUpForm() {
    hideAllAuthForms();
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
    // Check if MFA is required globally
    let mfaOn = true;
    try { const setting = await db.getAppSetting('mfa_required'); mfaOn = setting !== 'false'; } catch(e) { mfaOn = true; }

    if (!mfaOn) {
        // MFA disabled — go straight to app
        await enterApp();
        return;
    }

    const { data: factors } = await supa.auth.mfa.listFactors();
    const totp = factors?.totp?.find(f => f.status === 'verified');

    if (totp) {
        showMfaChallenge();
    } else {
        showMfaSetup();
    }
}

function showMfaChallenge() {
    hideAllAuthForms();
    document.getElementById('mfa-challenge-section').style.display = '';
    document.getElementById('mfa-challenge-code').value = '';
    document.getElementById('mfa-challenge-code').focus();
}

function showMfaSetup() {
    hideAllAuthForms();
    document.getElementById('mfa-setup-section').style.display = '';
    startMfaEnrollment();
}

async function startMfaEnrollment() {
    const { data, error } = await supa.auth.mfa.enroll({ factorType: 'totp' });
    if (error) { showLoginError(error.message); return; }

    document.getElementById('mfa-setup-qr').innerHTML = `
        <img src="${data.totp.qr_code}" alt="QR Code" style="width:200px;height:200px">
        <p style="font-size:11px;color:var(--slate-400);margin-top:8px;word-break:break-all">Manual code: <code style="font-family:var(--font-mono);color:var(--slate-600)">${data.totp.secret}</code></p>
    `;
    document.getElementById('mfa-setup-section').dataset.factorId = data.id;
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
    if (!name || !email || !password) { showLoginError('Please fill in all fields.'); return; }
    if (password.length < 6) { showLoginError('Password must be at least 6 characters.'); return; }

    try {
        await db.signUp(email, password, name);
        hideLoginError();
        alert('Account created! Check your email to confirm, then sign in.');
        showSignInForm();
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
    document.getElementById('login-loading').style.display = '';

    const profile = await db.getProfile();
    currentUser = profile?.name || profile?.email || 'User';
    currentUserId = profile?.id || null;
    const userEmail = profile?.email || '';

    // Check if user has been archived or deleted
    try {
        const { data: emailRow } = await supa.from('allowed_emails').select('role, status').eq('email', userEmail.toLowerCase()).single();
        if (!emailRow || emailRow.status === 'archived' || emailRow.status === 'revoked') {
            await db.signOut();
            document.getElementById('login-loading').style.display = 'none';
            document.getElementById('login-screen').style.display = 'flex';
            showLoginError('Your account has been archived. Please contact an admin if you need access restored.');
            return;
        }
        // Load role
        currentUserRole = profile?.role || emailRow?.role || 'user';
    } catch(e) {
        // Fallback if allowed_emails check fails
        currentUserRole = profile?.role || 'user';
    }

    // Load global MFA setting
    try { const mfaSetting = await db.getAppSetting('mfa_required'); mfaRequired = mfaSetting !== 'false'; } catch(e) { mfaRequired = true; }

    await loadAllData();

    document.getElementById('login-loading').style.display = 'none';
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
    restoreLastView();
    startInactivityTimer();
    } catch (err) {
        console.error('App initialization error:', err);
        document.getElementById('login-loading').style.display = 'none';
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
        alert('You have been signed out due to inactivity.');
        await logoutUser();
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
    // Re-render current view to reflect mode change
    const activeView = document.querySelector('.view.active');
    if (activeView) {
        if (activeView.id === 'view-all-sensors') renderSensors();
        if (activeView.id === 'view-community' && currentCommunity) showCommunityView(currentCommunity);
        if (activeView.id === 'view-sensor-detail' && currentSensor) showSensorView(currentSensor);
        if (activeView.id === 'view-contact-detail' && currentContact) showContactView(currentContact);
    }
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
                    childrenHtml += `<div class="open-tab-child ${childActive ? 'active' : ''}" onclick="switchToTab('${childTab.id}')" title="${childTab.label}">
                        <span class="open-tab-label">${childTab.label}</span>
                        <span class="open-tab-close" onclick="closeTab('${childTab.id}', event)">&times;</span>
                    </div>`;
                }
            });

            html += `<div class="open-tab-group">
                <div class="open-tab ${isActive ? 'active' : ''}" onclick="switchToTab('${tab.id}')" title="${tab.label}">
                    <span class="open-tab-icon">${tab.icon}</span>
                    <span class="open-tab-label">${tab.label}</span>
                    <span class="open-tab-close" onclick="closeTab('${tab.id}', event)">&times;</span>
                </div>
                <div class="open-tab-children">${childrenHtml}</div>
            </div>`;
        } else {
            html += `<div class="open-tab ${isActive ? 'active' : ''}" onclick="switchToTab('${tab.id}')" title="${tab.label}">
                <span class="open-tab-icon">${tab.icon}</span>
                <span class="open-tab-label">${tab.label}</span>
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

    saveLastView('view', viewName);
}

// ===== DASHBOARD =====
function renderDashboard() {
    const totalSensors = sensors.length;
    const onlineCount = sensors.filter(s => getStatusArray(s).includes('Online')).length;
    const issueCount = getIssueSensorCount();
    const communityCount = COMMUNITIES.filter(c => !isChildCommunity(c.id) && !isCommunityDeactivated(c.id)).length;

    document.getElementById('dashboard-summary').innerHTML = `
        <div class="dash-stat" onclick="showView('all-sensors')">
            <div class="dash-stat-value">${totalSensors}</div>
            <div class="dash-stat-label">Total Sensors</div>
        </div>
        <div class="dash-stat" onclick="sensorTagFilter=''; showView('all-sensors')">
            <div class="dash-stat-value">${onlineCount}</div>
            <div class="dash-stat-label">Online</div>
        </div>
        <div class="dash-stat ${issueCount > 0 ? 'dash-stat-issue' : ''}" onclick="filterSensorsByTag('Issue Sensors')">
            <div class="dash-stat-value">${issueCount}</div>
            <div class="dash-stat-label">Issues</div>
        </div>
        <div class="dash-stat" onclick="showView('communities')">
            <div class="dash-stat-value">${communityCount}</div>
            <div class="dash-stat-label">Communities</div>
        </div>
        <div class="dash-stat" onclick="showView('service')">
            <div class="dash-stat-value">${getActiveTicketCount()}</div>
            <div class="dash-stat-label">Service Tickets</div>
        </div>
        <div class="dash-stat" onclick="showView('audits')">
            <div class="dash-stat-value">${audits.filter(a => a.status === 'Scheduled' || a.status === 'In Progress').length}</div>
            <div class="dash-stat-label">Active Audits</div>
        </div>
    `;
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
        return `
            <div class="community-row parent-row" onclick="showCommunity('${c.id}')">
                <span class="parent-expand-arrow open" onclick="event.stopPropagation(); toggleChildList('${c.id}')">&#9654;</span>
                <div class="community-row-info">
                    <span class="community-row-name">${c.name}</span>
                    ${tagsHtml}
                    <span class="community-row-meta">${childCount} site${childCount !== 1 ? 's' : ''} &middot; ${totalSensors} sensor${totalSensors !== 1 ? 's' : ''}</span>
                </div>
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
        return `
            <div class="community-row child-row" onclick="showCommunity('${c.id}')">
                <div class="community-row-info">
                    <span class="community-row-name">${c.name}</span>
                    ${tagsHtml}
                </div>
                <div class="community-row-sensors">${sensorListStr}</div>
            </div>
        `;
    }

    // Regular community (no parent, no children)
    const sensorListStr = commSensors.length > 0
        ? commSensors.map(s => s.id).join(', ')
        : 'No sensors';
    return `
        <div class="community-row" onclick="showCommunity('${c.id}')">
            <div class="community-row-info">
                <span class="community-row-name">${c.name}</span>
                ${tagsHtml}
            </div>
            <div class="community-row-sensors">${sensorListStr}</div>
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

function renderCommunitiesList() {
    const search = (document.getElementById('community-search')?.value || '').toLowerCase();
    const isSearching = search.length > 0;

    let filtered = COMMUNITIES.filter(c => {
        if (search && !c.name.toLowerCase().includes(search)) return false;
        if (communityTagFilter && !getCommunityTags(c.id).includes(communityTagFilter)) return false;
        return true;
    });

    renderCommunityTagFilters();

    const container = document.getElementById('communities-list-container');

    if (isSearching) {
        container.innerHTML = filtered.map(c => renderCommunityCard(c)).join('')
            || '<div class="empty-state">No communities found.</div>';
    } else {
        // Only render top-level communities (parents + standalone); children rendered inside parents
        const topLevel = filtered.filter(c => !isChildCommunity(c.id));
        const activeTL = topLevel.filter(c => !isCommunityDeactivated(c.id));
        const deactivatedTL = topLevel.filter(c => isCommunityDeactivated(c.id));

        let html = activeTL.map(c => renderCommunityCard(c)).join('');

        // Orphaned children whose parent didn't pass filter
        const childrenInFilter = filtered.filter(c => isChildCommunity(c.id));
        childrenInFilter.forEach(child => {
            const parentInList = topLevel.find(p => p.id === communityParents[child.id]);
            if (!parentInList && !isCommunityDeactivated(child.id)) {
                html += renderCommunityCard(child);
            }
        });

        // Deactivated at bottom
        if (deactivatedTL.length > 0) {
            html += '<div class="deactivated-section-header">Deactivated Communities</div>';
            html += deactivatedTL.map(c => {
                const card = renderCommunityCard(c);
                return card.replace('class="community-row', 'class="community-row community-row-deactivated');
            }).join('');
        }

        container.innerHTML = html || '<div class="empty-state">No communities found.</div>';
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
        'In Transit': 'badge-transit',
        'Service at Quant': 'badge-service-quant',
        'Collocation': 'badge-collocation',
        'Auditing a Community': 'badge-auditing',
        'Lab Storage': 'badge-lab-storage',
        'Needs Repair': 'badge-needs-repair',
        'Ready for Deployment': 'badge-ready',
        'PM Sensor Issue': 'badge-issue-orange',
        'Gaseous Sensor Issue': 'badge-issue-orange',
        'SD Card Issue': 'badge-issue-yellow',
        'Power Failure': 'badge-issue-red',
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

function getStatusDisplay(s) {
    return getStatusArray(s).join(', ') || '—';
}

function renderStatusBadges(s, clickable) {
    const statuses = getStatusArray(s);
    if (statuses.length === 0) {
        if (clickable) return `<span class="editable-field" onclick="openStatusChangeModal('${s.id}')">No status set</span>`;
        return '—';
    }
    return statuses.map(st => {
        const cls = clickable ? 'badge-clickable' : '';
        if (st === 'Quant Ticket in Progress' && clickable) {
            const activeTicket = getActiveTicketsForSensor(s.id)[0];
            const ticketClick = activeTicket ? `onclick="openTicketDetail('${activeTicket.id}')"` : `onclick="openStatusChangeModal('${s.id}')"`;
            return `<span class="badge ${getStatusBadgeClass(st)} ${cls}" ${ticketClick}>${st}</span>`;
        }
        const onclick = clickable ? `onclick="openStatusChangeModal('${s.id}')"` : '';
        return `<span class="badge ${getStatusBadgeClass(st)} ${cls}" ${onclick}>${st}</span>`;
    }).join(' ');
}

function getCommunityName(id) {
    const c = COMMUNITIES.find(c => c.id === id);
    return c ? c.name : id || '—';
}

const ALL_SENSOR_COLUMNS = [
    { key: 'status', label: 'Status', sortable: true, removable: false },
    { key: 'community', label: 'Community', sortable: true, removable: false },
    { key: 'location', label: 'Location', sortable: true, removable: true },
    { key: 'dateInstalled', label: 'Install Date', sortable: true, removable: true },
    { key: 'collocationDates', label: 'Most Recent Collocation', sortable: false, removable: true },
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
        if (!confirm(`Permanently delete "${cf.label}"? This removes the field and all its data from every sensor. This cannot be undone.`)) return;
        customSensorFields = customSensorFields.filter(f => f.key !== cfKey);
        saveData('customSensorFields', customSensorFields);
        sensors.forEach(s => { if (s.customFields) delete s.customFields[cfKey]; });
        saveCustomFieldData();
    } else {
        const col = ALL_SENSOR_COLUMNS.find(c => c.key === key);
        if (!confirm(`Hide "${col?.label || key}" column? You can restore it later in setup mode.`)) return;
        hiddenColumns.push(key);
        saveData('hiddenSensorColumns', hiddenColumns);
    }
    renderSensorTableHeader();
    renderSensors();
    if (currentSensor) showSensorView(currentSensor);
}

function restoreHiddenColumns() {
    const names = hiddenColumns.map(key => ALL_SENSOR_COLUMNS.find(c => c.key === key)?.label || key).join(', ');
    if (!confirm(`Restore hidden columns: ${names}?`)) return;
    hiddenColumns = [];
    saveData('hiddenSensorColumns', hiddenColumns);
    renderSensorTableHeader();
    renderSensors();
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
                ${('<option value="">— None —</option>' + COMMUNITIES.map(c => `<option value="${c.id}" ${s.community === c.id ? 'selected' : ''}>${c.name}</option>`).join(''))}
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

    if (field === 'status') {
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

    // Track old value for phone/email logging
    const oldVal = c[field] || '';

    if (field === 'active') {
        c.active = el.value === 'true';
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
        const note = {
            id: generateId('n'), date: nowDatetime(), type: 'Info Edit',
            text: `${c.name} ${action}.`,
            createdBy: getCurrentUserName(), createdById: currentUserId,
            taggedSensors: [], taggedCommunities: c.community ? [c.community] : [], taggedContacts: [contactId],
        };
        notes.push(note); persistNote(note);
    }

    // Auto-log phone/email changes (not in setup mode)
    if (!setupMode && (field === 'email' || field === 'phone') && oldVal !== newVal) {
        const label = field === 'email' ? 'Email' : 'Phone';
        const note = {
            id: generateId('n'),
            date: nowDatetime(),
            type: 'Info Edit',
            text: `${c.name} ${label.toLowerCase()} changed from "${oldVal || '(empty)'}" to "${newVal || '(empty)'}".`,
            createdBy: getCurrentUserName(), createdById: currentUserId,
            taggedSensors: [],
            taggedCommunities: c.community ? [c.community] : [],
            taggedContacts: [contactId],
        };
        notes.push(note); persistNote(note);
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
    document.getElementById('sensor-collocation-input').value = s.collocationDates || '';
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
        collocationDates: document.getElementById('sensor-collocation-input').value.trim(),
    };

    if (editId) {
        const oldSensor = sensors.find(s => s.id === editId);
        if (!oldSensor) return;

        // Detect changes
        const fieldLabels = {
            soaTagId: 'SOA Tag ID', type: 'Type', status: 'Status',
            community: 'Community', location: 'Location',
            datePurchased: 'Purchase Date', collocationDates: 'Most Recent Collocation'
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
            alert('A sensor with that ID already exists.');
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

    const note = {
        id: generateId('n'),
        date: statusDate,
        type: 'Status Change',
        text: noteText,
        additionalInfo: additionalInfo || '',
        createdBy: getCurrentUserName(), createdById: currentUserId,
        taggedSensors: [sensorId],
        taggedCommunities: s.community ? [s.community] : [],
        taggedContacts: mentionedContacts,
    };

    if (!setupMode) { notes.push(note); persistNote(note); }
    closeModal('modal-status-change');
    buildSensorSidebar();
    renderSensors();
    if (currentSensor === sensorId) showSensorView(sensorId);
    if (currentCommunity) showCommunityView(currentCommunity);
}

// ===== MOVE SENSOR =====
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

    s.community = toCommunityId;
    s.dateInstalled = moveDate.split('T')[0] || nowDatetime().split('T')[0];
    persistSensor(s);

    let noteText = `${sensorId} removed from ${fromName} and brought to ${toName}.`;

    const mentionedContacts = parseMentionedContacts(additionalInfo);
    const taggedCommunities = [fromId, toCommunityId].filter(Boolean);

    const note = {
        id: generateId('n'),
        date: moveDate,
        type: 'Movement',
        text: noteText,
        additionalInfo: additionalInfo || '',
        createdBy: getCurrentUserName(), createdById: currentUserId,
        taggedSensors: [sensorId],
        taggedCommunities: taggedCommunities,
        taggedContacts: mentionedContacts,
    };

    if (!setupMode) { notes.push(note); persistNote(note); }
    closeModal('modal-move-sensor');
    renderSensors();
    if (currentSensor === sensorId) showSensorView(sensorId);
    if (currentCommunity) showCommunityView(currentCommunity);
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
                <select class="inline-edit-select inline-edit-status" data-sensor="${s.id}" data-field="status" multiple onchange="inlineSaveSensor(this)">
                    <option value="" ${currentStatuses.length === 0 ? 'selected' : ''}>— No Status —</option>
                    ${ALL_STATUSES.map(st => `<option value="${st}" ${currentStatuses.includes(st) ? 'selected' : ''}>${st}</option>`).join('')}
                </select>
            </div>
            <div class="info-item"><label>Community</label>
                <select class="inline-edit-select" data-sensor="${s.id}" data-field="community" onchange="inlineSaveSensor(this); showSensorView('${s.id}')">
                    ${'<option value="">— None —</option>' + [...COMMUNITIES].sort((a, b) => a.name.localeCompare(b.name)).map(c => `<option value="${c.id}" ${s.community === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
                </select>
            </div>
            <div class="info-item"><label>Location</label>
                <input class="inline-edit-input" data-sensor="${s.id}" data-field="location" value="${s.location || ''}" placeholder="Address or GPS coordinates" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Install Date</label>
                <input class="inline-edit-input" type="date" data-sensor="${s.id}" data-field="dateInstalled" value="${s.dateInstalled || ''}" onblur="inlineSaveSensor(this)">
            </div>
            <div class="info-item"><label>Most Recent Collocation</label>
                <input class="inline-edit-input" data-sensor="${s.id}" data-field="collocationDates" value="${s.collocationDates || ''}" placeholder="e.g. Floyd Dryden, Mar 5-25" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>SOA Tag ID</label>
                <input class="inline-edit-input" data-sensor="${s.id}" data-field="soaTagId" value="${s.soaTagId || ''}" placeholder="SOA Tag" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Purchase Date</label>
                <input class="inline-edit-input" type="date" data-sensor="${s.id}" data-field="datePurchased" value="${s.datePurchased || ''}" onblur="inlineSaveSensor(this)">
            </div>
        `;
    } else {
        document.getElementById('sensor-info-card').innerHTML = `
            <div class="info-item"><label>Type</label><p class="editable-field" onclick="inlineEditSensorType('${s.id}')">${s.type}</p></div>
            <div class="info-item"><label>Status</label><p>${renderStatusBadges(s, true)}</p></div>
            <div class="info-item"><label>Community</label><p>${getCommunityName(s.community)} <a class="move-sensor-link" onclick="openMoveSensorModal('${s.id}')">Move &rarr;</a></p></div>
            <div class="info-item"><label>Location</label><p class="editable-field" onclick="inlineEditSensor('${s.id}', 'location')">${s.location || '<span class="field-placeholder">Address or GPS coordinates</span>'}</p></div>
            <div class="info-item"><label>Install Date</label><p>${s.dateInstalled || '—'} <a class="move-sensor-link" onclick="viewInstallHistory()">View history &rarr;</a></p></div>
            <div class="info-item"><label>Most Recent Collocation</label><p>${(() => { const c = getMostRecentCollocation(s.id); return c ? `${c.communityName}, ${c.dateRange}` : (s.collocationDates || '\u2014'); })()} <a class="move-sensor-link" onclick="viewCollocationHistory()">View history &rarr;</a></p></div>
            <div class="info-item"><label>SOA Tag ID</label><p class="editable-field" onclick="inlineEditSensor('${s.id}', 'soaTagId')">${s.soaTagId || '—'}</p></div>
            <div class="info-item"><label>Purchase Date</label><p class="editable-field" onclick="inlineEditSensor('${s.id}', 'datePurchased')">${s.datePurchased || '—'}</p></div>
            ${customSensorFields.map(cf => `<div class="info-item"><label>${cf.label}</label><p class="editable-field" onclick="editCustomField('${s.id}', '${cf.key}')">${(s.customFields || {})[cf.key] || '—'}</p></div>`).join('')}
            ${setupMode ? '<div class="info-item"><button class="btn btn-sm" onclick="openAddFieldModal()" style="margin-top:18px">+ Add Field</button></div>' : ''}
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

    resetTabs(document.getElementById('view-sensor-detail'));

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-sensor-detail').classList.add('active');
    pushViewHistory();
}

function inlineEditSensor(sensorId, field) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;

    const labels = { soaTagId: 'SOA Tag ID', location: 'Location', datePurchased: 'Purchase Date', collocationDates: 'Most Recent Collocation' };
    const label = labels[field] || field;
    const oldVal = s[field] || '';
    const promptMsg = field === 'location' ? `Edit ${label} (enter an address or GPS coordinates):` : `Edit ${label}:`;
    const newVal = prompt(promptMsg, oldVal);
    if (newVal === null || newVal.trim() === oldVal) return;

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
        ? `<span class="community-parent-breadcrumb"><span class="clickable" onclick="showCommunity('${parent.id}')">${parent.name}</span> &rsaquo; </span>`
        : '';
    document.getElementById('community-name').innerHTML = parentHtml + community.name;

    const tags = getCommunityTags(communityId);
    const badgeContainer = document.getElementById('community-type-badge');
    badgeContainer.innerHTML = tags.map(t =>
        `<span class="community-type-badge clickable-badge" onclick="filterCommunitiesByTag('${t}')">${t}</span>`
    ).join(' ') +
    ` <span class="community-tag-edit" onclick="openEditCommunityTags('${communityId}')">+ Edit Tags</span>`;

    // Show/hide sub-community button (only for non-child communities)
    const isDeactivated = isCommunityDeactivated(communityId);
    const isChild = isChildCommunity(communityId);
    document.getElementById('add-sub-community-btn').style.display = isChild || isDeactivated ? 'none' : '';
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
        <th>Location</th><th>Install Date</th><th>Most Recent Collocation</th><th>SOA Tag ID</th><th>Purchase Date</th><th>Actions</th>
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
                    <td><input class="inline-edit-input" data-sensor="${s.id}" data-field="collocationDates" value="${s.collocationDates || ''}" placeholder="e.g. Mar 5-13" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
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
            <td>${s.collocationDates || '—'}</td>
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
        const aI = a.active === false ? 1 : 0, bI = b.active === false ? 1 : 0;
        if (aI !== bI) return aI - bI;
        return a.name.localeCompare(b.name);
    });
    document.getElementById('community-contacts-list').innerHTML = commContacts.length ? `
        <div class="table-container"><table class="contacts-table"><thead><tr>
            <th>Name</th><th>Role</th><th>Organization</th><th>Email</th><th>Phone</th><th>Status</th>
        </tr></thead><tbody>
        ${commContacts.map(c => `
            <tr class="${c.active === false ? 'contact-row-inactive' : ''}" onclick="showContactDetail('${c.id}')" style="cursor:pointer">
                <td><span class="clickable">${c.name}</span></td>
                <td>${c.role || '—'}</td>
                <td>${c.org || '—'}</td>
                <td>${c.email ? `<a href="#" class="clickable" onclick="event.stopPropagation(); openQuickEmail('${c.id}')">${c.email}</a>` : '—'}</td>
                <td>${c.phone ? `<a href="tel:${c.phone}" class="clickable" onclick="event.stopPropagation()">${c.phone}</a>` : '—'}</td>
                <td>${c.active === false ? '<span class="contact-inactive-badge">Inactive</span>' : '<span style="color:var(--aurora-green);font-size:11px;font-weight:600">Active</span>'}</td>
            </tr>
        `).join('')}
        </tbody></table></div>
    ` : '<div class="empty-state">No contacts for this community.</div>';

    // History — include notes tagged to this community, its children, or sensors in this community
    const childIds = children.map(c => c.id);
    const allCommunityIds = [communityId, ...childIds];
    const sensorIdsInCommunity = sensors.filter(s => allCommunityIds.includes(s.community)).map(s => s.id);
    const contactIdsInCommunity = contacts.filter(c => allCommunityIds.includes(c.community)).map(c => c.id);

    const commNotes = notes.filter(n => {
        if (n.taggedCommunities && n.taggedCommunities.some(id => allCommunityIds.includes(id))) return true;
        if (n.taggedSensors && n.taggedSensors.some(id => sensorIdsInCommunity.includes(id))) return true;
        if (n.taggedContacts && n.taggedContacts.some(id => contactIdsInCommunity.includes(id))) return true;
        return false;
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
            alert('File upload failed: ' + err.message);
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

    grid.innerHTML = files.map(f => {
        const fileUrl = f.storagePath ? '' : (f.data || ''); // fallback for old base64 data
        const viewOnclick = f.storagePath
            ? `onclick="openStorageFile('${f.storagePath}')"`
            : `onclick="openImageLightbox('${fileUrl}')"`;
        const downloadHref = f.storagePath ? '#' : fileUrl;
        const downloadOnclick = f.storagePath
            ? `onclick="event.preventDefault(); downloadStorageFile('${f.storagePath}', '${f.name}')"`
            : '';

        if (f.type && f.type.startsWith('image/')) {
            const imgSrc = f.storagePath ? db.getFileUrl(f.storagePath) : fileUrl;
            return `
                <div class="file-card">
                    <img src="${imgSrc}" alt="${f.name}" ${viewOnclick}>
                    <div class="file-info">
                        <div>
                            <div class="file-name">${f.name}</div>
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
                        <div class="pdf-label">${f.name}</div>
                    </div>
                    <div class="file-info">
                        <div>
                            <div class="file-name">${f.name}</div>
                            <div class="file-date">${formatDate(f.date)}</div>
                        </div>
                        <div>
                            <a class="btn btn-sm" href="${downloadHref}" ${downloadOnclick} download="${f.name}">Download</a>
                            <button class="btn btn-sm btn-danger" onclick="deleteFile('${communityId}', '${f.id}', '${f.storagePath || ''}')">Delete</button>
                        </div>
                    </div>
                </div>
            `;
        }
    }).join('');
}

async function openStorageFile(storagePath) {
    const url = await db.getSignedUrl(storagePath);
    openImageLightbox(url);
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
    const url = await db.getSignedUrl(storagePath);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
}

async function deleteFile(communityId, fileId, storagePath) {
    if (!confirm('Delete this file?')) return;
    try {
        await db.deleteFile(fileId, storagePath);
        communityFiles[communityId] = (communityFiles[communityId] || []).filter(f => f.id !== fileId);
        renderCommunityFiles(communityId);
    } catch (err) {
        console.error('Delete error:', err);
        alert('Delete failed: ' + err.message);
    }
}

// ===== CONTACTS =====
function renderContacts() {
    const search = (document.getElementById('contact-search')?.value || '').toLowerCase();
    let filtered = contacts.filter(c => {
        if (search && !c.name.toLowerCase().includes(search) && !getCommunityName(c.community).toLowerCase().includes(search)) return false;
        return true;
    });

    // Group by community, sorted alphabetically
    const groups = {};
    filtered.forEach(c => {
        const commName = getCommunityName(c.community);
        if (!groups[commName]) groups[commName] = [];
        groups[commName].push(c);
    });

    // Sort community names alphabetically
    const sortedCommunities = Object.keys(groups).sort();

    // Sort: active first alphabetically, then inactive alphabetically
    sortedCommunities.forEach(comm => {
        groups[comm].sort((a, b) => {
            const aInactive = a.active === false ? 1 : 0;
            const bInactive = b.active === false ? 1 : 0;
            if (aInactive !== bInactive) return aInactive - bInactive;
            return a.name.localeCompare(b.name);
        });
    });

    const container = document.getElementById('contacts-grid');
    container.innerHTML = sortedCommunities.map(commName => `
        <div class="contacts-group">
            <div class="contacts-group-header">${commName}</div>
            <div class="table-container">
                <table class="contacts-table"><thead><tr>
                    <th>Name</th><th>Role</th><th>Organization</th><th>Email</th><th>Phone</th><th>Status</th>
                </tr></thead><tbody>
                ${groups[commName].map(c => `
                    <tr class="${c.active === false ? 'contact-row-inactive' : ''}" onclick="showContactDetail('${c.id}')" style="cursor:pointer">
                        <td><span class="clickable">${c.name}</span></td>
                        <td>${c.role || '—'}</td>
                        <td>${c.org || '—'}</td>
                        <td>${c.email ? `<a href="#" class="clickable" onclick="event.stopPropagation(); openQuickEmail('${c.id}')">${c.email}</a>` : '—'}</td>
                        <td>${c.phone ? `<a href="tel:${c.phone}" class="clickable" onclick="event.stopPropagation()">${c.phone}</a>` : '—'}</td>
                        <td>${c.active === false ? '<span class="contact-inactive-badge">Inactive</span>' : '<span style="color:var(--aurora-green);font-size:11px;font-weight:600">Active</span>'}</td>
                    </tr>
                `).join('')}
                </tbody></table>
            </div>
        </div>
    `).join('') || '<div class="empty-state">No contacts found.</div>';
}

function openAddContactModal() {
    document.getElementById('contact-modal-title').textContent = 'Add New Contact';
    document.getElementById('contact-form').reset();
    document.getElementById('contact-edit-id').value = '';
    document.getElementById('contact-active-yes').checked = true;
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
        alert('Please enter a valid email address.');
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
    };

    let statusChanged = null;
    let emailChanged = false;
    let phoneChanged = false;
    let oldEmail = '';
    let oldPhone = '';

    if (editId) {
        const old = contacts.find(c => c.id === editId);
        if (old) {
            const wasActive = old.active !== false;
            if (wasActive && !isActive) statusChanged = 'deactivated';
            else if (!wasActive && isActive) statusChanged = 'reactivated';
            if ((old.email || '') !== data.email) { emailChanged = true; oldEmail = old.email || ''; }
            if ((old.phone || '') !== data.phone) { phoneChanged = true; oldPhone = old.phone || ''; }
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

    // Auto-log email/phone changes (not in setup mode)
    if (!setupMode && editId) {
        if (emailChanged) {
            const note = { id: generateId('n'), date: nowDatetime(), type: 'Info Edit',
                text: `${data.name} email changed from "${oldEmail || '(empty)'}" to "${data.email || '(empty)'}".`,
                createdBy: getCurrentUserName(), createdById: currentUserId, taggedSensors: [], taggedCommunities: data.community ? [data.community] : [], taggedContacts: [data.id] };
            notes.push(note); persistNote(note);
        }
        if (phoneChanged) {
            const note = { id: generateId('n'), date: nowDatetime(), type: 'Info Edit',
                text: `${data.name} phone changed from "${oldPhone || '(empty)'}" to "${data.phone || '(empty)'}".`,
                createdBy: getCurrentUserName(), createdById: currentUserId, taggedSensors: [], taggedCommunities: data.community ? [data.community] : [], taggedContacts: [data.id] };
            notes.push(note); persistNote(note);
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
    if (!pendingContactStatusNote) return;
    const p = pendingContactStatusNote;
    const date = document.getElementById('contact-status-note-date').value || nowDatetime();

    const noteText = p.action === 'deactivated'
        ? `${p.contactName} marked as inactive.`
        : `${p.contactName} reactivated.`;

    const note = {
        id: generateId('n'),
        date: date,
        type: 'Info Edit',
        text: noteText,
        createdBy: getCurrentUserName(), createdById: currentUserId,
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

    document.getElementById('contact-detail-name').innerHTML = c.name + (c.active === false ? '<span class="contact-inactive-badge" style="margin-left:10px;font-size:12px">Inactive</span>' : '');
    if (setupMode) {
        document.getElementById('contact-info-card').innerHTML = `
            <div class="info-item"><label>Name</label>
                <input class="inline-edit-input" data-contact="${c.id}" data-field="name" value="${c.name}" onblur="inlineSaveContact(this); showContactView('${c.id}')" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Role</label>
                <input class="inline-edit-input" data-contact="${c.id}" data-field="role" value="${c.role || ''}" placeholder="Role / Title" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Community</label>
                <select class="inline-edit-select" data-contact="${c.id}" data-field="community" onchange="inlineSaveContact(this)">
                    ${'<option value="">— Select —</option>' + [...COMMUNITIES].sort((a, b) => a.name.localeCompare(b.name)).map(cm => `<option value="${cm.id}" ${c.community === cm.id ? 'selected' : ''}>${cm.name}</option>`).join('')}
                </select>
            </div>
            <div class="info-item"><label>Organization</label>
                <input class="inline-edit-input" data-contact="${c.id}" data-field="org" value="${c.org || ''}" placeholder="Organization" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Email</label>
                <input class="inline-edit-input" type="email" data-contact="${c.id}" data-field="email" value="${c.email || ''}" placeholder="Email" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Phone</label>
                <input class="inline-edit-input" type="tel" data-contact="${c.id}" data-field="phone" value="${c.phone || ''}" placeholder="Phone" onblur="inlineSaveContact(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Status</label>
                <select class="inline-edit-select" data-contact="${c.id}" data-field="active" onchange="inlineSaveContact(this)">
                    <option value="true" ${c.active !== false ? 'selected' : ''}>Active</option>
                    <option value="false" ${c.active === false ? 'selected' : ''}>Inactive</option>
                </select>
            </div>
        `;
    } else {
        document.getElementById('contact-info-card').innerHTML = `
            <div class="info-item"><label>Role</label><p>${c.role || '—'}</p></div>
            <div class="info-item"><label>Community</label><p><span class="clickable" onclick="showCommunity('${c.community}')">${getCommunityName(c.community)}</span></p></div>
            <div class="info-item"><label>Organization</label><p>${c.org || '—'}</p></div>
            <div class="info-item"><label>Email</label><p>${c.email ? `<a href="#" class="clickable" onclick="openQuickEmail('${c.id}')">${c.email}</a>` : '—'}</p></div>
            <div class="info-item"><label>Phone</label><p>${c.phone ? `<a href="tel:${c.phone}" class="clickable">${c.phone}</a>` : '—'}</p></div>
            <div class="info-item"><label>Status</label><p>${c.active === false ? 'Inactive' : 'Active'}</p></div>
        `;
    }

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

function openEditCurrentContact() {
    if (!currentContact) return;
    const c = contacts.find(x => x.id === currentContact);
    if (!c) return;
    document.getElementById('contact-modal-title').textContent = 'Edit Contact';
    document.getElementById('contact-edit-id').value = c.id;
    document.getElementById('contact-name-input').value = c.name;
    document.getElementById('contact-role-input').value = c.role || '';
    populateGroupedCommunitySelect('contact-community-input');
    document.getElementById('contact-community-input').value = c.community;
    document.getElementById('contact-email-input').value = c.email || '';
    document.getElementById('contact-phone-input').value = c.phone || '';
    document.getElementById('contact-org-input').value = c.org || '';
    // Set active/inactive
    if (c.active === false) {
        document.getElementById('contact-active-no').checked = true;
    } else {
        document.getElementById('contact-active-yes').checked = true;
    }
    // Show delete button
    document.getElementById('delete-contact-btn').style.display = '';
    openModal('modal-add-contact');
}

function deleteCurrentContact() {
    if (!currentContact) return;
    const c = contacts.find(x => x.id === currentContact);
    if (!c) return;
    if (!confirm(`Delete contact "${c.name}"? This cannot be undone.`)) return;

    db.deleteContact(currentContact).catch(err => console.error('Delete error:', err));
    contacts = contacts.filter(x => x.id !== currentContact);
    closeModal('modal-add-contact'); showSuccessToast('Contact saved');

    // Close the tab and go to contacts list
    const tabId = getTabId('contact', currentContact);
    const tabIdx = openTabs.findIndex(t => t.id === tabId);
    if (tabIdx >= 0) openTabs.splice(tabIdx, 1);
    activeTabId = null;
    renderOpenTabs();
    currentContact = null;
    showView('contacts');
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
    renderEmailRecipients();
    document.getElementById('email-subject').value = '';
    document.getElementById('email-body').value = '';
    openModal('modal-email');
}

function renderEmailRecipients() {
    const list = document.getElementById('email-recipients-list');

    // Group active contacts by community alphabetically
    const groups = {};
    contacts.filter(c => c.active !== false).forEach(c => {
        const commName = getCommunityName(c.community);
        if (!groups[commName]) groups[commName] = [];
        groups[commName].push(c);
    });

    const sortedCommunities = Object.keys(groups).sort();

    list.innerHTML = sortedCommunities.map(commName => {
        const groupContacts = groups[commName].sort((a, b) => a.name.localeCompare(b.name));
        return `
            <div class="email-community-header">${commName}</div>
            ${groupContacts.map(c => `
                <div class="email-recipient-row">
                    <input type="checkbox" id="email-cb-${c.id}" data-contact-id="${c.id}" data-community="${c.community}" checked>
                    <label for="email-cb-${c.id}">${c.name}</label>
                    <span class="recipient-community">${c.email || 'no email'}</span>
                </div>
            `).join('')}
        `;
    }).join('');
}

function emailSelectAll() {
    document.querySelectorAll('#email-recipients-list input[type="checkbox"]').forEach(cb => cb.checked = true);
}

function emailDeselectAll() {
    document.querySelectorAll('#email-recipients-list input[type="checkbox"]').forEach(cb => cb.checked = false);
}

function emailShowAll() {
    document.getElementById('email-community-filter').value = '';
    renderEmailRecipients();
    emailDeselectAll();
}

function emailFilterByCommunity() {
    const commId = document.getElementById('email-community-filter').value;
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
        ${filtered.sort((a, b) => a.name.localeCompare(b.name)).map(c => `
            <div class="email-recipient-row">
                <input type="checkbox" id="email-cb-${c.id}" data-contact-id="${c.id}" data-community="${c.community}" checked>
                <label for="email-cb-${c.id}">${c.name}</label>
                <span class="recipient-community">${c.email || 'no email'}</span>
            </div>
        `).join('')}
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
        alert('No contacts with email addresses are selected.');
        return;
    }

    if (!subject || !body) {
        alert('Please enter both a subject and body before sending.');
        return;
    }

    // Open mailto link (works with Outlook and other mail clients)
    const mailtoLink = `mailto:${emails.join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = mailtoLink;

    // Log the communication under each involved contact and community
    const involvedCommunities = [...new Set(selectedContacts.map(c => c.community))];

    const comm = {
        id: 'comm' + Date.now(),
        date: nowDatetime(),
        type: 'Communication',
        commType: 'Email',
        subject: subject,
        fullBody: body,
        text: `[Email] Subject: ${subject}`,
        createdBy: getCurrentUserName(), createdById: currentUserId,
        community: involvedCommunities[0] || '',
        taggedContacts: selectedContactIds,
        taggedCommunities: involvedCommunities,
    };

    comms.push(comm); persistComm(comm);
    closeModal('modal-email');
}

function openQuickEmail(contactId) {
    const c = contacts.find(x => x.id === contactId);
    if (!c || !c.email) return;

    // Open the email modal with just this contact selected
    populateCommunitySelect('email-community-filter');

    // Render only this contact as a recipient
    const list = document.getElementById('email-recipients-list');
    list.innerHTML = `
        <div class="email-community-header">${getCommunityName(c.community)}</div>
        <div class="email-recipient-row">
            <input type="checkbox" id="email-cb-${c.id}" data-contact-id="${c.id}" data-community="${c.community}" checked>
            <label for="email-cb-${c.id}">${c.name}</label>
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

    // Show status change option only when on a sensor page
    const statusGroup = document.getElementById('note-status-change-group');
    const statusCheckbox = document.getElementById('note-change-status');
    const statusList = document.getElementById('note-status-list');
    if (contextType === 'sensor') {
        statusGroup.style.display = '';
        statusCheckbox.checked = false;
        statusList.style.display = 'none';
        const s = sensors.find(x => x.id === contextId);
        renderStatusToggleList('note-status-list', s ? getStatusArray(s) : []);
    } else {
        statusGroup.style.display = 'none';
    }

    // Reset audit link
    document.getElementById('note-audit-link-group').style.display = 'none';

    openModal('modal-add-note');
}

function onNoteTypeChange() {
    const type = document.getElementById('note-type-input').value;
    const linkGroup = document.getElementById('note-audit-link-group');
    if (type === 'Audit') {
        const contextId = document.getElementById('note-context-id').value;
        const contextType = document.getElementById('note-context-type').value;
        // Find relevant audits for this sensor or community
        let relevantAudits;
        if (contextType === 'sensor') {
            relevantAudits = audits.filter(a => a.auditPodId === contextId || a.communityPodId === contextId);
        } else {
            relevantAudits = audits.filter(a => a.communityId === contextId);
        }
        if (relevantAudits.length > 0) {
            linkGroup.style.display = '';
            document.getElementById('note-audit-link-options').innerHTML = relevantAudits.map(a => {
                const cName = COMMUNITIES.find(c => c.id === a.communityId)?.name || a.communityId;
                const dateStr = a.scheduledStart ? `${formatDate(a.scheduledStart)} \u2013 ${formatDate(a.scheduledEnd)}` : '';
                return `<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--slate-600);cursor:pointer;padding:4px 0">
                    <input type="checkbox" class="note-audit-link-cb" value="${a.id}" style="width:15px;height:15px">
                    ${escapeHtml(a.auditPodId)} at ${escapeHtml(cName)} ${dateStr} <span class="audit-status-badge ${AUDIT_STATUS_CSS[a.status]}" style="font-size:10px;padding:1px 6px">${a.status}</span>
                </label>`;
            }).join('');
        } else {
            linkGroup.style.display = 'none';
        }
    } else {
        linkGroup.style.display = 'none';
    }
}

function saveNote(e) {
    e.preventDefault();

    const text = document.getElementById('note-text-input').value.trim();
    const type = document.getElementById('note-type-input').value;
    const noteDate = document.getElementById('note-date-input').value || nowDatetime();

    const sensorTags = getChipValues('tag-sensors-container');

    const communityTags = getChipValues('tag-communities-container')
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
        taggedCommunities: communityTags,
        taggedContacts: contactTags,
    };

    notes.push(note); persistNote(note);

    // Apply status change if checked
    const contextType = document.getElementById('note-context-type').value;
    const contextId = document.getElementById('note-context-id').value;
    if (contextType === 'sensor' && document.getElementById('note-change-status').checked) {
        const newStatuses = getSelectedStatuses('note-status-list');
        const s = sensors.find(x => x.id === contextId);
        if (s && newStatuses.length > 0) {
            const oldStatuses = getStatusArray(s);
            s.status = newStatuses;
            persistSensor(s);

            if (!setupMode) {
                const statusNote = {
                    id: generateId('n'),
                    date: noteDate,
                    type: 'Status Change',
                    text: `${s.id} status changed from "${oldStatuses.join(', ') || '(none)'}" to "${newStatuses.join(', ')}".`,
                    createdBy: getCurrentUserName(), createdById: currentUserId,
                    taggedSensors: [s.id],
                    taggedCommunities: s.community ? [s.community] : [],
                    taggedContacts: [],
                };
                notes.push(statusNote); persistNote(statusNote);
            }
        }
    }

    closeModal('modal-add-note'); showSuccessToast('Note added');

    if (currentCommunity) showCommunityView(currentCommunity);
    if (currentSensor) showSensorView(currentSensor);
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

    if (currentCommunity) showCommunityView(currentCommunity);
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

        const additionalInfoHtml = item.additionalInfo
            ? `<div class="timeline-additional-info"><em>${highlightMentions(escapeHtml(item.additionalInfo))}</em></div>`
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
                <div class="timeline-text">${highlightMentions(escapeHtml(item.text))}${hasFullBody ? ' <small style="color:var(--navy-500)">(click to expand)</small>' : ''}</div>
                ${additionalInfoHtml}
                ${hasFullBody ? `<div class="timeline-text-full">${item.fullBody}</div>` : ''}
                ${attribution}
                ${tags ? `<div class="timeline-tags">${tags}</div>` : ''}
            </div>
        `;
    }).join('');
}

function editTimelineItem(id, isNote) {
    if (isNote) {
        const idx = notes.findIndex(n => n.id === id);
        if (idx < 0) return;
        const newText = prompt('Edit note text:', notes[idx].text);
        if (newText === null || newText.trim() === notes[idx].text) return;
        notes[idx].text = newText.trim();
        supa.from('notes').update({ text: notes[idx].text }).eq('id', id).catch(err => console.error('Edit note error:', err));
    } else {
        const idx = comms.findIndex(c => c.id === id);
        if (idx < 0) return;
        const newText = prompt('Edit communication text:', comms[idx].text);
        if (newText === null || newText.trim() === comms[idx].text) return;
        comms[idx].text = newText.trim();
        supa.from('comms').update({ text: comms[idx].text }).eq('id', id).catch(err => console.error('Edit comm error:', err));
    }
    refreshCurrentView();
}

async function deleteTimelineItem(id, isNote) {
    if (!confirm('Are you sure? Only delete events that were created by accident.')) return;
    try {
        if (isNote) {
            notes = notes.filter(n => n.id !== id);
            await supa.from('note_tags').delete().eq('note_id', id);
            await supa.from('notes').delete().eq('id', id);
        } else {
            comms = comms.filter(c => c.id !== id);
            await supa.from('comm_tags').delete().eq('comm_id', id);
            await supa.from('comms').delete().eq('id', id);
        }
    } catch (err) {
        console.error('Delete error:', err);
    }
    refreshCurrentView();
}

function refreshCurrentView() {
    buildSensorSidebar();
    // Preserve active tab before re-rendering
    const activeTab = document.querySelector('.view.active .tab.active')?.dataset.tab;
    if (currentSensor) showSensorView(currentSensor);
    if (currentCommunity) showCommunityView(currentCommunity);
    if (currentContact) showContactView(currentContact);
    // Restore active tab
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
            const contact = contacts.find(x => x.id === cId);
            return contact ? `<span class="tag tag-contact" onclick="event.stopPropagation(); showContactDetail('${cId}')">${contact.name}</span>` : '';
        }).join('');
    }
    return tags;
}

function highlightMentions(text) {
    return text.replace(/@([\w\s]+?)(?=\.|,|$|@)/g, '<strong style="color:var(--navy-600)">@$1</strong>');
}

function nowDatetime() {
    const now = new Date();
    return now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + 'T' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0');
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    if (typeof dateStr !== 'string') dateStr = String(dateStr);
    // Handle "2026-03-14", "2026-03-14T10:30", and ISO "2026-03-14T10:30:00.000Z"
    const hasTime = dateStr.includes('T') && dateStr.split('T')[1];
    const isUTC = dateStr.endsWith('Z') || dateStr.includes('+');
    let d;
    if (isUTC) {
        // Already has timezone — parse as-is
        d = new Date(dateStr);
    } else if (hasTime) {
        // Local datetime like "2026-03-19T14:30" — parse as local, not UTC
        const [datePart, timePart] = dateStr.split('T');
        const [y, m, day] = datePart.split('-').map(Number);
        const [hr, min] = (timePart || '00:00').split(':').map(Number);
        d = new Date(y, m - 1, day, hr, min);
    } else {
        d = new Date(dateStr + 'T00:00:00');
    }
    const datePart = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    if (hasTime) {
        const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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
                        `<div class="mention-option${i === 0 ? ' selected' : ''}" data-name="${c.name}" data-community="${getCommunityName(c.community)}">
                            <span>${c.name}</span>
                            <span class="mention-community">${getCommunityName(c.community)}</span>
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
            `<option value="${c.id}">${c.name}</option>`
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

    // Check for duplicates
    if (COMMUNITIES.find(c => c.id === id)) {
        alert('A community with that name already exists.');
        return;
    }

    // Add to communities list (sorted)
    COMMUNITIES.push({ id, name });
    COMMUNITIES.sort((a, b) => a.name.localeCompare(b.name));

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
        const note = {
            id: generateId('n'),
            date: nowDatetime(),
            type: 'Info Edit',
            text: `Sub-community "${name}" added under ${getCommunityName(parentId)}.`,
            createdBy: getCurrentUserName(), createdById: currentUserId,
            taggedSensors: [],
            taggedCommunities: [parentId, id],
            taggedContacts: [],
        };
        notes.push(note); persistNote(note);
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

        const note = {
            id: generateId('n'),
            date: nowDatetime(),
            type: 'Info Edit',
            text: `Tag "${tag}" removed from ${community.name}.`,
            createdBy: getCurrentUserName(), createdById: currentUserId,
            taggedSensors: [],
            taggedCommunities: [editingTagsCommunity],
            taggedContacts: [],
        };
        if (!setupMode) { notes.push(note); persistNote(note); }
    } else {
        // Add tag
        if (!communityTags[editingTagsCommunity]) communityTags[editingTagsCommunity] = [];
        communityTags[editingTagsCommunity].push(tag);

        const note = {
            id: generateId('n'),
            date: nowDatetime(),
            type: 'Info Edit',
            text: `Tag "${tag}" added to ${community.name}.`,
            createdBy: getCurrentUserName(), createdById: currentUserId,
            taggedSensors: [],
            taggedCommunities: [editingTagsCommunity],
            taggedContacts: [],
        };
        if (!setupMode) { notes.push(note); persistNote(note); }
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
        const note = {
            id: generateId('n'),
            date: nowDatetime(),
            type: 'Info Edit',
            text: `Tag "${tag}" added to ${community.name}.`,
            createdBy: getCurrentUserName(), createdById: currentUserId,
            taggedSensors: [],
            taggedCommunities: [editingTagsCommunity],
            taggedContacts: [],
        };
        if (!setupMode) { notes.push(note); persistNote(note); }
        persistCommunityTags(editingTagsCommunity, getCommunityTags(editingTagsCommunity));
    }

    input.value = '';
    renderEditTagsList();
    buildSidebar(); // Update sidebar with new tag
    if (currentCommunity === editingTagsCommunity) showCommunityView(editingTagsCommunity);
}

// ===== STATUS TOGGLE LIST =====
const ALL_STATUSES = [
    'Online', 'Offline', 'In Transit', 'Service at Quant', 'Collocation',
    'Auditing a Community', 'Lab Storage', 'Needs Repair', 'Ready for Deployment',
    'PM Sensor Issue', 'Gaseous Sensor Issue', 'SD Card Issue', 'Power Failure', 'Lost Connection',
    'Quant Ticket in Progress'
];

function renderStatusToggleList(containerId, selectedStatuses) {
    const container = document.getElementById(containerId);
    container.innerHTML = ALL_STATUSES.map(st => {
        const isActive = selectedStatuses.includes(st);
        const badgeClass = getStatusBadgeClass(st);
        return `<span class="status-toggle-option ${isActive ? 'active' : ''}" data-status="${st}" onclick="toggleStatusOption(this)">
            <span class="badge ${badgeClass}" style="pointer-events:none">${st}</span>
        </span>`;
    }).join('');
}

function toggleStatusOption(el) {
    el.classList.toggle('active');
}

function getSelectedStatuses(containerId) {
    const container = document.getElementById(containerId);
    return Array.from(container.querySelectorAll('.status-toggle-option.active')).map(el => el.dataset.status);
}

const FILTER_GROUPS = {
    '_notes': ['General', 'Audit', 'Site Work', 'Issue', 'Installation', 'Removal', 'Maintenance'],
    '_changes': ['Info Edit', 'Status Change', 'Movement'],
    '_service': ['Service'],
};

function filterSensorHistory() {
    if (!currentSensor) return;
    const filterVal = document.getElementById('sensor-history-filter')?.value || '';

    let sensorNotes = notes.filter(n => n.taggedSensors && n.taggedSensors.includes(currentSensor));

    if (filterVal && FILTER_GROUPS[filterVal]) {
        sensorNotes = sensorNotes.filter(n => FILTER_GROUPS[filterVal].includes(n.type));
    } else if (filterVal) {
        sensorNotes = sensorNotes.filter(n => n.type === filterVal);
    }

    renderTimeline('sensor-history-timeline', sensorNotes);
}

// ===== INLINE COMMUNITY CHANGE (sensor detail) =====


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
    chip.innerHTML = `${value} <span class="tag-chip-remove" onclick="this.parentElement.remove()">&times;</span>`;
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
        [...COMMUNITIES].sort((a, b) => a.name.localeCompare(b.name)).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
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
        <div class="info-item"><label>Name</label><p>${profile?.name || '—'}</p></div>
        <div class="info-item"><label>Email</label><p>${userEmail}</p></div>
    `;

    await renderAllowedUsers(userEmail);
    await renderMfaSettings();
}

async function renderAllowedUsers(currentEmail) {
    const isAdmin = currentUserRole === 'admin';
    const { data, error } = await supa.from('allowed_emails').select('*').order('email');
    if (error) { console.error(error); return; }

    // Show/hide admin-only controls
    document.getElementById('settings-add-user-row').style.display = isAdmin ? '' : 'none';

    const active = (data || []).filter(r => r.status === 'active');
    const archived = (data || []).filter(r => r.status === 'archived' || r.status === 'revoked');

    document.getElementById('settings-active-users').innerHTML = active.map(row => {
        const isYou = row.email.toLowerCase() === currentEmail.toLowerCase();
        const roleBadge = row.role === 'admin'
            ? '<span style="background:var(--navy-800);color:white;padding:1px 8px;border-radius:8px;font-size:10px;font-weight:600;margin-left:6px">Admin</span>'
            : '<span style="background:var(--slate-100);color:var(--slate-500);padding:1px 8px;border-radius:8px;font-size:10px;font-weight:600;margin-left:6px">User</span>';
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
        return `<div class="settings-user-row">
            <span>
                <span class="settings-user-email">${escapeHtml(row.email)}</span>
                ${roleBadge}
                ${isYou ? '<span class="settings-user-you">(you)</span>' : ''}
            </span>
            <span style="display:flex;gap:6px;align-items:center">${roleToggle}${archiveBtn}${deleteBtn}</span>
        </div>`;
    }).join('') || '<p style="color:var(--slate-400);font-size:13px">No active users.</p>';

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

    // MFA admin toggle
    const mfaAdminSection = document.getElementById('settings-mfa-admin-section');
    if (mfaAdminSection) {
        mfaAdminSection.style.display = isAdmin ? '' : 'none';
        if (isAdmin) {
            document.getElementById('settings-mfa-toggle').innerHTML = `
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
                    <input type="checkbox" ${mfaRequired ? 'checked' : ''} onchange="toggleMfaRequirement(this.checked)" style="width:18px;height:18px">
                    <span>Require MFA for all users</span>
                </label>
                <p style="font-size:12px;color:var(--slate-400);margin-top:6px">${mfaRequired ? 'MFA is currently required. All users must set up an authenticator app.' : 'MFA is currently disabled. Users can sign in with just email and password.'}</p>
            `;
        }
    }
}

async function addAllowedEmail() {
    if (currentUserRole !== 'admin') { alert('Only admins can add users.'); return; }
    const input = document.getElementById('settings-add-email');
    const roleSelect = document.getElementById('settings-add-role');
    const email = input.value.trim().toLowerCase();
    const role = roleSelect?.value || 'user';
    if (!email) return;

    const { data: existing } = await supa.from('allowed_emails').select('*').eq('email', email).single();
    if (existing && (existing.status === 'archived' || existing.status === 'revoked')) {
        await supa.from('allowed_emails').update({ status: 'active', role }).eq('id', existing.id);
    } else {
        const { error } = await supa.from('allowed_emails').insert({ email, status: 'active', role });
        if (error) {
            alert(error.message.includes('duplicate') ? 'That email is already added.' : error.message);
            return;
        }
    }

    input.value = '';
    if (roleSelect) roleSelect.value = 'user';
    const session = await db.getSession();
    await renderAllowedUsers(session?.user?.email || '');
}

async function archiveUser(id) {
    if (currentUserRole !== 'admin') { alert('Only admins can archive users.'); return; }
    if (!confirm('Archive this user? They will no longer be able to sign in, but their history and edits will be preserved. You can reactivate them later.')) return;

    const { error } = await supa.from('allowed_emails').update({ status: 'archived' }).eq('id', id);
    if (error) { alert(error.message); return; }

    const session = await db.getSession();
    await renderAllowedUsers(session?.user?.email || '');
}

async function reactivateUser(id) {
    if (currentUserRole !== 'admin') { alert('Only admins can reactivate users.'); return; }
    const { error } = await supa.from('allowed_emails').update({ status: 'active' }).eq('id', id);
    if (error) { alert(error.message); return; }

    const session = await db.getSession();
    await renderAllowedUsers(session?.user?.email || '');
}

async function permanentlyDeleteUser(id, email) {
    if (currentUserRole !== 'admin') { alert('Only admins can delete users.'); return; }

    // First warning — recommend archiving instead
    const firstConfirm = confirm(
        'Are you sure you want to permanently delete this user?\n\n' +
        'If this user has simply become inactive, you should ARCHIVE them instead. ' +
        'Archiving preserves their account so it can be reactivated later.\n\n' +
        'Click OK to proceed with permanent deletion, or Cancel to go back.'
    );
    if (!firstConfirm) return;

    // Second warning — final confirmation
    const secondConfirm = confirm(
        'FINAL WARNING: This action cannot be undone!\n\n' +
        'Permanently deleting "' + email + '" will:\n' +
        '  - Remove their account entirely\n' +
        '  - Change all their past edits and notes to show "[Deleted User]"\n\n' +
        'Are you absolutely sure you want to delete this user?'
    );
    if (!secondConfirm) return;

    try {
        // Update the user's profile name to "[Deleted User]" so all past
        // notes, comms, audits, and tickets show the anonymized name
        const { data: profileRow } = await supa.from('profiles').select('id').eq('email', email).single();
        if (profileRow) {
            await supa.from('profiles').update({ name: '[Deleted User]', email: '' }).eq('id', profileRow.id);
        }

        // Remove from allowed emails
        await supa.from('allowed_emails').delete().eq('id', id);

        // Update in-memory data to reflect the change immediately
        notes.forEach(n => { if (profileRow && n.createdById === profileRow.id) n.createdBy = '[Deleted User]'; });
        comms.forEach(c => { if (profileRow && c.createdById === profileRow.id) c.createdBy = '[Deleted User]'; });

        const session = await db.getSession();
        await renderAllowedUsers(session?.user?.email || '');
    } catch (err) {
        alert('Failed to delete user: ' + err.message);
    }
}

async function changeUserRole(id, newRole) {
    if (currentUserRole !== 'admin') { alert('Only admins can change roles.'); return; }
    const { error } = await supa.from('allowed_emails').update({ role: newRole }).eq('id', id);
    if (error) { alert(error.message); return; }

    // Also update the profile if the user has one
    const { data: emailRow } = await supa.from('allowed_emails').select('email').eq('id', id).single();
    if (emailRow) {
        await supa.from('profiles').update({ role: newRole }).eq('email', emailRow.email);
    }

    const session = await db.getSession();
    await renderAllowedUsers(session?.user?.email || '');
}

async function toggleMfaRequirement(enabled) {
    if (currentUserRole !== 'admin') { alert('Only admins can change MFA settings.'); return; }
    try {
        await db.setAppSetting('mfa_required', enabled ? 'true' : 'false');
        mfaRequired = enabled;
        const session = await db.getSession();
        await renderAllowedUsers(session?.user?.email || '');
    } catch (err) {
        alert('Failed to update MFA setting: ' + err.message);
    }
}

// ===== MFA =====
async function renderMfaSettings() {
    const { data: factors } = await supa.auth.mfa.listFactors();
    const totp = factors?.totp?.find(f => f.status === 'verified');
    const container = document.getElementById('settings-mfa');

    if (totp) {
        container.innerHTML = `<p style="color:var(--aurora-green);font-weight:600">MFA is enabled. A 6-digit code is required on every sign-in.</p>`;
    } else {
        container.innerHTML = `<p style="color:var(--aurora-amber);font-weight:600">MFA setup is pending. You will be prompted to complete it on your next sign-in.</p>`;
    }
}

async function startMfaSetup() {
    const { data, error } = await supa.auth.mfa.enroll({ factorType: 'totp' });
    if (error) { alert(error.message); return; }

    const area = document.getElementById('mfa-setup-area');
    area.innerHTML = `
        <div class="mfa-setup-container">
            <p style="margin:16px 0 8px;font-weight:500">Scan this QR code with your authenticator app:</p>
            <div class="mfa-qr-code">
                <img src="${data.totp.qr_code}" alt="MFA QR Code" style="width:200px;height:200px">
            </div>
            <p style="font-size:12px;color:var(--slate-400);margin:8px 0">Or enter this code manually: <code style="font-family:var(--font-mono);color:var(--slate-700)">${data.totp.secret}</code></p>
            <div class="mfa-verify-field">
                <input type="text" id="mfa-verify-code" placeholder="000000" maxlength="6">
                <button class="btn btn-primary" onclick="verifyMfa('${data.id}')">Verify</button>
            </div>
        </div>
    `;
}

async function verifyMfa(factorId) {
    const code = document.getElementById('mfa-verify-code').value.trim();
    if (!code || code.length !== 6) { alert('Enter the 6-digit code from your authenticator app.'); return; }

    const { data: challenge } = await supa.auth.mfa.challenge({ factorId });
    const { error } = await supa.auth.mfa.verify({ factorId, challengeId: challenge.id, code });

    if (error) { alert('Invalid code. Try again.'); return; }
    alert('MFA enabled successfully!');
    await renderMfaSettings();
}

async function disableMfa(factorId) {
    if (!confirm('Disable MFA? Your account will only be protected by your password.')) return;
    const { error } = await supa.auth.mfa.unenroll({ factorId });
    if (error) { alert(error.message); return; }
    await renderMfaSettings();
}

// ===== SENSOR TAGS & SIDEBAR =====
const SENSOR_ISSUE_STATUSES = ['PM Sensor Issue', 'Gaseous Sensor Issue', 'SD Card Issue', 'Needs Repair', 'Power Failure', 'Lost Connection'];

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
                <span class="search-result-name">${c.name}</span>
                <span class="search-result-meta">${getChildCommunities(c.id).length ? getChildCommunities(c.id).length + ' sub-communities' : ''}</span>
            </div>`).join('')}</div>`;
    }
    if (matchedContacts.length) {
        html += `<div class="search-result-group"><div class="search-result-group-label">Contacts</div>
            ${matchedContacts.map(c => `<div class="search-result-item" onclick="closeGlobalSearch(); showContactDetail('${c.id}')">
                <span class="search-result-name">${c.name}</span>
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
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    { key: 'collocationDates', label: 'Most Recent Collocation', get: s => s.collocationDates || '' },
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

    openModal('modal-export');
}

function executeExport() {
    const type = document.getElementById('export-type').value;
    const checkboxes = document.querySelectorAll('#export-fields-list input[type="checkbox"]:checked');
    const selectedKeys = Array.from(checkboxes).map(cb => cb.dataset.key);

    const fields = type === 'sensors' ? SENSOR_EXPORT_FIELDS : CONTACT_EXPORT_FIELDS;
    const customFields = loadData('customSensorFields', []);
    const data = type === 'sensors' ? [...sensors].sort((a, b) => a.id.localeCompare(b.id)) : [...contacts].sort((a, b) => a.name.localeCompare(b.name));

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

function openBulkActionModal() {
    if (selectedSensors.size === 0) return;
    document.getElementById('bulk-action-count').textContent = selectedSensors.size;
    populateGroupedCommunitySelect('bulk-move-community');
    renderStatusToggleList('bulk-status-list', []);
    document.getElementById('bulk-action-notes').value = '';
    document.getElementById('bulk-action-date').value = nowDatetime();
    document.getElementById('bulk-do-move').checked = true;
    document.getElementById('bulk-do-status').checked = false;
    toggleBulkFields();
    openModal('modal-bulk-action');
}

function toggleBulkFields() {
    const doMove = document.getElementById('bulk-do-move').checked;
    const doStatus = document.getElementById('bulk-do-status').checked;
    document.getElementById('bulk-move-community').style.display = doMove ? '' : 'none';
    document.getElementById('bulk-status-list').style.display = doStatus ? '' : 'none';
}

function executeBulkAction() {
    const doMove = document.getElementById('bulk-do-move').checked;
    const doStatus = document.getElementById('bulk-do-status').checked;
    if (!doMove && !doStatus) { alert('Select at least one action.'); return; }

    const userNotes = document.getElementById('bulk-action-notes').value.trim();
    const eventDate = document.getElementById('bulk-action-date').value || nowDatetime();
    const sensorIds = Array.from(selectedSensors);
    const sensorList = sensorIds.join(', ');
    const now = eventDate;

    let toCommunityId = null;
    let toName = '';
    let newStatuses = [];

    if (doMove) {
        toCommunityId = document.getElementById('bulk-move-community').value;
        if (!toCommunityId) { alert('Select a community.'); return; }
        toName = getCommunityName(toCommunityId);
    }

    if (doStatus) {
        newStatuses = getSelectedStatuses('bulk-status-list');
        if (newStatuses.length === 0) { alert('Select at least one status.'); return; }
    }

    const sourceCommunities = new Set();
    sensorIds.forEach(id => {
        const s = sensors.find(x => x.id === id);
        if (!s) return;
        if (s.community) sourceCommunities.add(s.community);
        if (doMove) {
            s.community = toCommunityId;
            s.dateInstalled = now.split('T')[0];
        }
        if (doStatus) {
            s.status = newStatuses;
        }
        persistSensor(s);
    });

    if (!setupMode) {
        const parts = [];
        if (doMove) parts.push(`moved to ${toName}`);
        if (doStatus) parts.push(`status set to ${newStatuses.join(', ')}`);
        const noteText = `Bulk action: ${sensorList} ${parts.join(' and ')}.${userNotes ? ' ' + userNotes : ''}`;
        const taggedComms = [...sourceCommunities];
        if (toCommunityId && !taggedComms.includes(toCommunityId)) taggedComms.push(toCommunityId);
        const note = {
            id: generateId('n'),
            date: now,
            type: doMove ? 'Movement' : 'Status Change',
            text: noteText,
            createdBy: getCurrentUserName(), createdById: currentUserId,
            taggedSensors: sensorIds,
            taggedCommunities: taggedComms,
            taggedContacts: [],
        };
        notes.push(note); persistNote(note);
    }

    selectedSensors.clear();
    document.getElementById('select-all-sensors').checked = false;
    closeModal('modal-bulk-action');
    buildSensorSidebar();
    renderSensors();
    updateBulkActionButton();
}

// ===== BACK BUTTON =====
let viewHistory = [];

function pushViewHistory() {
    if (isNavigatingBack) return;
    const active = document.querySelector('.view.active');
    if (active) viewHistory.push(active.id);
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
    const prevViewId = viewHistory[viewHistory.length - 1];
    isNavigatingBack = true; // prevent pushViewHistory from adding during navigation
    if (prevViewId === 'view-dashboard') showView('dashboard');
    else if (prevViewId === 'view-all-sensors') showView('all-sensors');
    else if (prevViewId === 'view-communities') showView('communities');
    else if (prevViewId === 'view-contacts') showView('contacts');
    else if (prevViewId === 'view-settings') showView('settings');
    else if (prevViewId === 'view-community' && currentCommunity) showCommunityView(currentCommunity);
    else if (prevViewId === 'view-sensor-detail' && currentSensor) showSensorView(currentSensor);
    else if (prevViewId === 'view-contact-detail' && currentContact) showContactView(currentContact);
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
    // additionalInfo stores "location|startDate|endDate"
    const parts = (n.additionalInfo || '').split('|');
    const location = parts[0] || '';
    const start = parts[1] ? formatDate(parts[1]) : '';
    const end = parts[2] ? formatDate(parts[2]) : '';
    return { communityName: location, dateRange: `${start} \u2013 ${end}` };
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
        .map(c => `<option value="${c.name}">${c.name}</option>`).join('');
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
    if (new Date(endDate) < new Date(startDate)) { alert('End date must be after start date.'); return; }

    const s = sensors.find(x => x.id === sensorId);
    const communityId = s?.community || '';

    // Create note with structured additionalInfo for getMostRecentCollocation
    const noteText = `Collocation at ${location}: ${formatDate(startDate)} \u2013 ${formatDate(endDate)}.${extraNotes ? ' ' + extraNotes : ''}`;
    const collocNote = createNote('Collocation', noteText, {
        sensors: [sensorId],
        communities: communityId ? [communityId] : [],
    });
    // Set additionalInfo on the in-memory note (createNote already persists to DB)
    collocNote.additionalInfo = `${location}|${startDate}|${endDate}`;

    // Update the sensor's collocationDates field for backward compatibility
    s.collocationDates = `${location}, ${formatDate(startDate)} \u2013 ${formatDate(endDate)}`;
    persistSensor(s);

    closeModal('modal-collocation'); showSuccessToast('Collocation logged');
    if (currentSensor === sensorId) showSensorView(sensorId);
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

    const oldName = c.name;
    c.name = newName.trim();
    db.updateCommunity(currentCommunity, { name: c.name }).catch(err => console.error(err));

    if (!setupMode) {
        const note = {
            id: generateId('n'),
            date: nowDatetime(),
            type: 'Info Edit',
            text: `Community renamed from "${oldName}" to "${c.name}".`,
            createdBy: getCurrentUserName(), createdById: currentUserId,
            taggedSensors: [],
            taggedCommunities: [currentCommunity],
            taggedContacts: [],
        };
        notes.push(note); persistNote(note);
    }

    showCommunityView(currentCommunity);
    buildSidebar();
    renderPinnedSidebar();
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
let deactivatedCommunities = loadData('deactivatedCommunities', []);

function deactivateCommunity(communityId) {
    if (!confirm('Deactivate this community? It will move to the bottom of the list. All history is preserved.')) return;
    if (!deactivatedCommunities.includes(communityId)) {
        deactivatedCommunities.push(communityId);
        saveData('deactivatedCommunities', deactivatedCommunities);
    }
    showView('communities');
}

function reactivateCommunity(communityId) {
    deactivatedCommunities = deactivatedCommunities.filter(id => id !== communityId);
    saveData('deactivatedCommunities', deactivatedCommunities);
    showView('communities');
}

function isCommunityDeactivated(communityId) {
    return deactivatedCommunities.includes(communityId);
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
        alert('A field with that name already exists.');
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
    if (!confirm('Discard this new field and all values entered so far?')) return;
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
function getActiveTicketsForSensor(sensorId) { return serviceTickets.filter(t => t.sensorId === sensorId && t.status !== 'Closed'); }

function updateSidebarServiceCount() {
    const count = getActiveTicketCount();
    const el = document.getElementById('sidebar-service-count');
    if (!el) return;
    el.textContent = `(${count})`;
}

function renderServiceView() {
    updateSidebarServiceCount();
    const typeFilter = document.getElementById('service-type-filter')?.value || '';
    const showClosed = document.getElementById('service-show-closed')?.checked || false;
    let tickets = [...serviceTickets];
    if (typeFilter) tickets = tickets.filter(t => t.ticketType.includes(typeFilter));
    if (!showClosed) tickets = tickets.filter(t => t.status !== 'Closed');

    const pipeline = document.getElementById('service-pipeline');
    const statusesToShow = showClosed ? TICKET_STATUSES : TICKET_STATUSES.filter(s => s !== 'Closed');

    pipeline.innerHTML = statusesToShow.map(status => {
        const st = tickets.filter(t => t.status === status);
        return `<div class="service-pipeline-column">
            <div class="service-pipeline-column-header"><h3>${status}</h3><span class="service-pipeline-count">${st.length}</span></div>
            ${st.length === 0 ? '<p style="font-size:13px;color:var(--slate-400)">No tickets</p>' : st.map(t => renderTicketCard(t)).join('')}
        </div>`;
    }).join('');
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
            ${ticket.fedexTrackingTo ? `<span>To Quant: ${escapeHtml(ticket.fedexTrackingTo)}</span>` : ''}
            ${ticket.fedexTrackingFrom ? `<span>From Quant: ${escapeHtml(ticket.fedexTrackingFrom)}</span>` : ''}
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
            <div class="ticket-field"><label>FedEx Tracking (to QuantAQ)</label>${isOpen ? `<input class="ticket-edit-input" value="${escapeHtml(ticket.fedexTrackingTo)}" placeholder="Tracking number" onblur="saveTicketField('${ticket.id}','fedexTrackingTo',this.value)">${ticket.fedexTrackingTo ? ` <a href="https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(ticket.fedexTrackingTo)}" target="_blank" class="tracking-link">Track &#8599;</a>` : ''}` : `<p>${ticket.fedexTrackingTo ? `<a href="https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(ticket.fedexTrackingTo)}" target="_blank" class="tracking-link">${escapeHtml(ticket.fedexTrackingTo)} &#8599;</a>` : '—'}</p>`}</div>
            <div class="ticket-field"><label>FedEx Tracking (from QuantAQ)</label>${isOpen ? `<input class="ticket-edit-input" value="${escapeHtml(ticket.fedexTrackingFrom)}" placeholder="Tracking number" onblur="saveTicketField('${ticket.id}','fedexTrackingFrom',this.value)">${ticket.fedexTrackingFrom ? ` <a href="https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(ticket.fedexTrackingFrom)}" target="_blank" class="tracking-link">Track &#8599;</a>` : ''}` : `<p>${ticket.fedexTrackingFrom ? `<a href="https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(ticket.fedexTrackingFrom)}" target="_blank" class="tracking-link">${escapeHtml(ticket.fedexTrackingFrom)} &#8599;</a>` : '—'}</p>`}</div>
            <div class="ticket-field"><label>Closed</label><p>${ticket.closedAt ? formatDate(ticket.closedAt) : '—'}</p></div>
            <div class="ticket-field full-width"><label>QuantAQ Notes</label>${isOpen ? `<textarea class="ticket-edit-input" rows="3" placeholder="Notes from QuantAQ..." onblur="saveTicketField('${ticket.id}','quantNotes',this.value)">${escapeHtml(ticket.quantNotes)}</textarea>` : `<p>${escapeHtml(ticket.quantNotes) || '—'}</p>`}</div>
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

function advanceTicketStatus(ticketId) {
    const ticket = serviceTickets.find(t => t.id === ticketId);
    if (!ticket) return;
    const idx = TICKET_STATUSES.indexOf(ticket.status);
    if (idx >= TICKET_STATUSES.length - 2) return;
    const oldStatus = ticket.status;
    const newStatus = TICKET_STATUSES[idx + 1];
    ticket.status = newStatus;
    persistServiceTicketUpdate(ticketId, { status: newStatus });

    const sensorStatusMap = { 'Shipped to Quant': ['In Transit'], 'At Quant': ['Service at Quant'], 'Shipped from Quant': ['In Transit'] };
    if (sensorStatusMap[newStatus]) {
        const s = sensors.find(x => x.id === ticket.sensorId);
        if (s) {
            const current = getStatusArray(s).filter(st => st !== 'Quant Ticket in Progress' && !sensorStatusMap[newStatus].includes(st));
            s.status = [...current, ...sensorStatusMap[newStatus]];
            persistSensor(s); buildSensorSidebar();
        }
    }

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
    const sensorStatusMap = { 'Shipped to Quant': ['In Transit'], 'At Quant': ['Service at Quant'], 'Shipped from Quant': ['In Transit'] };
    const s = sensors.find(x => x.id === ticket.sensorId);
    if (s) {
        // Strip all service-related statuses, then apply what the new status implies
        const serviceStatuses = ['In Transit', 'Service at Quant'];
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
    openTicketDetail(ticketId);
    updateSidebarServiceCount();
    if (document.getElementById('view-service')?.classList.contains('active')) renderServiceView();
}

async function deleteServiceTicket(ticketId) {
    const ticket = serviceTickets.find(t => t.id === ticketId);
    if (!ticket) return;

    const confirmed = confirm(
        `Delete this service ticket permanently?\n\n` +
        `Sensor: ${ticket.sensorId}\n` +
        `Status: ${ticket.status}\n` +
        `Type: ${formatTicketType(ticket.ticketType)}\n\n` +
        `This will delete all ticket data and history. This cannot be undone.`
    );
    if (!confirmed) return;

    // Remove from in-memory array
    const idx = serviceTickets.indexOf(ticket);
    if (idx >= 0) serviceTickets.splice(idx, 1);

    // Remove from database
    try {
        await supa.from('service_tickets').delete().eq('id', ticketId);
    } catch (err) {
        console.error('Delete ticket error:', err);
    }

    // Clean up sensor service statuses
    const s = sensors.find(x => x.id === ticket.sensorId);
    if (s) {
        const serviceStatuses = ['Quant Ticket in Progress', 'In Transit', 'Service at Quant'];
        const cleaned = getStatusArray(s).filter(st => !serviceStatuses.includes(st));
        s.status = cleaned.length > 0 ? cleaned : ['Online'];
        persistSensor(s);
    }
    buildSensorSidebar();

    closeModal('modal-service-ticket');
    updateSidebarServiceCount();
    if (document.getElementById('view-service')?.classList.contains('active')) renderServiceView();
    if (currentSensor === ticket.sensorId) showSensorView(ticket.sensorId);
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
    if (!isIssue && !isCalibration) { alert('Select at least one action needed.'); return; }

    const actions = [];
    if (isIssue) actions.push('Issue / Repair');
    if (isCalibration) actions.push('Calibration');
    const ticketType = isIssue && isCalibration ? 'issue+calibration' : isIssue ? 'issue' : 'calibration';

    const ticket = { sensorId, ticketType, status: rmaNumber ? 'RMA Assigned' : 'Ticket Opened',
        rmaNumber, fedexTrackingTo: '', fedexTrackingFrom: '', issueDescription: description,
        quantNotes: '', workCompleted: '', createdBy: getCurrentUserName(), createdById: currentUserId,
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
    ticket.closedAt = new Date().toISOString();
    if (workCompleted) ticket.workCompleted = workCompleted;
    persistServiceTicketUpdate(ticketId, { status: 'Closed', closedAt: ticket.closedAt, workCompleted: ticket.workCompleted });

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
const AUDIT_STATUSES = ['Scheduled', 'In Progress', 'Complete', 'Analysis Pending', 'Audit Complete'];
const AUDIT_STATUS_CSS = { 'Scheduled': 'as-scheduled', 'In Progress': 'as-in-progress', 'Complete': 'as-complete', 'Analysis Pending': 'as-analysis', 'Audit Complete': 'as-verified' };
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
    const dateRange = audit.scheduledStart ? `${new Date(audit.scheduledStart + 'T00:00').toLocaleDateString()} - ${new Date(audit.scheduledEnd + 'T00:00').toLocaleDateString()}` : '—';
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
    document.getElementById('audit-community-input').innerHTML = '<option value="">— Select Community —</option>' + auditable.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
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
    if (new Date(scheduledEnd) < new Date(scheduledStart)) { alert('End date must be after start date.'); return; }

    // Check for sensor overlap with existing audits
    const conflicts = audits.filter(a => {
        if (a.status === 'Audit Complete') return false;
        const hasSensorOverlap = a.auditPodId === auditPodId || a.auditPodId === communityPodId || a.communityPodId === auditPodId || a.communityPodId === communityPodId;
        if (!hasSensorOverlap) return false;
        const hasDateOverlap = a.scheduledStart <= scheduledEnd && a.scheduledEnd >= scheduledStart;
        return hasDateOverlap;
    });
    if (conflicts.length > 0) {
        const msgs = conflicts.map(c => {
            const cName = COMMUNITIES.find(x => x.id === c.communityId)?.name || c.communityId;
            return `\u2022 ${c.auditPodId} \u2194 ${c.communityPodId} at ${cName} (${c.scheduledStart} to ${c.scheduledEnd})`;
        });
        if (!confirm(`Warning: One or more sensors are already assigned to overlapping audits:\n\n${msgs.join('\n')}\n\nSchedule anyway?`)) return;
    }

    const conductedBy = [installTeam, takedownTeam].filter(Boolean).join(' / ');
    const audit = { auditPodId, communityPodId, communityId, status: 'Scheduled', scheduledStart, scheduledEnd,
        actualStart: null, actualEnd: null, conductedBy, notes: auditNotes, analysisResults: {},
        createdBy: getCurrentUserName(), createdById: currentUserId };
    try { const saved = await db.insertAudit(audit); audits.unshift(saved); }
    catch (err) { handleSaveError(err); audit.id = generateId('aud'); audits.unshift(audit); }

    const communityName = COMMUNITIES.find(c => c.id === communityId)?.name || communityId;
    createNote('Audit', `Audit scheduled: ${auditPodId} auditing ${communityPodId} at ${communityName} (${scheduledStart} to ${scheduledEnd}).`, {
        sensors: [auditPodId, communityPodId], communities: [communityId] });
    closeModal('modal-new-audit'); showSuccessToast('Audit scheduled');
    updateSidebarAuditCount();
    if (document.getElementById('view-audits')?.classList.contains('active')) renderAuditsView();
}

function openAuditDetail(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || audit.communityId;
    const idx = AUDIT_STATUSES.indexOf(audit.status);
    const nextStatus = idx < AUDIT_STATUSES.length - 1 ? AUDIT_STATUSES[idx + 1] : null;
    const isEditable = true; // All fields always editable
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
            ${idx > 0 && isEditable ? `<a class="undo-link" onclick="revertAuditStatus('${audit.id}')">Undo</a>` : ''}
            <span class="action-spacer"></span>
            ${audit.status === 'Complete' || audit.status === 'Analysis Pending' || audit.status === 'Audit Complete' ? `<button class="btn" onclick="beginAnalysis('${audit.id}')" style="border-color:var(--navy-500);color:var(--navy-500)">${Object.keys(audit.analysisResults || {}).length > 0 ? 'View Analysis' : 'Begin Analysis'}</button>` : ''}
            <button class="btn" onclick="closeModal('modal-audit-detail')">Done</button>
        </div>
        <div class="ticket-detail-grid">
            <div class="ticket-field"><label>Community</label><p><a href="#" onclick="closeModal('modal-audit-detail'); showCommunity('${audit.communityId}'); return false;" style="color:var(--navy-500)">${escapeHtml(communityName)}</a></p></div>
            <div class="ticket-field"><label>Status</label><p><span class="audit-status-badge ${AUDIT_STATUS_CSS[audit.status]}">${audit.status}</span></p></div>
            <div class="ticket-field"><label>Audit Pod</label><p style="font-family:var(--font-mono);font-size:13px"><a href="#" onclick="closeModal('modal-audit-detail'); showSensorDetail('${audit.auditPodId}'); return false;" style="color:var(--navy-500)">${audit.auditPodId}</a></p></div>
            <div class="ticket-field"><label>Community Pod</label><p style="font-family:var(--font-mono);font-size:13px"><a href="#" onclick="closeModal('modal-audit-detail'); showSensorDetail('${audit.communityPodId}'); return false;" style="color:var(--navy-500)">${audit.communityPodId}</a></p></div>
            <div class="ticket-field"><label>Scheduled Start</label>${isEditable ? `<input type="date" class="ticket-edit-input" value="${audit.scheduledStart || ''}" onblur="saveAuditField('${audit.id}','scheduledStart',this.value)">` : `<p>${audit.scheduledStart || '—'}</p>`}</div>
            <div class="ticket-field"><label>Scheduled End</label>${isEditable ? `<input type="date" class="ticket-edit-input" value="${audit.scheduledEnd || ''}" onblur="saveAuditField('${audit.id}','scheduledEnd',this.value)">` : `<p>${audit.scheduledEnd || '—'}</p>`}</div>
            <div class="ticket-field"><label>Actual Start</label>${isEditable ? `<input type="date" class="ticket-edit-input" value="${audit.actualStart || ''}" onblur="saveAuditField('${audit.id}','actualStart',this.value)">` : `<p>${audit.actualStart || '—'}</p>`}</div>
            <div class="ticket-field"><label>Actual End</label>${isEditable ? `<input type="date" class="ticket-edit-input" value="${audit.actualEnd || ''}" onblur="saveAuditField('${audit.id}','actualEnd',this.value)">` : `<p>${audit.actualEnd || '—'}</p>`}</div>
            <div class="ticket-field"><label>Install Team</label>${isEditable ? `<input class="ticket-edit-input" value="${escapeHtml(audit.conductedBy?.split(' / ')[0] || '')}" placeholder="Who installed" onblur="saveAuditConductors('${audit.id}', this.value, null)">` : `<p>${escapeHtml(audit.conductedBy?.split(' / ')[0]) || '—'}</p>`}</div>
            <div class="ticket-field"><label>Takedown Team</label>${isEditable ? `<input class="ticket-edit-input" value="${escapeHtml(audit.conductedBy?.split(' / ')[1] || '')}" placeholder="Who removed" onblur="saveAuditConductors('${audit.id}', null, this.value)">` : `<p>${escapeHtml(audit.conductedBy?.split(' / ')[1]) || '—'}</p>`}</div>
            <div class="ticket-field full-width"><label>Notes</label>${isEditable ? `<textarea class="ticket-edit-input" rows="3" onblur="saveAuditField('${audit.id}','notes',this.value)">${escapeHtml(audit.notes)}</textarea>` : `<p>${escapeHtml(audit.notes) || '—'}</p>`}</div>
        </div>
        <div style="padding:0 28px 16px"><label style="font-size:11px;font-weight:600;color:var(--slate-400);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:8px">Analysis Results</label>${analysisHtml}</div>
        <div style="padding:0 28px 16px"><label style="font-size:11px;font-weight:600;color:var(--slate-400);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:8px">Photos</label>
            ${isEditable ? `<label class="btn btn-sm" style="cursor:pointer;margin-bottom:8px">Upload Photos <input type="file" accept="image/*" multiple style="display:none" onchange="uploadAuditPhotos('${audit.id}', '${audit.communityId}', this.files)"></label>` : ''}
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

    // Warn if skipping analysis
    if (newStatus === 'Audit Complete' && Object.keys(audit.analysisResults || {}).length === 0) {
        if (!confirm('No analysis data has been uploaded for this audit. Are you sure you want to mark it as complete without DQO analysis?')) return;
    }
    audit.status = newStatus;
    const updates = { status: newStatus };

    if (newStatus === 'In Progress' && !audit.actualStart) { audit.actualStart = localDate(); updates.actualStart = audit.actualStart; }
    if (newStatus === 'Complete' && !audit.actualEnd) { audit.actualEnd = localDate(); updates.actualEnd = audit.actualEnd; }
    persistAuditUpdate(auditId, updates);

    // Update sensor statuses — community pod shows current audit step, audit pod shows "Auditing a Community"
    const auditStatusPrefix = 'Audit: ';
    const communityPod = sensors.find(x => x.id === audit.communityPodId);
    const auditPod = sensors.find(x => x.id === audit.auditPodId);

    if (communityPod) {
        // Remove any previous audit status
        const cleaned = getStatusArray(communityPod).filter(st => !st.startsWith(auditStatusPrefix));
        if (newStatus !== 'Audit Complete') {
            communityPod.status = [...cleaned, auditStatusPrefix + newStatus];
        } else {
            communityPod.status = cleaned.length > 0 ? cleaned : ['Online'];
        }
        persistSensor(communityPod);
    }

    if (auditPod) {
        const cleaned = getStatusArray(auditPod).filter(st => st !== 'Auditing a Community');
        if (newStatus === 'In Progress' || newStatus === 'Complete') {
            auditPod.status = [...cleaned, 'Auditing a Community'];
        } else if (newStatus === 'Analysis Pending' || newStatus === 'Audit Complete') {
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
        if (newStatus === 'In Progress' || newStatus === 'Complete') {
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
    r2: { min: 0.70, label: 'R\u00B2 \u2265 0.70' },
    slope: { min: 0.65, max: 1.35, label: 'Slope: 1.0 \u00B1 0.35' },
    intercept: { min: -5, max: 5, label: '\u22125 \u2264 Intercept \u2264 5' },
    sd: { max: 5, label: 'SD \u2264 5' },
    rmse: { max: 7, label: 'RMSE \u2264 7' },
};

// Column name mapping: match QuantAQ AirVision export columns to our parameter keys
const PARAM_COLUMN_MAP = {
    co: [/\bCO_PPB\b/i, /\bco_ppb\b/i, /\bCO\b.*ppb/i],
    no: [/\bNO_PPB\b/i, /\bno_ppb\b/i, /(?<![A-Z])NO\b.*ppb/i],
    no2: [/\bNO2_PPB\b/i, /\bno2_ppb\b/i, /\bNO\u2082\b/i],
    o3: [/\bOZONE_PPB\b/i, /\bo3_ppb\b/i, /\bO3\b.*ppb/i, /\bozone\b/i],
    pm10: [/\bPM10_CONTIN\b/i, /\bpm10\b/i, /\bPM\s*10\b/i],
    pm25: [/\bPM25\b/i, /\bpm2\.?5\b/i, /\bPM\s*2\.?5\b/i],
};

async function deleteAudit(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    const communityName = COMMUNITIES.find(c => c.id === audit.communityId)?.name || audit.communityId;

    const confirmed = confirm(
        `Delete this audit permanently?\n\n` +
        `Community: ${communityName}\n` +
        `Pods: ${audit.auditPodId} \u2194 ${audit.communityPodId}\n` +
        `Dates: ${audit.scheduledStart || '?'} to ${audit.scheduledEnd || '?'}\n\n` +
        `This will delete all audit data, analysis results, and associated notes. This cannot be undone.`
    );
    if (!confirmed) return;

    // Remove from in-memory array
    const idx = audits.indexOf(audit);
    if (idx >= 0) audits.splice(idx, 1);

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
}

function beginAnalysis(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
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
        <input type="text" class="analysis-name-input" id="analysis-name-input" value="${escapeHtml(defaultName)}" placeholder="e.g. Audit 471 - Kodiak 660, March 4-13 2026">
        <label class="analysis-upload-zone" id="analysis-drop-zone">
            <div class="analysis-upload-icon">&#128196;</div>
            <div class="analysis-upload-text">Click to upload Excel file (.xls or .xlsx)</div>
            <div class="analysis-upload-hint">Hourly data export from AirVision with both sensor columns</div>
            <input type="file" accept=".xls,.xlsx" onchange="handleAnalysisUpload('${auditId}', this.files[0])">
        </label>
    `;
    openModal('modal-audit-analysis');
}

function closeAnalysisModal() {
    // Destroy any active charts to free memory
    analysisChartInstances.forEach(c => { try { c.destroy(); } catch(e) {} });
    analysisChartInstances = [];
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
            });

            // Cache in memory
            analysisDataCache[auditId] = parsed;
            analysisDataCache[auditId].regressionResults = results;

            // Advance status based on DQO results
            const allPass = AUDIT_PARAMETERS.every(p => audit.analysisResults[p.key]?.pass);
            if (audit.status === 'Complete' || audit.status === 'Analysis Pending') {
                const oldStatus = audit.status;
                const newStatus = allPass ? 'Audit Complete' : 'Analysis Pending';
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
        } catch (err) {
            console.error('Analysis error:', err);
            body.innerHTML = `<div class="analysis-processing" style="color:var(--aurora-rose)">Error processing file: ${escapeHtml(err.message)}</div>`;
        }
    };
    reader.readAsArrayBuffer(file);
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
    const dqo = {
        r2: result.r2 >= DQO_THRESHOLDS.r2.min,
        slope: result.slope >= DQO_THRESHOLDS.slope.min && result.slope <= DQO_THRESHOLDS.slope.max,
        intercept: result.intercept >= DQO_THRESHOLDS.intercept.min && result.intercept <= DQO_THRESHOLDS.intercept.max,
        sd: result.sd <= DQO_THRESHOLDS.sd.max,
        rmse: result.rmse <= DQO_THRESHOLDS.rmse.max,
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

    // Rebuild regression results — reconstruct pairs from row data if missing
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

    const body = document.getElementById('audit-analysis-body');
    body.innerHTML = `
        <div style="margin-top:16px">
            <span class="analysis-trim-note">First 24 hours excluded from DQO analysis (${trimCount} of ${totalCount} rows trimmed) \u2014 regression and DQO calculated on ${analysisCount} rows</span>
            ${audit.analysisUploadDate ? `<span style="float:right;font-size:11px;color:var(--slate-400)">Uploaded ${formatDate(audit.analysisUploadDate)} by ${escapeHtml(audit.analysisUploadedBy || '')}</span>` : ''}
        </div>
        <div class="analysis-tabs">
            <button class="analysis-tab active" onclick="switchAnalysisTab(this, 'analysis')">Analysis</button>
            <button class="analysis-tab" onclick="switchAnalysisTab(this, 'rawdata')">Raw Data</button>
        </div>
        <div id="analysis-panel-analysis" class="analysis-tab-panel active">
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
        <label class="analysis-upload-zone" id="analysis-drop-zone">
            <div class="analysis-upload-icon">&#128196;</div>
            <div class="analysis-upload-text">Click to upload Excel file (.xls or .xlsx)</div>
            <div class="analysis-upload-hint">This will replace the existing analysis results</div>
            <input type="file" accept=".xls,.xlsx" onchange="handleAnalysisUpload('${auditId}', this.files[0])">
        </label>
    `;
}

function renderSavedAnalysisView(auditId) {
    const audit = audits.find(a => a.id === auditId);
    if (!audit) return;
    const results = audit.analysisResults || {};
    const T = DQO_THRESHOLDS;

    const body = document.getElementById('audit-analysis-body');
    body.innerHTML = `
        <div style="margin-top:16px">
            ${audit.analysisUploadDate ? `<span style="font-size:11px;color:var(--slate-400)">Uploaded ${formatDate(audit.analysisUploadDate)} by ${escapeHtml(audit.analysisUploadedBy || '')}</span>` : ''}
        </div>
        <div style="overflow-x:auto;margin-top:16px">
        <table class="dqo-summary-table">
            <thead><tr>
                <th scope="col">Parameter<br><span class="dqo-thresh">(DQO Threshold)</span></th>
                <th>R\u00B2 <span class="dqo-thresh">(\u2265 ${T.r2.min})</span></th>
                <th>Slope <span class="dqo-thresh">(${T.slope.min}\u2013${T.slope.max})</span></th>
                <th>Intercept <span class="dqo-thresh">(${T.intercept.min} to ${T.intercept.max})</span></th>
                <th>SD <span class="dqo-thresh">(\u2264 ${T.sd.max})</span></th>
                <th>RMSE <span class="dqo-thresh">(\u2264 ${T.rmse.max})</span></th>
                <th>Result</th>
            </tr></thead>
            <tbody>
                ${AUDIT_PARAMETERS.map(p => {
                    const r = results[p.key];
                    if (!r) return `<tr><td>${p.labelHtml} (${p.unit})</td><td colspan="6" style="color:var(--slate-400);font-family:var(--font-sans)">No data</td></tr>`;
                    const d = r.dqo || {};
                    const cls = (pass) => pass ? 'dqo-cell-pass' : 'dqo-cell-fail';
                    return `<tr>
                        <td>${p.labelHtml} (${p.unit})</td>
                        <td class="${cls(d.r2)}">${r.r2}</td>
                        <td class="${cls(d.slope)}">${r.slope}</td>
                        <td class="${cls(d.intercept)}">${r.intercept}</td>
                        <td class="${cls(d.sd)}">${r.sd}</td>
                        <td class="${cls(d.rmse)}">${r.rmse}</td>
                        <td>${r.pass ? '<span class="dqo-pass">PASS</span>' : '<span class="dqo-fail">FAIL</span>'}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
        </div>
        <div class="analysis-dqo-thresholds"><span style="font-size:10px">Intercept, SD, and RMSE in parameter units. PM<sub>10</sub> values &gt; 1000 \u00B5g/m\u00B3 invalidated.</span></div>
        <p style="font-size:13px;color:var(--slate-400);margin-top:16px">To view scatter plots, time series, and raw data, re-upload the original Excel file.</p>
        <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center">
            <button class="btn btn-primary" onclick="generateAuditReport('${auditId}')">Generate Report</button>
            <button class="btn" onclick="rerunAnalysisUpload('${auditId}')">Re-upload Data for Charts</button>
        </div>
    `;
}

function renderDQOSection(results, overallPass) {
    const el = document.getElementById('analysis-section-dqo');
    const T = DQO_THRESHOLDS;

    el.innerHTML = `
        <div style="overflow-x:auto">
        <table class="dqo-summary-table">
            <thead><tr>
                <th scope="col">Parameter<br><span class="dqo-thresh">(DQO Threshold)</span></th>
                <th>R\u00B2 <span class="dqo-thresh">(\u2265 ${T.r2.min})</span></th>
                <th>Slope <span class="dqo-thresh">(${T.slope.min}\u2013${T.slope.max})</span></th>
                <th>Intercept <span class="dqo-thresh">(${T.intercept.min} to ${T.intercept.max})</span></th>
                <th>SD <span class="dqo-thresh">(\u2264 ${T.sd.max})</span></th>
                <th>RMSE <span class="dqo-thresh">(\u2264 ${T.rmse.max})</span></th>
                <th>Result</th>
            </tr></thead>
            <tbody>
                ${AUDIT_PARAMETERS.map(p => {
                    const r = results[p.key];
                    if (!r) return `<tr><td>${p.labelHtml} (${p.unit})</td><td colspan="6" style="color:var(--slate-400);font-family:var(--font-sans)">No data</td></tr>`;
                    const d = r.dqo || {};
                    const cls = (pass) => pass ? 'dqo-cell-pass' : 'dqo-cell-fail';
                    return `<tr>
                        <td>${p.labelHtml} (${p.unit})</td>
                        <td class="${cls(d.r2)}">${r.r2}</td>
                        <td class="${cls(d.slope)}">${r.slope}</td>
                        <td class="${cls(d.intercept)}">${r.intercept}</td>
                        <td class="${cls(d.sd)}">${r.sd}</td>
                        <td class="${cls(d.rmse)}">${r.rmse}</td>
                        <td>${r.pass ? '<span class="dqo-pass">PASS</span>' : '<span class="dqo-fail">FAIL</span>'}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
        </div>
        <div class="analysis-dqo-thresholds"><span style="font-size:10px">Intercept, SD, and RMSE are in the units of the measured parameter (ppb for gases, \u00B5g/m\u00B3 for PM). PM<sub>10</sub> values &gt; 1000 \u00B5g/m\u00B3 invalidated before analysis.</span></div>
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
                                return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
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
                x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                y: { grid: { display: false }, ticks: { font: { size: 10 } } },
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
        <div class="analysis-chart-grid">
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
                x: { type: 'time', time: { unit: 'day', displayFormats: { day: 'MMM d', hour: 'MMM d HH:mm' } }, grid: { display: false }, ticks: { font: { size: 10 } } },
                y: {
                    min: Math.max(0, yMin - yPad),
                    max: yMax + yPad,
                    grid: { display: false },
                    ticks: { font: { size: 10 } },
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
        const dateStr = r.timestamp.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
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

    // Recent history (3 items)
    const sensorIdsInCommunity = sensors.filter(s => allCommunityIds.includes(s.community)).map(s => s.id);
    const commNotes = notes.filter(n => {
        if (n.taggedCommunities && n.taggedCommunities.some(id => allCommunityIds.includes(id))) return true;
        if (n.taggedSensors && n.taggedSensors.some(id => sensorIdsInCommunity.includes(id))) return true;
        return false;
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

    // Top contacts (2)
    const commContacts = contacts.filter(c => allCommunityIds.includes(c.community) && c.active !== false).slice(0, 2);
    const contactsHtml = commContacts.length > 0
        ? commContacts.map(c => `<div class="ov-contact-row" onclick="showContactDetail('${c.id}')">
            <div><strong>${escapeHtml(c.name)}</strong></div>
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
        return `<div class="audit-list-card" onclick="openTicketDetail('${t.id}')">
            <div class="audit-list-card-header">
                <span style="font-weight:600;color:var(--slate-700)">${formatTicketType(t.ticketType)}</span>
                <span class="ticket-status-badge ${TICKET_STATUS_CSS[t.status] || ''}">${t.status}</span>
            </div>
            <div class="audit-list-card-meta">${dateStr}${t.createdBy ? ' by ' + escapeHtml(t.createdBy) : ''}</div>
            ${t.issueDescription ? `<div style="font-size:12px;color:var(--slate-500);margin-top:4px">${escapeHtml(t.issueDescription.substring(0, 100))}${t.issueDescription.length > 100 ? '...' : ''}</div>` : ''}
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
    const dateRange = audit.scheduledStart ? `${new Date(audit.scheduledStart + 'T00:00').toLocaleDateString()} \u2013 ${new Date(audit.scheduledEnd + 'T00:00').toLocaleDateString()}` : '\u2014';
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
    const T = DQO_THRESHOLDS;

    // Build descriptive sensor labels
    const auditPodSensor = sensors.find(s => s.id === audit.auditPodId);
    const communityPodSensor = sensors.find(s => s.id === audit.communityPodId);
    const auditPodLoc = auditPodSensor?.community ? (COMMUNITIES.find(c => c.id === auditPodSensor.community)?.name || '') : '';
    const labelA = `${auditPodLoc ? auditPodLoc + ' ' : ''}${auditPodSensor?.type || 'Audit Pod'} ${audit.auditPodId}`.trim();
    const labelB = `${communityName} ${communityPodSensor?.type || 'Community Pod'} ${audit.communityPodId}`.trim();
    const shortA = `${auditPodSensor?.type || 'Audit Pod'} ${shortSensorId(audit.auditPodId)}`;
    const shortB = `${communityName} Pod ${shortSensorId(audit.communityPodId)}`;

    const dateRange = audit.scheduledStart
        ? `${new Date(audit.scheduledStart + 'T00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} \u2013 ${new Date(audit.scheduledEnd + 'T00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
        : '\u2014';

    // DQO table rows — using labelHtml for subscripts
    const dqoRows = AUDIT_PARAMETERS.map(p => {
        const r = results[p.key];
        if (!r) return `<tr><td>${p.labelHtml} (${p.unit})</td><td colspan="6" style="color:#64748b">No data</td></tr>`;
        const d = r.dqo || {};
        const cls = (pass) => pass ? 'color:#1a7f37' : 'color:#c53030;font-weight:700';
        return `<tr>
            <td style="font-family:'DM Sans',sans-serif;font-weight:600">${p.labelHtml} (${p.unit})</td>
            <td style="${cls(d.r2)}">${r.r2}</td>
            <td style="${cls(d.slope)}">${r.slope}</td>
            <td style="${cls(d.intercept)}">${r.intercept}</td>
            <td style="${cls(d.sd)}">${r.sd}</td>
            <td style="${cls(d.rmse)}">${r.rmse}</td>
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
            <div style="page-break-before:always"></div>
            <h2 style="font-size:16px;color:#1B2A4A;margin:24px 0 12px;border-bottom:2px solid #1B2A4A;padding-bottom:6px">Hourly Data</h2>
            <p style="font-size:11px;color:#8a6d20;background:#fff8e8;display:inline-block;padding:3px 10px;border-radius:6px;margin-bottom:8px">* = first 24 hours (excluded from regression). PM<sub>10</sub> values &gt; 1000 invalidated.</p>
            <table style="width:100%;border-collapse:collapse;font-size:9px;font-family:'JetBrains Mono',monospace">
                <thead><tr style="background:#1B2A4A;color:white">
                    <th style="padding:4px 6px;text-align:left">Date/Time</th>
                    ${paramKeys.map(k => `<th style="padding:4px 6px">${escapeHtml(labelA)}<br>${paramLabels[k] || k}</th><th style="padding:4px 6px">${escapeHtml(labelB)}<br>${paramLabels[k] || k}</th>`).join('')}
                </tr></thead>
                <tbody>
                    ${cached.allRows.map((r, i) => {
                        const isTrimmed = i < cached.trimIndex;
                        const dateStr = r.timestamp.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
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
                        x: { type: 'time', time: { unit: 'day', displayFormats: { day: 'MMM d' } }, grid: { display: false }, ticks: { font: { size: 22 } } },
                        y: { title: { display: true, text: p.label + ' (' + p.unit + ')', font: { size: 24, weight: '600' } }, grid: { display: false }, ticks: { font: { size: 22 } } },
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
                        x: { title: { display: true, text: shortA + ' ' + p.label + ' (' + p.unit + ')', font: { size: 24, weight: '600' } }, grid: { display: false }, ticks: { font: { size: 22 } } },
                        y: { title: { display: true, text: shortB + ' ' + p.label + ' (' + p.unit + ')', font: { size: 24, weight: '600' } }, grid: { display: false }, ticks: { font: { size: 22 } } },
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
        const r = (cached.regressionResults || results)[p.key];
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
    body { font-family: 'DM Sans', sans-serif; color: #1e293b; padding: 40px 48px; max-width: 1000px; margin: 0 auto; line-height: 1.5; }
    h1 { font-size: 26px; color: #1B2A4A; margin-bottom: 2px; }
    h2 { font-size: 16px; color: #1B2A4A; margin: 28px 0 12px; border-bottom: 2px solid #1B2A4A; padding-bottom: 6px; }
    sub { font-size: 0.8em; }
    .report-subtitle { font-size: 14px; color: #64748b; margin-bottom: 4px; line-height: 1.6; }
    .report-sensors { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #475569; margin-bottom: 20px; }
    .report-header-bar { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; border-bottom: 3px solid #C9A84C; padding-bottom: 16px; }
    .report-meta { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 6px 16px; font-size: 13px; margin-bottom: 20px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px; }
    .report-meta dt { font-weight: 600; color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
    .report-meta dd { margin: 0; color: #1e293b; padding-bottom: 6px; border-bottom: 1px solid #f1f5f9; }
    .report-meta dd:last-child, .report-meta dd:nth-last-child(2) { border-bottom: none; }
    .report-meta dd .mono { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
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
    .thresholds { font-size: 14px; color: #334155; margin-top: 12px; line-height: 1.7; }
    .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
    .chart-grid-single { grid-template-columns: 1fr; }
    .chart-card { border: 1px solid #cbd5e1; border-radius: 10px; padding: 16px; page-break-inside: avoid; }
    .chart-card h4 { font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 500; color: #1e293b; margin-bottom: 2px; }
    .chart-card h4 strong { font-weight: 700; }
    .chart-card .chart-sub { font-family: 'DM Sans', sans-serif; font-size: 12px; color: #64748b; margin-bottom: 8px; }
    .chart-card img { width: 100%; display: block; }
    .chart-card .chart-eq { font-family: 'DM Sans', sans-serif; font-size: 13px; color: #334155; text-align: center; margin-top: 8px; }
    .chart-card .chart-legend { display: flex; justify-content: center; gap: 32px; font-family: 'DM Sans', sans-serif; font-size: 13px; color: #334155; margin-top: 8px; white-space: nowrap; }
    .chart-card .chart-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .print-controls { margin-bottom: 20px; display: flex; align-items: center; gap: 16px; }
    .print-controls button { padding: 10px 24px; font-size: 14px; font-family: 'DM Sans', sans-serif; font-weight: 600; background: #1B2A4A; color: white; border: none; border-radius: 8px; cursor: pointer; }
    .print-controls label { font-size: 13px; color: #64748b; display: flex; align-items: center; gap: 6px; cursor: pointer; }
    0; text-align: center; }
    @media print {
        body { padding: 16px; padding-top: 32px; }
        .no-print { display: none !important; }
        h2 { break-after: avoid; page-break-after: avoid; margin-top: 20px; }
        h1 { margin-top: 12px; }
        .chart-card { break-inside: avoid; page-break-inside: avoid; }
        .chart-grid { break-before: auto; }
        .report-header-bar { break-inside: avoid; }
        .report-meta { break-inside: avoid; page-break-inside: avoid; }
        table.dqo { break-inside: avoid; page-break-inside: avoid; }
        .thresholds { break-before: avoid; }
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
        <div style="text-align:right;font-size:11px;color:#64748b;line-height:1.6">
            <div style="font-weight:600">ADEC Division of Air Quality</div>
            <div>Air Monitoring and Quality Assurance</div>
            <div style="margin-top:4px">${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
        </div>
    </div>

    <h2>Audit Details</h2>
    <dl class="report-meta">
        <dt>Community</dt><dd>${escapeHtml(communityName)}</dd>
        <dt>Audit Period</dt><dd>${dateRange}</dd>
        <dt>Community Pod ID</dt><dd><span class="mono">${escapeHtml(audit.communityPodId)}</span></dd>
        <dt>Audit Pod ID</dt><dd><span class="mono">${escapeHtml(audit.auditPodId)}</span></dd>
        <dt>Community Pod Location</dt><dd>${escapeHtml(communityPodSensor?.location || '\u2014')}</dd>
        <dt>Installation / Removal By</dt><dd>${escapeHtml(audit.conductedBy || '\u2014')}</dd>
        ${audit.notes ? `<dt>Notes</dt><dd style="grid-column:span 3">${escapeHtml(audit.notes)}</dd>` : ''}
    </dl>

    <h2>Data Quality Objectives (DQO) Summary</h2>
    <span class="trim-note">${trimInfo}</span>
    <table class="dqo">
        <thead><tr>
            <th scope="col">Parameter<br><span class="dqo-thresh">(DQO Threshold)</span></th>
            <th>R\u00B2 <span class="dqo-thresh">(\u2265 ${T.r2.min})</span></th>
            <th>Slope <span class="dqo-thresh">(${T.slope.min}\u2013${T.slope.max})</span></th>
            <th>Intercept <span class="dqo-thresh">(${T.intercept.min} to ${T.intercept.max})</span></th>
            <th>SD <span class="dqo-thresh">(\u2264 ${T.sd.max})</span></th>
            <th>RMSE <span class="dqo-thresh">(\u2264 ${T.rmse.max})</span></th>
            <th>Result</th>
        </tr></thead>
        <tbody>${dqoRows}</tbody>
    </table>
    <div class="thresholds">Intercept, SD, and RMSE are expressed in the units of the measured parameter (ppb for gases, \u00B5g/m\u00B3 for particulate matter). PM<sub>10</sub> values exceeding 1000 \u00B5g/m\u00B3 were invalidated prior to analysis.</div>

    ${tsHtml ? `<h2>PM Timeseries</h2><div class="chart-grid">${tsHtml}</div>` : ''}

    ${scatterCards.length > 0 ? (() => {
        let out = '<h2>Regression Plots</h2>';
        for (let i = 0; i < scatterCards.length; i += 2) {
            if (i > 0) out += '<h2>Regression Plots (continued)</h2>';
            out += '<div class="chart-grid">' + scatterCards.slice(i, i + 2).join('') + '</div>';
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
    if (!confirm('Delete this photo?')) return;
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
}

async function uploadAuditPhotos(auditId, communityId, files) {
    for (const file of files) {
        try {
            const path = `${auditId}/${Date.now()}_${file.name}`;
            await supa.storage.from('community-files').upload(path, file);
            const { data: fileData } = await supa.from('community_files').insert({
                community_id: communityId, file_name: file.name, file_type: file.type,
                storage_path: path, uploaded_by: currentUserId,
            }).select();
            if (!communityFiles[communityId]) communityFiles[communityId] = [];
            communityFiles[communityId].push({ id: fileData?.[0]?.id || generateId('f'), name: file.name, type: file.type, storagePath: path, date: new Date().toISOString() });
        } catch (err) { handleSaveError(err); }
    }
    // Refresh the photo grid inline instead of reopening the whole modal
    const grid = document.getElementById('audit-photos-grid');
    if (grid) grid.innerHTML = renderAuditPhotos(auditId, communityId);
}

// ===== DARK MODE =====
function toggleDarkMode() {
    document.documentElement.classList.toggle('dark-mode');
    const isDark = document.documentElement.classList.contains('dark-mode');
    localStorage.setItem('snt_darkMode', isDark ? 'true' : 'false');
    const label = document.getElementById('dark-mode-label');
    if (label) label.textContent = isDark ? 'Light Mode' : 'Dark Mode';
}

function loadDarkMode() {
    if (localStorage.getItem('snt_darkMode') === 'true') {
        document.documentElement.classList.add('dark-mode');
        const label = document.getElementById('dark-mode-label');
        if (label) label.textContent = 'Light Mode';
    }
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
                collocationDates: String(row['Most Recent Collocation'] || row['collocation_dates'] || '').trim(),
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

            sensors.push(sensor);
            persistSensor(sensor);
            imported++;
        }

        alert(`Import complete: ${imported} sensors added, ${skipped} skipped (duplicate or missing ID).`);
        event.target.value = '';
        renderSensors();
        buildSensorSidebar();
    } catch (err) {
        alert('Import failed: ' + err.message);
        console.error('Import error:', err);
    }
}

// ===== INIT =====
loadDarkMode();

(async function init() {
    try {
    // Handle auth redirects (email confirmation links, password resets)
    const hash = window.location.hash;
    if (hash && (hash.includes('access_token') || hash.includes('type=signup') || hash.includes('type=recovery'))) {
        const { data } = await supa.auth.getSession();
        if (data?.session) {
            window.history.replaceState(null, '', window.location.pathname);
            await checkMfaAndProceed();
            return;
        }
    }

    const params = new URLSearchParams(window.location.search);
    if (params.has('token_hash') || params.has('type')) {
        const { error } = await supa.auth.verifyOtp({
            token_hash: params.get('token_hash'),
            type: params.get('type'),
        });
        if (!error) {
            window.history.replaceState(null, '', window.location.pathname);
            const session = await db.getSession();
            if (session) {
                await checkMfaAndProceed();
                return;
            }
        }
    }

    const session = await db.getSession();
    if (session) {
        // Check if MFA was verified recently (within 1 hour) for THIS user
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
