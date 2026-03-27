// ===== QuantAQ Sensor Check — Supabase Edge Function =====
// FAST version: uses batch endpoints to check all sensors in 2-3 API calls.
// Offline detection via device list + most-recent timestamps.
// Flag detection via per-sensor raw data (only for online sensors, batched).

import { createClient } from "jsr:@supabase/supabase-js@2";

// --- QuantAQ Flag Bitmask ---
const FLAG_OPC = 2;
const FLAG_NEPH = 4;
const FLAG_CO = 16;
const FLAG_NO = 32;
const FLAG_NO2 = 64;
const FLAG_O3 = 128;
const FLAG_SD = 8192;

const PM_FLAGS = [FLAG_OPC, FLAG_NEPH];
const GAS_FLAGS = [FLAG_CO, FLAG_NO, FLAG_NO2, FLAG_O3];

function decodeFlags(flagValue: number): string[] {
  const issues: string[] = [];
  if (PM_FLAGS.some((f) => flagValue & f)) issues.push("PM Sensor Issue");
  if (GAS_FLAGS.some((f) => flagValue & f)) issues.push("Gaseous Sensor Issue");
  if (flagValue & FLAG_SD) issues.push("SD Card Issue");
  return issues;
}

function describeFlagBits(flagValue: number): string {
  const names: string[] = [];
  if (flagValue & FLAG_OPC) names.push("FLAG_OPC");
  if (flagValue & FLAG_NEPH) names.push("FLAG_NEPH");
  if (flagValue & FLAG_CO) names.push("FLAG_CO");
  if (flagValue & FLAG_NO) names.push("FLAG_NO");
  if (flagValue & FLAG_NO2) names.push("FLAG_NO2");
  if (flagValue & FLAG_O3) names.push("FLAG_O3");
  if (flagValue & FLAG_SD) names.push("FLAG_SD");
  return names.join(", ");
}

// --- API helpers ---
const OFFLINE_MS = 60 * 60 * 1000;
const ORG_ID = "1250"; // ADEC AMQA

