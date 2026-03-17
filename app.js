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
let communityParents = {}; // childId -> parentId

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
    const [communitiesData, tagsData, sensorsData, contactsData, notesData, commsData, filesData] = await Promise.all([
        db.getCommunities(),
        db.getCommunityTags(),
        db.getSensors(),
        db.getContacts(),
        db.getNotes(),
        db.getComms(),
        db.getCommunityFiles(),
    ]);

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
    }));

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
}

// ===== PERSISTENCE LAYER =====
// Fire-and-forget writes to Supabase. UI updates immediately from in-memory arrays.
function handleSaveError(err) {
    console.error('Save error:', err);
    const msg = document.createElement('div');
    msg.className = 'save-error-toast';
    msg.textContent = 'Save failed: ' + (err?.message || err || 'Unknown error');
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 6000);
}

function persistSensor(s) { db.upsertSensor(s).catch(handleSaveError); }
function persistContact(c) { return db.upsertContact(c).catch(handleSaveError); }
function persistNote(n) { return db.insertNote(n).catch(handleSaveError); }
function persistComm(c) { return db.insertComm(c).catch(handleSaveError); }
function persistCommunityTags(id, tags) { db.setCommunityTags(id, tags).catch(handleSaveError); }
function persistCommunity(c) { db.insertCommunity(c).catch(handleSaveError); }

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
        createdById: currentUserId,
        createdAt: new Date().toISOString(),
        taggedSensors: tags?.sensors || [],
        taggedCommunities: tags?.communities || [],
        taggedContacts: tags?.contacts || [],
    };
    notes.push(note);
    persistNote(note);
    return note;
}

function createNoteIfNotSetup(type, text, tags, additionalInfo) {
    if (!setupMode) return createNote(type, text, tags, additionalInfo);
    return null;
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
    sessionStorage.setItem('mfa_verified_at', Date.now().toString());
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('login-loading').style.display = '';

    const profile = await db.getProfile();
    currentUser = profile?.name || profile?.email || 'User';
    currentUserId = profile?.id || null;

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
    restoreLastView();
    startInactivityTimer();
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
        alert('You have been signed out due to inactivity.');
        await logoutUser();
    }, INACTIVITY_LIMIT);
}

async function logoutUser() {
    await db.signOut();
    currentUser = null;
    currentUserId = null;
    selectedSensors.clear();
    viewHistory = [];
    if (inactivityTimeout) clearTimeout(inactivityTimeout);
    showLoginScreen();
}

function getCurrentUserName() {
    return currentUser || 'Unknown';
}

// ===== SETUP MODE =====
let setupMode = loadData('setupMode', false);

function toggleSetupMode() {
    setupMode = !setupMode;
    saveData('setupMode', setupMode);
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

    saveLastView('view', viewName);
}

// ===== DASHBOARD =====
function renderDashboard() {
    // Dashboard is just the embedded AQI map — nothing to render dynamically
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
    const arrow = el.previousElementSibling.querySelector('.parent-expand-arrow');
    el.classList.toggle('open');
    arrow.classList.toggle('open');
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

function clearCommunityTagFilter() {
    communityTagFilter = '';
    renderCommunitiesList();
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
    };
    return map[status] || 'badge-offline';
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
        const onclick = clickable ? `onclick="openStatusChangeModal('${s.id}')"` : '';
        return `<span class="badge ${getStatusBadgeClass(st)} ${cls}" ${onclick}>${st}</span>`;
    }).join(' ');
}

function getCommunityName(id) {
    const c = COMMUNITIES.find(c => c.id === id);
    return c ? c.name : id || '—';
}

