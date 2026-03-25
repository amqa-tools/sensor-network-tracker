// ===== QuantAQ Sensor Check — Supabase Edge Function =====
// Fetches all devices from QuantAQ API, checks for issues,
// and syncs alerts to the quantaq_alerts table.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- Types ---

interface QuantAQDevice {
  sn: string;
  model: string;
  city?: string;
  last_seen: string;
  [key: string]: unknown;
}

interface QuantAQRawDataPoint {
  flag: number;
  timestamp: string;
  [key: string]: unknown;
}

interface QuantAQAlert {
  id: string;
  sensor_sn: string;
  sensor_model: string | null;
  community_name: string | null;
  issue_type: string;
  detail: string | null;
  status: string;
  is_new: boolean;
  detected_at: string;
  resolved_at: string | null;
  last_checked: string;
  acknowledged_by: string | null;
  notes: unknown[];
}

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

  // Check PM sensor flags
  if (PM_FLAGS.some((f) => flagValue & f)) {
    issues.push("PM Sensor Issue");
  }

  // Check gaseous sensor flags
  if (GAS_FLAGS.some((f) => flagValue & f)) {
    issues.push("Gaseous Sensor Issue");
  }

  // Check SD card flag
  if (flagValue & FLAG_SD) {
    issues.push("SD Card Issue");
  }

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

// --- QuantAQ API Helpers ---

const OFFLINE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes

