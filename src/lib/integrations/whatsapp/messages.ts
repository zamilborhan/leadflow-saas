/**
 * WhatsApp outbound messaging — DB-backed outbox queue (no worker infra in
 * this service, so enqueue + inline drain; see module notes below).
 *
 * Flow: queueTemplateMessage validates (permission, lead, phone, APPROVED
 * template, complete variables), persists a QUEUED row, then drains due
 * rows inline: claim QUEUED → SENDING, POST to Meta, SENT with the wamid on
 * acceptance, FAILED with attempts/lastError/nextRetryAt otherwise.
 * Meta only *accepts* here — delivery/read receipts arrive via webhooks
 * later, so callers MUST poll getMessage/listLeadMessages and never trust
 * the send response as delivery.
 *
 * Tenant isolation: every read/write filters by the context businessId;
 * lead ids resolve inside the workspace (unknown/foreign → 404, no
 * oracle). Tokens decrypt function-locally for the Graph call only.
 * Logs carry ids/statuses/error messages — never tokens, signatures, or
 * message bodies.
 */
import { WhatsAppMessageTable } from "../../../prisma/tables";
import { env } from "../../env";
import type { BusinessContext } from "../../tenancy/context";
import { requirePermission, TenantConflict, TenantNotFound } from "../../tenancy/policies";
import { toBusinessId, toDbId } from "../../tenancy/businesses";
import { getLead } from "../../tenancy/leads";
import { decryptToken } from "../meta/crypto";
import { MetaApiError, WhatsAppCloudClient } from "./client";
import { recordLeadActivity } from "../../tenancy/activities";
import { buildSendComponents, TemplateSendError } from "./template-parse";
import { listTemplates } from "./templates";
import { findConnection } from "./service";
import { notifyWhatsAppFailed } from "../../tenancy/notifications";

export type MessageStatus =
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "RECEIVED"
  | "FAILED";

export interface WhatsAppMessageDTO {
  id: string;
  businessId: string;
  leadId: string | null;
  direction: string;
  type: string;
  templateName: string | null;
  templateLanguage: string | null;
  variables: Record<string, string>;
  body: string | null;
  fromPhone: string | null;
  toPhone: string;
  messageId: string | null;
  status: MessageStatus;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
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

function parseVariables(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function toDTO(row: MessageRow): WhatsAppMessageDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    leadId: row.leadId,
    direction: row.direction,
    type: row.type,
    templateName: row.templateName,
    templateLanguage: row.templateLanguage,
    variables: parseVariables(row.variablesJson),
    body: row.body,
    fromPhone: row.fromPhone,
    toPhone: row.toPhone,
    messageId: row.messageId,
    status: row.status as MessageStatus,
    attempts: row.attempts,
    lastError: row.lastError,
    nextRetryAt: row.nextRetryAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function defaultClient(): WhatsAppCloudClient {
  const baseUrl = env.metaGraphBaseUrl;
  return new WhatsAppCloudClient(baseUrl ? { baseUrl } : undefined);
}

function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : "Unknown messaging error.";
  return message.replace(/EAA[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
}

/** Transient Meta/network failures are retryable; auth/shape errors are terminal. */
export function isRetryableSendError(err: unknown): boolean {
  if (err instanceof MetaApiError) {
    if (err.message === "WhatsApp API unreachable.") return true;
    if (err.code !== undefined) return err.code === 1 || err.code === 2;
    return false;
  }
  if (err instanceof TemplateSendError) return false;
  return false;
}

const MAX_SEND_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];

function backoffForAttempt(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(attempt - 1, 0), RETRY_BACKOFF_MS.length - 1)];
}

async function findMessageInBusiness(messageId: string, businessId: string): Promise<MessageRow | null> {
  const bid = toBusinessId(businessId);
  const rows = await WhatsAppMessageTable.where((m) => m.businessId.eq(bid))
    .select(...MESSAGE_FIELDS)
    .all();
  return rows.find((r) => r.id === messageId) ?? null;
}

async function setMessage(
  id: string,
  patch: Partial<Pick<MessageRow, "status" | "attempts" | "lastError" | "nextRetryAt" | "messageId">>
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) update["status"] = patch.status;
  if (patch.attempts !== undefined) update["attempts"] = patch.attempts;
  if (patch.lastError !== undefined) update["lastError"] = patch.lastError;
  if (patch.nextRetryAt !== undefined) update["nextRetryAt"] = patch.nextRetryAt;
  if (patch.messageId !== undefined) update["messageId"] = patch.messageId;
  await WhatsAppMessageTable.where({ id: toDbId(id) }).update(update as never);
}

