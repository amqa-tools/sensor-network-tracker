// ===== QUANTAQ INTEGRATION =====
// Loads alerts from quantaq_alerts Supabase table.
// The actual QuantAQ API calls happen in the Edge Function (quantaq-check).
// This file handles: loading, rendering, filtering, acknowledging, and notes.

// In-memory alert state (loaded from DB)
let quantaqAlerts = [];
let quantaqLastCheck = null;
let quantaqChecking = false;
let quantaqFilter = ''; // '' = all, or 'Lost Connection', 'PM Sensor Issue', etc.
let quantaqTab = 'active'; // 'active' or 'dismissed'

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
            severity: row.severity || ALERT_SEVERITY[row.issue_type] || 'warning',
            graceExpiresAt: row.grace_expires_at || null,
            isNew: row.is_new,
            detectedAt: row.detected_at,
            resolvedAt: row.resolved_at,
            lastChecked: row.last_checked,
            acknowledgedBy: row.acknowledged_by,
            notes: row.notes || [],
            eventNoteId: (row.notes || []).find(n => n.noteId)?.noteId || null,
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
        typeof loadQuantAQCronInfo === 'function' ? loadQuantAQCronInfo() : Promise.resolve(),
    ]);
    // Don't call renderDashboard() here — the boot sequence in app.js
    // will call restoreLastView() which renders the appropriate view.
    // Calling it here would be premature (sidebar not built yet) and redundant.
}

// Severity tiers (mirrors edge function for fallback display when DB
// rows don't have a severity value).
const ALERT_SEVERITY = {
    'PM Sensor Issue': 'critical',
    'SD Card Issue': 'critical',
    'Gaseous Sensor Issue': 'warning',
    'Lost Connection': 'info',
};

// The manual "Run Check Now" button just invokes the edge function in scan
// mode. All the scan logic (devices, flag decoding, alert diffing, event
// notes, sensor status updates) lives server-side in
// supabase/functions/quantaq-check/index.ts so there's only one scanner.
// Call from DevTools console, e.g. diagnoseQuantAQSensor('MOD-00465').
// Returns the scanner's view of a single sensor — whether it's being skipped
// by EXPECTED_OFFLINE filtering, how many raw rows came back, what flag bits
// they carry, what the scan would decide, and any existing alerts in the DB.
// The result is also logged to the console for quick inspection.
async function diagnoseQuantAQSensor(sn) {
    if (!sn || typeof sn !== 'string') { console.warn('diagnoseQuantAQSensor: pass a sensor id like "MOD-00465"'); return; }
    try {
        const resp = await fetch(SUPABASE_URL + '/functions/v1/quantaq-check', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'diagnose', sn }),
        });
        const data = await resp.json();
        if (!resp.ok) { console.error('[QAQ diagnose]', resp.status, data); return data; }
        console.log('[QAQ diagnose]', sn, data);
        return data;
    } catch (err) {
        console.error('[QAQ diagnose] failed:', err);
    }
}

