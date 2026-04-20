// ===== QuantAQ Check — Supabase Edge Function =====
// Runs the full sensor scan server-side so cron can drive it and no user
// needs to have the app open. Replaces the old browser-side scan loop.
//
// Two modes, chosen by request body:
//   { mode: "scan" } or empty body  → run the full scan
//   { path: "/devices/..." }        → legacy proxy mode (kept for fallback)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ----- QuantAQ flag bitmask (matches quantaq.js) -----
const FLAG_OPC = 2, FLAG_NEPH = 4, FLAG_CO = 16, FLAG_NO = 32, FLAG_NO2 = 64, FLAG_O3 = 128, FLAG_SD = 8192;
function decodeFlags(f: number): string[] {
  const issues: string[] = [];
  if (f & (FLAG_OPC | FLAG_NEPH)) issues.push("PM Sensor Issue");
  if (f & (FLAG_CO | FLAG_NO | FLAG_NO2 | FLAG_O3)) issues.push("Gaseous Sensor Issue");
  if (f & FLAG_SD) issues.push("SD Card Issue");
  return issues;
}
function describeFlags(f: number): string {
  const n: string[] = [];
  if (f & FLAG_OPC) n.push("OPC");
  if (f & FLAG_NEPH) n.push("NEPH");
  if (f & FLAG_CO) n.push("CO");
  if (f & FLAG_NO) n.push("NO");
  if (f & FLAG_NO2) n.push("NO2");
  if (f & FLAG_O3) n.push("O3");
  if (f & FLAG_SD) n.push("SD");
  return n.join(", ");
}

const EXPECTED_OFFLINE = new Set([
  "Offline", "Lab Storage", "In Transit Between Audits", "Service at Quant",
  "Ready for Deployment", "Shipped to Quant", "Shipped from Quant", "Needs Repair",
]);
const OFFLINE_MS = 60 * 60 * 1000; // 1 hour
// How old the newest raw reading can be before we stop trusting its flags.
// Matches QuantAQ's dashboard behavior: a sensor that went offline yesterday
// with a PM fault is still shown as PM-faulty, but a sensor we haven't heard
// from in a week stops generating noise about flags.
const FLAG_MAX_STALENESS_MS = 24 * 60 * 60 * 1000;

// How many recent raw readings to pull per sensor when checking flags.
// We OR the flag bits across the whole window instead of trusting a single
// latest reading — QuantAQ's own dashboard appears to work the same way, and
// it's the only way to catch sensors (e.g. a misbehaving PM unit) that set
// the fault bit intermittently rather than on every point. Kept deliberately
// small (5) because QuantAQ's raw endpoint has been observed to time out for
// larger paginated queries, and even a small window dramatically beats the
// single-latest-point check.
const RAW_WINDOW_SIZE = 5;

const ALERT_SEVERITY: Record<string, string> = {
  "PM Sensor Issue": "critical",
  "SD Card Issue": "critical",
  "Gaseous Sensor Issue": "warning",
  "Lost Connection": "info",
};
const GRACE_PERIODS: Record<string, number> = {
  "Gaseous Sensor Issue": 6 * 60 * 60 * 1000,
  "Lost Connection": 2 * 60 * 60 * 1000,
};

// ----- QuantAQ HTTP client -----
// Deno's fetch has no default timeout — if QuantAQ stalls on even one
// request, the entire scan hangs until the edge runtime's 150s wall
// clock kills it. AbortController keeps us honest.
// 20s was plenty for per_page=1, but pulling a window of 60 raw readings
// regularly takes longer than that — bumped so windowed flag checks
// don't silently timeout for every sensor.
const QAQ_TIMEOUT_MS = 45_000;

