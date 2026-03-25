// ===== QUANTAQ INTEGRATION =====
// Loads alerts from quantaq_alerts Supabase table.
// The actual QuantAQ API calls happen in the Edge Function (quantaq-check).
// This file handles: loading, rendering, filtering, acknowledging, and notes.

const QUANTAQ_OFFLINE_THRESHOLD_MIN = 60;

// In-memory alert state (loaded from DB)
let quantaqAlerts = [];
let quantaqLastCheck = null;
let quantaqChecking = false;
let quantaqFilter = ''; // '' = all, or 'Offline', 'PM Sensor Issue', etc.

// ===== LOAD ALERTS FROM DATABASE =====

async function loadQuantAQAlerts() {
    try {
        // Load all non-ancient alerts (active + recently resolved/acknowledged)
        const { data, error } = await supa
            .from('quantaq_alerts')
            .select('*')
            .order('detected_at', { ascending: false });

        if (error) throw error;

        quantaqAlerts = (data || []).map(row => ({
            id: row.id,
            sensorSn: row.sensor_sn,
            sensorModel: row.sensor_model || '',
            communityName: row.community_name || '',
            issueType: row.issue_type,
            detail: row.detail || '',
            status: row.status,
            isNew: row.is_new,
            detectedAt: row.detected_at,
            resolvedAt: row.resolved_at,
            lastChecked: row.last_checked,
            acknowledgedBy: row.acknowledged_by,
            notes: row.notes || [],
        }));

        console.log(`[QuantAQ] Loaded ${quantaqAlerts.length} alerts from database`);
    } catch (err) {
        console.error('[QuantAQ] Failed to load alerts:', err);
    }
}

async function loadQuantAQLastCheck() {
    try {
        const value = await db.getAppSetting('quantaq_last_check');
        quantaqLastCheck = value || null;
    } catch (err) {
        console.error('[QuantAQ] Failed to load last check time:', err);
    }
}

async function initQuantAQ() {
    await Promise.all([
        loadQuantAQAlerts(),
        loadQuantAQLastCheck(),
    ]);
    renderDashboard();
    if (document.getElementById('view-quantaq-alerts')?.classList.contains('active')) {
        renderQuantAQAlertsView();
    }
}

// ===== RUN CHECK (calls Edge Function, then reloads from DB) =====

async function runQuantAQCheck() {
    if (quantaqChecking) return;
    quantaqChecking = true;
    updateQuantAQStatus('Running QuantAQ check...');
    renderCheckButtons();

    try {
        // Call the Edge Function
        const session = await db.getSession();
        const token = session?.access_token;

        if (!token) {
            throw new Error('Not authenticated. Please sign in first.');
        }

        const resp = await fetch(SUPABASE_URL + '/functions/v1/quantaq-check', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
            },
            body: '{}',
        });

        if (!resp.ok) {
            const errBody = await resp.text();
            throw new Error(`Edge Function error ${resp.status}: ${errBody.slice(0, 200)}`);
        }

        const result = await resp.json();
        console.log('[QuantAQ] Check result:', result);

        updateQuantAQStatus(
            result.success
                ? `Check complete: ${result.devices_checked} devices, ${result.new_alerts} new alerts, ${result.resolved_alerts} resolved`
                : 'Check failed: ' + (result.error || 'Unknown error')
        );

        // Reload alerts from database
        await loadQuantAQAlerts();
        await loadQuantAQLastCheck();

        // Re-render
        renderDashboard();
        if (document.getElementById('view-quantaq-alerts')?.classList.contains('active')) {
            renderQuantAQAlertsView();
        }

    } catch (err) {
        console.error('[QuantAQ] Check failed:', err);
        updateQuantAQStatus('Check failed: ' + err.message);
    } finally {
        quantaqChecking = false;
        renderCheckButtons();
    }
}

// ===== HELPERS =====