async function runQuantAQCheck() {
    if (quantaqChecking) return;
    quantaqChecking = true;
    const checkStartTime = Date.now();
    let dots = 0;
    const progressInterval = setInterval(() => {
        dots = (dots + 1) % 4;
        const elapsed = Math.floor((Date.now() - checkStartTime) / 1000);
        updateQuantAQStatus(`Running server-side scan${'.'.repeat(dots)} (${elapsed}s)`);
    }, 400);
    updateQuantAQStatus('Running server-side scan...');
    renderCheckButtons();

    try {
        const resp = await fetch(SUPABASE_URL + '/functions/v1/quantaq-check', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const summary = await resp.json().catch(() => ({}));
        if (!resp.ok || summary.error) {
            throw new Error(summary.error || `HTTP ${resp.status}`);
        }

        // Pull the fresh alerts/timestamps/cron info from Supabase so the UI
        // reflects what the scan just wrote.
        await loadQuantAQAlerts();
        await loadQuantAQLastCheck();
        if (typeof loadQuantAQCronInfo === 'function') await loadQuantAQCronInfo();
        // Sensor status arrays may have been updated by the scan — reload them.
        if (typeof loadAllData === 'function') {
            try { await loadAllData(); } catch (_) {}
        }

        const parts = [`${summary.devicesSeen ?? '?'} devices`];
        if (summary.newCritical) parts.push(`${summary.newCritical} new alerts`);
        if (summary.newPending) parts.push(`${summary.newPending} pending`);
        if (summary.promotedFromPending) parts.push(`${summary.promotedFromPending} promoted`);
        if (summary.silentlyDismissed) parts.push(`${summary.silentlyDismissed} auto-cleared`);
        if (summary.resolved) parts.push(`${summary.resolved} resolved`);
        const secs = Math.round((summary.durationMs ?? (Date.now() - checkStartTime)) / 100) / 10;
        updateQuantAQStatus(`Check complete in ${secs}s: ${parts.join(', ')}`);

        renderDashboardAlerts();
        if (typeof buildSensorSidebar === 'function') buildSensorSidebar();
    } catch (err) {
        console.error('[QuantAQ] Check failed:', err);
        updateQuantAQStatus('Check failed: ' + (err?.message || String(err)));
    } finally {
        clearInterval(progressInterval);
        quantaqChecking = false;
        renderCheckButtons();
    }
}

// ===== INTERNAL HELPERS =====
// Find the auto-generated event note that an alert is linked to. Previously
// inlined in four places with the same filter each time.
function _findEventNoteForAlert(alert, sensorSn) {
    const sn = sensorSn || alert.sensorSn;
    return notes.find(n =>
        n.text && n.text.includes('QuantAQ Auto-Flag') &&
        n.text.includes(alert.issueType) &&
        n.taggedSensors && n.taggedSensors.includes(sn)
    );
}

// ===== HELPERS =====

function quantaqTimeSince(dateStr) {
    if (!dateStr) return '';
    const d = dateStr.endsWith('Z') ? dateStr : dateStr + 'Z';
    const diff = Date.now() - new Date(d).getTime();
    if (isNaN(diff) || diff < 0) return '';
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

// Replace "Last seen <ISO>" in an alert's detail string with a friendly
// AK-local timestamp + relative age. Leaves other detail strings alone.
function formatAlertDetail(detail) {
    if (!detail) return '';
    const match = detail.match(/^Last seen (\S+)/);
    if (!match) return detail;
    const iso = match[1];
    const d = new Date(iso);
    if (isNaN(d.getTime())) return detail;
    const absolute = d.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: AK_TZ,
    });
    const relative = quantaqTimeSince(iso);
    return `Last seen ${absolute} AK${relative ? ` (${relative})` : ''}`;
}

function renderCheckButtons() {
    const dashBtn = document.getElementById('dashboard-check-btn');
    if (dashBtn) {
        dashBtn.disabled = quantaqChecking;
        dashBtn.textContent = quantaqChecking ? 'Checking...' : 'Run Check Now';
    }
}

// ===== DASHBOARD ALERTS (inline on dashboard) =====