async function quantaqFetch(
  path: string,
  apiKey: string
): Promise<Response> {
  const encoded = btoa(apiKey + ":");
  const url = `https://api.quant-aq.com/v1${path}`;
  console.log(`[QuantAQ] GET ${url}`);

  const resp = await fetch(url, {
    headers: {
      Authorization: `Basic ${encoded}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `QuantAQ API error ${resp.status} for ${path}: ${body.slice(0, 200)}`
    );
  }

  return resp;
}

async function getAllDevices(apiKey: string): Promise<QuantAQDevice[]> {
  const all: QuantAQDevice[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const resp = await quantaqFetch(
      `/devices/?per_page=100&page=${page}`,
      apiKey
    );
    const json = await resp.json();
    const devices = json.data || [];
    all.push(...devices);

    totalPages = json.meta?.pages || 1;
    page++;

    console.log(
      `[QuantAQ] Fetched device page ${page - 1}/${totalPages}, got ${devices.length} devices`
    );
  }

  console.log(`[QuantAQ] Total devices: ${all.length}`);
  return all;
}

async function getLatestRawData(
  sn: string,
  apiKey: string
): Promise<QuantAQRawDataPoint | null> {
  try {
    const resp = await quantaqFetch(
      `/devices/${sn}/data/raw/?per_page=1&sort=timestamp,desc`,
      apiKey
    );
    const json = await resp.json();
    return json.data?.[0] || null;
  } catch (err) {
    console.warn(`[QuantAQ] Failed to get raw data for ${sn}:`, err);
    return null;
  }
}

// --- Time helpers ---

function timeSinceStr(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h ago`;
}

// --- Main Handler ---

Deno.serve(async (req: Request) => {
  try {
    console.log("[QuantAQ Check] Starting...");

    // --- Get environment variables ---
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const quantaqApiKey = Deno.env.get("QUANTAQ_API_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }

    if (!quantaqApiKey) {
      throw new Error(
        "Missing QUANTAQ_API_KEY environment variable. Set it in Supabase Dashboard > Edge Functions > Secrets."
      );
    }

    // --- Initialize Supabase client with service role (bypasses RLS) ---
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    const now = new Date().toISOString();

    // --- Load existing active alerts ---
    const { data: existingAlerts, error: alertsErr } = await supabase
      .from("quantaq_alerts")
      .select("*")
      .eq("status", "active");

    if (alertsErr) {
      throw new Error(`Failed to load existing alerts: ${alertsErr.message}`);
    }

    console.log(
      `[QuantAQ Check] ${(existingAlerts || []).length} existing active alerts`
    );

    // --- Load sensor-to-community mapping from sensors table ---
    const { data: sensorRows } = await supabase
      .from("sensors")
      .select("id, community_id");
    const { data: communityRows } = await supabase
      .from("communities")
      .select("id, name");

    const communityMap: Record<string, string> = {};
    for (const c of communityRows || []) {
      communityMap[c.id] = c.name;
    }

    const sensorCommunityMap: Record<string, string> = {};
    for (const s of sensorRows || []) {
      if (s.community_id && communityMap[s.community_id]) {
        sensorCommunityMap[s.id] = communityMap[s.community_id];
      }
    }

    // --- Fetch all QuantAQ devices ---
    const devices = await getAllDevices(quantaqApiKey);

    // --- Check each device for issues ---
    // Track which existing alerts are still active
    const stillActiveIds = new Set<string>();
    const newAlertsToInsert: Partial<QuantAQAlert>[] = [];
    const sensorStatusUpdates: { sn: string; statuses: string[] }[] = [];

    // Process in batches to avoid rate limits
    const BATCH_SIZE = 10;
    for (let i = 0; i < devices.length; i += BATCH_SIZE) {
      const batch = devices.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (device) => {
          const sn = device.sn;
          const issues: { type: string; detail: string }[] = [];

          // --- Check if offline ---
          const lastSeenStr = device.last_seen;
          let lastSeenDate: Date | null = null;
          if (lastSeenStr) {
            // QuantAQ sometimes returns without timezone — assume UTC
            lastSeenDate = new Date(
              lastSeenStr.endsWith("Z") ? lastSeenStr : lastSeenStr + "Z"
            );
          }

          const msSinceSeen = lastSeenDate
            ? Date.now() - lastSeenDate.getTime()
            : Infinity;

          if (msSinceSeen > OFFLINE_THRESHOLD_MS) {
            issues.push({
              type: "Offline",
              detail: lastSeenDate
                ? `Last seen ${timeSinceStr(lastSeenDate.toISOString())}`
                : "Never seen",
            });
          } else {
            // --- Online: check flag bitmask from latest raw data ---
            const raw = await getLatestRawData(sn, quantaqApiKey);
            if (raw && raw.flag && raw.flag > 0) {
              // Ignore startup flag (bit 0 = 1)
              const flagNoStartup = raw.flag & ~1;
              if (flagNoStartup > 0) {
                const issueTypes = decodeFlags(flagNoStartup);
                const flagDesc = describeFlagBits(flagNoStartup);
                for (const issueType of issueTypes) {
                  issues.push({
                    type: issueType,
                    detail: `Flags: ${flagDesc} (raw: ${raw.flag})`,
                  });
                }
              }
            }
          }

          // --- Match issues to existing alerts ---
          const communityName =
            sensorCommunityMap[sn] || device.city || "";

          for (const issue of issues) {
            const existing = (existingAlerts || []).find(
              (a: QuantAQAlert) =>
                a.sensor_sn === sn &&
                a.issue_type === issue.type &&
                a.status === "active"
            );

            if (existing) {
              // Alert persists — mark as still active and update last_checked + detail
              stillActiveIds.add(existing.id);
              await supabase
                .from("quantaq_alerts")
                .update({
                  last_checked: now,
                  detail: issue.detail,
                  is_new: false,
                })
                .eq("id", existing.id);
            } else {
              // New alert
              newAlertsToInsert.push({
                sensor_sn: sn,
                sensor_model: device.model || null,
                community_name: communityName,
                issue_type: issue.type,
                detail: issue.detail,
                status: "active",
                is_new: true,
                detected_at: now,
                last_checked: now,
                notes: [],
              });
            }
          }

          // --- Build sensor status update ---
          const issueStatuses = issues
            .filter((i) => i.type !== "Offline")
            .map((i) => i.type);
          if (issueStatuses.length > 0) {
            sensorStatusUpdates.push({ sn, statuses: issueStatuses });
          }
        })
      );
    }

    // --- Insert new alerts ---
    if (newAlertsToInsert.length > 0) {
      const { error: insertErr } = await supabase
        .from("quantaq_alerts")
        .insert(newAlertsToInsert);
      if (insertErr) {
        console.error("[QuantAQ Check] Failed to insert new alerts:", insertErr);
      } else {
        console.log(
          `[QuantAQ Check] Inserted ${newAlertsToInsert.length} new alerts`
        );
      }
    }

    // --- Resolve alerts that are no longer active ---
    const alertsToResolve = (existingAlerts || []).filter(
      (a: QuantAQAlert) => !stillActiveIds.has(a.id)
    );

    if (alertsToResolve.length > 0) {
      const resolveIds = alertsToResolve.map((a: QuantAQAlert) => a.id);
      const { error: resolveErr } = await supabase
        .from("quantaq_alerts")
        .update({
          status: "resolved",
          resolved_at: now,
          is_new: true, // Mark as new so the UI highlights the resolution
          last_checked: now,
        })
        .in("id", resolveIds);

      if (resolveErr) {
        console.error(
          "[QuantAQ Check] Failed to resolve alerts:",
          resolveErr
        );
      } else {
        console.log(
          `[QuantAQ Check] Resolved ${resolveIds.length} alerts`
        );

        // For resolved alerts, try to clear the status on the sensor
        for (const alert of alertsToResolve) {
          if (alert.issue_type !== "Offline") {
            // Check if this sensor has any OTHER active alerts of the same type
            const otherActive = (existingAlerts || []).find(
              (a: QuantAQAlert) =>
                a.sensor_sn === alert.sensor_sn &&
                a.issue_type === alert.issue_type &&
                a.id !== alert.id &&
                stillActiveIds.has(a.id)
            );
            if (!otherActive) {
              // Remove this status from the sensor
              const { data: sensorRow } = await supabase
                .from("sensors")
                .select("status")
                .eq("id", alert.sensor_sn)
                .single();

              if (sensorRow && Array.isArray(sensorRow.status)) {
                const updatedStatuses = sensorRow.status.filter(
                  (s: string) => s !== alert.issue_type
                );
                // If no statuses left, set to Online
                const finalStatuses =
                  updatedStatuses.length > 0 ? updatedStatuses : ["Online"];
                await supabase
                  .from("sensors")
                  .update({ status: finalStatuses, updated_at: now })
                  .eq("id", alert.sensor_sn);
              }
            }
          }
        }
      }
    }

    // --- Update sensor statuses for new issues ---
    for (const update of sensorStatusUpdates) {
      const { data: sensorRow } = await supabase
        .from("sensors")
        .select("status")
        .eq("id", update.sn)
        .single();

      if (sensorRow) {
        const currentStatuses: string[] = Array.isArray(sensorRow.status)
          ? sensorRow.status
          : [];
        const merged = new Set([...currentStatuses, ...update.statuses]);
        // Remove 'Online' if there are issue statuses
        merged.delete("Online");
        const finalStatuses = [...merged];

        if (
          finalStatuses.sort().join(",") !==
          currentStatuses.sort().join(",")
        ) {
          await supabase
            .from("sensors")
            .update({ status: finalStatuses, updated_at: now })
            .eq("id", update.sn);
          console.log(
            `[QuantAQ Check] Updated sensor ${update.sn} status: ${finalStatuses.join(", ")}`
          );
        }
      }
    }

    // --- Update last check timestamp ---
    await supabase
      .from("app_settings")
      .upsert({ key: "quantaq_last_check", value: now, updated_at: now });

    // --- Summary ---
    const summary = {
      success: true,
      checked_at: now,
      devices_checked: devices.length,
      new_alerts: newAlertsToInsert.length,
      resolved_alerts: alertsToResolve.length,
      still_active: stillActiveIds.size,
    };

    console.log("[QuantAQ Check] Complete:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    console.error("[QuantAQ Check] Fatal error:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});
