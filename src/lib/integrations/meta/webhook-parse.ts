/**
 * Leadgen webhook payload extraction. Pure module (no imports) so unit
 * tests exercise it directly.
 *
 * Per Meta's leadgen webhook docs, deliveries look like:
 * { object: "page", entry: [{ id, time, changes: [{ field: "leadgen",
 *   value: { leadgen_id, page_id, form_id, adgroup_id?, ad_id?,
 *   created_time? } }]}] }
 * Entries/changes batch, non-leadgen fields are ignored, and malformed
 * values are skipped (never throw on attacker-controlled JSON).
 */

export interface LeadgenEvent {
  leadgenId: string;
  pageId: string;
  formId: string;
  adId: string | null;
  adgroupId: string | null;
  createdTime: number | null;
}

function asId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return null;
}

/** True for page-object leadgen deliveries (the only kind we process). */
export function isLeadgenDelivery(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const rec = payload as Record<string, unknown>;
  if (rec["object"] !== "page") return false;
  return Array.isArray(rec["entry"]);
}

/**
 * Extract every well-formed leadgen change. Skips entries/changes with
 * missing ids or non-leadgen fields — callers treat an empty result on a
 * well-formed page payload as "nothing to do" (still 200).
 */
export function extractLeadgenEvents(payload: unknown): LeadgenEvent[] {
  if (!isLeadgenDelivery(payload)) return [];
  const out: LeadgenEvent[] = [];
  const entries = (payload as { entry: unknown[] }).entry;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = (entry as Record<string, unknown>)["changes"];
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const rec = change as Record<string, unknown>;
      if (rec["field"] !== "leadgen") continue;
      const value = rec["value"];
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const leadgenId = asId(v["leadgen_id"]);
      const pageId = asId(v["page_id"]);
      const formId = asId(v["form_id"]);
      if (!leadgenId || !pageId || !formId) continue;
      out.push({
        leadgenId,
        pageId,
        formId,
        adId: asId(v["ad_id"]),
        adgroupId: asId(v["adgroup_id"]),
        createdTime: asTimestamp(v["created_time"]),
      });
    }
  }
  return out;
}