function quantaqTimeSince(dateStr) {
    const d = dateStr.endsWith('Z') ? dateStr : dateStr + 'Z';
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ${hrs % 24}h ago`;
}

function updateQuantAQStatus(msg) {
    const el = document.getElementById('quantaq-status');
    if (el) el.textContent = msg;
}

function renderCheckButtons() {
    // Update all "Run Check" buttons across dashboard and alerts view
    const btns = document.querySelectorAll('[data-quantaq-check-btn]');
    btns.forEach(btn => {
        btn.disabled = quantaqChecking;
        btn.textContent = quantaqChecking ? 'Checking...' : 'Run QuantAQ Check';
    });
    // Also the full-view button
    const fullBtn = document.querySelector('#quantaq-alerts-content .btn-primary[onclick*="runQuantAQCheck"]');
    if (fullBtn) {
        fullBtn.disabled = quantaqChecking;
        fullBtn.textContent = quantaqChecking ? 'Checking...' : 'Run Check Now';
    }
}

// ===== DASHBOARD ALERTS (inline on dashboard) =====

function renderDashboardAlerts() {
    const container = document.getElementById('dashboard-alerts-section');
    if (!container) return;

    // Update check button state
    const btn = document.getElementById('dashboard-check-btn');
    if (btn) {
        btn.disabled = quantaqChecking;
        btn.textContent = quantaqChecking ? 'Checking...' : 'Run QuantAQ Check';
    }

    // Update last check time
    const lastCheckEl = document.getElementById('dashboard-last-check');
    if (lastCheckEl && quantaqLastCheck) {
        lastCheckEl.textContent = 'Last QuantAQ check: ' + new Date(quantaqLastCheck).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    const active = quantaqAlerts.filter(a => a.status === 'active');
    const newAlerts = active.filter(a => a.isNew);
    const offline = active.filter(a => a.issueType === 'Offline');
    const pmIssues = active.filter(a => a.issueType === 'PM Sensor Issue');
    const gasIssues = active.filter(a => a.issueType === 'Gaseous Sensor Issue');
    const sdIssues = active.filter(a => a.issueType === 'SD Card Issue');
    const resolved = quantaqAlerts.filter(a => a.status === 'resolved' && a.isNew);

    if (active.length === 0 && resolved.length === 0 && !quantaqLastCheck) {
        container.innerHTML = `<div class="quantaq-empty" style="padding:24px">
            <p style="font-size:14px;color:var(--slate-400)">Click "Run QuantAQ Check" to scan all sensors for issues.</p>
        </div>`;
        return;
    }

    let html = '';

    // Alert counts row — clickable to filter
    if (active.length > 0) {
        const countCard = (list, type, cls, label) => list.length > 0
            ? `<div class="quantaq-count ${cls} ${quantaqFilter === type ? 'active-filter' : ''}" onclick="filterQuantAQAlerts('${type}')"><span class="quantaq-count-num">${list.length}</span><span class="quantaq-count-label">${label}</span></div>`
            : '';
        html += `<div class="quantaq-counts" style="margin-bottom:16px">
            ${countCard(active, '', 'all', 'All Active')}
            ${countCard(offline, 'Offline', 'offline', 'Offline')}
            ${countCard(pmIssues, 'PM Sensor Issue', 'pm', 'PM Issue')}
            ${countCard(gasIssues, 'Gaseous Sensor Issue', 'gas', 'Gas Issue')}
            ${countCard(sdIssues, 'SD Card Issue', 'sd', 'SD Card')}
        </div>`;
        if (quantaqFilter) {
            html += `<p style="font-size:12px;color:var(--slate-400);margin-bottom:12px">Filtered by: <strong>${quantaqFilter || 'All'}</strong> <a href="#" onclick="event.preventDefault();filterQuantAQAlerts('')" style="color:var(--navy-400);margin-left:6px">Clear filter</a></p>`;
        }
        if (newAlerts.length > 0 && !quantaqFilter) html += `<p class="quantaq-new-badge">${newAlerts.length} new since last check</p>`;
        if (resolved.length > 0 && !quantaqFilter) html += `<p class="quantaq-resolved-badge">${resolved.length} resolved since last check</p>`;
    }

    // Apply filter
    const filterFn = a => !quantaqFilter || quantaqFilter === a.issueType;
    const filteredNew = newAlerts.filter(filterFn);
    const ongoing = active.filter(a => !a.isNew).filter(filterFn);
    const filteredResolved = resolved.filter(filterFn);

    // New alerts
    if (filteredNew.length > 0) {
        html += `<h3 class="quantaq-section-title" style="color:#dc2626">New Alerts (${filteredNew.length})</h3>`;
        html += renderQuantAQAlertList(filteredNew, true);
    }

    // Ongoing
    if (ongoing.length > 0) {
        html += `<h3 class="quantaq-section-title">Preexisting Alerts (${ongoing.length})</h3>`;
        html += renderQuantAQAlertList(ongoing, false);
    }

    // Resolved
    if (filteredResolved.length > 0) {
        html += `<h3 class="quantaq-section-title" style="color:#16a34a">Resolved (${filteredResolved.length})</h3>`;
        html += renderQuantAQAlertList(filteredResolved, false);
    }

    // All clear
    if (active.length === 0 && quantaqLastCheck) {
        html += `<div class="quantaq-empty" style="padding:24px">
            <span style="font-size:28px;color:#16a34a">&#10003;</span>
            <p style="font-size:15px;font-weight:600;color:var(--navy-500);margin-top:6px">All Clear</p>
            <p style="font-size:13px;color:var(--slate-400)">All sensors are online and healthy.</p>
        </div>`;
    }

    // View all link
    if (active.length > 0) {
        html += `<div style="text-align:center;margin-top:16px">
            <button class="btn btn-primary" onclick="showView('quantaq-alerts')">View Full Alert Details</button>
        </div>`;
    }

    container.innerHTML = html;
}

// ===== FULL ALERTS VIEW =====

function renderQuantAQAlertsView() {
    const container = document.getElementById('quantaq-alerts-content');
    if (!container) return;

    const active = quantaqAlerts.filter(a => a.status === 'active');
    const newActive = active.filter(a => a.isNew);
    const ongoingActive = active.filter(a => !a.isNew);
    const resolved = quantaqAlerts.filter(a => a.status === 'resolved' && a.isNew);

    const lastCheckStr = quantaqLastCheck
        ? new Date(quantaqLastCheck).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : 'Never';

    let html = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
            <div>
                <p style="font-size:13px;color:var(--slate-500)">Last check: ${lastCheckStr}</p>
                <span id="quantaq-status" style="font-size:11px;color:var(--slate-400)"></span>
            </div>
            <button class="btn btn-primary" onclick="runQuantAQCheck()" ${quantaqChecking ? 'disabled' : ''}>
                ${quantaqChecking ? 'Checking...' : 'Run Check Now'}
            </button>
        </div>
    `;

    // Summary counts
    const offline = active.filter(a => a.issueType === 'Offline');
    const pmIssues = active.filter(a => a.issueType === 'PM Sensor Issue');
    const gasIssues = active.filter(a => a.issueType === 'Gaseous Sensor Issue');
    const sdIssues = active.filter(a => a.issueType === 'SD Card Issue');

    html += `<div class="quantaq-summary-row">
        <div class="quantaq-summary-card"><span class="quantaq-summary-num ${active.length > 0 ? 'alert' : 'ok'}">${active.length}</span><span class="quantaq-summary-label">Active Alerts</span></div>
        <div class="quantaq-summary-card"><span class="quantaq-summary-num ${offline.length > 0 ? 'alert' : ''}">${offline.length}</span><span class="quantaq-summary-label">Offline</span></div>
        <div class="quantaq-summary-card"><span class="quantaq-summary-num ${pmIssues.length > 0 ? 'alert' : ''}">${pmIssues.length}</span><span class="quantaq-summary-label">PM Issues</span></div>
        <div class="quantaq-summary-card"><span class="quantaq-summary-num ${gasIssues.length > 0 ? 'alert' : ''}">${gasIssues.length}</span><span class="quantaq-summary-label">Gas Issues</span></div>
        <div class="quantaq-summary-card"><span class="quantaq-summary-num ${sdIssues.length > 0 ? 'alert' : ''}">${sdIssues.length}</span><span class="quantaq-summary-label">SD Card</span></div>
        <div class="quantaq-summary-card"><span class="quantaq-summary-num ok">${resolved.length}</span><span class="quantaq-summary-label">Resolved</span></div>
    </div>`;

    // New alerts
    if (newActive.length > 0) {
        html += `<h3 class="quantaq-section-title" style="color:#dc2626">New Since Last Check (${newActive.length})</h3>`;
        html += renderQuantAQAlertList(newActive, true);
    }

    // Ongoing alerts
    if (ongoingActive.length > 0) {
        html += `<h3 class="quantaq-section-title">Ongoing (${ongoingActive.length})</h3>`;
        html += renderQuantAQAlertList(ongoingActive, false);
    }

    // Resolved
    if (resolved.length > 0) {
        html += `<h3 class="quantaq-section-title" style="color:#16a34a">Resolved Since Last Check (${resolved.length})</h3>`;
        html += renderQuantAQAlertList(resolved, false);
    }

    if (active.length === 0 && resolved.length === 0) {
        html += `<div class="quantaq-empty">
            <span style="font-size:36px">&#10003;</span>
            <p style="font-size:15px;font-weight:600;color:var(--navy-500);margin-top:8px">All Clear</p>
            <p style="font-size:13px;color:var(--slate-400)">No active alerts. All sensors are online and healthy.</p>
        </div>`;
    }

    container.innerHTML = html;
}