async function mustFindMessage(businessId: string, messageId: string): Promise<WhatsAppMessageDTO> {
  const row = await findMessageInBusiness(messageId, businessId);
  if (!row) throw new TenantNotFound();
  return toDTO(row);
}

export interface QueueTemplateInput {
  templateName: string;
  templateLanguage: string;
  variables: Record<string, string>;
}

/**
 * Validate and enqueue a template message for a lead, then drain due rows
 * inline (see module notes). Requires whatsapp.send. The lead must have a
 * phone number; the template must be cached APPROVED with every variable
 * supplied. Returns the row in its post-drain state — callers must still
 * poll for later transitions (delivery receipts arrive via webhook).
 */
export async function queueTemplateMessage(
  context: BusinessContext,
  leadId: string,
  input: QueueTemplateInput,
  client?: WhatsAppCloudClient
): Promise<WhatsAppMessageDTO> {
  requirePermission(context, "whatsapp.send");
  const lead = await getLead(context, leadId);
  if (!lead) throw new TenantNotFound();
  if (!lead.phone) {
    throw new TenantConflict("Lead has no phone number.");
  }
  const template = (await listTemplates(context)).find(
    (t) => t.name === input.templateName && t.language === input.templateLanguage
  );
  if (!template) throw new TenantNotFound("Template not found. Sync templates first.");
  if (template.status !== "APPROVED") {
    throw new TenantConflict("Only APPROVED templates can be sent.");
  }
  const variables: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.variables ?? {})) {
    if (typeof v === "string" && v.trim().length > 0) variables[k] = v.trim().slice(0, 1024);
  }
  try {
    // Validate variables now so the caller gets 422 synchronously;
    // processMessageRow rebuilds the identical payload at send time.
    buildSendComponents(
      template.components.map((c) => ({ type: c.type, text: c.text })),
      variables
    );
  } catch (err) {
    if (err instanceof TemplateSendError) throw new TenantConflict(err.message);
    throw err;
  }

  const businessId = toBusinessId(context.business.id);
  const row = await WhatsAppMessageTable.select(...MESSAGE_FIELDS).create({
    businessId,
    leadId: toDbId(lead.id),
    direction: "outbound",
    type: "template",
    templateName: template.name,
    templateLanguage: template.language,
    variablesJson: JSON.stringify(variables),
    toPhone: lead.phone,
  });
  await drainDueMessages(context, client);
  return mustFindMessage(context.business.id, row.id);
}

/**
 * Drain due rows (QUEUED, or FAILED with attempts left and elapsed
 * backoff): claim → POST → SENT/FAILED. Returns settled rows. A future
 * Redis worker can call this on a timer without changing the machine.
 */
export async function drainDueMessages(
  context: BusinessContext,
  client?: WhatsAppCloudClient,
  nowMs: number = Date.now()
): Promise<WhatsAppMessageDTO[]> {
  requirePermission(context, "whatsapp.send");
  const businessId = toBusinessId(context.business.id);
  const rows = await WhatsAppMessageTable.where((m) => m.businessId.eq(businessId))
    .select(...MESSAGE_FIELDS)
    .all();
  const settled: WhatsAppMessageDTO[] = [];
  for (const row of rows) {
    if (row.status !== "QUEUED") continue;
    if (row.nextRetryAt && new Date(row.nextRetryAt).getTime() > nowMs) continue;
    settled.push(await processMessageRow(context, row, client, nowMs));
  }
  const failed = rows.filter(
    (r) =>
      r.status === "FAILED" &&
      r.attempts < MAX_SEND_ATTEMPTS &&
      (!r.nextRetryAt || new Date(r.nextRetryAt).getTime() <= nowMs)
  );
  for (const row of failed) {
    settled.push(await processMessageRow(context, row, client, nowMs));
  }
  return settled;
}

