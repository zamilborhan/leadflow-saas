/**
 * Tenant-scoped data access for businesses + memberships.
 *
 * Invariant: a user may only see businesses they belong to. `ownerId` marks
 * the creator but never grants implicit access — every check goes through
 * the BusinessMember row.
 */
import type { Char } from "@prisma/orm-postgres/target/codec-types";
import { BusinessTable, BusinessMemberTable } from "../../prisma/tables";
import { toUserId } from "../auth/users";
import type { WorkspaceRole } from "./roles";
import { isValidRole } from "./roles";

export type BusinessId = Char<36>;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function toBusinessId(id: string): BusinessId {
  if (!UUID_RE.test(id)) throw new Error("Invalid business id");
  return id as BusinessId;
}

/** Brand any UUID string for exact-id `where({ id })` lookups. All uuid columns share Char<36>. */
export function toDbId(id: string): BusinessId {
  if (!UUID_RE.test(id)) throw new Error("Invalid id");
  return id as BusinessId;
}

export interface BusinessDTO {
  id: string;
  name: string;
  ownerId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface MembershipDTO {
  id: string;
  businessId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: string;
  updatedAt: string;
}

function toBusinessDTO(row: {
  id: string;
  name: string;
  ownerId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}): BusinessDTO {
  return { id: row.id, name: row.name, ownerId: row.ownerId, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** True when the workspace is suspended (member access revoked). Unknown ids read as active. */
export async function isBusinessSuspended(businessId: string): Promise<boolean> {
  let bid: BusinessId;
  try {
    bid = toBusinessId(businessId);
  } catch {
    return false;
  }
  try {
    const row = await BusinessTable.where({ id: bid }).select("id", "status").first();
    if (!row || row.id !== businessId) return false;
    return row.status === "SUSPENDED";
  } catch {
    // A transient read failure must not wedge ingestion — the routing read
    // that located this business just succeeded, so fail open with a log.
    console.warn("[tenancy] suspension check failed; failing open", { businessId });
    return false;
  }
}

function toMembershipDTO(row: {
  id: string;
  businessId: string;
  userId: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}): MembershipDTO | null {
  if (!isValidRole(row.role)) return null;
  return {
    id: row.id,
    businessId: row.businessId,
    userId: row.userId,
    role: row.role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create a business + its OWNER membership atomically from the caller's
 * perspective (two writes; the membership write is what grants access).
 */
export async function createBusiness(ownerUserId: string, name: string): Promise<BusinessDTO> {
  const ownerId = toUserId(ownerUserId);
  // Server-side quota: workspaces per owner come from live subscription
  // state, never from the request.
  const { assertBusinessQuota } = await import("../billing/subscriptions");
  await assertBusinessQuota(ownerUserId);
  const business = await BusinessTable.select("id", "name", "ownerId", "status", "createdAt", "updatedAt").create({
    name,
    ownerId,
  });
  await BusinessMemberTable.create({
    businessId: business.id,
    userId: ownerId,
    role: "OWNER",
  });
  // Seed workspace automation defaults best-effort (dynamic import avoids a
  // static cycle: automation/rules.ts reads these tenancy helpers).
  try {
    const { ensureDefaultAutomationRules } = await import("../automation/rules");
    await ensureDefaultAutomationRules(business.id);
  } catch {
    // Rules auto-seed lazily on first list — creation never fails for this.
  }
  return toBusinessDTO(business);
}

/** All businesses the user belongs to (workspace switcher source). Suspended
 * workspaces are hidden — members lose all access until reactivation. */
export async function listUserBusinesses(userId: string): Promise<BusinessDTO[]> {
  const uid = toUserId(userId);
  const memberships = await BusinessMemberTable.where((m) => m.userId.eq(uid))
    .select("businessId")
    .all();
  const out: BusinessDTO[] = [];
  for (const m of memberships) {
    const row = await BusinessTable.where({ id: m.businessId })
      .select("id", "name", "ownerId", "status", "createdAt", "updatedAt")
      .first();
    if (row && row.status !== "SUSPENDED") out.push(toBusinessDTO(row));
  }
  return out;
}

/**
 * Fetch a business ONLY if `userId` is a member. Returns null for missing
 * businesses AND for non-members (callers map both to 404/403 without
 * distinguishing, so membership can't be probed).
 */
export async function getBusinessForMember(
  userId: string,
  businessId: string
): Promise<BusinessDTO | null> {
  const membership = await findMembership(userId, businessId);
  if (!membership) return null;
  const row = await BusinessTable.where({ id: toDbId(membership.businessId) })
    .select("id", "name", "ownerId", "status", "createdAt", "updatedAt")
    .first();
  return row ? toBusinessDTO(row) : null;
}

/** Membership lookup — the single choke point for workspace access. */
export async function findMembership(
  userId: string,
  businessId: string
): Promise<MembershipDTO | null> {
  let bid: BusinessId;
  try {
    bid = toBusinessId(businessId);
  } catch {
    return null;
  }
  const uid = toUserId(userId);
  const row = await BusinessMemberTable.where((m) => m.businessId.eq(bid))
    .where((m) => m.userId.eq(uid))
    .select("id", "businessId", "userId", "role", "createdAt", "updatedAt")
    .first();
  if (!row) return null;
  return toMembershipDTO(row);
}

export async function listMembers(businessId: string): Promise<MembershipDTO[]> {
  const bid = toBusinessId(businessId);
  const rows = await BusinessMemberTable.where((m) => m.businessId.eq(bid))
    .select("id", "businessId", "userId", "role", "createdAt", "updatedAt")
    .all();
  const out: MembershipDTO[] = [];
  for (const r of rows) {
    const dto = toMembershipDTO(r);
    if (dto) out.push(dto);
  }
  return out;
}

export async function countOwners(businessId: string): Promise<number> {
  const bid = toBusinessId(businessId);
  const rows = await BusinessMemberTable.where((m) => m.businessId.eq(bid))
    .where((m) => m.role.eq("OWNER"))
    .select("id")
    .all();
  return rows.length;
}
