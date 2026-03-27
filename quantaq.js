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
    ]);
    // Don't call renderDashboard() here — the boot sequence in app.js
    // will call restoreLastView() which renders the appropriate view.
    // Calling it here would be premature (sidebar not built yet) and redundant.
}

// ===== RUN CHECK (calls Edge Function, then reloads from DB) =====

// ===== QUANTAQ API (via Edge Function proxy) =====

async function qaqFetch(path) {
    const resp = await fetch(SUPABASE_URL + '/functions/v1/quantaq-check', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
    });
    if (!resp.ok) throw new Error(`Proxy error ${resp.status}`);
    return resp.json();
}

// Flag bitmask
const FLAG_OPC = 2, FLAG_NEPH = 4, FLAG_CO = 16, FLAG_NO = 32, FLAG_NO2 = 64, FLAG_O3 = 128, FLAG_SD = 8192;
function decodeQAQFlags(f) {
    const issues = [];
    if (f & (FLAG_OPC | FLAG_NEPH)) issues.push('PM Sensor Issue');
    if (f & (FLAG_CO | FLAG_NO | FLAG_NO2 | FLAG_O3)) issues.push('Gaseous Sensor Issue');
    if (f & FLAG_SD) issues.push('SD Card Issue');
    return issues;
}
function describeQAQFlags(f) {
    const n = [];
    if (f & FLAG_OPC) n.push('OPC'); if (f & FLAG_NEPH) n.push('NEPH');
    if (f & FLAG_CO) n.push('CO'); if (f & FLAG_NO) n.push('NO');
    if (f & FLAG_NO2) n.push('NO2'); if (f & FLAG_O3) n.push('O3');
    if (f & FLAG_SD) n.push('SD');
    return n.join(', ');
}

const EXPECTED_OFFLINE = ['Offline','Lab Storage','In Transit Between Audits','Service at Quant','Ready for Deployment','Shipped to Quant','Shipped from Quant','Needs Repair'];
const OFFLINE_MS = 60 * 60 * 1000;

