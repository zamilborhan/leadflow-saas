/**
 * Tenant-scoped follow-up scheduling.
 *
 * HARD RULE (same as leads.ts): every query filters by `businessId` from the
 * verified `BusinessContext`. Follow-up ids resolve inside the workspace —
 * cross-tenant ids return null (→ 404), never data.
 *
 * Status machine: PENDING → COMPLETED | CANCELLED, and terminal states can
 * reopen to PENDING. OVERDUE is derived at read time (PENDING with
 * scheduledAt in the past), never stored. Completing a follow-up appends a
 * FOLLOW_UP_COMPLETED timeline entry; creating appends FOLLOW_UP_CREATED.
 */
import { FollowUpTable, LeadTable } from "../../prisma/tables";
import { toUserId } from "../auth/users";
import { appendLeadActivity } from "./activities";
import { findMembership, toBusinessId, toDbId } from "./businesses";
import type { BusinessContext } from "./context";
import { assertSameBusiness, requirePermission, TenantConflict, TenantNotFound } from "./policies";
import { followUpEffectiveStatus, type FollowUpQuery } from "./validation";

export interface FollowUpDTO {
  id: string;
  businessId: string;
  leadId: string;
  assignedTo: string | null;
  scheduledAt: string;
  /** Stored status: PENDING | COMPLETED | CANCELLED. */
  status: string;
  /** Display status: stored status, or OVERDUE when pending and past due. */
  effectiveStatus: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

const FOLLOW_UP_FIELDS = [
  "id",
  "businessId",
  "leadId",
  "assignedTo",
  "scheduledAt",
  "status",
  "note",
  "createdAt",
  "updatedAt",
] as const;

type FollowUpRow = {
  id: string;
  businessId: string;
  leadId: string;
  assignedTo: string | null;
  scheduledAt: string;
  status: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

function toFollowUpDTO(row: FollowUpRow, nowMs = Date.now()): FollowUpDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    leadId: row.leadId,
    assignedTo: row.assignedTo,
    scheduledAt: row.scheduledAt,
    status: row.status,
    effectiveStatus: followUpEffectiveStatus(row.status, row.scheduledAt, nowMs),
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Resolve a lead id inside the workspace (minimal projection). */
async function requireLeadInBusiness(
  context: BusinessContext,
  leadId: string
): Promise<{ id: string; businessId: string }> {
  let bid;
  try {
    bid = toBusinessId(context.business.id);
  } catch {
    throw new TenantNotFound();
  }
  const rows = await LeadTable.where((l) => l.businessId.eq(bid))
    .select("id", "businessId")
    .all();
  const lead = rows.find((r) => r.id === leadId) ?? null;
  if (!lead) throw new TenantNotFound();
  assertSameBusiness(context, lead.businessId);
  return lead;
}

async function findFollowUpInBusiness(followUpId: string, businessId: string) {
  const bid = toBusinessId(businessId);
  const rows = await FollowUpTable.where((f) => f.businessId.eq(bid))
    .select(...FOLLOW_UP_FIELDS)
    .all();
  return rows.find((r) => r.id === followUpId) ?? null;
}

export interface NewFollowUp {
  scheduledAt: string;
  note?: string;
  assignedTo?: string;
}

export async function createFollowUp(
  context: BusinessContext,
  leadId: string,
  input: NewFollowUp
): Promise<FollowUpDTO> {
  requirePermission(context, "followups.create");
  const lead = await requireLeadInBusiness(context, leadId);
  // Default assignee is the scheduler; handing to someone else needs
  // leads.assign (mirrors lead assignment policy).
  let assignee = toUserId(context.membership.userId);
  if (input.assignedTo !== undefined) {
    if (input.assignedTo !== context.membership.userId) {
      requirePermission(context, "leads.assign");
    }
    const member = await findMembership(input.assignedTo, context.business.id);
    if (!member) throw new TenantNotFound();
    assignee = toUserId(input.assignedTo);
  }
  const row = await FollowUpTable.select(...FOLLOW_UP_FIELDS).create({
    businessId: toBusinessId(context.business.id),
    leadId: toDbId(lead.id),
    assignedTo: assignee,
    scheduledAt: input.scheduledAt,
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
  assertSameBusiness(context, row.businessId);
  const dto = toFollowUpDTO(row);
  await appendLeadActivity(context, lead.id, "FOLLOW_UP_CREATED", {
    body: `Scheduled for ${new Date(dto.scheduledAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`,
  });
  return dto;
}

export interface FollowUpPage {
  followUps: FollowUpListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface FollowUpListItem extends FollowUpDTO {
  leadName: string;
}

async function leadNamesInBusiness(context: BusinessContext): Promise<Map<string, string>> {
  const businessId = toBusinessId(context.business.id);
  const leads = await LeadTable.where((l) => l.businessId.eq(businessId))
    .select("id", "name")
    .all();
  return new Map(leads.map((l) => [l.id as string, l.name as string]));
}

function dayBounds(nowMs: number): { start: number; end: number } {
  const d = new Date(nowMs);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

function inScope(
  row: FollowUpRow,
  query: FollowUpQuery,
  callerUserId: string,
  nowMs: number
): boolean {
  const effective = followUpEffectiveStatus(row.status, row.scheduledAt, nowMs);
  switch (query.scope) {
    case "upcoming":
      if (row.status !== "PENDING" || new Date(row.scheduledAt).getTime() < nowMs) return false;
      break;
    case "today": {
      if (row.status !== "PENDING") return false;
      const t = new Date(row.scheduledAt).getTime();
      const { start, end } = dayBounds(nowMs);
      if (!(t >= start && t < end)) return false;
      break;
    }
    case "overdue":
      if (effective !== "OVERDUE") return false;
      break;
    case "mine":
      if (row.assignedTo !== callerUserId) return false;
      break;
    case "all":
    default:
      break;
  }
  if (query.status !== "" && query.status !== "all" && effective !== query.status) return false;
  if (query.leadId !== "" && row.leadId !== query.leadId) return false;
  if (query.assignee !== "" && query.assignee !== "all") {
    if (query.assignee === "me" && row.assignedTo !== callerUserId) return false;
    else if (query.assignee === "unassigned" && row.assignedTo !== null) return false;
    else if (!["me", "unassigned"].includes(query.assignee) && row.assignedTo !== query.assignee)
      return false;
  }
  return true;
}

/**
 * Workspace follow-up list with scope/status/lead/assignee filters,
 * scheduled-time ordering, and pagination — all inside the tenant boundary.
 */
export async function queryFollowUps(
  context: BusinessContext,
  query: FollowUpQuery,
  nowMs = Date.now()
): Promise<FollowUpPage> {
  requirePermission(context, "followups.read");
  const businessId = toBusinessId(context.business.id);
  const [rows, names] = await Promise.all([
    FollowUpTable.where((f) => f.businessId.eq(businessId))
      .select(...FOLLOW_UP_FIELDS)
      .orderBy((f) => f.scheduledAt.asc())
      .all(),
    leadNamesInBusiness(context),
  ]);
  const matched = rows.filter((r) => inScope(r, query, context.membership.userId, nowMs));
  const total = matched.length;
  const totalPages = Math.ceil(total / query.pageSize);
  const page = totalPages === 0 ? 1 : Math.min(query.page, totalPages);
  const start = (page - 1) * query.pageSize;
  const withLead = (r: FollowUpRow): FollowUpListItem => ({
    ...toFollowUpDTO(r, nowMs),
    leadName: names.get(r.leadId) ?? "Unknown lead",
  });
  return {
    followUps: matched.slice(start, start + query.pageSize).map(withLead),
    total,
    page,
    pageSize: query.pageSize,
    totalPages,
  };
}

/** Follow-ups for one lead, scheduled-time ascending. */
export async function listLeadFollowUps(
  context: BusinessContext,
  leadId: string,
  nowMs = Date.now()
): Promise<FollowUpDTO[]> {
  requirePermission(context, "followups.read");
  await requireLeadInBusiness(context, leadId);
  const businessId = toBusinessId(context.business.id);
  const rows = await FollowUpTable.where((f) => f.businessId.eq(businessId))
    .select(...FOLLOW_UP_FIELDS)
    .orderBy((f) => f.scheduledAt.asc())
    .all();
  return rows.filter((r) => r.leadId === leadId).map((r) => toFollowUpDTO(r, nowMs));
}

export async function getFollowUp(
  context: BusinessContext,
  followUpId: string,
  nowMs = Date.now()
): Promise<FollowUpDTO | null> {
  requirePermission(context, "followups.read");
  const row = await findFollowUpInBusiness(followUpId, context.business.id);
  if (!row) return null;
  assertSameBusiness(context, row.businessId);
  return toFollowUpDTO(row, nowMs);
}

export interface UpdateFollowUpPatch {
  scheduledAt?: string;
  note?: string | null;
  status?: "PENDING" | "COMPLETED" | "CANCELLED";
}

const TRANSITIONS: Record<string, readonly string[]> = {
  PENDING: ["COMPLETED", "CANCELLED"],
  COMPLETED: ["PENDING"],
  CANCELLED: ["PENDING"],
};

/**
 * Edit (note/scheduled time) and reschedule a follow-up; status moves only
 * along the transition map. Terminal states reject unrelated edits so
 * history stays trustworthy — reopen first.
 */
export async function updateFollowUp(
  context: BusinessContext,
  followUpId: string,
  patch: UpdateFollowUpPatch,
  nowMs = Date.now()
): Promise<FollowUpDTO | null> {
  requirePermission(context, "followups.update");
  const existing = await findFollowUpInBusiness(followUpId, context.business.id);
  if (!existing) return null;
  assertSameBusiness(context, existing.businessId);

  const update: Record<string, unknown> = {};
  if (patch.scheduledAt !== undefined || patch.note !== undefined) {
    if (existing.status !== "PENDING") {
      throw new TenantConflict(`Only pending follow-ups can be edited. Reopen it first.`);
    }
    if (patch.scheduledAt !== undefined) update["scheduledAt"] = patch.scheduledAt;
    if (patch.note !== undefined) update["note"] = patch.note;
  }
  if (patch.status !== undefined && patch.status !== existing.status) {
    const allowed = TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(patch.status)) {
      throw new TenantConflict(`Cannot move a ${existing.status} follow-up to ${patch.status}.`);
    }
    update["status"] = patch.status;
  }
  if (Object.keys(update).length === 0) return toFollowUpDTO(existing, nowMs);

  const recheck = await findFollowUpInBusiness(followUpId, context.business.id);
  if (!recheck) throw new TenantNotFound();
  await FollowUpTable.where({ id: recheck.id }).update(update as never);
  const refreshed = await findFollowUpInBusiness(followUpId, context.business.id);
  if (!refreshed) throw new TenantNotFound();
  const dto = toFollowUpDTO(refreshed, nowMs);
  if (patch.status === "COMPLETED") {
    await appendLeadActivity(context, dto.leadId, "FOLLOW_UP_COMPLETED", {});
  }
  return dto;
}

export async function deleteFollowUp(context: BusinessContext, followUpId: string): Promise<boolean> {
  requirePermission(context, "followups.delete");
  const existing = await findFollowUpInBusiness(followUpId, context.business.id);
  if (!existing) return false;
  assertSameBusiness(context, existing.businessId);
  await FollowUpTable.where({ id: existing.id }).delete();
  return true;
}

export interface FollowUpSummary {
  today: FollowUpListItem[];
  overdue: FollowUpListItem[];
  upcomingCount: number;
}

/** Dashboard widgets: today's + overdue follow-ups with lead names. */
export async function getFollowUpSummary(
  context: BusinessContext,
  nowMs = Date.now()
): Promise<FollowUpSummary> {
  requirePermission(context, "followups.read");
  const businessId = toBusinessId(context.business.id);
  const [rows, names] = await Promise.all([
    FollowUpTable.where((f) => f.businessId.eq(businessId))
      .select(...FOLLOW_UP_FIELDS)
      .orderBy((f) => f.scheduledAt.asc())
      .all(),
    leadNamesInBusiness(context),
  ]);
  const withLead = (r: FollowUpRow): FollowUpListItem => ({
    ...toFollowUpDTO(r, nowMs),
    leadName: names.get(r.leadId) ?? "Unknown lead",
  });
  const { start, end } = dayBounds(nowMs);
  const today = rows
    .filter((r) => {
      if (r.status !== "PENDING") return false;
      const t = new Date(r.scheduledAt).getTime();
      return t >= start && t < end;
    })
    .map(withLead);
  const overdue = rows
    .filter((r) => followUpEffectiveStatus(r.status, r.scheduledAt, nowMs) === "OVERDUE")
    .map(withLead);
  const upcomingCount = rows.filter(
    (r) => r.status === "PENDING" && new Date(r.scheduledAt).getTime() >= nowMs
  ).length;
  return { today, overdue, upcomingCount };
}
