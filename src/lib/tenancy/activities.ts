/**
 * Tenant-scoped lead activity history + notes.
 *
 * HARD RULE (same as leads.ts): every query filters by `businessId` from the
 * verified `BusinessContext`. Lead ids are resolved inside the workspace —
 * cross-tenant ids resolve to null (→ 404) and are indistinguishable from
 * non-existent ids. Activity rows themselves carry `businessId` and are
 * always read scoped by it; the `leadId` match happens in code over the
 * scoped rows so free-text/detail filtering never escapes the boundary.
 *
 * Timeline model: `LeadActivity` is append-only (no update/delete API).
 * Notes: `LeadNote` stores the agent note; every note write also appends a
 * `NOTE_ADDED` activity row for the same business + lead so the timeline
 * and the notes section stay consistent.
 */
import { LeadActivityTable, LeadNoteTable, LeadTable } from "../../prisma/tables";
import { toUserId } from "../auth/users";
import { toBusinessId, toDbId } from "./businesses";
import type { BusinessContext } from "./context";
import { assertSameBusiness, requirePermission, TenantNotFound } from "./policies";
import type { ActivityQuery } from "./validation";
import { LEAD_ACTIVITY_TYPES } from "./validation";

export { LEAD_ACTIVITY_TYPES };
export type { LeadActivityType } from "./validation";