async function runQuantAQCheck() {
    if (quantaqChecking) return;
    quantaqChecking = true;
    const checkStartTime = Date.now();
    let dots = 0;
    const progressInterval = setInterval(() => {
        dots = (dots + 1) % 4;
        const elapsed = Math.floor((Date.now() - checkStartTime) / 1000);
        updateQuantAQStatus(`Checking sensors${'.'.repeat(dots)} (${elapsed}s)`);
    }, 500);
    updateQuantAQStatus('Fetching device list...');
    renderCheckButtons();

    try {
        const now = new Date().toISOString();

        // Load existing active alerts
        const { data: existingAlerts } = await supa.from('quantaq_alerts').select('*').eq('status', 'active');
        const stillActiveIds = new Set();
        const newAlerts = [];
        const statusUpdates = [];

        // Step 1: Get all devices (1-2 API calls)
        updateQuantAQStatus('Fetching device list...');
        let devices = [];
        let page = 1, pages = 1;
        while (page <= pages) {
            const json = await qaqFetch(`/devices/?per_page=100&org_id=1250&page=${page}`);
            devices = devices.concat(json.data || []);
            pages = json.meta?.pages || 1;
            page++;
        }

        // Step 2: Separate offline vs online
        const onlineDevices = [];
        for (const d of devices) {
            const lastSeen = d.last_seen ? new Date(d.last_seen.endsWith('Z') ? d.last_seen : d.last_seen + 'Z') : null;
            const msSince = lastSeen ? Date.now() - lastSeen.getTime() : Infinity;
            const appSensor = sensors.find(s => s.id === d.sn);
            const appStatuses = appSensor ? getStatusArray(appSensor) : [];

            if (msSince > OFFLINE_MS) {
                // Skip sensors with manually-set offline/storage statuses
                if (appStatuses.some(s => EXPECTED_OFFLINE.includes(s))) continue;
                // Skip sensors not assigned to any community (not deployed)
                if (!appSensor || !appSensor.community) continue;
                const detail = lastSeen ? `Last seen ${quantaqTimeSince(lastSeen.toISOString())}` : 'Never seen';
                const community = appSensor ? getCommunityName(appSensor.community) : (d.city || '');
                const existing = (existingAlerts || []).find(a => a.sensor_sn === d.sn && a.issue_type === 'Lost Connection');
                if (existing) {
                    stillActiveIds.add(existing.id);
                    await supa.from('quantaq_alerts').update({ last_checked: now, detail, is_new: false }).eq('id', existing.id);
                } else {
                    newAlerts.push({ sensor_sn: d.sn, sensor_model: d.model, community_name: community, issue_type: 'Lost Connection', detail, status: 'active', is_new: true, detected_at: now, last_checked: now, notes: [] });
                    statusUpdates.push({ sn: d.sn, statuses: ['Lost Connection'] });
                }
            } else {
                onlineDevices.push(d);
            }
        }

        // Step 3: Check flags for online sensors (batched, 15 at a time)
        updateQuantAQStatus(`Checking ${onlineDevices.length} online sensors for issues...`);
        const BATCH = 15;
        for (let i = 0; i < onlineDevices.length; i += BATCH) {
            const batch = onlineDevices.slice(i, i + BATCH);
            updateQuantAQStatus(`Checking sensors ${i + 1}–${Math.min(i + BATCH, onlineDevices.length)} of ${onlineDevices.length}...`);
            await new Promise(r => setTimeout(r, 0)); // yield to let UI repaint

            await Promise.allSettled(batch.map(async (d) => {
                try {
                    const json = await qaqFetch(`/devices/${d.sn}/data/raw/?per_page=1&sort=timestamp,desc`);
                    const raw = json.data?.[0];
                    if (!raw || !raw.flag || raw.flag <= 1) return;
                    const flagClean = raw.flag & ~1;
                    if (flagClean === 0) return;

                    const issues = decodeQAQFlags(flagClean);
                    const flagDesc = describeQAQFlags(flagClean);
                    const appSensor = sensors.find(s => s.id === d.sn);
                    const community = appSensor ? getCommunityName(appSensor.community) : (d.city || '');

                    for (const issueType of issues) {
                        const existing = (existingAlerts || []).find(a => a.sensor_sn === d.sn && a.issue_type === issueType);
                        if (existing) {
                            stillActiveIds.add(existing.id);
                            await supa.from('quantaq_alerts').update({ last_checked: now, detail: `Flags: ${flagDesc} (raw: ${raw.flag})`, is_new: false }).eq('id', existing.id);
                        } else {
                            newAlerts.push({ sensor_sn: d.sn, sensor_model: d.model, community_name: community, issue_type: issueType, detail: `Flags: ${flagDesc} (raw: ${raw.flag})`, status: 'active', is_new: true, detected_at: now, last_checked: now, notes: [] });
                            statusUpdates.push({ sn: d.sn, statuses: [issueType] });
                        }
                    }
                } catch(e) { console.warn(`[QAQ] Raw error for ${d.sn}:`, e); }
            }));
        }

        // Step 4: Insert new alerts + create event notes
        if (newAlerts.length > 0) {
            await supa.from('quantaq_alerts').insert(newAlerts);
            for (const alert of newAlerts) {
                try {
                    const appSensor = sensors.find(s => s.id === alert.sensor_sn);
                    const communityId = appSensor?.community || '';
                    const note = createNote('Issue', `QuantAQ Auto-Flag: ${alert.issue_type} detected on ${alert.sensor_sn}. ${alert.detail}`, {
                        sensors: [alert.sensor_sn], communities: communityId ? [communityId] : [], contacts: [],
                    });
                } catch(e) {}
            }
        }

        // Step 5: Resolve cleared alerts
        const toResolve = (existingAlerts || []).filter(a => !stillActiveIds.has(a.id));
        if (toResolve.length > 0) {
            const ids = toResolve.map(a => a.id);
            await supa.from('quantaq_alerts').update({ status: 'resolved', resolved_at: now, is_new: true, last_checked: now }).in('id', ids);
            for (const alert of toResolve) {
                try {
                    const appSensor = sensors.find(s => s.id === alert.sensor_sn);
                    const communityId = appSensor?.community || '';
                    createNote('Issue', `QuantAQ Auto-Resolved: ${alert.issue_type} on ${alert.sensor_sn} has cleared.`, {
                        sensors: [alert.sensor_sn], communities: communityId ? [communityId] : [], contacts: [],
                    });
                    // Remove status from sensor
                    if (appSensor && alert.issue_type !== 'Lost Connection') {
                        const cur = getStatusArray(appSensor).filter(s => s !== alert.issue_type);
                        appSensor.status = cur.length > 0 ? cur : ['Online'];
                        persistSensor(appSensor);
                    }
                } catch(e) {}
            }
        }

        // Step 6: Update sensor statuses for new issues
        for (const u of statusUpdates) {
            const s = sensors.find(x => x.id === u.sn);
            if (!s) continue;
            const cur = getStatusArray(s);
            const merged = new Set([...cur, ...u.statuses]);
            merged.delete('Online');
            const final = [...merged];
            if ([...final].sort().join(',') !== [...cur].sort().join(',')) {
                s.status = final;
                persistSensor(s);
            }
        }

        // Step 7: Update timestamp
        await db.setAppSetting('quantaq_last_check', now);

        // Reload and render
        await loadQuantAQAlerts();
        await loadQuantAQLastCheck();
        const elapsed = Math.floor((Date.now() - checkStartTime) / 1000);
        updateQuantAQStatus(`Check complete in ${elapsed}s: ${devices.length} devices, ${newAlerts.length} new alerts, ${toResolve.length} resolved`);
        renderDashboardAlerts();
        buildSensorSidebar();

    } catch (err) {
        console.error('[QuantAQ] Check failed:', err);
        updateQuantAQStatus('Check failed: ' + err.message);
    } finally {
        clearInterval(progressInterval);
        quantaqChecking = false;
        renderCheckButtons();
    }
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
    // Also update the alerts view status (separate element to avoid duplicate IDs)
    const el2 = document.getElementById('quantaq-alerts-view-status');
    if (el2) el2.textContent = msg;
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

    // Update last check time
    const lastCheckEl = document.getElementById('dashboard-last-check');
    if (lastCheckEl && quantaqLastCheck) {
        lastCheckEl.textContent = 'Last QuantAQ check: ' + new Date(quantaqLastCheck).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    const active = quantaqAlerts.filter(a => a.status === 'active' && !a.acknowledgedBy);
    const newAlerts = active.filter(a => a.isNew);
    const offline = active.filter(a => a.issueType === 'Lost Connection');
    const pmIssues = active.filter(a => a.issueType === 'PM Sensor Issue');
    const gasIssues = active.filter(a => a.issueType === 'Gaseous Sensor Issue');
    const sdIssues = active.filter(a => a.issueType === 'SD Card Issue');
    const resolved = quantaqAlerts.filter(a => a.status === 'resolved' && a.isNew);

    const dismissed = quantaqAlerts.filter(a => a.acknowledgedBy);

    if (active.length === 0 && resolved.length === 0 && dismissed.length === 0 && !quantaqLastCheck) {
        container.innerHTML = `<div class="quantaq-empty" style="padding:24px">
            <p style="font-size:14px;color:var(--slate-400)">Click "Run QuantAQ Check" to scan all sensors for issues.</p>
        </div>`;
        return;
    }

    let html = '';

    // Tabs
    html += `<div class="quantaq-tabs">
        <button class="quantaq-tab ${quantaqTab === 'active' ? 'active' : ''}" onclick="switchQuantAQTab('active')">Active Alerts</button>
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

    // Alert counts row — clickable to filter
    if (active.length > 0) {
        const countCard = (list, type, cls, label) => list.length > 0
            ? `<div class="quantaq-count ${cls} ${quantaqFilter === type ? 'active-filter' : ''}" onclick="filterQuantAQAlerts('${type}')"><span class="quantaq-count-num">${list.length}</span><span class="quantaq-count-label">${label}</span></div>`
            : '';
        html += `<div class="quantaq-counts" style="margin-bottom:16px">
            ${countCard(active, '', 'all', 'All Active')}
            ${countCard(offline, 'Lost Connection', 'offline', 'Lost Connection')}
            ${countCard(pmIssues, 'PM Sensor Issue', 'pm', 'PM Issue')}
            ${countCard(gasIssues, 'Gaseous Sensor Issue', 'gas', 'Gas Issue')}
            ${countCard(sdIssues, 'SD Card Issue', 'sd', 'SD Card')}
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

    // All clear
    if (active.length === 0 && quantaqLastCheck) {
        html += `<div class="quantaq-empty" style="padding:24px">
            <span style="font-size:28px;color:#16a34a">&#10003;</span>
            <p style="font-size:15px;font-weight:600;color:var(--navy-500);margin-top:6px">All Clear</p>
            <p style="font-size:13px;color:var(--slate-400)">All sensors are online and healthy.</p>
        </div>`;
    }


    container.innerHTML = html;
}

// ===== FULL ALERTS VIEW =====

function renderQuantAQAlertsView() {
    const container = document.getElementById('quantaq-alerts-content');
    if (!container) return;

    const active = quantaqAlerts.filter(a => a.status === 'active' && !a.acknowledgedBy);
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
                <span id="quantaq-alerts-view-status" style="font-size:11px;color:var(--slate-400)"></span>
            </div>
            <button class="btn btn-primary" onclick="runQuantAQCheck()" ${quantaqChecking ? 'disabled' : ''}>
                ${quantaqChecking ? 'Checking...' : 'Run Check Now'}
            </button>
        </div>
    `;

    // Summary counts
    const offline = active.filter(a => a.issueType === 'Lost Connection');
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

        const detectedStr = new Date(a.detectedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const duration = quantaqTimeSince(a.detectedAt);

        const notesHtml = a.notes.length > 0
            ? a.notes.map(n => `<div class="quantaq-note"><strong>${escapeHtml(n.by)}</strong> <span style="color:var(--slate-400)">${new Date(n.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span><br>${escapeHtml(n.text)}</div>`).join('')
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
                <p class="quantaq-alert-detail">${escapeHtml(a.detail)}</p>
                <p class="quantaq-alert-meta">Detected: ${detectedStr}${duration ? ` (${duration})` : ''}${isResolved ? ` · Resolved: ${new Date(a.resolvedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}</p>
                ${followUpHtml}
                <div id="quantaq-note-panel-${a.id}" class="quantaq-note-panel" style="display:none">
                    <textarea id="quantaq-note-input-${a.id}" rows="2" placeholder="Add a follow-up note..." style="width:100%;font-size:13px;font-family:var(--font-sans);padding:8px 10px;border:1px solid var(--slate-200);border-radius:6px;resize:vertical;margin-top:8px"></textarea>
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
    if (document.getElementById('view-quantaq-alerts')?.classList.contains('active')) {
        renderQuantAQAlertsView();
    }
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
    const timestamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const input = document.getElementById('quantaq-dismiss-input-' + alertId);
    const noteText = input?.value?.trim() || '';

    alert.acknowledgedBy = userName;

    // Add dismiss entry to the auto-flag event note
    const eventNote = notes.find(n =>
        n.text && n.text.includes('QuantAQ Auto-Flag') &&
        n.text.includes(alert.issueType) &&
        n.taggedSensors && n.taggedSensors.includes(alert.sensorSn)
    );
    if (eventNote) {
        let line = `\n— Dismissed by ${userName} (${timestamp})`;
        if (noteText) line += `: ${noteText}`;
        eventNote.text += line;
        try { await supa.from('notes').update({ text: eventNote.text }).eq('id', eventNote.id); } catch(e) {}
    }

    try {
        await supa.from('quantaq_alerts').update({ acknowledged_by: userName }).eq('id', alertId);
    } catch (err) {
        alert.acknowledgedBy = null;
    }

    renderQuantAQAlertsView();
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
    const timestamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const input = document.getElementById('quantaq-restore-input-' + alertId);
    const noteText = input?.value?.trim() || '';

    // Add restore entry to the auto-flag event note
    const eventNote = notes.find(n =>
        n.text && n.text.includes('QuantAQ Auto-Flag') &&
        n.text.includes(alert.issueType) &&
        n.taggedSensors && n.taggedSensors.includes(alert.sensorSn)
    );
    if (eventNote) {
        let line = `\n— Restored by ${userName} (${timestamp})`;
        if (noteText) line += `: ${noteText}`;
        eventNote.text += line;
        try { await supa.from('notes').update({ text: eventNote.text }).eq('id', eventNote.id); } catch(e) {}
    }

    alert.acknowledgedBy = null;

    try {
        await supa.from('quantaq_alerts').update({ acknowledged_by: null }).eq('id', alertId);
    } catch (err) {}

    renderQuantAQAlertsView();
    renderDashboardAlerts();
}

async function deleteQuantAQAlert(alertId) {
    const idx = quantaqAlerts.findIndex(a => a.id === alertId);
    if (idx < 0) return;
    quantaqAlerts.splice(idx, 1);
    renderDashboardAlerts();
    try {
        await supa.from('quantaq_alerts').delete().eq('id', alertId);
    } catch (err) {
        console.error('[QuantAQ] Failed to delete alert:', err);
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

async function saveQuantAQFollowUp(alertId, sensorSn) {
    const input = document.getElementById('quantaq-note-input-' + alertId);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    const alert = quantaqAlerts.find(a => a.id === alertId);
    if (!alert) return;

    // Find the auto-generated event note for this alert
    const eventNote = notes.find(n =>
        n.text && n.text.includes('QuantAQ Auto-Flag') &&
        n.text.includes(alert.issueType) &&
        n.taggedSensors && n.taggedSensors.includes(sensorSn)
    );

    if (eventNote) {
        // Append the follow-up to the existing note
        const timestamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const userName = currentUser || 'Unknown';
        eventNote.text += `\n— ${userName} (${timestamp}): ${text}`;

        // Persist to database
        try {
            await supa.from('notes').update({ text: eventNote.text }).eq('id', eventNote.id);
        } catch (err) {
            console.error('[QuantAQ] Failed to update note:', err);
        }
    } else {
        // No auto-generated note found — create a new one
        const sensor = sensors.find(s => s.id === sensorSn);
        const communityId = sensor?.community || '';
        createNote('Issue', `QuantAQ Alert: ${alert.issueType} — ${text}`, {
            sensors: [sensorSn],
            communities: communityId ? [communityId] : [],
            contacts: [],
        });
    }

    input.value = '';
    document.getElementById('quantaq-note-panel-' + alertId).style.display = 'none';
    renderDashboardAlerts();
}