function renderDashboardAlerts() {
    const container = document.getElementById('dashboard-alerts-section');
    if (!container) return;

    // Update check button and next-check time
    renderCheckButtons();

    // Update last / next check lines from live cron info
    if (typeof renderQuantAQCronLines === 'function') renderQuantAQCronLines();

    const active = quantaqAlerts.filter(a => a.status === 'active' && !a.acknowledgedBy);
    const pending = quantaqAlerts.filter(a => a.status === 'pending');
    const newAlerts = active.filter(a => a.isNew);
    const offline = active.filter(a => a.issueType === 'Lost Connection');
    const pmIssues = active.filter(a => a.issueType === 'PM Sensor Issue');
    const gasIssues = active.filter(a => a.issueType === 'Gaseous Sensor Issue');
    const sdIssues = active.filter(a => a.issueType === 'SD Card Issue');
    const resolved = quantaqAlerts.filter(a => a.status === 'resolved' && a.isNew);

    const dismissed = quantaqAlerts.filter(a => a.acknowledgedBy);

    if (active.length === 0 && pending.length === 0 && resolved.length === 0 && dismissed.length === 0 && !quantaqLastCheck) {
        container.innerHTML = `<div class="quantaq-empty" style="padding:24px">
            <p style="font-size:14px;color:var(--slate-400)">Click "Run QuantAQ Check" to scan all sensors for issues.</p>
        </div>`;
        return;
    }

    let html = '';

    // Tabs
    html += `<div class="quantaq-tabs">
        <button class="quantaq-tab ${quantaqTab === 'active' ? 'active' : ''}" onclick="switchQuantAQTab('active')">Active Alerts</button>
        <button class="quantaq-tab ${quantaqTab === 'pending' ? 'active' : ''}" onclick="switchQuantAQTab('pending')">Pending${pending.length > 0 ? ` (${pending.length})` : ''}</button>
        <button class="quantaq-tab ${quantaqTab === 'dismissed' ? 'active' : ''}" onclick="switchQuantAQTab('dismissed')">Dismissed${dismissed.length > 0 ? ` (${dismissed.length})` : ''}</button>
    </div>`;

    if (quantaqTab === 'dismissed') {
        // Sort by most recently dismissed (use the last note timestamp or detected time)
        const sortedDismissed = [...dismissed].sort((a, b) => {
            const aTime = a.notes?.length ? a.notes[a.notes.length - 1].at : a.detectedAt;
            const bTime = b.notes?.length ? b.notes[b.notes.length - 1].at : b.detectedAt;
            return new Date(bTime || 0) - new Date(aTime || 0);
        });

        if (sortedDismissed.length > 0) {
            html += renderQuantAQAlertList(sortedDismissed, false);
        } else {
            html += `<div class="quantaq-empty" style="padding:24px">
                <p style="font-size:13px;color:var(--slate-400)">No dismissed alerts.</p>
            </div>`;
        }

        container.innerHTML = html;
        return;
    }

    if (quantaqTab === 'pending') {
        if (pending.length > 0) {
            html += `<p style="font-size:13px;color:var(--slate-400);margin-bottom:16px">These alerts are in a grace period. If the issue persists past the timer, it will be promoted to an active alert and an event note will be created. Transient issues (power blips, routine restarts) typically clear on their own.</p>`;
            html += renderPendingAlertList(pending);
        } else {
            html += `<div class="quantaq-empty" style="padding:24px">
                <p style="font-size:13px;color:var(--slate-400)">No pending alerts. Gaseous sensor flags and lost connections start here with a grace period before becoming active alerts.</p>
            </div>`;
        }
        container.innerHTML = html;
        return;
    }

    // Alert counts row — clickable to filter
    if (active.length > 0) {
        const countCard = (list, type, cls, label, alwaysShow) => {
            if (!alwaysShow && list.length === 0) return '';
            return `<div class="quantaq-count ${cls} ${quantaqFilter === type ? 'active-filter' : ''}" onclick="filterQuantAQAlerts('${type}')"><span class="quantaq-count-num">${list.length}</span><span class="quantaq-count-label">${label}</span></div>`;
        };
        html += `<div class="quantaq-counts" style="margin-bottom:16px">
            ${countCard(active, '', 'all', 'All Active', true)}
            ${countCard(offline, 'Lost Connection', 'offline', 'Lost Connection', true)}
            ${countCard(pmIssues, 'PM Sensor Issue', 'pm', 'PM Issue', true)}
            ${countCard(gasIssues, 'Gaseous Sensor Issue', 'gas', 'Gas Issue', true)}
            ${countCard(sdIssues, 'SD Card Issue', 'sd', 'SD Card', false)}
        </div>`;
        if (quantaqFilter) {
            html += `<p style="font-size:12px;color:var(--slate-400);margin-bottom:12px">Filtered by: <strong>${quantaqFilter || 'All'}</strong> <a href="#" onclick="event.preventDefault();filterQuantAQAlerts('')" style="color:var(--navy-400);margin-left:6px">Clear filter</a></p>`;
        }
        if (newAlerts.length > 0 && !quantaqFilter) html += `<p class="quantaq-new-badge">${newAlerts.length} new since last check</p>`;
        if (resolved.length > 0 && !quantaqFilter) html += `<p class="quantaq-resolved-badge"><a href="#quantaq-resolved-section" style="color:#16a34a;text-decoration:none" onclick="document.getElementById('quantaq-resolved-section')?.scrollIntoView({behavior:'smooth'})">${resolved.length} resolved since last check</a></p>`;
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
        html += `<h3 id="quantaq-resolved-section" class="quantaq-section-title" style="color:#16a34a">Resolved (${filteredResolved.length})</h3>`;
        html += renderQuantAQAlertList(filteredResolved, false);
    }

    // Pending summary (shown on active tab)
    if (pending.length > 0 && !quantaqFilter) {
        html += `<h3 class="quantaq-section-title" style="color:var(--gold-600)">Pending — Grace Period (${pending.length}) <a href="#" onclick="event.preventDefault();switchQuantAQTab('pending')" style="font-size:12px;font-weight:400;color:var(--slate-400);margin-left:8px">View all &rarr;</a></h3>`;
        html += renderPendingAlertList(pending.slice(0, 3));
        if (pending.length > 3) {
            html += `<p style="font-size:12px;color:var(--slate-400);margin:8px 0 16px"><a href="#" onclick="event.preventDefault();switchQuantAQTab('pending')" style="color:var(--navy-400)">+ ${pending.length - 3} more pending alerts</a></p>`;
        }
    }

    // All clear
    if (active.length === 0 && pending.length === 0 && quantaqLastCheck) {
        html += `<div class="quantaq-empty" style="padding:24px">
            <span style="font-size:28px;color:#16a34a">&#10003;</span>
            <p style="font-size:15px;font-weight:600;color:var(--navy-500);margin-top:6px">All Clear</p>
            <p style="font-size:13px;color:var(--slate-400)">All sensors are online and healthy.</p>
        </div>`;
    }


    container.innerHTML = html;
}