function renderSensors() {
    const search = (document.getElementById('sensor-search')?.value || '').toLowerCase();
    const statusFilter = document.getElementById('sensor-status-filter')?.value || '';

    let filtered = sensors.filter(s => {
        if (search && !s.id.toLowerCase().includes(search) && !getCommunityName(s.community).toLowerCase().includes(search) && !(s.soaTagId || '').toLowerCase().includes(search)) return false;
        if (statusFilter && !getStatusArray(s).includes(statusFilter)) return false;
        if (sensorTagFilter) {
            if (sensorTagFilter === 'Issue Sensors') {
                if (!getStatusArray(s).some(st => SENSOR_ISSUE_STATUSES.includes(st))) return false;
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

    if (setupMode) {
        const communityOptions = '<option value="">— None —</option>' +
            COMMUNITIES.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        const statusOptions = ALL_STATUSES.map(st =>
            `<option value="${st}">${st}</option>`
        ).join('');
        const typeOptions = SENSOR_TYPES.map(t =>
            `<option value="${t}">${t}</option>`
        ).join('');

        document.getElementById('sensors-tbody').innerHTML = filtered.map(s => {
            const currentStatuses = getStatusArray(s);
            const statusSelectHtml = `<select class="inline-edit-select inline-edit-status" data-sensor="${s.id}" data-field="status" multiple title="Hold Ctrl/Cmd to select multiple">
                ${ALL_STATUSES.map(st => `<option value="${st}" ${currentStatuses.includes(st) ? 'selected' : ''}>${st}</option>`).join('')}
            </select>`;

            return `<tr>
                <td><input type="checkbox" class="sensor-checkbox" data-sensor-id="${s.id}" onchange="toggleSensorCheckbox('${s.id}', this.checked)" ${selectedSensors.has(s.id) ? 'checked' : ''}></td>
                <td>
                    <span class="clickable" onclick="showSensorDetail('${s.id}')">${s.id}</span><br>
                    <select class="inline-edit-select inline-edit-sm" data-sensor="${s.id}" data-field="type" onchange="inlineSaveSensor(this)">
                        ${SENSOR_TYPES.map(t =>
                            `<option value="${t}" ${s.type === t ? 'selected' : ''}>${t}</option>`
                        ).join('')}
                    </select>
                </td>
                <td><input class="inline-edit-input" data-sensor="${s.id}" data-field="soaTagId" value="${s.soaTagId || ''}" placeholder="SOA Tag" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                <td>${statusSelectHtml}</td>
                <td><select class="inline-edit-select" data-sensor="${s.id}" data-field="community" onchange="inlineSaveSensor(this)">
                    ${('<option value="">— None —</option>' + COMMUNITIES.map(c => `<option value="${c.id}" ${s.community === c.id ? 'selected' : ''}>${c.name}</option>`).join(''))}
                </select></td>
                <td><input class="inline-edit-input" data-sensor="${s.id}" data-field="location" value="${s.location || ''}" placeholder="Address or GPS" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                <td>${s.dateInstalled || '—'}</td>
                <td><input class="inline-edit-input" type="date" data-sensor="${s.id}" data-field="datePurchased" value="${s.datePurchased || ''}" onblur="inlineSaveSensor(this)"></td>
                <td><input class="inline-edit-input" data-sensor="${s.id}" data-field="collocationDates" value="${s.collocationDates || ''}" placeholder="e.g. Mar 5-13" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                <td>
                    <button class="btn btn-sm" onclick="openMoveSensorModal('${s.id}')">Move</button>
                </td>
            </tr>`;
        }).join('') || '<tr><td colspan="9" class="empty-state">No sensors found.</td></tr>';

        // Attach change listener for multi-select status fields
        document.querySelectorAll('.inline-edit-status').forEach(sel => {
            sel.addEventListener('change', function() { inlineSaveSensor(this); });
        });
    } else {
        document.getElementById('sensors-tbody').innerHTML = filtered.map(s => `
            <tr>
                <td><input type="checkbox" class="sensor-checkbox" data-sensor-id="${s.id}" onchange="toggleSensorCheckbox('${s.id}', this.checked)" ${selectedSensors.has(s.id) ? 'checked' : ''}></td>
                <td><span class="clickable" onclick="showSensorDetail('${s.id}')">${s.id}</span><br><small style="color:#888">${s.type}</small></td>
                <td>${s.soaTagId || '—'}</td>
                <td>${renderStatusBadges(s, true)}</td>
                <td><span class="clickable" onclick="showCommunity('${s.community}')">${getCommunityName(s.community)}</span></td>
                <td>${s.location || '—'}</td>
                <td>${s.dateInstalled || '—'}</td>
                <td>${s.datePurchased || '—'}</td>
                <td>${s.collocationDates || '—'}</td>
                <td>
                    <button class="btn btn-sm" onclick="openEditSensorModal('${s.id}')">Edit</button>
                    <button class="btn btn-sm" onclick="openMoveSensorModal('${s.id}')">Move</button>
                </td>
            </tr>
        `).join('') || '<tr><td colspan="10" class="empty-state">No sensors found.</td></tr>';
    }
}

function inlineSaveSensor(el) {
    const sensorId = el.dataset.sensor;
    const field = el.dataset.field;
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;

    if (field === 'status') {
        s.status = Array.from(el.selectedOptions).map(o => o.value);
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
            datePurchased: 'Purchase Date', collocationDates: 'Collocation Dates'
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

        // Apply the data
        const idx = sensors.findIndex(s => s.id === editId);
        if (idx >= 0) sensors[idx] = data;
        trackRecent('sensors', data.id, 'edited');
        persistSensor(data);
        closeModal('modal-add-sensor');
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
        closeModal('modal-add-sensor');
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
            <div class="info-item"><label>SOA Tag ID</label>
                <input class="inline-edit-input" data-sensor="${s.id}" data-field="soaTagId" value="${s.soaTagId || ''}" placeholder="SOA Tag" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
            <div class="info-item"><label>Status</label>
                <select class="inline-edit-select inline-edit-status" data-sensor="${s.id}" data-field="status" multiple onchange="inlineSaveSensor(this)">
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
                <p>${s.dateInstalled || '—'}</p>
            </div>
            <div class="info-item"><label>Purchase Date</label>
                <input class="inline-edit-input" type="date" data-sensor="${s.id}" data-field="datePurchased" value="${s.datePurchased || ''}" onblur="inlineSaveSensor(this)">
            </div>
            <div class="info-item"><label>Collocation Dates</label>
                <input class="inline-edit-input" data-sensor="${s.id}" data-field="collocationDates" value="${s.collocationDates || ''}" placeholder="e.g. Mar 5-13" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()">
            </div>
        `;
    } else {
        document.getElementById('sensor-info-card').innerHTML = `
            <div class="info-item"><label>Type</label><p class="editable-field" onclick="inlineEditSensorType('${s.id}')">${s.type}</p></div>
            <div class="info-item"><label>SOA Tag ID</label><p class="editable-field" onclick="inlineEditSensor('${s.id}', 'soaTagId')">${s.soaTagId || '—'}</p></div>
            <div class="info-item"><label>Status</label><p>${renderStatusBadges(s, true)}</p></div>
            <div class="info-item"><label>Community</label><p>${getCommunityName(s.community)} <a class="move-sensor-link" onclick="openMoveSensorModal('${s.id}')">Move &rarr;</a></p></div>
            <div class="info-item"><label>Location</label><p class="editable-field" onclick="inlineEditSensor('${s.id}', 'location')">${s.location || '<span class="field-placeholder">Address or GPS coordinates</span>'}</p></div>
            <div class="info-item"><label>Install Date</label><p>${s.dateInstalled || '—'} <a class="move-sensor-link" onclick="viewInstallHistory()">View history &rarr;</a></p></div>
            <div class="info-item"><label>Purchase Date</label><p class="editable-field" onclick="inlineEditSensor('${s.id}', 'datePurchased')">${s.datePurchased || '—'}</p></div>
            <div class="info-item"><label>Collocation Dates</label><p class="editable-field" onclick="inlineEditSensor('${s.id}', 'collocationDates')">${s.collocationDates || '—'}</p></div>
        `;
    }

    // Reset filter
    const filterEl = document.getElementById('sensor-history-filter');
    if (filterEl) filterEl.value = '';

    filterSensorHistory();

    resetTabs(document.getElementById('view-sensor-detail'));

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-sensor-detail').classList.add('active');
    pushViewHistory();
}

function inlineEditSensor(sensorId, field) {
    const s = sensors.find(x => x.id === sensorId);
    if (!s) return;

    const labels = { soaTagId: 'SOA Tag ID', location: 'Location', datePurchased: 'Purchase Date', collocationDates: 'Collocation Dates' };
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
        <th>Sensor ID</th><th>SOA Tag ID</th><th>Status</th>
        <th>Location</th><th>Install Date</th><th>Purchase Date</th><th>Collocation Dates</th><th>Actions</th>
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
                    <td><input class="inline-edit-input" data-sensor="${s.id}" data-field="soaTagId" value="${s.soaTagId || ''}" placeholder="SOA Tag" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                    <td><select class="inline-edit-select inline-edit-status" data-sensor="${s.id}" data-field="status" multiple onchange="inlineSaveSensor(this)">
                        ${ALL_STATUSES.map(st => `<option value="${st}" ${currentStatuses.includes(st) ? 'selected' : ''}>${st}</option>`).join('')}
                    </select></td>
                    <td><input class="inline-edit-input" data-sensor="${s.id}" data-field="location" value="${s.location || ''}" placeholder="Address or GPS" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                    <td>${s.dateInstalled || '—'}</td>
                    <td><input class="inline-edit-input" type="date" data-sensor="${s.id}" data-field="datePurchased" value="${s.datePurchased || ''}" onblur="inlineSaveSensor(this)"></td>
                    <td><input class="inline-edit-input" data-sensor="${s.id}" data-field="collocationDates" value="${s.collocationDates || ''}" placeholder="e.g. Mar 5-13" onblur="inlineSaveSensor(this)" onkeydown="if(event.key==='Enter')this.blur()"></td>
                    <td><button class="btn btn-sm" onclick="openMoveSensorModal('${s.id}')">Move</button></td>
                </tr>`;
            }).join('');
        }
        return list.map(s => `<tr>
            <td><span class="clickable" onclick="showSensorDetail('${s.id}')">${s.id}</span><br><small style="color:#888">${s.type}</small></td>
            <td>${s.soaTagId || '—'}</td>
            <td>${renderStatusBadges(s, true)}</td>
            <td>${s.location || '—'}</td>
            <td>${s.dateInstalled || '—'}</td>
            <td>${s.datePurchased || '—'}</td>
            <td>${s.collocationDates || '—'}</td>
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
    const commComms = comms.filter(c => c.community === communityId || (c.taggedCommunities && c.taggedCommunities.includes(communityId)));
    renderTimeline('community-comms-timeline', commComms.map(c => ({
        ...c,
        type: c.commType || c.type,
    })));

    // Files
    renderCommunityFiles(communityId);

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
            : `onclick="window.open('${fileUrl}', '_blank')"`;
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
    window.open(url, '_blank');
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

function saveContact(e) {
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
        contacts.push(data);
        trackRecent('contacts', data.id, 'edited');

        // Log new contact added
        if (!setupMode && data.community) {
            const note = {
                id: generateId('n'),
                date: nowDatetime(),
                type: 'Info Edit',
                text: `${data.name} added as a contact for ${getCommunityName(data.community)}.`,
                createdBy: getCurrentUserName(), createdById: currentUserId,
                taggedSensors: [],
                taggedCommunities: [data.community],
                taggedContacts: [data.id],
            };
            notes.push(note); persistNote(note);
        }
    }

    persistContact(data);
    closeModal('modal-add-contact');
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
    closeModal('modal-add-contact');

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

    openModal('modal-add-note');
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

    closeModal('modal-add-note');

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
        id: 'comm' + Date.now(),
        date: commDate,
        type: 'Communication',
        commType: commType,
        text: `[${commType}] ${text}`,
        createdBy: getCurrentUserName(), createdById: currentUserId,
        community: communityId,
        taggedContacts: taggedContacts,
        taggedCommunities: [communityId],
    };

    comms.push(comm); persistComm(comm);
    closeModal('modal-comm');

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
            ? `<div class="timeline-additional-info"><em>${highlightMentions(item.additionalInfo)}</em></div>`
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
                <div class="timeline-text">${highlightMentions(item.text)}${hasFullBody ? ' <small style="color:#2563eb">(click to expand)</small>' : ''}</div>
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
    if (currentSensor) showSensorView(currentSensor);
    if (currentCommunity) showCommunityView(currentCommunity);
    if (currentContact) showContactView(currentContact);
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
    return text.replace(/@([\w\s]+?)(?=\.|,|$|@)/g, '<strong style="color:#6c3483">@$1</strong>');
}

function nowDatetime() {
    const now = new Date();
    return now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + 'T' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0');
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    if (typeof dateStr !== 'string') dateStr = String(dateStr);
    // Handle both "2026-03-14" and "2026-03-14T10:30" formats
    const hasTime = dateStr.includes('T') && dateStr.split('T')[1];
    let d;
    if (hasTime) {
        d = new Date(dateStr);
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
    'PM Sensor Issue', 'Gaseous Sensor Issue', 'SD Card Issue', 'Power Failure', 'Lost Connection'
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
function openInlineCommunityChange(sensorId) {
    // Reuse the move sensor modal
    openMoveSensorModal(sensorId);
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
    const { data, error } = await supa.from('allowed_emails').select('*').order('email');
    if (error) { console.error(error); return; }

    const active = (data || []).filter(r => r.status !== 'revoked');
    const revoked = (data || []).filter(r => r.status === 'revoked');

    document.getElementById('settings-active-users').innerHTML = active.map(row => {
        const isYou = row.email.toLowerCase() === currentEmail.toLowerCase();
        return `<div class="settings-user-row">
            <span>
                <span class="settings-user-email">${row.email}</span>
                ${isYou ? '<span class="settings-user-you">(you)</span>' : ''}
            </span>
            ${!isYou ? `<button class="btn btn-sm btn-danger" onclick="revokeUser('${row.id}')">Revoke Access</button>` : ''}
        </div>`;
    }).join('') || '<p style="color:var(--slate-400);font-size:13px">No active users.</p>';

    const revokedSection = document.getElementById('settings-revoked-section');
    if (revoked.length > 0) {
        revokedSection.style.display = '';
        document.getElementById('settings-revoked-users').innerHTML = revoked.map(row => {
            return `<div class="settings-user-row">
                <span class="settings-user-email" style="color:var(--slate-400)">${row.email}</span>
                <button class="btn btn-sm" onclick="reactivateUser('${row.id}')">Reactivate</button>
            </div>`;
        }).join('');
    } else {
        revokedSection.style.display = 'none';
    }
}

async function addAllowedEmail() {
    const input = document.getElementById('settings-add-email');
    const email = input.value.trim().toLowerCase();
    if (!email) return;

    const { data: existing } = await supa.from('allowed_emails').select('*').eq('email', email).single();
    if (existing && existing.status === 'revoked') {
        await supa.from('allowed_emails').update({ status: 'active' }).eq('id', existing.id);
    } else {
        const { error } = await supa.from('allowed_emails').insert({ email, status: 'active' });
        if (error) {
            alert(error.message.includes('duplicate') ? 'That email is already added.' : error.message);
            return;
        }
    }

    input.value = '';
    const session = await db.getSession();
    await renderAllowedUsers(session?.user?.email || '');
}

async function revokeUser(id) {
    if (!confirm('Revoke access for this user? They will no longer be able to sign in. Their history will be preserved.')) return;

    const { error } = await supa.from('allowed_emails').update({ status: 'revoked' }).eq('id', id);
    if (error) { alert(error.message); return; }

    const session = await db.getSession();
    await renderAllowedUsers(session?.user?.email || '');
}

async function reactivateUser(id) {
    const { error } = await supa.from('allowed_emails').update({ status: 'active' }).eq('id', id);
    if (error) { alert(error.message); return; }

    const session = await db.getSession();
    await renderAllowedUsers(session?.user?.email || '');
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

function getIssueSensorCount() {
    return sensors.filter(s => getStatusArray(s).some(st => SENSOR_ISSUE_STATUSES.includes(st))).length;
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
function exportSpreadsheet(headers, rows, filename) {
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    ws['!cols'] = headers.map(() => ({ wch: 20 }));
    XLSX.writeFile(wb, filename);
}

function exportSensorsCSV() {
    const headers = ['Sensor ID', 'SOA Tag ID', 'Type', 'Status', 'Community', 'Location', 'Install Date', 'Purchase Date', 'Collocation Dates'];
    const rows = sensors.sort((a, b) => a.id.localeCompare(b.id)).map(s => [
        s.id, s.soaTagId || '', s.type, getStatusArray(s).join('; '),
        getCommunityName(s.community), s.location || '', s.dateInstalled || '',
        s.datePurchased || '', s.collocationDates || '',
    ]);
    exportSpreadsheet(headers, rows, `sensors_${new Date().toISOString().split('T')[0]}.xlsx`);
}

function exportContactsCSV() {
    const headers = ['Name', 'Role', 'Community', 'Organization', 'Email', 'Phone', 'Status'];
    const rows = contacts.sort((a, b) => a.name.localeCompare(b.name)).map(c => [
        c.name, c.role || '', getCommunityName(c.community), c.org || '',
        c.email || '', c.phone || '', c.active === false ? 'Inactive' : 'Active',
    ]);
    exportSpreadsheet(headers, rows, `contacts_${new Date().toISOString().split('T')[0]}.xlsx`);
}

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
    const sensorIds = Array.from(selectedSensors);
    const sensorList = sensorIds.join(', ');
    const now = nowDatetime();

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

    sensorIds.forEach(id => {
        const s = sensors.find(x => x.id === id);
        if (!s) return;
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
        let parts = [];
        if (doMove) parts.push(`moved to ${toName}`);
        if (doStatus) parts.push(`status set to ${newStatuses.join(', ')}`);
        const noteText = `Bulk action: ${sensorList} ${parts.join(' and ')}.${userNotes ? ' ' + userNotes : ''}`;
        const note = {
            id: generateId('n'),
            date: now,
            type: doMove ? 'Movement' : 'Status Change',
            text: noteText,
            createdBy: getCurrentUserName(), createdById: currentUserId,
            taggedSensors: sensorIds,
            taggedCommunities: toCommunityId ? [toCommunityId] : [],
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
    const active = document.querySelector('.view.active');
    if (active) viewHistory.push(active.id);
    if (viewHistory.length > 20) viewHistory.shift();
    updateBackButton();
}

function updateBackButton() {
    const btn = document.getElementById('back-button');
    btn.style.display = viewHistory.length > 1 ? '' : 'none';
}

function goBack() {
    if (viewHistory.length <= 1) return;
    viewHistory.pop();
    const prevViewId = viewHistory[viewHistory.length - 1];
    if (prevViewId === 'view-dashboard') showView('dashboard');
    else if (prevViewId === 'view-all-sensors') showView('all-sensors');
    else if (prevViewId === 'view-communities') showView('communities');
    else if (prevViewId === 'view-contacts') showView('contacts');
    else if (prevViewId === 'view-settings') showView('settings');
    else if (prevViewId === 'view-community' && currentCommunity) showCommunityView(currentCommunity);
    else if (prevViewId === 'view-sensor-detail' && currentSensor) showSensorView(currentSensor);
    else if (prevViewId === 'view-contact-detail' && currentContact) showContactView(currentContact);
    viewHistory.pop();
    updateBackButton();
}

// ===== VIEW INSTALLATION HISTORY =====
function viewInstallHistory() {
    const filterEl = document.getElementById('sensor-history-filter');
    if (filterEl) filterEl.value = '_changes';
    filterSensorHistory();
    document.getElementById('tab-sensor-history').scrollIntoView({ behavior: 'smooth' });
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

// ===== INIT =====
(async function init() {
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
        // Check if MFA was verified recently (within 1 hour) and browser hasn't been closed
        const mfaVerifiedAt = sessionStorage.getItem('mfa_verified_at');
        const mfaStillValid = mfaVerifiedAt && (Date.now() - parseInt(mfaVerifiedAt)) < INACTIVITY_LIMIT;

        if (mfaStillValid) {
            await enterApp();
        } else {
            await checkMfaAndProceed();
        }
    } else {
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
