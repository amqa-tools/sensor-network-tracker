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
async function qaqFetch(apiKey: string, path: string): Promise<any> {
  const url = `https://api.quant-aq.com/v1${path}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Basic ${btoa(apiKey + ":")}`,
      Accept: "application/json",
    },
    redirect: "follow",
  });
  if (!resp.ok) {
    throw new Error(`QuantAQ ${resp.status} on ${path}`);
  }
  return resp.json();
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
) {
  const nowIso = new Date().toISOString();
  const noteRes = await supa
    .from("notes")
    .insert({
      date: nowIso,
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
  if (sensorsRes.error) throw sensorsRes.error;
  if (communitiesRes.error) throw communitiesRes.error;
  if (existingRes.error) throw existingRes.error;

  const sensors: any[] = sensorsRes.data || [];
  const communities: any[] = communitiesRes.data || [];
  const existingAlerts: any[] = existingRes.data || [];

  const communityNameById = new Map<string, string>();
  for (const c of communities) communityNameById.set(c.id, c.name);

  const sensorById = new Map<string, any>();
  for (const s of sensors) sensorById.set(s.id, s);

  const getStatusArray = (s: any): string[] => Array.isArray(s?.status) ? s.status : [];

  // --- Fetch all devices from QuantAQ ---
  const devices: any[] = [];
  let page = 1, pages = 1;
  while (page <= pages) {
    const json = await qaqFetch(apiKey, `/devices/?per_page=100&org_id=1250&page=${page}`);
    devices.push(...(json.data || []));
    pages = json.meta?.pages || 1;
    page++;
  }

  const stillActiveIds = new Set<string>();
  const newAlerts: any[] = [];
  const statusUpdates: { sn: string; statuses: string[] }[] = [];

  // --- Split offline vs online ---
  const onlineDevices: any[] = [];
  for (const d of devices) {
    const lastSeenStr = d.last_seen ? (d.last_seen.endsWith("Z") ? d.last_seen : d.last_seen + "Z") : null;
    const lastSeen = lastSeenStr ? new Date(lastSeenStr) : null;
    const msSince = lastSeen ? Date.now() - lastSeen.getTime() : Infinity;
    const appSensor = sensorById.get(d.sn);
    const appStatuses = appSensor ? getStatusArray(appSensor) : [];

    if (msSince > OFFLINE_MS) {
      if (appStatuses.some((s) => EXPECTED_OFFLINE.has(s))) continue;
      if (!appSensor || !appSensor.community_id) continue;
      const detail = lastSeen ? `Last seen ${lastSeen.toISOString()}` : "Never seen";
      const community = communityNameById.get(appSensor.community_id) || d.city || "";
      const existing = existingAlerts.find((a) => a.sensor_sn === d.sn && a.issue_type === "Lost Connection");
      if (existing) {
        stillActiveIds.add(existing.id);
        const res = await supa.from("quantaq_alerts").update({ last_checked: now, detail, is_new: false }).eq("id", existing.id);
        check("update lost-connection alert", res);
      } else {
        // Anchor to QuantAQ's clock: detected_at = last_seen, grace window
        // runs from there. If the sensor has been dark longer than the grace
        // window already, the alert goes straight to active on first detect.
        const detectedAtIso = lastSeen ? lastSeen.toISOString() : now;
        const detectedAtMs = lastSeen ? lastSeen.getTime() : Date.now();
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
    } else {
      onlineDevices.push(d);
    }
  }

  // --- Fetch latest raw reading per online device, concurrency 30 ---
  await runWithConcurrency(onlineDevices, 30, async (d) => {
    try {
      const json = await qaqFetch(apiKey, `/devices/${d.sn}/data/raw/?per_page=1&sort=timestamp,desc`);
      const raw = json.data?.[0];
      if (!raw || !raw.flag || raw.flag <= 1) return;
      const flagClean = raw.flag & ~1;
      if (flagClean === 0) return;

      const issues = decodeFlags(flagClean);
      const flagDesc = describeFlags(flagClean);
      const appSensor = sensorById.get(d.sn);
      const community = appSensor ? (communityNameById.get(appSensor.community_id) || "") : (d.city || "");

      for (const issueType of issues) {
        const existing = existingAlerts.find((a) => a.sensor_sn === d.sn && a.issue_type === issueType);
        if (existing) {
          stillActiveIds.add(existing.id);
          const res = await supa.from("quantaq_alerts")
            .update({ last_checked: now, detail: `Flags: ${flagDesc} (raw: ${raw.flag})`, is_new: false })
            .eq("id", existing.id);
          check("update existing flag alert", res);
        } else {
          // Anchor detected_at to QuantAQ's raw reading timestamp, not our
          // scan time. If the raw timestamp is missing or unparseable, fall
          // back to now so we never lose the alert.
          const rawTsStr = raw.timestamp
            ? (String(raw.timestamp).endsWith("Z") ? String(raw.timestamp) : String(raw.timestamp) + "Z")
            : null;
          const rawTs = rawTsStr ? new Date(rawTsStr) : null;
          const detectedAtIso = rawTs && !isNaN(rawTs.getTime()) ? rawTs.toISOString() : now;
          const detectedAtMs = rawTs && !isNaN(rawTs.getTime()) ? rawTs.getTime() : Date.now();

          const severity = ALERT_SEVERITY[issueType] || "warning";
          if (severity === "critical") {
            // Critical skips the grace window entirely — straight to active.
            newAlerts.push({
              sensor_sn: d.sn, sensor_model: d.model, community_name: community,
              issue_type: issueType, detail: `Flags: ${flagDesc} (raw: ${raw.flag})`,
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
              issue_type: issueType, detail: `Flags: ${flagDesc} (raw: ${raw.flag})`,
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
    } catch (e) {
      console.warn(`[QAQ] Raw error for ${d.sn}:`, e);
    }
  });

  // --- Insert new alerts + create event notes for critical ones ---
  if (newAlerts.length > 0) {
    check("insert new alerts", await supa.from("quantaq_alerts").insert(newAlerts));
    for (const alert of newAlerts) {
      if (alert.status !== "active") continue;
      const appSensor = sensorById.get(alert.sensor_sn);
      const communityId = appSensor?.community_id || null;
      await insertAutoFlagNote(
        supa,
        `QuantAQ Auto-Flag: ${alert.issue_type} detected on ${alert.sensor_sn}. ${alert.detail}`,
        alert.sensor_sn,
        communityId,
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
      );
      if (appSensor) {
        const cur = getStatusArray(appSensor);
        const merged = new Set([...cur, alert.issue_type]);
        merged.delete("Online");
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
    for (const alert of toResolve) {
      const appSensor = sensorById.get(alert.sensor_sn);
      const communityId = appSensor?.community_id || null;
      await insertAutoFlagNote(
        supa,
        `QuantAQ Auto-Resolved: ${alert.issue_type} on ${alert.sensor_sn} has cleared.`,
        alert.sensor_sn,
        communityId,
      );
      if (appSensor && alert.issue_type !== "Lost Connection") {
        const cur = getStatusArray(appSensor).filter((s) => s !== alert.issue_type);
        const next = cur.length > 0 ? cur : ["Online"];
        check(
          "clear sensor status (resolve)",
          await supa.from("sensors").update({ status: next, updated_at: now }).eq("id", appSensor.id),
        );
        appSensor.status = next;
      }
    }
  }

  // --- Apply status updates for new critical alerts ---
  for (const u of statusUpdates) {
    const s = sensorById.get(u.sn);
    if (!s) continue;
    const cur = getStatusArray(s);
    const merged = new Set([...cur, ...u.statuses]);
    merged.delete("Online");
    const final = [...merged];
    if (final.slice().sort().join(",") !== cur.slice().sort().join(",")) {
      check(
        "update sensor status (new critical)",
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
    onlineDevices: onlineDevices.length,
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