function renderPendingAlertList(alerts) {
    return alerts.map(a => {
        const badgeClass = a.issueType === 'Lost Connection' ? 'quantaq-badge-offline'
            : a.issueType === 'Gaseous Sensor Issue' ? 'quantaq-badge-gas'
            : a.issueType === 'PM Sensor Issue' ? 'quantaq-badge-pm'
            : 'quantaq-badge-sd';
        const detectedStr = new Date(a.detectedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: AK_TZ });

        let countdownHtml = '';
        if (a.graceExpiresAt) {
            const remaining = new Date(a.graceExpiresAt).getTime() - Date.now();
            if (remaining > 0) {
                const hrs = Math.floor(remaining / 3600000);
                const mins = Math.floor((remaining % 3600000) / 60000);
                countdownHtml = `<span class="pending-countdown">${hrs}h ${mins}m remaining</span>`;
            } else {
                countdownHtml = `<span class="pending-countdown expired">Grace period expired — will promote on next check</span>`;
            }
        }

        const severityLabel = (ALERT_SEVERITY[a.issueType] || 'warning').toUpperCase();

        return `<div class="quantaq-alert-card pending">
            <div class="quantaq-alert-header">
                <div class="quantaq-alert-header-left">
                    <span class="quantaq-alert-sensor" onclick="showSensorDetail('${a.sensorSn}')" style="cursor:pointer">${a.sensorSn}</span>
                    <span class="quantaq-badge ${badgeClass}">${a.issueType}</span>
                    <span class="pending-severity-badge">${severityLabel}</span>
                </div>
                <div class="quantaq-alert-header-right">
                    ${countdownHtml}
                </div>
            </div>
            <div class="quantaq-alert-body">
                <p class="quantaq-alert-detail">${escapeHtml(formatAlertDetail(a.detail || ''))}</p>
                <p class="quantaq-alert-meta">Detected: ${detectedStr}${a.communityName ? ` &middot; ${a.communityName}` : ''}</p>
            </div>
            <div class="quantaq-alert-actions">
                <button class="btn btn-sm" style="background:var(--gold-500);color:var(--navy-900)" onclick="promoteAlert('${a.id}')">Promote Now</button>
                <button class="btn btn-sm" onclick="silentDismissPendingAlert('${a.id}')">Dismiss</button>
            </div>
        </div>`;
    }).join('');
}

