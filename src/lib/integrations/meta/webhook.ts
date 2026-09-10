/**
 * Meta leadgen webhook pipeline (server-only).
 *
 * Flow: Meta POSTs a signed batch → each leadgen change is routed to the
 * business owning the connected form → persisted as a MetaLeadEvent row →
 * processed inline (Graph fetch → field map → CRM lead + timeline entry).
 *
 * Reliability design (no worker infra in this service):
 * - The (businessId, leadgenId) unique constraint is the idempotency key:
 *   concurrent redeliveries collapse to one row, and the Lead
 *   (businessId, facebookLeadId) constraint guarantees at most one CRM
 *   lead even if two workers race past the pre-checks.
 * - The route always answers 200 after signature validation (Meta's
 *   redeliveries double as the retry transport). Failures are stored with
 *   attempts/lastError/nextRetryAt; redeliveries requeue due events.
 * - Processing is synchronous in the request so behavior is deterministic
 *   and testable; a Redis worker can later claim PENDING rows without
 *   changing the state machine.
 *
 * Tenant isolation: routing resolves the business from the connected
 * MetaForm row — never from client input. Unknown forms are skipped
 * (logged by form id only). Cross-business leadgen ids can never match:
 * every read/write carries the routed businessId.
 *
 * Secret hygiene: tokens are decrypted function-locally for the Graph
 * call only. Logs carry ids, statuses, and error messages — never tokens,
 * signatures, or lead field values (PII).
 */
import { MetaConnectionTable, MetaFormTable, MetaLeadEventTable } from "../../../prisma/tables";
import { env } from "../../env";
import { isBusinessSuspended, toBusinessId, toDbId } from "../../tenancy/businesses";
import { findLeadByFacebookId, insertLeadRecord, type NewLead } from "../../tenancy/leads";
import { TenantLimitExceeded } from "../../tenancy/policies";
import { recordLeadActivity } from "../../tenancy/activities";
import { decryptToken } from "./crypto";
import { MetaApiError, MetaGraphClient } from "./client";
import { mapLeadFields } from "./field-map";
import { extractLeadgenEvents, type LeadgenEvent } from "./webhook-parse";
import { verifyWebhookSignature } from "./webhook-verify";
import { emitAutomationTrigger } from "../../automation/jobs";

export const MAX_EVENT_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];
const STALE_CLAIM_MS = 10 * 60_000;

/** Meta error codes worth retrying (transient platform failures). */
const RETRYABLE_META_CODES = new Set([1, 2]);

export type EventStatus = "PENDING" | "PROCESSING" | "DONE" | "FAILED";

