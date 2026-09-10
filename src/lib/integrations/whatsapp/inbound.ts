/**
 * WhatsApp inbound webhook pipeline (server-only).
 *
 * Flow: Meta POSTs a signed batch → each messages/statuses change is
 * routed to the business owning the WhatsAppConnection (by
 * phone_number_id) → inbound texts persist as WhatsAppMessage rows
 * (direction=inbound, status=RECEIVED) → matched to a lead by phone →
 * timeline entry. Status receipts update outbound rows by wamid
 * (SENT → DELIVERED → READ).
 *
 * Reliability design (mirrors the Meta leadgen pipeline, no worker infra):
 * - The (businessId, messageId=wamid) unique constraint is the idempotency
 *   key: concurrent redeliveries collapse to one row.
 * - The route always answers 200 after signature validation (Meta's
 *   redeliveries double as the retry transport). Per-item failures are
 *   logged and skipped — never thrown.
 * - Processing is synchronous in the request so behavior is deterministic
 *   and testable.
 *
 * Lead matching (safe-by-default): the sender wa_id is normalized to
 * digits and compared against every lead phone in the routed business
 * (exact or last-10-digit match for +880/0 prefix variants). Exactly one
 * match → assigned. Zero or ambiguous (2+) → persisted with leadId=null
 * (unmatched) and logged — NEVER assigned to a wrong lead.
 *
 * Tenant isolation: routing resolves the business from the stored
 * WhatsAppConnection — never from client input. Unknown phone_number_ids
 * are skipped (logged by phone id only). Cross-business wamids can never
 * match: every read/write carries the routed businessId.
 *
 * Secret hygiene: no tokens involved. Logs carry ids, phones in truncated
 * form, statuses, and error messages — never message bodies (PII) beyond
 * a length count, never signatures.
 */

import { LeadTable, WhatsAppConnectionTable, WhatsAppMessageTable } from "../../../prisma/tables";
import { isBusinessSuspended, toBusinessId, toDbId } from "../../tenancy/businesses";
import { recordLeadActivity } from "../../tenancy/activities";
import { notifyWhatsAppFailed } from "../../tenancy/notifications";
import {
  extractWhatsappEvents,
  normalizePhoneDigits,
  samePhoneNumber,
  type InboundChange,
  type InboundMessage,
  type InboundStatus,
} from "./inbound-parse";

export interface InboundSummary {
  received: number;
  routed: number;
  matched: number;
  unmatched: number;
  duplicates: number;
  statusesUpdated: number;
  skipped: number;
}

const MESSAGE_FIELDS = [
  "id",
  "businessId",
  "leadId",
  "direction",
  "type",
  "templateName",
  "templateLanguage",
  "variablesJson",
  "body",
  "fromPhone",
  "toPhone",
  "messageId",
  "status",
  "attempts",
  "lastError",
  "nextRetryAt",
  "createdAt",
  "updatedAt",
] as const;