function renderQuantAQAlertList(alerts, isNew) {
    // Deduplicate: group by sensor + issue type, keep the most recent
    const seen = new Map();
    for (const a of alerts) {
        const key = a.sensorSn + '|' + a.issueType;
        if (!seen.has(key) || new Date(a.detectedAt) > new Date(seen.get(key).detectedAt)) {
            seen.set(key, a);
        }
    }

    // Sort by priority: Lost Connection > PM > Gaseous > SD Card
    // Sensors with multiple issues sort by their highest priority issue
    const PRIORITY = { 'Lost Connection': 0, 'PM Sensor Issue': 1, 'Gaseous Sensor Issue': 2, 'SD Card Issue': 3 };
    const sensorHighestPriority = {};
    for (const a of seen.values()) {
        const p = PRIORITY[a.issueType] ?? 99;
        if (sensorHighestPriority[a.sensorSn] === undefined || p < sensorHighestPriority[a.sensorSn]) {
            sensorHighestPriority[a.sensorSn] = p;
        }
    }
    const deduped = [...seen.values()].sort((a, b) => {
        const pa = sensorHighestPriority[a.sensorSn] ?? 99;
        const pb = sensorHighestPriority[b.sensorSn] ?? 99;
        if (pa !== pb) return pa - pb;
        const ia = PRIORITY[a.issueType] ?? 99;
        const ib = PRIORITY[b.issueType] ?? 99;
        return ia - ib;
    });

    return deduped.map(a => {
        const isOffline = a.issueType === 'Lost Connection';
        const isResolved = a.status === 'resolved';
        const badgeClass = isResolved ? 'quantaq-badge-resolved'
            : isOffline ? 'quantaq-badge-offline'
            : a.issueType === 'PM Sensor Issue' ? 'quantaq-badge-pm'
            : a.issueType === 'Gaseous Sensor Issue' ? 'quantaq-badge-gas'
            : 'quantaq-badge-sd';

        const detectedStr = new Date(a.detectedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: AK_TZ });
        const duration = quantaqTimeSince(a.detectedAt);

        const notesHtml = a.notes.length > 0
            ? a.notes.map(n => `<div class="quantaq-note"><strong>${escapeHtml(n.by)}</strong> <span style="color:var(--slate-400)">${new Date(n.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: AK_TZ })}</span><br>${escapeHtml(n.text)}</div>`).join('')
            : '';

        const communityStr = a.communityName ? ` — ${escapeHtml(a.communityName)}` : '';

        // Find the auto-generated event note and show any appended follow-ups
        const eventNote = notes.find(n =>
            n.text && n.text.includes('QuantAQ Auto-Flag') &&
            n.text.includes(a.issueType) &&
            n.taggedSensors && n.taggedSensors.includes(a.sensorSn)
        );

        // Extract follow-up lines with edit/delete actions
        let followUpHtml = '';
        if (eventNote && eventNote.text.includes('\n—')) {
            const lines = eventNote.text.split('\n').filter(l => l.startsWith('—'));
            followUpHtml = lines.map((l, idx) => {
                const text = l.substring(2).trim();
                const match = text.match(/^(.+?)\s*\((.+?)\)(?::\s*(.+))?$/);
                const actions = `<span class="followup-actions" onclick="event.stopPropagation()"><span class="followup-action-btn" onclick="editFollowUp('${eventNote.id}', ${idx})" title="Edit">&#9998;</span><span class="followup-action-btn" onclick="deleteFollowUp('${eventNote.id}', ${idx})" title="Delete">&#128465;</span></span>`;
                if (match) {
                    return `<div class="quantaq-followup-note"><div class="followup-header"><div><strong>${escapeHtml(match[1])}</strong> <span class="timeline-followup-date">${escapeHtml(match[2])}</span></div>${actions}</div>${match[3] ? `<div class="timeline-followup-text">${escapeHtml(match[3])}</div>` : ''}</div>`;
                }
                return `<div class="quantaq-followup-note"><div class="followup-header"><div>${escapeHtml(text)}</div>${actions}</div></div>`;
            }).join('');
        }

        return `<div class="quantaq-alert-card ${isNew ? 'new' : ''} ${isResolved ? 'resolved' : ''}">
            <div class="quantaq-alert-header">
                <div class="quantaq-alert-title-row">
                    <span class="quantaq-alert-sn" onclick="showSensorDetail('${escapeHtml(a.sensorSn)}')">${escapeHtml(a.sensorSn)}${communityStr}</span>
                    <span class="quantaq-badge ${badgeClass}">${a.issueType}</span>
                    ${isNew && !isResolved ? '<span class="quantaq-new-tag">NEW</span>' : ''}
                </div>
            </div>
            <div class="quantaq-alert-body">
                <p class="quantaq-alert-detail">${escapeHtml(formatAlertDetail(a.detail))}</p>
                <p class="quantaq-alert-meta">Detected: ${detectedStr}${duration ? ` (${duration})` : ''}${isResolved ? ` · Resolved: ${new Date(a.resolvedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: AK_TZ })}` : ''}</p>
                ${followUpHtml}
                <div id="quantaq-note-panel-${a.id}" class="quantaq-note-panel" style="display:none">
                    <div style="position:relative;margin-top:8px">
                        <textarea id="quantaq-note-input-${a.id}" class="mention-textarea" rows="2" placeholder="Add a follow-up note… type @ to tag a contact" style="width:100%;font-size:13px;font-family:var(--font-sans);padding:8px 10px;border:1px solid var(--slate-200);border-radius:6px;resize:vertical" onfocus="initQuantAQMention('${a.id}')"></textarea>
                        <div id="quantaq-note-mention-dropdown-${a.id}" class="mention-dropdown" style="left:0;width:100%"></div>
                    </div>
                    <div style="display:flex;gap:8px;margin-top:6px">
                        <button class="btn btn-sm btn-primary" onclick="saveQuantAQFollowUp('${a.id}', '${escapeHtml(a.sensorSn)}')">Save Note</button>
                        <button class="btn btn-sm" onclick="document.getElementById('quantaq-note-panel-${a.id}').style.display='none'">Cancel</button>
                    </div>
                </div>
            </div>
            <div class="quantaq-alert-actions">
                <button class="btn btn-sm" onclick="toggleQuantAQNotePanel('${a.id}')">Add Note</button>
                <button class="btn btn-sm" onclick="showSensorDetail('${escapeHtml(a.sensorSn)}')">View Sensor</button>
                ${!isResolved && !a.acknowledgedBy ? `<button class="btn btn-sm" style="color:var(--slate-400);border-color:var(--slate-200)" onclick="dismissQuantAQAlert('${a.id}')">Dismiss</button>` : ''}
                ${a.acknowledgedBy ? `<span style="font-size:11px;color:var(--slate-400)">Dismissed by ${escapeHtml(a.acknowledgedBy)}</span> <button class="btn btn-sm" style="font-size:10px;color:var(--slate-400);border-color:var(--slate-200)" onclick="undismissQuantAQAlert('${a.id}')">Restore</button>` : ''}
                ${setupMode && a.acknowledgedBy ? `<button class="btn btn-sm" style="font-size:10px;color:#dc2626;border-color:#fecdd3" onclick="deleteQuantAQAlert('${a.id}')">Delete</button>` : ''}
            </div>
            ${!isResolved && !a.acknowledgedBy ? `<div id="quantaq-dismiss-panel-${a.id}" class="quantaq-action-panel" style="display:none">
                <p style="font-size:12px;font-weight:600;color:var(--slate-500);margin-bottom:6px">Dismiss Alert</p>
                <textarea id="quantaq-dismiss-input-${a.id}" rows="2" placeholder="Add a reason (optional — leave blank to skip)" style="width:100%;font-size:13px;font-family:var(--font-sans);padding:8px 10px;border:1px solid var(--slate-200);border-radius:6px;resize:vertical"></textarea>
                <div style="display:flex;gap:8px;margin-top:6px">
                    <button class="btn btn-sm btn-primary" onclick="confirmDismissQuantAQAlert('${a.id}')">Dismiss</button>
                    <button class="btn btn-sm" onclick="document.getElementById('quantaq-dismiss-panel-${a.id}').style.display='none'">Cancel</button>
                </div>
            </div>` : ''}
            ${a.acknowledgedBy ? `<div id="quantaq-restore-panel-${a.id}" class="quantaq-action-panel" style="display:none">
                <p style="font-size:12px;font-weight:600;color:var(--slate-500);margin-bottom:6px">Restore Alert</p>
                <textarea id="quantaq-restore-input-${a.id}" rows="2" placeholder="Add a reason (optional — leave blank to skip)" style="width:100%;font-size:13px;font-family:var(--font-sans);padding:8px 10px;border:1px solid var(--slate-200);border-radius:6px;resize:vertical"></textarea>
                <div style="display:flex;gap:8px;margin-top:6px">
                    <button class="btn btn-sm btn-primary" onclick="confirmUndismissQuantAQAlert('${a.id}')">Restore</button>
                    <button class="btn btn-sm" onclick="document.getElementById('quantaq-restore-panel-${a.id}').style.display='none'">Cancel</button>
                </div>
            </div>` : ''}
        </div>`;
    }).join('');
}

