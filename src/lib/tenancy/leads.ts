/**
 * Tenant-scoped Lead CRM.
 *
 * HARD RULE: every query filters by `businessId` from the verified
 * `BusinessContext`. There is no function here that fetches a lead by bare
 * id — cross-tenant ids resolve to null (→ 404) and are indistinguishable
 * from non-existent ids.
 *
 * Listing composes database predicates (workspace, status, assignee,
 * archived state, ordering) with in-memory search over the scoped rows so
 * free-text matching never escapes the tenant boundary.
 */
import { LeadTable } from "../../prisma/tables";
import { toUserId } from "../auth/users";
import { findMembership, toBusinessId } from "./businesses";
import type { BusinessContext } from "./context";
import { assertSameBusiness, requirePermission, TenantAccessDenied, TenantNotFound } from "./policies";
import type { LeadQuery, UpdateLeadInput } from "./validation";
import { appendLeadActivity } from "./activities";
import { emitNotification } from "./notifications";
import { assertLeadQuota } from "../billing/subscriptions";

/**
 * Best-effort assignment notification: tells the new assignee (unless
 * they assigned the lead to themselves). Never throws — notification
 * delivery must not break lead writes.
 */
async function notifyAssignee(
  businessId: string,
  actorUserId: string,
  leadId: string,
  leadName: string,
  assigneeId: string | null
): Promise<void> {
  if (!assigneeId || assigneeId === actorUserId) return;
  try {
    await emitNotification(businessId, {
      type: "LEAD_ASSIGNED",
      title: `New lead assigned: ${leadName}`,
      body: `You were assigned lead "${leadName}".`,
      leadId,
      userIds: [assigneeId],
    });
  } catch {
    // Logged inside emit paths; assignment already persisted.
  }
}

export interface LeadDTO {
  id: string;
  businessId: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  source: string | null;
  campaignName: string | null;
  adSetName: string | null;
  adName: string | null;
  facebookLeadId: string | null;
  assignedTo: string | null;
  lastContactedAt: string | null;
  nextFollowUpAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const LEAD_FIELDS = [
  "id",
  "businessId",
  "name",
  "email",
  "phone",
  "status",
  "source",
  "campaignName",
  "adSetName",
  "adName",
  "facebookLeadId",
  "assignedTo",
  "lastContactedAt",
  "nextFollowUpAt",
  "archivedAt",
  "createdAt",
  "updatedAt",
] as const;

type LeadRow = {
  id: string;
  businessId: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  source: string | null;
  campaignName: string | null;
  adSetName: string | null;
  adName: string | null;
  facebookLeadId: string | null;
  assignedTo: string | null;
  lastContactedAt: string | null;
  nextFollowUpAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toLeadDTO(row: LeadRow): LeadDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    source: row.source,
    campaignName: row.campaignName,
    adSetName: row.adSetName,
    adName: row.adName,
    facebookLeadId: row.facebookLeadId,
    assignedTo: row.assignedTo,
    lastContactedAt: row.lastContactedAt,
    nextFollowUpAt: row.nextFollowUpAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface NewLead {
  name: string;
  email?: string;
  phone?: string;
  status?: string;
  source?: string;
  campaignName?: string;
  adSetName?: string;
  adName?: string;
  facebookLeadId?: string;
  assignedTo?: string;
  lastContactedAt?: string;
  nextFollowUpAt?: string;
}

/** Assignees must belong to the workspace — never an outsider. */
async function requireAssigneeInBusiness(context: BusinessContext, userId: string): Promise<void> {
  const member = await findMembership(userId, context.business.id);
  if (!member) {
    throw new TenantAccessDenied("Assignee must be a member of this business.");
  }
}

/**
 * Raw scoped insert without permission checks. Reserved for trusted
 * server-side flows (Meta webhook ingestion) that authorize at the
 * integration layer instead of through a user membership. Asserts the
 * written row belongs to the given business.
 */
export async function insertLeadRecord(businessId: string, input: NewLead): Promise<LeadDTO> {
  // Webhook ingestion shares the manual-create quota: over-limit intake is
  // rejected before the insert so Meta redeliveries can never grow usage.
  await assertLeadQuota(businessId);
  const bid = toBusinessId(businessId);
  const row = await LeadTable.select(...LEAD_FIELDS).create({
    businessId: bid,
    name: input.name,
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.campaignName !== undefined ? { campaignName: input.campaignName } : {}),
    ...(input.adSetName !== undefined ? { adSetName: input.adSetName } : {}),
    ...(input.adName !== undefined ? { adName: input.adName } : {}),
    ...(input.facebookLeadId !== undefined ? { facebookLeadId: input.facebookLeadId } : {}),
    ...(input.assignedTo !== undefined ? { assignedTo: toUserId(input.assignedTo) } : {}),
    ...(input.lastContactedAt !== undefined ? { lastContactedAt: input.lastContactedAt } : {}),
    ...(input.nextFollowUpAt !== undefined ? { nextFollowUpAt: input.nextFollowUpAt } : {}),
  });
  if (row.businessId !== businessId) {
    throw new TenantNotFound();
  }
  return toLeadDTO(row);
}

/** Lead ids already stored in a business (for webhook dedupe checks). */
export async function findLeadByFacebookId(
  businessId: string,
  facebookLeadId: string
): Promise<LeadDTO | null> {
  const bid = toBusinessId(businessId);
  const row = await LeadTable.where((l) => l.businessId.eq(bid))
    .select(...LEAD_FIELDS)
    .all()
    .then((rows) => rows.find((r) => r.facebookLeadId === facebookLeadId) ?? null);
  return row ? toLeadDTO(row) : null;
}

export async function createLead(context: BusinessContext, input: NewLead): Promise<LeadDTO> {
  requirePermission(context, "leads.create");
  if (input.assignedTo !== undefined) {
    requirePermission(context, "leads.assign");
    await requireAssigneeInBusiness(context, input.assignedTo);
  }
  // Server-side quota: checked after authz, before any write, from live
  // usage — request fields cannot influence the outcome.
  await assertLeadQuota(context.business.id);
  const businessId = toBusinessId(context.business.id);
  const row = await LeadTable.select(...LEAD_FIELDS).create({
    businessId,
    name: input.name,
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.campaignName !== undefined ? { campaignName: input.campaignName } : {}),
    ...(input.adSetName !== undefined ? { adSetName: input.adSetName } : {}),
    ...(input.adName !== undefined ? { adName: input.adName } : {}),
    ...(input.facebookLeadId !== undefined ? { facebookLeadId: input.facebookLeadId } : {}),
    ...(input.assignedTo !== undefined ? { assignedTo: toUserId(input.assignedTo) } : {}),
    ...(input.lastContactedAt !== undefined ? { lastContactedAt: input.lastContactedAt } : {}),
    ...(input.nextFollowUpAt !== undefined ? { nextFollowUpAt: input.nextFollowUpAt } : {}),
  });
  assertSameBusiness(context, row.businessId);
  const created = toLeadDTO(row);
  // Timeline: every lead birth is recorded; assignment gets its own entry.
  await appendLeadActivity(context, created.id, "CREATED", {
    body: input.source ? `Source: ${input.source}` : undefined,
  });
  if (created.assignedTo) {
    await appendLeadActivity(context, created.id, "ASSIGNED", {});
    await notifyAssignee(
      context.business.id,
      context.membership.userId,
      created.id,
      created.name,
      created.assignedTo
    );
  }
  return created;
}