async function qFetch(path: string, apiKey: string): Promise<unknown> {
  const resp = await fetch(`https://api.quant-aq.com/v1${path}`, {
    headers: { Authorization: `Basic ${btoa(apiKey + ":")}`, Accept: "application/json" },
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`QuantAQ ${resp.status}: ${await resp.text().then(t => t.slice(0, 100))}`);
  return resp.json();
}

function timeSinceStr(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// --- CORS ---
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// --- Main ---
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const apiKey = Deno.env.get("QUANTAQ_API_KEY");
    if (!apiKey) throw new Error("Missing QUANTAQ_API_KEY");

    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
    const now = new Date().toISOString();

    // --- Step 1: Load app data (parallel) ---
    const [
      { data: existingAlerts },
      { data: sensorRows },
      { data: communityRows },
    ] = await Promise.all([
      supabase.from("quantaq_alerts").select("*").eq("status", "active"),
      supabase.from("sensors").select("id, community_id, status"),
      supabase.from("communities").select("id, name"),
    ]);

    const communityMap: Record<string, string> = {};
    for (const c of communityRows || []) communityMap[c.id] = c.name;

    const sensorInfo: Record<string, { communityId: string; communityName: string; statuses: string[] }> = {};
    for (const s of sensorRows || []) {
      sensorInfo[s.id] = {
        communityId: s.community_id || "",
        communityName: (s.community_id && communityMap[s.community_id]) || "",
        statuses: Array.isArray(s.status) ? s.status : [],
      };
    }

    const EXPECTED_OFFLINE = [
      "Lab Storage", "In Transit Between Audits", "Service at Quant",
      "Ready for Deployment", "Shipped to Quant", "Shipped from Quant",
    ];

    console.log(`[QAQ] ${(existingAlerts || []).length} existing alerts`);

    // --- Step 2: Fetch ALL devices in 1 call ---
    const devicesJson = await qFetch(`/devices/?per_page=100&org_id=${ORG_ID}`, apiKey) as { data: Array<{ sn: string; model: string; city?: string; last_seen: string }>; meta: { pages: number } };
    let devices = devicesJson.data || [];
    // Paginate if needed
    if (devicesJson.meta?.pages > 1) {
      for (let p = 2; p <= devicesJson.meta.pages; p++) {
        const page = await qFetch(`/devices/?per_page=100&org_id=${ORG_ID}&page=${p}`, apiKey) as { data: Array<{ sn: string; model: string; city?: string; last_seen: string }> };
        devices = devices.concat(page.data || []);
      }
    }
    console.log(`[QAQ] ${devices.length} devices`);

    // --- Step 3: Categorize offline vs online ---
    const stillActiveIds = new Set<string>();
    const newAlerts: Array<{ sensor_sn: string; sensor_model: string | null; community_name: string; issue_type: string; detail: string; status: string; is_new: boolean; detected_at: string; last_checked: string; notes: unknown[] }> = [];
    const statusUpdates: Array<{ sn: string; statuses: string[] }> = [];

    const onlineDevices: typeof devices = [];

    for (const d of devices) {
      const lastSeen = d.last_seen ? new Date(d.last_seen.endsWith("Z") ? d.last_seen : d.last_seen + "Z") : null;
      const msSince = lastSeen ? Date.now() - lastSeen.getTime() : Infinity;
      const info = sensorInfo[d.sn];

      if (msSince > OFFLINE_MS) {
        // Skip expected-offline sensors
        if (info?.statuses.some(s => EXPECTED_OFFLINE.includes(s))) continue;

        const detail = lastSeen ? `Last seen ${timeSinceStr(lastSeen.toISOString())}` : "Never seen";
        const community = info?.communityName || d.city || "";
        const existing = (existingAlerts || []).find((a: { sensor_sn: string; issue_type: string }) => a.sensor_sn === d.sn && a.issue_type === "Lost Connection");

        if (existing) {
          stillActiveIds.add((existing as { id: string }).id);
          await supabase.from("quantaq_alerts").update({ last_checked: now, detail, is_new: false }).eq("id", (existing as { id: string }).id);
        } else {
          newAlerts.push({ sensor_sn: d.sn, sensor_model: d.model, community_name: community, issue_type: "Lost Connection", detail, status: "active", is_new: true, detected_at: now, last_checked: now, notes: [] });
          statusUpdates.push({ sn: d.sn, statuses: ["Lost Connection"] });
        }
      } else {
        onlineDevices.push(d);
      }
    }

    console.log(`[QAQ] ${devices.length - onlineDevices.length} offline, ${onlineDevices.length} online`);

    // --- Step 4: Check flags for online sensors (batched, max 50 at a time) ---
    const BATCH = 50;
    for (let i = 0; i < onlineDevices.length; i += BATCH) {
      const batch = onlineDevices.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (d) => {
          try {
            const json = await qFetch(`/devices/${d.sn}/data/raw/?per_page=1&sort=timestamp,desc`, apiKey) as { data?: Array<{ flag: number; timestamp: string }> };
            const raw = json.data?.[0];
            if (!raw || !raw.flag || raw.flag <= 1) return; // 0 or 1 (startup only) = no issues

            const flagNoStartup = raw.flag & ~1;
            if (flagNoStartup === 0) return;

            const issues = decodeFlags(flagNoStartup);
            const flagDesc = describeFlagBits(flagNoStartup);
            const info = sensorInfo[d.sn];
            const community = info?.communityName || d.city || "";

            for (const issueType of issues) {
              const existing = (existingAlerts || []).find((a: { sensor_sn: string; issue_type: string }) => a.sensor_sn === d.sn && a.issue_type === issueType);
              if (existing) {
                stillActiveIds.add((existing as { id: string }).id);
                await supabase.from("quantaq_alerts").update({ last_checked: now, detail: `Flags: ${flagDesc} (raw: ${raw.flag})`, is_new: false }).eq("id", (existing as { id: string }).id);
              } else {
                newAlerts.push({ sensor_sn: d.sn, sensor_model: d.model, community_name: community, issue_type: issueType, detail: `Flags: ${flagDesc} (raw: ${raw.flag})`, status: "active", is_new: true, detected_at: now, last_checked: now, notes: [] });
                statusUpdates.push({ sn: d.sn, statuses: [issueType] });
              }
            }
          } catch (e) {
            console.warn(`[QAQ] Raw data error for ${d.sn}:`, e);
          }
        })
      );
    }

    // --- Step 5: Insert new alerts + create event notes ---
    if (newAlerts.length > 0) {
      await supabase.from("quantaq_alerts").insert(newAlerts);
      console.log(`[QAQ] Inserted ${newAlerts.length} new alerts`);

      for (const alert of newAlerts) {
        try {
          const info = sensorInfo[alert.sensor_sn];
          const { data: noteData } = await supabase.from("notes").insert({
            date: now, type: "Issue",
            text: `QuantAQ Auto-Flag: ${alert.issue_type} detected on ${alert.sensor_sn}. ${alert.detail}`,
            created_by: null, additional_info: "",
          }).select("id");
          if (noteData?.[0]?.id) {
            const tags = [{ note_id: noteData[0].id, tag_type: "sensor", tag_id: alert.sensor_sn }];
            if (info?.communityId) tags.push({ note_id: noteData[0].id, tag_type: "community", tag_id: info.communityId });
            await supabase.from("note_tags").insert(tags);
          }
        } catch (e) { console.warn(`[QAQ] Note error for ${alert.sensor_sn}:`, e); }
      }
    }

    // --- Step 6: Resolve cleared alerts ---
    const toResolve = (existingAlerts || []).filter((a: { id: string }) => !stillActiveIds.has(a.id));
    if (toResolve.length > 0) {
      const ids = toResolve.map((a: { id: string }) => a.id);
      await supabase.from("quantaq_alerts").update({ status: "resolved", resolved_at: now, is_new: true, last_checked: now }).in("id", ids);
      console.log(`[QAQ] Resolved ${ids.length} alerts`);

      for (const alert of toResolve as Array<{ id: string; sensor_sn: string; issue_type: string }>) {
        try {
          const info = sensorInfo[alert.sensor_sn];
          const { data: noteData } = await supabase.from("notes").insert({
            date: now, type: "Issue",
            text: `QuantAQ Auto-Resolved: ${alert.issue_type} on ${alert.sensor_sn} has cleared.`,
            created_by: null, additional_info: "",
          }).select("id");
          if (noteData?.[0]?.id) {
            const tags = [{ note_id: noteData[0].id, tag_type: "sensor", tag_id: alert.sensor_sn }];
            if (info?.communityId) tags.push({ note_id: noteData[0].id, tag_type: "community", tag_id: info.communityId });
            await supabase.from("note_tags").insert(tags);
          }
        } catch (e) { console.warn(`[QAQ] Resolve note error:`, e); }

        // Remove status from sensor
        const info = sensorInfo[alert.sensor_sn];
        if (info) {
          const updated = info.statuses.filter(s => s !== alert.issue_type);
          const final = updated.length > 0 ? updated : ["Online"];
          if ([...final].sort().join(",") !== [...info.statuses].sort().join(",")) {
            await supabase.from("sensors").update({ status: final, updated_at: now }).eq("id", alert.sensor_sn);
          }
        }
      }
    }

    // --- Step 7: Update sensor statuses for new issues ---
    for (const u of statusUpdates) {
      const info = sensorInfo[u.sn];
      if (!info) continue;
      const merged = new Set([...info.statuses, ...u.statuses]);
      merged.delete("Online");
      const final = [...merged];
      if ([...final].sort().join(",") !== [...info.statuses].sort().join(",")) {
        await supabase.from("sensors").update({ status: final, updated_at: now }).eq("id", u.sn);
      }
    }

    // --- Step 8: Update timestamp ---
    await supabase.from("app_settings").upsert({ key: "quantaq_last_check", value: now, updated_at: now });

    const summary = { success: true, checked_at: now, devices_checked: devices.length, new_alerts: newAlerts.length, resolved_alerts: toResolve.length, still_active: stillActiveIds.size };
    console.log(`[QAQ] Done:`, JSON.stringify(summary));

    return new Response(JSON.stringify(summary), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[QAQ] Fatal:", err);
    return new Response(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 });
  }
});