// ===== TABS =====

function switchQuantAQTab(tab) {
    quantaqTab = tab;
    renderDashboardAlerts();
}

// ===== FILTER =====

function filterQuantAQAlerts(type) {
    quantaqFilter = quantaqFilter === type ? '' : type; // toggle
    renderDashboardAlerts();
}

// ===== ALERT ACTIONS (persisted to database) =====

function dismissQuantAQAlert(alertId) {
    // Show inline note input instead of browser prompt
    const panel = document.getElementById('quantaq-dismiss-panel-' + alertId);
    if (panel) {
        panel.style.display = '';
        const input = panel.querySelector('textarea');
        if (input) input.focus();
    }
}

async function confirmDismissQuantAQAlert(alertId) {
    const alert = quantaqAlerts.find(a => a.id === alertId);
    if (!alert) return;

    const userName = currentUser || 'Unknown';
    const timestamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: AK_TZ });
    const input = document.getElementById('quantaq-dismiss-input-' + alertId);
    const noteText = input?.value?.trim() || '';

    alert.acknowledgedBy = userName;

    // Add dismiss entry to the auto-flag event note
    const eventNote = _findEventNoteForAlert(alert);
    if (eventNote) {
        let line = `\n— Dismissed by ${userName} (${timestamp})`;
        if (noteText) line += `: ${noteText}`;
        eventNote.text += line;
        try {
            await db.updateNote(eventNote.id, { text: eventNote.text });
        } catch (err) {
            if (typeof handleSaveError === 'function') handleSaveError(err);
        }
    }

    try {
        await db.updateQuantAQAlert(alertId, { acknowledged_by: userName });
    } catch (err) {
        // Roll back the optimistic in-memory acknowledge so UI matches DB.
        alert.acknowledgedBy = null;
        if (typeof handleSaveError === 'function') handleSaveError(err);
    }

    renderDashboardAlerts();
}