function renderQuantAQAlertList(alerts, isNew) {
    return alerts.map(a => {
        const isOffline = a.issueType === 'Offline';
        const isResolved = a.status === 'resolved';
        const badgeClass = isResolved ? 'quantaq-badge-resolved'
            : isOffline ? 'quantaq-badge-offline'
            : a.issueType === 'PM Sensor Issue' ? 'quantaq-badge-pm'
            : a.issueType === 'Gaseous Sensor Issue' ? 'quantaq-badge-gas'
            : 'quantaq-badge-sd';

        const detectedStr = new Date(a.detectedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const duration = quantaqTimeSince(a.detectedAt);

        const notesHtml = a.notes.length > 0
            ? a.notes.map(n => `<div class="quantaq-note"><strong>${escapeHtml(n.by)}</strong> <span style="color:var(--slate-400)">${new Date(n.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span><br>${escapeHtml(n.text)}</div>`).join('')
            : '';

        return `<div class="quantaq-alert-card ${isNew ? 'new' : ''} ${isResolved ? 'resolved' : ''}">
            <div class="quantaq-alert-header">
                <div>
                    <span class="quantaq-alert-sn" onclick="showSensorDetail('${a.sensorSn}')">${a.sensorSn}</span>
                    <span class="quantaq-badge ${badgeClass}">${a.issueType}</span>
                    ${isNew && !isResolved ? '<span class="quantaq-new-tag">NEW</span>' : ''}
                </div>
                <span class="quantaq-alert-community">${escapeHtml(a.communityName)}</span>
            </div>
            <div class="quantaq-alert-body">
                <p class="quantaq-alert-detail">${escapeHtml(a.detail)}</p>
                <p class="quantaq-alert-meta">Detected: ${detectedStr} (${duration})${isResolved ? ` · Resolved: ${new Date(a.resolvedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}</p>
                ${notesHtml}
            </div>
            ${!isResolved ? `<div class="quantaq-alert-actions">
                <button class="btn btn-sm" onclick="addQuantAQNote('${a.id}')">Add Note</button>
                <button class="btn btn-sm" onclick="acknowledgeQuantAQAlert('${a.id}')">${a.acknowledgedBy ? 'Acknowledged by ' + escapeHtml(a.acknowledgedBy) : 'Acknowledge'}</button>
            </div>` : ''}
        </div>`;
    }).join('');
}

// ===== FILTER =====

function filterQuantAQAlerts(type) {
    quantaqFilter = quantaqFilter === type ? '' : type; // toggle
    renderDashboardAlerts();
    if (document.getElementById('view-quantaq-alerts')?.classList.contains('active')) {
        renderQuantAQAlertsView();
    }
}

// ===== ALERT ACTIONS (persisted to database) =====

async function acknowledgeQuantAQAlert(alertId) {
    const alert = quantaqAlerts.find(a => a.id === alertId);
    if (!alert) return;

    const userName = currentUser || 'Unknown';
    alert.acknowledgedBy = userName;
    alert.status = 'acknowledged';

    // Persist to database
    try {
        const { error } = await supa
            .from('quantaq_alerts')
            .update({
                acknowledged_by: userName,
                status: 'acknowledged',
            })
            .eq('id', alertId);

        if (error) {
            console.error('[QuantAQ] Failed to persist acknowledge:', error);
            alert.status = 'active'; // revert on failure
            alert.acknowledgedBy = null;
        }
    } catch (err) {
        console.error('[QuantAQ] Failed to persist acknowledge:', err);
        alert.status = 'active';
        alert.acknowledgedBy = null;
    }

    renderQuantAQAlertsView();
    renderDashboardAlerts();
}

async function addQuantAQNote(alertId) {
    const alert = quantaqAlerts.find(a => a.id === alertId);
    if (!alert) return;

    const text = prompt('Add a note to this alert:');
    if (!text || !text.trim()) return;

    const noteEntry = {
        by: currentUser || 'Unknown',
        at: new Date().toISOString(),
        text: text.trim(),
    };

    alert.notes.push(noteEntry);

    // Persist to database (notes is a JSONB array)
    try {
        const { error } = await supa
            .from('quantaq_alerts')
            .update({ notes: alert.notes })
            .eq('id', alertId);

        if (error) {
            console.error('[QuantAQ] Failed to persist note:', error);
            alert.notes.pop(); // revert on failure
        }
    } catch (err) {
        console.error('[QuantAQ] Failed to persist note:', err);
        alert.notes.pop();
    }

    renderQuantAQAlertsView();
    renderDashboardAlerts();
}