export interface LeadPage {
  leads: LeadDTO[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Scoped lead search: database predicates for exact filters + ordering,
 * in-memory matching for free text (name, email, phone, campaign), then
 * pagination over the scoped result.
 */
export async function queryLeads(context: BusinessContext, query: LeadQuery): Promise<LeadPage> {
  requirePermission(context, "leads.read");
  const businessId = toBusinessId(context.business.id);

  let filtered = LeadTable.where((l) => l.businessId.eq(businessId));

  if (query.status !== "" && query.status !== "all") {
    const status = query.status;
    filtered = filtered.where((l) => l.status.eq(status));
  }
  if (query.archived === "active") {
    filtered = filtered.where((l) => l.archivedAt.isNull());
  } else if (query.archived === "archived") {
    filtered = filtered.where((l) => l.archivedAt.isNotNull());
  }
  if (query.assignee !== "" && query.assignee !== "all") {
    if (query.assignee === "me") {
      const me = toUserId(context.membership.userId);
      filtered = filtered.where((l) => l.assignedTo.eq(me));
    } else if (query.assignee === "unassigned") {
      filtered = filtered.where((l) => l.assignedTo.isNull());
    } else {
      try {
        const target = toUserId(query.assignee);
        filtered = filtered.where((l) => l.assignedTo.eq(target));
      } catch {
        // Malformed assignee ids match nothing (validated upstream).
        return { leads: [], total: 0, page: query.page, pageSize: query.pageSize, totalPages: 0 };
      }
    }
  }

  let scoped = filtered.select(...LEAD_FIELDS);
  const desc = query.dir === "desc";
  switch (query.sort) {
    case "name":
      scoped = desc ? scoped.orderBy((l) => l.name.desc()) : scoped.orderBy((l) => l.name.asc());
      break;
    case "status":
      scoped = desc ? scoped.orderBy((l) => l.status.desc()) : scoped.orderBy((l) => l.status.asc());
      break;
    case "updatedAt":
      scoped = desc ? scoped.orderBy((l) => l.updatedAt.desc()) : scoped.orderBy((l) => l.updatedAt.asc());
      break;
    case "nextFollowUpAt":
      scoped = desc
        ? scoped.orderBy((l) => l.nextFollowUpAt.desc())
        : scoped.orderBy((l) => l.nextFollowUpAt.asc());
      break;
    case "createdAt":
    default:
      scoped = desc ? scoped.orderBy((l) => l.createdAt.desc()) : scoped.orderBy((l) => l.createdAt.asc());
      break;
  }

  const rows = await scoped.all();

  const needle = query.search.trim().toLowerCase();
  const matched =
    needle.length === 0
      ? rows
      : rows.filter((r) =>
          [r.name, r.email, r.phone, r.campaignName, r.adSetName, r.adName, r.facebookLeadId]
            .filter((v): v is string => typeof v === "string")
            .some((v) => v.toLowerCase().includes(needle))
        );

  const total = matched.length;
  const totalPages = Math.ceil(total / query.pageSize);
  const page = totalPages === 0 ? 1 : Math.min(query.page, totalPages);
  const start = (page - 1) * query.pageSize;
  return {
    leads: matched.slice(start, start + query.pageSize).map(toLeadDTO),
    total,
    page,
    pageSize: query.pageSize,
    totalPages,
  };
}

/**
 * Fetch one lead scoped to the workspace. Returns null for missing ids AND
 * for ids owned by another business (no existence oracle). Archived leads
 * remain readable (the details page shows an archived banner).
 */
export async function getLead(context: BusinessContext, leadId: string): Promise<LeadDTO | null> {
  requirePermission(context, "leads.read");
  const exact = await findLeadByIdInBusiness(leadId, context.business.id);
  if (!exact) return null;
  return toLeadDTO(exact);
}

async function findLeadByIdInBusiness(leadId: string, businessId: string) {
  const bid = toBusinessId(businessId);
  // Single-row terminal semantics: fetch candidates scoped to the business,
  // then match the id in code — never a bare-id query.
  const rows = await LeadTable.where((l) => l.businessId.eq(bid))
    .select(...LEAD_FIELDS)
    .all();
  return rows.find((r) => r.id === leadId) ?? null;
}

const SCALAR_PATCH_KEYS = [
  "name",
  "email",
  "phone",
  "status",
  "source",
  "campaignName",
  "adSetName",
  "adName",
  "facebookLeadId",
  "lastContactedAt",
  "nextFollowUpAt",
] as const;

export async function updateLead(
  context: BusinessContext,
  leadId: string,
  patch: UpdateLeadInput
): Promise<LeadDTO | null> {
  requirePermission(context, "leads.update");
  if (patch.assignedTo !== undefined) {
    requirePermission(context, "leads.assign");
    if (patch.assignedTo !== null) {
      await requireAssigneeInBusiness(context, patch.assignedTo);
    }
  }
  // Archiving is a soft-delete: governed by leads.delete, like hard deletes.
  if (patch.archived !== undefined) {
    requirePermission(context, "leads.delete");
  }
  const existing = await findLeadByIdInBusiness(leadId, context.business.id);
  if (!existing) return null;
  assertSameBusiness(context, existing.businessId);
  const update: Record<string, unknown> = {};
  for (const key of SCALAR_PATCH_KEYS) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }
  if (patch.assignedTo !== undefined) {
    update["assignedTo"] = patch.assignedTo === null ? null : toUserId(patch.assignedTo);
  }
  if (patch.archived !== undefined) {
    update["archivedAt"] = patch.archived ? new Date().toISOString() : null;
  }
  if (Object.keys(update).length === 0) return toLeadDTO(existing);
  // Re-verify scope at mutation time: fetch-then-update keeps the
  // businessId predicate on both statements.
  const recheck = await findLeadByIdInBusiness(leadId, context.business.id);
  if (!recheck) throw new TenantNotFound();
  await LeadTable.where({ id: recheck.id }).update(update as never);
  const refreshed = await findLeadByIdInBusiness(leadId, context.business.id);
  if (!refreshed) throw new TenantNotFound();
  const dto = toLeadDTO(refreshed);
  // Timeline: record status transitions and assignment changes.
  if (patch.status !== undefined && patch.status !== existing.status) {
    await appendLeadActivity(context, dto.id, "STATUS_CHANGED", {
      body: `${existing.status} → ${patch.status}`,
    });
  }
  if (patch.assignedTo !== undefined) {
    const before = existing.assignedTo ?? null;
    const after = patch.assignedTo;
    if (before !== after) {
      await appendLeadActivity(context, dto.id, "ASSIGNED", {
        body: after === null ? "Unassigned" : undefined,
      });
      await notifyAssignee(context.business.id, context.membership.userId, dto.id, dto.name, after);
    }
  }
  return dto;
}

export async function deleteLead(context: BusinessContext, leadId: string): Promise<boolean> {
  requirePermission(context, "leads.delete");
  const existing = await findLeadByIdInBusiness(leadId, context.business.id);
  if (!existing) return false;
  assertSameBusiness(context, existing.businessId);
  await LeadTable.where({ id: existing.id }).delete();
  return true;
}