export interface LeadEventDTO {
  id: string;
  businessId: string;
  leadgenId: string;
  metaPageId: string;
  metaFormId: string;
  adId: string | null;
  adgroupId: string | null;
  leadId: string | null;
  status: EventStatus;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const EVENT_FIELDS = [
  "id",
  "businessId",
  "leadgenId",
  "metaPageId",
  "metaFormId",
  "adId",
  "adgroupId",
  "leadId",
  "status",
  "attempts",
  "lastError",
  "nextRetryAt",
  "createdAt",
  "updatedAt",
] as const;

type EventRow = {
  id: string;
  businessId: string;
  leadgenId: string;
  metaPageId: string;
  metaFormId: string;
  adId: string | null;
  adgroupId: string | null;
  leadId: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toEventDTO(row: EventRow): LeadEventDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    leadgenId: row.leadgenId,
    metaPageId: row.metaPageId,
    metaFormId: row.metaFormId,
    adId: row.adId,
    adgroupId: row.adgroupId,
    leadId: row.leadId,
    status: row.status as EventStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    nextRetryAt: row.nextRetryAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function defaultClient(): MetaGraphClient {
  const baseUrl = env.metaGraphBaseUrl;
  return new MetaGraphClient(baseUrl ? { baseUrl } : undefined);
}

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Unknown processing error.";
  // Belt-and-braces: error texts must never carry token-looking material.
  return message.replace(/EAA[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
}

/** Transient Meta/network failures are retryable; auth/shape errors are terminal. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof MetaApiError) {
    if (err.message === "Meta Graph API unreachable.") return true;
    if (err.code !== undefined) return RETRYABLE_META_CODES.has(err.code);
    // No code (shape errors, invalid token) — terminal.
    return false;
  }
  return false;
}

function backoffForAttempt(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(attempt - 1, 0), RETRY_BACKOFF_MS.length - 1)];
}

async function findEvent(businessId: string, leadgenId: string): Promise<EventRow | null> {
  const bid = toBusinessId(businessId);
  const rows = await MetaLeadEventTable.where((e) => e.businessId.eq(bid))
    .select(...EVENT_FIELDS)
    .all();
  return rows.find((r) => r.leadgenId === leadgenId) ?? null;
}

async function mustFindEvent(businessId: string, leadgenId: string): Promise<LeadEventDTO> {
  const row = await findEvent(businessId, leadgenId);
  if (!row) throw new Error("Lead event not found.");
  return toEventDTO(row);
}

async function findFormBusiness(metaFormId: string): Promise<{ businessId: string; metaPageId: string; name: string } | null> {
  const rows = await MetaFormTable.select("businessId", "metaPageId", "metaFormId", "name").all();
  const match = rows.find((r) => r.metaFormId === metaFormId) ?? null;
  if (!match) return null;
  return { businessId: match.businessId, metaPageId: match.metaPageId, name: match.name };
}

async function findConnectionToken(businessId: string): Promise<string | null> {
  const bid = toBusinessId(businessId);
  const row = await MetaConnectionTable.where((m) => m.businessId.eq(bid))
    .select("accessTokenEncrypted", "status")
    .first();
  if (!row || row.status !== "ACTIVE") return null;
  try {
    return await decryptToken(row.accessTokenEncrypted, env.metaTokenKey);
  } catch {
    return null;
  }
}

async function setEvent(
  id: string,
  patch: Partial<Pick<EventRow, "status" | "attempts" | "lastError" | "nextRetryAt" | "leadId">>
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) update["status"] = patch.status;
  if (patch.attempts !== undefined) update["attempts"] = patch.attempts;
  if (patch.lastError !== undefined) update["lastError"] = patch.lastError;
  if (patch.nextRetryAt !== undefined) update["nextRetryAt"] = patch.nextRetryAt;
  if (patch.leadId !== undefined) update["leadId"] = patch.leadId;
  await MetaLeadEventTable.where({ id: toDbId(id) }).update(update as never);
}

export interface StoreOutcome {
  event: LeadEventDTO;
  /** True when this delivery created no new work (already done/in-flight/waiting). */
  duplicate: boolean;
}

/**
 * Persist one inbound change idempotently. Returns the stored row and
 * whether the delivery was a duplicate. Unknown forms resolve to null
 * (caller skips — no business to attribute to).
 */
export async function storeLeadEvent(event: LeadgenEvent): Promise<StoreOutcome | null> {
  const form = await findFormBusiness(event.formId);
  if (!form) {
    console.warn("[meta-webhook] ignoring event for unconnected form", { formId: event.formId });
    return null;
  }
  const existing = await findEvent(form.businessId, event.leadgenId);
  if (existing) {
    return { event: toEventDTO(existing), duplicate: true };
  }
  try {
    const row = await MetaLeadEventTable.select(...EVENT_FIELDS).create({
      businessId: toBusinessId(form.businessId),
      leadgenId: event.leadgenId,
      metaPageId: event.pageId,
      metaFormId: event.formId,
      ...(event.adId !== null ? { adId: event.adId } : {}),
      ...(event.adgroupId !== null ? { adgroupId: event.adgroupId } : {}),
    });
    return { event: toEventDTO(row), duplicate: false };
  } catch {
    // Concurrent delivery won the insert race — re-read the winner.
    const winner = await findEvent(form.businessId, event.leadgenId);
    if (winner) return { event: toEventDTO(winner), duplicate: true };
    throw new Error("Failed to store lead event.");
  }
}

export interface ProcessOutcome {
  event: LeadEventDTO;
  /** "created" | "duplicate" (lead already existed) | "deferred" (still retryable) | "skipped" */
  result: "created" | "duplicate" | "deferred" | "skipped";
}

/**
 * Process one stored event to completion-or-retryable-failure. Safe to call
 * on redelivery: DONE rows ack immediately, in-flight rows ack unless the
 * claim is stale, FAILED rows requeue only when attempts remain and the
 * backoff has elapsed.
 */
export async function processLeadEvent(
  businessId: string,
  leadgenId: string,
  client?: MetaGraphClient,
  nowMs: number = Date.now()
): Promise<ProcessOutcome> {
  const stored = await findEvent(businessId, leadgenId);
  if (!stored) throw new Error("Lead event not found.");
  const event = toEventDTO(stored);

  // Suspended workspaces pause ingestion: skip without touching the row
  // so a later redelivery processes normally after reactivation.
  if (await isBusinessSuspended(businessId)) {
    console.warn("[meta-webhook] ignoring event for suspended workspace", { businessId });
    return { event, result: "skipped" };
  }

  if (event.status === "DONE") return { event, result: "duplicate" };
  if (event.status === "PROCESSING") {
    const claimedAt = new Date(stored.updatedAt).getTime();
    if (Number.isFinite(claimedAt) && nowMs - claimedAt < STALE_CLAIM_MS) {
      return { event, result: "duplicate" };
    }
  }
  if (event.status === "FAILED") {
    if (event.attempts >= MAX_EVENT_ATTEMPTS) return { event, result: "skipped" };
    if (event.nextRetryAt && new Date(event.nextRetryAt).getTime() > nowMs) {
      return { event, result: "deferred" };
    }
  }

  await setEvent(event.id, { status: "PROCESSING" });
  try {
    const token = await findConnectionToken(businessId);
    if (!token) {
      await setEvent(event.id, {
        status: "FAILED",
        attempts: event.attempts + 1,
        lastError: "No active Meta connection.",
        nextRetryAt: null,
      });
      const failed = await mustFindEvent(businessId, leadgenId);
      return { event: failed, result: "skipped" };
    }

    const details = await (client ?? defaultClient()).getLeadDetails(token, event.leadgenId);
    const mapped = mapLeadFields(details.fieldData);
    const input: NewLead = {
      name: mapped.name,
      ...(mapped.email !== undefined ? { email: mapped.email } : {}),
      ...(mapped.phone !== undefined ? { phone: mapped.phone } : {}),
      status: "NEW",
      source: "facebook",
      ...(details.campaignName ? { campaignName: details.campaignName.slice(0, 200) } : {}),
      ...(details.adsetName ? { adSetName: details.adsetName.slice(0, 200) } : {}),
      ...(details.adName ? { adName: details.adName.slice(0, 200) } : {}),
      facebookLeadId: event.leadgenId,
    };

    // Pre-check, then rely on the (businessId, facebookLeadId) constraint
    // as the race-proof backstop.
    const preexisting = await findLeadByFacebookId(businessId, event.leadgenId);
    if (preexisting) {
      await setEvent(event.id, { status: "DONE", leadId: toDbId(preexisting.id), lastError: null, nextRetryAt: null });
      const done = await mustFindEvent(businessId, leadgenId);
      return { event: done, result: "duplicate" };
    }

    let leadId: string;
    try {
      const created = await insertLeadRecord(businessId, input);
      leadId = created.id;
    } catch (err) {
      // Quota rejections are terminal with a clear message — never masked
      // as a generic failure and never retried.
      if (err instanceof TenantLimitExceeded) throw err;
      const raced = await findLeadByFacebookId(businessId, event.leadgenId);
      if (!raced) throw new Error("Failed to create lead.");
      leadId = raced.id;
    }
    await recordLeadActivity(
      businessId,
      leadId,
      "CREATED",
      `Imported from Facebook lead ${event.leadgenId}`
    );
    await setEvent(event.id, { status: "DONE", leadId: toDbId(leadId), lastError: null, nextRetryAt: null });
    const done = await mustFindEvent(businessId, leadgenId);
    // Fire NEW_LEAD automations best-effort — the webhook ack never fails for automation.
    try {
      await emitAutomationTrigger(businessId, "NEW_LEAD", leadId);
    } catch {
      // Logged inside the emitter; the DONE state stands.
    }
    return { event: done, result: "created" };
  } catch (err) {
    const message = sanitizeError(err);
    const attempts = event.attempts + 1;
    if (!isRetryableError(err) || attempts >= MAX_EVENT_ATTEMPTS) {
      await setEvent(event.id, {
        status: "FAILED",
        attempts,
        lastError: message,
        nextRetryAt: null,
      });
      console.error("[meta-webhook] event failed terminally", {
        businessId,
        leadgenId: event.leadgenId,
        attempts,
        error: message,
      });
    } else {
      await setEvent(event.id, {
        status: "FAILED",
        attempts,
        lastError: message,
        nextRetryAt: new Date(nowMs + backoffForAttempt(attempts)).toISOString(),
      });
      console.error("[meta-webhook] event failed, retry scheduled", {
        businessId,
        leadgenId: event.leadgenId,
        attempts,
        error: message,
      });
    }
    const failed = await mustFindEvent(businessId, leadgenId);
    return { event: failed, result: "deferred" };
  }
}

export interface DeliverySummary {
  received: number;
  routed: number;
  created: number;
  duplicates: number;
  deferred: number;
  skipped: number;
}

/**
 * Handle one verified webhook batch: route + store each change, process
 * inline, and summarize. Never throws for per-event failures — they are
 * recorded on the event rows. Always safe to answer 200 afterwards.
 */
export async function handleWebhookDelivery(
  payload: unknown,
  client?: MetaGraphClient,
  nowMs: number = Date.now()
): Promise<DeliverySummary> {
  const summary: DeliverySummary = {
    received: 0,
    routed: 0,
    created: 0,
    duplicates: 0,
    deferred: 0,
    skipped: 0,
  };
  const events = extractLeadgenEvents(payload);
  summary.received = events.length;
  for (const event of events) {
    let stored: StoreOutcome | null;
    try {
      stored = await storeLeadEvent(event);
    } catch (err) {
      console.error("[meta-webhook] failed to store event", {
        leadgenId: event.leadgenId,
        error: sanitizeError(err),
      });
      summary.skipped += 1;
      continue;
    }
    if (!stored) {
      summary.skipped += 1;
      continue;
    }
    summary.routed += 1;
    if (stored.duplicate && stored.event.status === "DONE") {
      summary.duplicates += 1;
      continue;
    }
    try {
      const outcome = await processLeadEvent(stored.event.businessId, stored.event.leadgenId, client, nowMs);
      if (outcome.result === "created") summary.created += 1;
      else if (outcome.result === "duplicate") summary.duplicates += 1;
      else if (outcome.result === "deferred") summary.deferred += 1;
      else summary.skipped += 1;
    } catch (err) {
      console.error("[meta-webhook] failed to process event", {
        leadgenId: event.leadgenId,
        error: sanitizeError(err),
      });
      summary.skipped += 1;
    }
  }
  return summary;
}

export { verifyWebhookSignature };