async function qaqFetch(apiKey: string, path: string): Promise<any> {
  const url = `https://api.quant-aq.com/v1${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QAQ_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Basic ${btoa(apiKey + ":")}`,
        Accept: "application/json",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`QuantAQ ${resp.status} on ${path}`);
    }
    return await resp.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`QuantAQ timeout (${QAQ_TIMEOUT_MS}ms) on ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Run N promises at a time
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function step() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await worker(items[i]) };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, step);
  await Promise.all(runners);
  return results;
}

// Every DB write goes through this so nothing fails silently.
function check(label: string, res: any) {
  if (!res) {
    throw new Error(`${label}: response was undefined (likely a typo in the query)`);
  }
  if (res.error) {
    console.error(`[QAQ] DB error on ${label}:`, res.error);
    throw new Error(`${label}: ${res.error.message || JSON.stringify(res.error)}`);
  }
}

// ----- Note insert helper (matches db.insertNote shape) -----
async function insertAutoFlagNote(
  supa: any,
  text: string,
  sensorSn: string,
  communityId: string | null,
  dateIso?: string,
) {
  const nowIso = new Date().toISOString();
  const noteRes = await supa
    .from("notes")
    .insert({
      date: dateIso || nowIso,
      type: "Issue",
      text,
      additional_info: "",
      created_by: null,
    })
    .select();
  check("insert note", noteRes);
  const noteId = noteRes.data?.[0]?.id;
  if (!noteId) return;
  const tagRows: any[] = [{ note_id: noteId, tag_type: "sensor", tag_id: String(sensorSn) }];
  if (communityId) tagRows.push({ note_id: noteId, tag_type: "community", tag_id: String(communityId) });
  const tagRes = await supa.from("note_tags").insert(tagRows);
  check("insert note_tags", tagRes);
}

// ----- Main scan -----
async function runScan(): Promise<Response> {
  const apiKey = Deno.env.get("QUANTAQ_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!apiKey) throw new Error("Missing QUANTAQ_API_KEY");
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing Supabase env vars");

  const supa = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const scanStart = Date.now();
  const now = new Date().toISOString();

  // --- Load sensors, communities, existing alerts from DB ---
  const [sensorsRes, communitiesRes, existingRes] = await Promise.all([
    supa.from("sensors").select("id, status, community_id"),
    supa.from("communities").select("id, name"),
    supa.from("quantaq_alerts").select("*").in("status", ["active", "pending"]),
  ]);
  check("load sensors", sensorsRes);
  check("load communities", communitiesRes);
  check("load existing alerts", existingRes);

  const sensors: any[] = sensorsRes.data || [];
  const communities: any[] = communitiesRes.data || [];
  const existingAlerts: any[] = existingRes.data || [];

  const communityNameById = new Map<string, string>();
  for (const c of communities) communityNameById.set(c.id, c.name);

  const sensorById = new Map<string, any>();
  for (const s of sensors) sensorById.set(s.id, s);

  const getStatusArray = (s: any): string[] => Array.isArray(s?.status) ? s.status : [];

  // --- Fetch all devices from QuantAQ ---
  // Cap pagination so a misbehaving pages count from the API can't serialize
  // dozens of slow fetches into our 150s edge-function budget. At 100 per
  // page, 5 pages == 500 devices, far beyond what we actually manage.
  const MAX_DEVICE_PAGES = 5;
  const devices: any[] = [];
  let page = 1, pages = 1;
  while (page <= pages && page <= MAX_DEVICE_PAGES) {
    const json = await qaqFetch(apiKey, `/devices/?per_page=100&org_id=1250&page=${page}`);
    devices.push(...(json.data || []));
    pages = json.meta?.pages || 1;
    page++;
  }

  const stillActiveIds = new Set<string>();
  const newAlerts: any[] = [];
  const statusUpdates: { sn: string; statuses: string[] }[] = [];

  // Index the existing active/pending alerts by (sensor_sn, issue_type) so each
  // worker can look up "is there already an alert for this sensor+issue?" in
  // O(1) rather than scanning the whole list — the scan is hot on this lookup
  // (every candidate sensor × every possible issue type).
  const existingKey = (sn: string, issueType: string) => `${sn}|${issueType}`;
  const existingByKey = new Map<string, any>();
  const existingBySensor = new Map<string, any[]>();
  for (const a of existingAlerts) {
    existingByKey.set(existingKey(a.sensor_sn, a.issue_type), a);
    if (!existingBySensor.has(a.sensor_sn)) existingBySensor.set(a.sensor_sn, []);
    existingBySensor.get(a.sensor_sn)!.push(a);
  }

  // --- Pre-filter out sensors we're intentionally ignoring ---
  // EXPECTED_OFFLINE sensors (Lab Storage, In Transit, etc.) are never
  // checked — raw OR lost-connection.
  const candidateDevices: any[] = [];
  for (const d of devices) {
    const appSensor = sensorById.get(d.sn);
    const appStatuses = appSensor ? getStatusArray(appSensor) : [];
    if (appStatuses.some((s) => EXPECTED_OFFLINE.has(s))) continue;
    candidateDevices.push(d);
  }

  // --- For every candidate sensor: fetch a window of recent raw readings, ---
  // --- then decide (per sensor) whether it's lost connection or has flags. ---
  //
  // Why not split by /devices/ last_seen first like we used to?
  //   Because last_seen can lag significantly behind the freshest raw data.
  //   A sensor that's actively reporting flagged data would get bucketed as
  //   "offline" purely because /devices/ hadn't updated yet, and its flag
  //   malfunction would never surface. We now use max(device.last_seen,
  //   latest raw timestamp) as the real "last activity" signal.
  // Helper: when we can't evaluate flag state for a sensor (raw fetch failed,
  // empty response, or raw data too stale), preserve any EXISTING flag alerts
  // so the later resolve-cleared pass doesn't wrongly declare them "cleared."
  // Lost Connection is not included — it's evaluated from last_seen, which
  // doesn't depend on the raw fetch.
  const preserveFlagAlertsFor = (sn: string) => {
    for (const a of existingBySensor.get(sn) || []) {
      if (a.issue_type !== "Lost Connection") stillActiveIds.add(a.id);
    }
  };

  await runWithConcurrency(candidateDevices, 30, async (d) => {
    let rows: any[] = [];
    let rawFetchFailed = false;
    try {
      const json = await qaqFetch(apiKey, `/devices/${d.sn}/data/raw/?per_page=${RAW_WINDOW_SIZE}&sort=timestamp,desc`);
      rows = Array.isArray(json.data) ? json.data : [];
    } catch (e) {
      rawFetchFailed = true;
      console.warn(`[QAQ] Raw error for ${d.sn}:`, e);
      // Fall through — raw fetch failed, device last_seen still drives Lost
      // Connection detection. We keep existing flag alerts alive below so a
      // transient QuantAQ outage doesn't flip every flag alert to resolved.
    }

    const appSensor = sensorById.get(d.sn);
    const community = appSensor ? (communityNameById.get(appSensor.community_id) || "") : (d.city || "");

    // Parse device-level last_seen and the newest raw-data timestamp; use the
    // freshest of the two as the source of truth for "when did we last hear
    // from this sensor."
    const deviceLastSeenStr = d.last_seen
      ? (d.last_seen.endsWith("Z") ? d.last_seen : d.last_seen + "Z")
      : null;
    const deviceLastSeen = deviceLastSeenStr ? new Date(deviceLastSeenStr) : null;
    const deviceLastSeenMs = deviceLastSeen && !isNaN(deviceLastSeen.getTime())
      ? deviceLastSeen.getTime()
      : -Infinity;

    let latestRawMs = -Infinity;
    for (const r of rows) {
      if (!r || !r.timestamp) continue;
      const tsStr = String(r.timestamp).endsWith("Z") ? String(r.timestamp) : String(r.timestamp) + "Z";
      const ts = new Date(tsStr);
      if (!isNaN(ts.getTime()) && ts.getTime() > latestRawMs) latestRawMs = ts.getTime();
    }

    const effectiveLastSeenMs = Math.max(deviceLastSeenMs, latestRawMs);
    const effectiveLastSeen = Number.isFinite(effectiveLastSeenMs) ? new Date(effectiveLastSeenMs) : null;
    const msSince = effectiveLastSeen ? Date.now() - effectiveLastSeen.getTime() : Infinity;

    // --- Lost Connection (runs independently of flag detection) ---
    // A sensor can be both offline AND have a PM/gas/SD fault recorded in its
    // last-reported data — that's exactly what QuantAQ's dashboard shows, so
    // we fire both alerts rather than treating them as mutually exclusive.
    if (msSince > OFFLINE_MS) {
      if (appSensor && appSensor.community_id) {
        const detail = effectiveLastSeen ? `Last seen ${effectiveLastSeen.toISOString()}` : "Never seen";
        const existing = existingByKey.get(existingKey(d.sn, "Lost Connection"));
        if (existing) {
          stillActiveIds.add(existing.id);
          const detectedAtIso = effectiveLastSeen ? effectiveLastSeen.toISOString() : existing.detected_at;
          const detectedAtMs = effectiveLastSeen ? effectiveLastSeen.getTime() : new Date(existing.detected_at).getTime();
          const graceExpiresMs = detectedAtMs + GRACE_PERIODS["Lost Connection"];
          const graceExpiresIso = new Date(graceExpiresMs).toISOString();
          const res = await supa.from("quantaq_alerts")
            .update({
              last_checked: now,
              detail,
              is_new: false,
              detected_at: detectedAtIso,
              grace_expires_at: graceExpiresIso,
            })
            .eq("id", existing.id);
          check("update lost-connection alert", res);
          existing.detected_at = detectedAtIso;
          existing.grace_expires_at = graceExpiresIso;
        } else {
          const detectedAtIso = effectiveLastSeen ? effectiveLastSeen.toISOString() : now;
          const detectedAtMs = effectiveLastSeen ? effectiveLastSeen.getTime() : Date.now();
          const graceMs = GRACE_PERIODS["Lost Connection"];
          const graceExpiresMs = detectedAtMs + graceMs;
          const graceExpiresIso = new Date(graceExpiresMs).toISOString();
          const alreadyExpired = graceExpiresMs <= Date.now();
          newAlerts.push({
            sensor_sn: d.sn, sensor_model: d.model, community_name: community,
            issue_type: "Lost Connection", detail,
            status: alreadyExpired ? "active" : "pending",
            severity: "info",
            grace_expires_at: graceExpiresIso,
            is_new: true,
            detected_at: detectedAtIso,
            last_checked: now,
            notes: [],
          });
        }
      }
      // Don't return — still evaluate flags below.
    }

    // --- Flag detection across the raw window ---
    // Cap: if the newest raw reading is older than FLAG_MAX_STALENESS_MS, don't
    // surface flag alerts. A sensor that's been dark for a week shouldn't keep
    // creating PM noise from ancient readings. But any flag alert that was
    // already active must be kept alive in stillActiveIds so the later
    // "resolve cleared" pass doesn't auto-resolve it and write a misleading
    // "has cleared" note — we're just choosing not to refresh, not declaring
    // the fault gone. Same rule applies to fetch failures and empty responses.
    if (rawFetchFailed || rows.length === 0) {
      preserveFlagAlertsFor(d.sn);
      return;
    }
    const rawFreshnessMs = Number.isFinite(latestRawMs) ? Date.now() - latestRawMs : Infinity;
    if (rawFreshnessMs > FLAG_MAX_STALENESS_MS) {
      preserveFlagAlertsFor(d.sn);
      return;
    }
    let flagUnion = 0;
    let flaggedCount = 0;
    let earliestFlaggedMs = Infinity;
    for (const r of rows) {
      if (!r || !r.flag || r.flag <= 1) continue;
      const bits = r.flag & ~1;
      if (bits === 0) continue;
      flagUnion |= bits;
      flaggedCount++;
      const tsStr = r.timestamp
        ? (String(r.timestamp).endsWith("Z") ? String(r.timestamp) : String(r.timestamp) + "Z")
        : null;
      const ts = tsStr ? new Date(tsStr) : null;
      if (ts && !isNaN(ts.getTime())) {
        const ms = ts.getTime();
        if (ms < earliestFlaggedMs) earliestFlaggedMs = ms;
      }
    }
    if (flagUnion === 0) return;

    const issues = decodeFlags(flagUnion);
    const flagDesc = describeFlags(flagUnion);
    const detailStr = `Flags: ${flagDesc} (raw: ${flagUnion}; ${flaggedCount}/${rows.length} recent)`;

    // Earliest flagged reading in the window approximates "when did the fault
    // start." For a persistent fault it hits the oldest reading we fetched;
    // for a just-appeared fault it's recent.
    const detectedAtMs = Number.isFinite(earliestFlaggedMs) ? earliestFlaggedMs : Date.now();
    const detectedAtIso = new Date(detectedAtMs).toISOString();

    for (const issueType of issues) {
      const existing = existingByKey.get(existingKey(d.sn, issueType));
      if (existing) {
        stillActiveIds.add(existing.id);
        const res = await supa.from("quantaq_alerts")
          .update({ last_checked: now, detail: detailStr, is_new: false })
          .eq("id", existing.id);
        check("update existing flag alert", res);
      } else {
        const severity = ALERT_SEVERITY[issueType] || "warning";
        if (severity === "critical") {
          newAlerts.push({
            sensor_sn: d.sn, sensor_model: d.model, community_name: community,
            issue_type: issueType, detail: detailStr,
            status: "active", severity, is_new: true,
            detected_at: detectedAtIso, last_checked: now, notes: [],
          });
          statusUpdates.push({ sn: d.sn, statuses: [issueType] });
        } else {
          const graceMs = GRACE_PERIODS[issueType];
          const graceExpiresMs = detectedAtMs + graceMs;
          const graceExpiresIso = new Date(graceExpiresMs).toISOString();
          const alreadyExpired = graceExpiresMs <= Date.now();
          newAlerts.push({
            sensor_sn: d.sn, sensor_model: d.model, community_name: community,
            issue_type: issueType, detail: detailStr,
            status: alreadyExpired ? "active" : "pending",
            severity,
            grace_expires_at: graceExpiresIso,
            is_new: true,
            detected_at: detectedAtIso,
            last_checked: now,
            notes: [],
          });
          if (alreadyExpired) {
            statusUpdates.push({ sn: d.sn, statuses: [issueType] });
          }
        }
      }
    }
  });

  // --- Insert new alerts + create event notes for critical ones ---
  if (newAlerts.length > 0) {
    check("insert new alerts", await supa.from("quantaq_alerts").insert(newAlerts));
    for (const alert of newAlerts) {
      if (alert.status !== "active") continue;
      const appSensor = sensorById.get(alert.sensor_sn);
      const communityId = appSensor?.community_id || null;
      // Date the note at detected_at so the sensor timeline reflects when
      // the sensor actually went offline/faulted, not when the cron ran.
      await insertAutoFlagNote(
        supa,
        `QuantAQ Auto-Flag: ${alert.issue_type} detected on ${alert.sensor_sn}. ${alert.detail}`,
        alert.sensor_sn,
        communityId,
        alert.detected_at,
      );
    }
  }

  // --- Process existing pending alerts: promote or silently dismiss ---
  let promotedCount = 0, silentDismissCount = 0;
  for (const alert of existingAlerts.filter((a) => a.status === "pending")) {
    const stillActive = stillActiveIds.has(alert.id);
    const graceExpired = alert.grace_expires_at && new Date(alert.grace_expires_at) <= new Date();
    if (!stillActive) {
      check("delete silently-dismissed pending", await supa.from("quantaq_alerts").delete().eq("id", alert.id));
      silentDismissCount++;
    } else if (graceExpired) {
      check(
        "promote pending to active",
        await supa.from("quantaq_alerts")
          .update({ status: "active", is_new: true, last_checked: now })
          .eq("id", alert.id),
      );
      promotedCount++;
      const appSensor = sensorById.get(alert.sensor_sn);
      const communityId = appSensor?.community_id || null;
      await insertAutoFlagNote(
        supa,
        `QuantAQ Auto-Flag: ${alert.issue_type} detected on ${alert.sensor_sn} (persisted past ${alert.issue_type === "Lost Connection" ? "2-hour" : "6-hour"} grace period). ${alert.detail}`,
        alert.sensor_sn,
        communityId,
        alert.detected_at,
      );
      if (appSensor) {
        const cur = getStatusArray(appSensor);
        const merged = new Set([...cur, alert.issue_type]);
        // Only Lost Connection (or a manual change) knocks a sensor out of
        // Online. PM/gas/SD faults ride alongside Online so the dashboard
        // still shows the sensor as reporting data while flagging the issue.
        if (alert.issue_type === "Lost Connection") merged.delete("Online");
        const final = [...merged];
        if (final.slice().sort().join(",") !== cur.slice().sort().join(",")) {
          check(
            "update sensor status (promote)",
            await supa.from("sensors").update({ status: final, updated_at: now }).eq("id", appSensor.id),
          );
          appSensor.status = final;
        }
      }
    }
  }

  // --- Resolve cleared active alerts ---
  const activeExisting = existingAlerts.filter((a) => a.status === "active");
  const toResolve = activeExisting.filter((a) => !stillActiveIds.has(a.id));
  if (toResolve.length > 0) {
    const ids = toResolve.map((a) => a.id);
    check(
      "resolve cleared alerts",
      await supa.from("quantaq_alerts")
        .update({ status: "resolved", resolved_at: now, is_new: true, last_checked: now })
        .in("id", ids),
    );
    // Figure out which sensors actually disappeared from QuantAQ's device list
    // so we can word the auto-resolution note honestly. "cleared" implies the
    // fault went away; if the sensor is just gone from QuantAQ, say so.
    const knownSns = new Set(devices.map((d) => d.sn));
    for (const alert of toResolve) {
      const appSensor = sensorById.get(alert.sensor_sn);
      const communityId = appSensor?.community_id || null;
      const sensorStillReported = knownSns.has(alert.sensor_sn);
      const wording = sensorStillReported
        ? `QuantAQ Auto-Resolved: ${alert.issue_type} on ${alert.sensor_sn} has cleared.`
        : `QuantAQ Auto-Resolved: ${alert.issue_type} on ${alert.sensor_sn} closed — sensor no longer reported by QuantAQ.`;
      await insertAutoFlagNote(supa, wording, alert.sensor_sn, communityId);
      if (appSensor) {
        const filtered = getStatusArray(appSensor).filter((s) => s !== alert.issue_type);
        let next: string[];
        if (alert.issue_type === "Lost Connection") {
          // Sensor reconnected — strip "Lost Connection" and make sure
          // "Online" is present again (reverse of the promotion step).
          next = filtered.includes("Online") ? filtered : ["Online", ...filtered];
        } else {
          // PM/Gas/SD cleared — drop the issue; if that was the only status,
          // fall back to "Online".
          next = filtered.length > 0 ? filtered : ["Online"];
        }
        const sortedNext = next.slice().sort().join(",");
        const sortedCur = getStatusArray(appSensor).slice().sort().join(",");
        if (sortedNext !== sortedCur) {
          check(
            "clear sensor status (resolve)",
            await supa.from("sensors").update({ status: next, updated_at: now }).eq("id", appSensor.id),
          );
          appSensor.status = next;
        }
      }
    }
  }

  // --- Apply status updates for new critical alerts ---
  // Only critical flag alerts (PM / SD) push into this list — never Lost
  // Connection — so we deliberately do NOT strip "Online" here. The sensor is
  // still actively reporting; we just want to flag the fault alongside.
  for (const u of statusUpdates) {
    const s = sensorById.get(u.sn);
    if (!s) continue;
    const cur = getStatusArray(s);
    const merged = new Set([...cur, ...u.statuses]);
    const final = [...merged];
    if (final.slice().sort().join(",") !== cur.slice().sort().join(",")) {
      check(
        "update sensor status (new critical)",
        await supa.from("sensors").update({ status: final, updated_at: now }).eq("id", s.id),
      );
      s.status = final;
    }
  }

  // --- Reconciliation: sensor.status must reflect every active alert ---
  // Belt-and-suspenders. The scan paths above update statuses as alerts
  // transition (promote / resolve / new critical), but an earlier build
  // missed the case where a Lost Connection alert is born "active" on
  // first detection (sensor offline longer than the 2h grace at time of
  // first scan) — the LC tag never landed. This pass re-queries the
  // currently-active alerts and forces sensor.status into agreement,
  // self-healing any historical misses including already-stored rows.
  const activeRes = await supa
    .from("quantaq_alerts")
    .select("sensor_sn, issue_type")
    .eq("status", "active");
  check("load active alerts for reconcile", activeRes);
  const neededBySensor = new Map<string, Set<string>>();
  for (const a of (activeRes.data || [])) {
    if (!a?.sensor_sn || !a?.issue_type) continue;
    let set = neededBySensor.get(a.sensor_sn);
    if (!set) { set = new Set(); neededBySensor.set(a.sensor_sn, set); }
    set.add(a.issue_type);
  }
  for (const [sn, needed] of neededBySensor) {
    const s = sensorById.get(sn);
    if (!s) continue;
    const cur = getStatusArray(s);
    const merged = new Set([...cur, ...needed]);
    // Lost Connection trumps Online — sensor truly isn't reporting.
    if (needed.has("Lost Connection")) merged.delete("Online");
    const final = [...merged];
    if (final.slice().sort().join(",") !== cur.slice().sort().join(",")) {
      check(
        "reconcile sensor status against active alerts",
        await supa.from("sensors").update({ status: final, updated_at: now }).eq("id", s.id),
      );
      s.status = final;
    }
  }

  // --- Stamp last check time ---
  check(
    "stamp quantaq_last_check",
    await supa.from("app_settings")
      .upsert({ key: "quantaq_last_check", value: now }, { onConflict: "key" }),
  );

  const durationMs = Date.now() - scanStart;
  const summary = {
    ok: true,
    durationMs,
    devicesSeen: devices.length,
    candidateDevices: candidateDevices.length,
    newAlerts: newAlerts.length,
    newCritical: newAlerts.filter((a) => a.status === "active").length,
    newPending: newAlerts.filter((a) => a.status === "pending").length,
    promotedFromPending: promotedCount,
    silentlyDismissed: silentDismissCount,
    resolved: toResolve.length,
    lastCheck: now,
  };
  console.log("[QAQ scan] done", summary);

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ----- Legacy proxy mode (kept for fallback) -----
async function runProxy(path: string): Promise<Response> {
  const apiKey = Deno.env.get("QUANTAQ_API_KEY");
  if (!apiKey) throw new Error("Missing QUANTAQ_API_KEY");
  if (!path.startsWith("/devices/") && !path.startsWith("/data/")) {
    throw new Error("Invalid path");
  }
  const url = `https://api.quant-aq.com/v1${path}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Basic ${btoa(apiKey + ":")}`,
      Accept: "application/json",
    },
    redirect: "follow",
  });
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ----- Entry point -----
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    let body: any = {};
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch (_) {
      body = {};
    }

    // Scan mode: empty body, { mode: "scan" }, or no path
    if (!body.path) {
      return await runScan();
    }

    // Legacy proxy mode
    return await runProxy(body.path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[QAQ] error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