type MessageRow = {
  id: string;
  businessId: string;
  leadId: string | null;
  direction: string;
  type: string;
  templateName: string | null;
  templateLanguage: string | null;
  variablesJson: string | null;
  body: string | null;
  fromPhone: string | null;
  toPhone: string;
  messageId: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function truncatePhone(phone: string): string {
  const digits = normalizePhoneDigits(phone);
  if (digits.length <= 4) return "***";
  return `***${digits.slice(-4)}`;
}

/** Business owning a phone_number_id (ACTIVE connections only). */
export async function findBusinessByPhoneNumberId(
  phoneNumberId: string
): Promise<{ businessId: string; displayPhoneNumber: string | null } | null> {
  const rows = await WhatsAppConnectionTable.select("businessId", "phoneNumberId", "displayPhoneNumber", "status").all();
  const match = rows.find((r) => r.phoneNumberId === phoneNumberId) ?? null;
  if (!match || match.status !== "ACTIVE") return null;
  return { businessId: match.businessId, displayPhoneNumber: match.displayPhoneNumber };
}

/**
 * Safe lead match within a business. Returns the single matching lead id,
 * or null when zero or ambiguous (2+) leads share the sender's number.
 * Archived leads participate (a reply to an archived thread still belongs
 * to that thread) — ambiguity across any of them blocks assignment.
 */
export async function matchLeadByPhone(businessId: string, fromPhone: string): Promise<string | null> {
  const senderDigits = normalizePhoneDigits(fromPhone);
  if (!senderDigits) return null;
  const bid = toBusinessId(businessId);
  const rows = await LeadTable.where((l) => l.businessId.eq(bid)).select("id", "phone").all();
  const hits = rows.filter((r) => r.phone && samePhoneNumber(normalizePhoneDigits(r.phone), senderDigits));
  if (hits.length !== 1) return null;
  return hits[0].id;
}

async function findMessageByWamid(businessId: string, wamid: string): Promise<MessageRow | null> {
  const bid = toBusinessId(businessId);
  const rows = await WhatsAppMessageTable.where((m) => m.businessId.eq(bid))
    .select(...MESSAGE_FIELDS)
    .all();
  return rows.find((r) => r.messageId === wamid) ?? null;
}

export type InboundStoreResult = "created" | "duplicate" | "unmatched-created";

/**
 * Persist one inbound message idempotently. Returns whether the wamid was
 * new (created, matched or unmatched) or a redelivery (duplicate).
 * Unmatched senders persist with leadId=null — never guessed.
 */
export async function storeInboundMessage(
  businessId: string,
  change: Pick<InboundChange, "phoneNumberId" | "displayPhoneNumber">,
  message: InboundMessage
): Promise<{ result: InboundStoreResult; leadId: string | null }> {
  const existing = await findMessageByWamid(businessId, message.wamid);
  if (existing) return { result: "duplicate", leadId: existing.leadId };

  const leadId = await matchLeadByPhone(businessId, message.from).catch(() => null);
  const bid = toBusinessId(businessId);
  const toPhone = change.displayPhoneNumber ?? change.phoneNumberId;
  try {
    await WhatsAppMessageTable.select(...MESSAGE_FIELDS).create({
      businessId: bid,
      ...(leadId ? { leadId: toDbId(leadId) } : {}),
      direction: "inbound",
      type: message.type || "text",
      body: message.body.slice(0, 2000),
      fromPhone: message.from,
      toPhone,
      messageId: message.wamid,
      status: "RECEIVED",
    });
    if (leadId) {
      await recordLeadActivity(businessId, leadId, "WHATSAPP_RECEIVED", "Inbound WhatsApp message received.").catch(
        () => null
      );
    } else {
      console.warn("[whatsapp-inbound] unmatched sender, stored without lead", {
        businessId,
        from: truncatePhone(message.from),
        wamid: message.wamid,
      });
    }
    return { result: leadId ? "created" : "unmatched-created", leadId };
  } catch {
    // Concurrent redelivery won the insert race — re-read the winner.
    const winner = await findMessageByWamid(businessId, message.wamid);
    if (winner) return { result: "duplicate", leadId: winner.leadId };
    throw new Error("Failed to store inbound message.");
  }
}

const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  received: 2,
  failed: 99,
};

function normalizeStatus(raw: string): string | null {
  const s = raw.toLowerCase();
  if (s === "sent" || s === "delivered" || s === "read") return s.toUpperCase();
  if (s === "failed" || s === "undelivered") return "FAILED";
  return null;
}

/**
 * Apply one delivery/read receipt to the outbound row with the same wamid.
 * Returns true when a row advanced. Unknown wamids, inbound rows, and
 * regressions (READ → DELIVERED) are skipped quietly. FAILED receipts mark
 * the row FAILED with the Meta error, if provided.
 */