function undismissQuantAQAlert(alertId) {
    // Show inline note input
    const panel = document.getElementById('quantaq-restore-panel-' + alertId);
    if (panel) {
        panel.style.display = '';
        const input = panel.querySelector('textarea');
        if (input) input.focus();
    }
}

async function confirmUndismissQuantAQAlert(alertId) {
    const alert = quantaqAlerts.find(a => a.id === alertId);
    if (!alert) return;

    const userName = currentUser || 'Unknown';
    const timestamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: AK_TZ });
    const input = document.getElementById('quantaq-restore-input-' + alertId);
    const noteText = input?.value?.trim() || '';

    // Add restore entry to the auto-flag event note
    const eventNote = _findEventNoteForAlert(alert);
    if (eventNote) {
        let line = `\n— Restored by ${userName} (${timestamp})`;
        if (noteText) line += `: ${noteText}`;
        eventNote.text += line;
        try {
            await db.updateNote(eventNote.id, { text: eventNote.text });
        } catch (err) {
            if (typeof handleSaveError === 'function') handleSaveError(err);
        }
    }

    const prevAck = alert.acknowledgedBy;
    alert.acknowledgedBy = null;

    try {
        await db.updateQuantAQAlert(alertId, { acknowledged_by: null });
    } catch (err) {
        alert.acknowledgedBy = prevAck;
        if (typeof handleSaveError === 'function') handleSaveError(err);
    }

    renderDashboardAlerts();
}

async function deleteQuantAQAlert(alertId) {
    const idx = quantaqAlerts.findIndex(a => a.id === alertId);
    if (idx < 0) return;
    const [removed] = quantaqAlerts.splice(idx, 1);
    renderDashboardAlerts();
    try {
        await db.deleteQuantAQAlert(alertId);
    } catch (err) {
        // Roll back so the dashboard matches the DB on failure.
        quantaqAlerts.splice(idx, 0, removed);
        renderDashboardAlerts();
        if (typeof handleSaveError === 'function') handleSaveError(err);
    }
}