export interface LeadActivityDTO {
  id: string;
  businessId: string;
  leadId: string;
  type: string;
  body: string | null;
  actorId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadNoteDTO {
  id: string;
  businessId: string;
  leadId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

const ACTIVITY_FIELDS = [
  "id",
  "businessId",
  "leadId",
  "type",
  "body",
  "actorId",
  "createdAt",
  "updatedAt",
] as const;

const NOTE_FIELDS = [
  "id",
  "businessId",
  "leadId",
  "authorId",
  "body",
  "createdAt",
  "updatedAt",
] as const;

type ActivityRow = {
  id: string;
  businessId: string;
  leadId: string;
  type: string;
  body: string | null;
  actorId: string | null;
  createdAt: string;
  updatedAt: string;
};

type NoteRow = {
  id: string;
  businessId: string;
  leadId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

function toActivityDTO(row: ActivityRow): LeadActivityDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    leadId: row.leadId,
    type: row.type,
    body: row.body,
    actorId: row.actorId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toNoteDTO(row: NoteRow): LeadNoteDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    leadId: row.leadId,
    authorId: row.authorId,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Resolve a lead id inside the workspace. Returns null for missing ids AND
 * for ids owned by another business. Minimal projection — callers that need
 * the full lead use getLead() from leads.ts.
 */
async function findLeadIdInBusiness(
  leadId: string,
  businessId: string
): Promise<{ id: string; businessId: string } | null> {
  let bid;
  try {
    bid = toBusinessId(businessId);
  } catch {
    return null;
  }
  const rows = await LeadTable.where((l) => l.businessId.eq(bid))
    .select("id", "businessId")
    .all();
  return rows.find((r) => r.id === leadId) ?? null;
}

async function requireLeadInBusiness(
  context: BusinessContext,
  leadId: string
): Promise<{ id: string; businessId: string }> {
  const lead = await findLeadIdInBusiness(leadId, context.business.id);
  if (!lead) throw new TenantNotFound();
  assertSameBusiness(context, lead.businessId);
  return lead;
}

/**
 * Append an activity row without a permission check. The caller must already
 * hold an authorized context (e.g. createLead/updateLead flows). Verifies
 * the lead belongs to the workspace before writing.
 */
export async function appendLeadActivity(
  context: BusinessContext,
  leadId: string,
  type: string,
  options?: { body?: string; actorId?: string | null }
): Promise<LeadActivityDTO> {
  const lead = await requireLeadInBusiness(context, leadId);
  const row = await LeadActivityTable.select(...ACTIVITY_FIELDS).create({
    businessId: toBusinessId(context.business.id),
    leadId: toDbId(lead.id),
    type,
    ...(options?.body !== undefined ? { body: options.body } : {}),
    ...(options?.actorId !== undefined
      ? options.actorId === null
        ? { actorId: null }
        : { actorId: toUserId(options.actorId) }
      : { actorId: toUserId(context.membership.userId) }),
  });
  assertSameBusiness(context, row.businessId);
  return toActivityDTO(row);
}

/**
 * System activity record without a user membership (webhook ingestion,
 * background jobs). The caller authorizes at the integration layer;
 * the lead's workspace containment is re-verified before writing, and the
 * actor is always null (system).
 */
export async function recordLeadActivity(
  businessId: string,
  leadId: string,
  type: string,
  body?: string
): Promise<LeadActivityDTO> {
  const lead = await findLeadIdInBusiness(leadId, businessId);
  if (!lead || lead.businessId !== businessId) throw new TenantNotFound();
  const row = await LeadActivityTable.select(...ACTIVITY_FIELDS).create({
    businessId: toBusinessId(businessId),
    leadId: toDbId(lead.id),
    type,
    ...(body !== undefined ? { body } : {}),
    actorId: null,
  });
  if (row.businessId !== businessId) throw new TenantNotFound();
  return toActivityDTO(row);
}

/**
 * Explicit activity logging (follow-ups, WhatsApp events, manual entries).
 * Requires `leads.update` — the same permission that mutates a lead.
 * The actor is always the caller; it cannot be spoofed.
 */
export async function logLeadActivity(
  context: BusinessContext,
  leadId: string,
  type: string,
  body?: string
): Promise<LeadActivityDTO> {
  requirePermission(context, "leads.update");
  if (!(LEAD_ACTIVITY_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid activity type: ${type}`);
  }
  return appendLeadActivity(context, leadId, type, { body });
}

/**
 * Lead timeline, newest or oldest first. Scoped reads: database predicate
 * on `businessId` (+ ordering), in-code match on `leadId` and `type`, then
 * limit. Unknown lead ids map to TenantNotFound (→ 404).
 */
export async function listLeadActivities(
  context: BusinessContext,
  leadId: string,
  query?: Partial<ActivityQuery>
): Promise<LeadActivityDTO[]> {
  requirePermission(context, "leads.read");
  await requireLeadInBusiness(context, leadId);
  const businessId = toBusinessId(context.business.id);
  const order = query?.order === "asc" ? "asc" : "desc";
  let scoped = LeadActivityTable.where((a) => a.businessId.eq(businessId)).select(
    ...ACTIVITY_FIELDS
  );
  scoped =
    order === "asc"
      ? scoped.orderBy((a) => a.createdAt.asc())
      : scoped.orderBy((a) => a.createdAt.desc());
  const rows = await scoped.all();
  const type = query?.type ?? "";
  const matched = rows.filter(
    (r) =>
      r.leadId === leadId &&
      (type === "" || type === "all" || r.type === type)
  );
  const limit = query?.limit ?? 100;
  return matched.slice(0, limit).map(toActivityDTO);
}

/**
 * Add an agent note + its NOTE_ADDED timeline entry. Requires
 * `leads.update` so SALES agents can write notes but read-only roles
 * cannot. Both rows carry the workspace `businessId`.
 */
export async function createLeadNote(
  context: BusinessContext,
  leadId: string,
  body: string
): Promise<{ note: LeadNoteDTO; activity: LeadActivityDTO }> {
  requirePermission(context, "leads.update");
  const lead = await requireLeadInBusiness(context, leadId);
  const authorId = toUserId(context.membership.userId);
  const note = await LeadNoteTable.select(...NOTE_FIELDS).create({
    businessId: toBusinessId(context.business.id),
    leadId: toDbId(lead.id),
    authorId,
    body,
  });
  assertSameBusiness(context, note.businessId);
  const activity = await appendLeadActivity(context, lead.id, "NOTE_ADDED", {
    body,
    actorId: context.membership.userId,
  });
  return { note: toNoteDTO(note), activity: toActivityDTO(activity) };
}

/** Notes for a lead, newest first. Same tenant-scoping as the timeline. */
export async function listLeadNotes(
  context: BusinessContext,
  leadId: string,
  query?: { order?: "asc" | "desc"; limit?: number }
): Promise<LeadNoteDTO[]> {
  requirePermission(context, "leads.read");
  await requireLeadInBusiness(context, leadId);
  const businessId = toBusinessId(context.business.id);
  const order = query?.order === "asc" ? "asc" : "desc";
  let scoped = LeadNoteTable.where((n) => n.businessId.eq(businessId)).select(...NOTE_FIELDS);
  scoped =
    order === "asc"
      ? scoped.orderBy((n) => n.createdAt.asc())
      : scoped.orderBy((n) => n.createdAt.desc());
  const rows = await scoped.all();
  const matched = rows.filter((r) => r.leadId === leadId);
  return matched.slice(0, query?.limit ?? 100).map(toNoteDTO);
}