export async function applyStatusReceipt(
  businessId: string,
  status: InboundStatus
): Promise<boolean> {
  const target = normalizeStatus(status.status);
  if (!target) return false;
  const row = await findMessageByWamid(businessId, status.wamid);
  if (!row || row.direction !== "outbound") return false;
  if (row.direction === "outbound" && row.leadId === null) return false;
  const currentRank = STATUS_RANK[row.status.toLowerCase()] ?? -1;
  const nextRank = STATUS_RANK[target.toLowerCase()] ?? -1;
  if (target === "FAILED") {
    if (row.status === "FAILED") return false;
    await WhatsAppMessageTable.where({ id: toDbId(row.id) }).update({
      status: "FAILED",
      lastError: "Delivery failed (Meta receipt).",
    } as never);
    await notifyWhatsAppFailed(businessId, {
      leadId: row.leadId,
      messageId: row.id,
      reason: "Delivery failed (Meta receipt).",
    });
    return true;
  }
  // Never regress (e.g. a late "sent" after "read"), never touch FAILED.
  if (row.status === "FAILED" || nextRank <= currentRank) return false;
  await WhatsAppMessageTable.where({ id: toDbId(row.id) }).update({ status: target } as never);
  return true;
}

/**
 * Handle one verified webhook batch: route + store each message, apply
 * each receipt, and summarize. Never throws for per-item failures — they
 * are logged and counted as skipped. Always safe to answer 200 afterwards.
 */
export async function handleWhatsappDelivery(payload: unknown): Promise<InboundSummary> {
  const summary: InboundSummary = {
    received: 0,
    routed: 0,
    matched: 0,
    unmatched: 0,
    duplicates: 0,
    statusesUpdated: 0,
    skipped: 0,
  };
  const changes = extractWhatsappEvents(payload);
  for (const change of changes) {
    let routed: { businessId: string; displayPhoneNumber: string | null } | null = null;
    try {
      routed = await findBusinessByPhoneNumberId(change.phoneNumberId);
    } catch (err) {
      console.error("[whatsapp-inbound] routing lookup failed", {
        phoneNumberId: change.phoneNumberId,
        error: err instanceof Error ? err.message : "unknown",
      });
      summary.skipped += change.messages.length + change.statuses.length;
      continue;
    }
    if (!routed) {
      console.warn("[whatsapp-inbound] ignoring change for unknown phone", {
        phoneNumberId: change.phoneNumberId,
      });
      summary.skipped += change.messages.length + change.statuses.length;
      continue;
    }
    if (await isBusinessSuspended(routed.businessId)) {
      console.warn("[whatsapp-inbound] ignoring change for suspended workspace", {
        businessId: routed.businessId,
      });
      summary.skipped += change.messages.length + change.statuses.length;
      continue;
    }
    summary.routed += change.messages.length + change.statuses.length;
    for (const message of change.messages) {
      summary.received += 1;
      try {
        const stored = await storeInboundMessage(routed.businessId, change, message);
        if (stored.result === "duplicate") summary.duplicates += 1;
        else if (stored.result === "created") summary.matched += 1;
        else summary.unmatched += 1;
      } catch (err) {
        console.error("[whatsapp-inbound] failed to store message", {
          wamid: message.wamid,
          error: err instanceof Error ? err.message : "unknown",
        });
        summary.skipped += 1;
      }
    }
    for (const receipt of change.statuses) {
      try {
        const updated = await applyStatusReceipt(routed.businessId, receipt);
        if (updated) summary.statusesUpdated += 1;
        else summary.duplicates += 1;
      } catch (err) {
        console.error("[whatsapp-inbound] failed to apply receipt", {
          wamid: receipt.wamid,
          error: err instanceof Error ? err.message : "unknown",
        });
        summary.skipped += 1;
      }
    }
  }
  return summary;
}

export { extractWhatsappEvents, normalizePhoneDigits, samePhoneNumber };
export type { InboundChange, InboundMessage, InboundStatus };