// ===== PENDING ALERT ACTIONS =====
async function promoteAlert(alertId) {
    const alert = quantaqAlerts.find(a => a.id === alertId);
    if (!alert) return;

    try {
        const now = new Date().toISOString();
        await db.updateQuantAQAlert(alertId, { status: 'active', is_new: true, last_checked: now });

        // Create event note
        const appSensor = sensors.find(s => s.id === alert.sensorSn);
        const communityId = appSensor?.community || '';
        createNote('Issue', `QuantAQ Auto-Flag: ${alert.issueType} detected on ${alert.sensorSn} (manually promoted). ${alert.detail}`, {
            sensors: [alert.sensorSn], communities: communityId ? [communityId] : [], contacts: [],
        });

        // Update sensor status. PM/SD/Gas faults keep "Online" — only a real
        // Lost Connection (which has its own path in the edge function)
        // removes it. Mirrors the server-side status rule.
        if (appSensor) {
            const cur = getStatusArray(appSensor);
            const merged = new Set([...cur, alert.issueType]);
            if (alert.issueType === 'Lost Connection') merged.delete('Online');
            appSensor.status = [...merged];
            persistSensor(appSensor);
        }

        alert.status = 'active';
        alert.isNew = true;
        showSuccessToast(`Alert promoted — event note created for ${alert.sensorSn}`);
        renderDashboardAlerts();
        buildSensorSidebar();
    } catch (err) {
        if (typeof handleSaveError === 'function') handleSaveError(err);
    }
}

async function silentDismissPendingAlert(alertId) {
    const alert = quantaqAlerts.find(a => a.id === alertId);
    if (!alert) return;

    try {
        await db.deleteQuantAQAlert(alertId);
        quantaqAlerts = quantaqAlerts.filter(a => a.id !== alertId);
        showSuccessToast(`Pending alert dismissed — no note created`);
        renderDashboardAlerts();
    } catch (err) {
        if (typeof handleSaveError === 'function') handleSaveError(err);
    }
}

function toggleQuantAQNotePanel(alertId) {
    const panel = document.getElementById('quantaq-note-panel-' + alertId);
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
    if (panel.style.display !== 'none') {
        const input = document.getElementById('quantaq-note-input-' + alertId);
        if (input) { input.value = ''; input.focus(); }
    }
}

function initQuantAQMention(alertId) {
    const ta = document.getElementById('quantaq-note-input-' + alertId);
    const dd = document.getElementById('quantaq-note-mention-dropdown-' + alertId);
    if (!ta || !dd || ta._mentionInit) return;
    if (typeof setupMentionAutocomplete === 'function') {
        setupMentionAutocomplete(ta, dd);
        ta._mentionInit = true;
    }
}

async function saveQuantAQFollowUp(alertId, sensorSn) {
    const input = document.getElementById('quantaq-note-input-' + alertId);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    const alert = quantaqAlerts.find(a => a.id === alertId);
    if (!alert) return;

    const mentionedContacts = (typeof parseMentionedContacts === 'function') ? parseMentionedContacts(text) : [];

    // Find the auto-generated event note for this alert
    const eventNote = _findEventNoteForAlert(alert, sensorSn);

    if (eventNote) {
        // Append the follow-up to the existing note
        const timestamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: AK_TZ });
        const userName = currentUser || 'Unknown';
        eventNote.text += `\n— ${userName} (${timestamp}): ${text}`;

        // Persist to database
        try {
            await db.updateNote(eventNote.id, { text: eventNote.text });
            if (mentionedContacts.length) {
                const added = await db.addNoteContactTags(eventNote.id, mentionedContacts);
                if (added.length) {
                    if (!eventNote.taggedContacts) eventNote.taggedContacts = [];
                    added.forEach(id => { if (!eventNote.taggedContacts.includes(id)) eventNote.taggedContacts.push(id); });
                }
            }
        } catch (err) {
            if (typeof handleSaveError === 'function') handleSaveError(err);
        }
    } else {
        // No auto-generated note found — create a new one
        const sensor = sensors.find(s => s.id === sensorSn);
        const communityId = sensor?.community || '';
        createNote('Issue', `QuantAQ Alert: ${alert.issueType} — ${text}`, {
            sensors: [sensorSn],
            communities: communityId ? [communityId] : [],
            contacts: mentionedContacts,
        });
    }

    input.value = '';
    document.getElementById('quantaq-note-panel-' + alertId).style.display = 'none';
    renderDashboardAlerts();
}