async function processMessageRow(
  context: BusinessContext,
  row: MessageRow,
  client: WhatsAppCloudClient | undefined,
  nowMs: number
): Promise<WhatsAppMessageDTO> {
  await setMessage(row.id, { status: "SENDING" });
  try {
    const connection = await findConnection(context.business.id);
    if (!connection || connection.status !== "ACTIVE") {
      throw new TenantConflict("No active WhatsApp connection.");
    }
    let token: string;
    try {
      token = await decryptToken(connection.accessTokenEncrypted, env.metaTokenKey);
    } catch {
      throw new TenantConflict("Stored credentials are unreadable. Reconnect WhatsApp.");
    }
    const template = (await listTemplates(context)).find(
      (t) => t.name === row.templateName && t.language === row.templateLanguage
    );
    if (!template || template.status !== "APPROVED") {
      throw new TenantConflict("Template is no longer APPROVED for sending.");
    }
    const components = buildSendComponents(
      template.components.map((c) => ({ type: c.type, text: c.text })),
      parseVariables(row.variablesJson)
    );
    const sent = await (client ?? defaultClient()).sendTemplateMessage({
      phoneNumberId: connection.phoneNumberId,
      token,
      to: row.toPhone,
      templateName: template.name,
      languageCode: template.language,
      components,
    });
    await setMessage(row.id, {
      status: "SENT",
      messageId: sent.messageId,
      lastError: null,
      nextRetryAt: null,
    });
    await recordLeadActivity(context.business.id, row.leadId as string, "WHATSAPP_SENT",
      `Template "${template.name}" accepted (wamid ${sent.messageId}).`);
    return mustFindMessage(context.business.id, row.id);
  } catch (err) {
    if (err instanceof TemplateSendError) {
      await setMessage(row.id, {
        status: "FAILED",
        attempts: row.attempts + 1,
        lastError: sanitizeError(err),
        nextRetryAt: null,
      });
      console.error("[whatsapp] message failed terminally", {
        businessId: context.business.id,
        messageId: row.id,
        error: sanitizeError(err),
      });
      await notifyWhatsAppFailed(context.business.id, {
        leadId: row.leadId,
        messageId: row.id,
        reason: sanitizeError(err),
      });
      return mustFindMessage(context.business.id, row.id);
    }
    const message = sanitizeError(err);
    const attempts = row.attempts + 1;
    if (!isRetryableSendError(err) || attempts >= MAX_SEND_ATTEMPTS) {
      await setMessage(row.id, { status: "FAILED", attempts, lastError: message, nextRetryAt: null });
      console.error("[whatsapp] message failed terminally", {
        businessId: context.business.id,
        messageId: row.id,
        attempts,
        error: message,
      });
      await notifyWhatsAppFailed(context.business.id, {
        leadId: row.leadId,
        messageId: row.id,
        reason: message,
      });
    } else {
      await setMessage(row.id, {
        status: "FAILED",
        attempts,
        lastError: message,
        nextRetryAt: new Date(nowMs + backoffForAttempt(attempts)).toISOString(),
      });
      console.error("[whatsapp] message failed, retry scheduled", {
        businessId: context.business.id,
        messageId: row.id,
        attempts,
        error: message,
      });
    }
    return mustFindMessage(context.business.id, row.id);
  }
}

/** Single message, scoped (unknown/foreign → 404). Requires leads.read. */
export async function getMessage(
  context: BusinessContext,
  messageId: string
): Promise<WhatsAppMessageDTO | null> {
  requirePermission(context, "leads.read");
  const row = await findMessageInBusiness(messageId, context.business.id);
  if (!row) return null;
  return toDTO(row);
}

/** Lead message history, newest first. Requires leads.read. */
export async function listLeadMessages(
  context: BusinessContext,
  leadId: string
): Promise<WhatsAppMessageDTO[]> {
  requirePermission(context, "leads.read");
  const lead = await getLead(context, leadId);
  if (!lead) throw new TenantNotFound();
  const businessId = toBusinessId(context.business.id);
  const rows = await WhatsAppMessageTable.where((m) => m.businessId.eq(businessId))
    .select(...MESSAGE_FIELDS)
    .all();
  return rows
    .filter((r) => r.leadId === lead.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(toDTO);
}

/** Requeue a FAILED message with attempts left (safe retry entrypoint). */
export async function retryMessage(
  context: BusinessContext,
  messageId: string,
  client?: WhatsAppCloudClient,
  nowMs: number = Date.now()
): Promise<WhatsAppMessageDTO> {
  requirePermission(context, "whatsapp.send");
  const row = await findMessageInBusiness(messageId, context.business.id);
  if (!row) throw new TenantNotFound();
  if (row.status !== "FAILED") {
    throw new TenantConflict("Only failed messages can be retried.");
  }
  if (row.attempts >= MAX_SEND_ATTEMPTS) {
    throw new TenantConflict("Retry budget exhausted for this message.");
  }
  await setMessage(row.id, { status: "QUEUED", lastError: null, nextRetryAt: null });
  await drainDueMessages(context, client, nowMs);
  return mustFindMessage(context.business.id, row.id);
}

// Re-exported for route/tests that only need the accessor shape.
export { findConnection };
