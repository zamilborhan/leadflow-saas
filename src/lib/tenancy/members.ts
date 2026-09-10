/**
 * Workspace member management. Every mutation is authorized against the
 * caller's verified BusinessContext — never against client-supplied roles.
 */
import { BusinessMemberTable } from "../../prisma/tables";
import { findUserByEmail, findUserById, toUserId } from "../auth/users";
import {
  countOwners,
  findMembership,
  listMembers,
  listUserBusinesses,
  toBusinessId,
  toDbId,
  type BusinessDTO,
  type MembershipDTO,
} from "./businesses";
import { resolveBusinessContext, type BusinessContext } from "./context";
import { requireCanManageMember, requirePermission, TenantAccessDenied } from "./policies";
import { assignableRoles, canManageMember, hasPermission, isValidRole, type WorkspaceRole } from "./roles";
import { assertMemberQuota } from "../billing/subscriptions";

export async function inviteMember(
  context: BusinessContext,
  email: string,
  role: WorkspaceRole
): Promise<MembershipDTO> {
  requirePermission(context, "members.invite");
  if (!assignableRoles(context.membership.role).includes(role)) {
    throw new TenantAccessDenied(`Role ${context.membership.role} cannot invite ${role}.`);
  }
  const user = await findUserByEmail(email.trim().toLowerCase());
  if (!user) throw new TenantAccessDenied("No account exists for this email.");
  const existing = await findMembership(user.id, context.business.id);
  if (existing) throw new TenantAccessDenied("User is already a member of this business.");
  // Server-side quota: re-read live member count — request fields cannot
  // influence the outcome.
  await assertMemberQuota(context.business.id);
  const row = await BusinessMemberTable.select(
    "id",
    "businessId",
    "userId",
    "role",
    "createdAt",
    "updatedAt"
  ).create({
    businessId: toBusinessId(context.business.id),
    userId: toUserId(user.id),
    role,
  });
  if (!isValidRole(row.role)) throw new TenantAccessDenied("Invalid role.");
  return {
    id: row.id,
    businessId: row.businessId,
    userId: row.userId,
    role: row.role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function updateMemberRole(
  context: BusinessContext,
  targetUserId: string,
  nextRole: WorkspaceRole
): Promise<MembershipDTO | null> {
  requirePermission(context, "members.update");
  const target = await findMembership(targetUserId, context.business.id);
  if (!target) return null;
  requireCanManageMember(context, target.role, nextRole);
  // Guard the last OWNER: never leave a business ownerless.
  if (target.role === "OWNER" && nextRole !== "OWNER") {
    const owners = await countOwners(context.business.id);
    if (owners <= 1) throw new TenantAccessDenied("Cannot demote the last owner.");
  }
  await BusinessMemberTable.where({ id: toDbId(target.id) }).update({ role: nextRole });
  const refreshed = await findMembership(targetUserId, context.business.id);
  return refreshed;
}

export async function removeMember(
  context: BusinessContext,
  targetUserId: string
): Promise<boolean> {
  requirePermission(context, "members.remove");
  const target = await findMembership(targetUserId, context.business.id);
  if (!target) return false;
  requireCanManageMember(context, target.role);
  if (target.role === "OWNER") {
    const owners = await countOwners(context.business.id);
    if (owners <= 1) throw new TenantAccessDenied("Cannot remove the last owner.");
  }
  // Single-row delete semantics: delete the exact membership row.
  await BusinessMemberTable.where({ id: toDbId(target.id) }).delete();
  return true;
}

export interface TeamMemberDTO extends MembershipDTO {
  email: string;
  name: string | null;
  status: string;
  /** Caller may change this member's role (update perm + rank rule). */
  canChangeRole: boolean;
  /** Caller may remove this member (remove perm + rank rule). */
  canRemove: boolean;
  /** Roles the caller may assign to this member. */
  allowedRoles: WorkspaceRole[];
}

export interface TeamRoster {
  business: BusinessDTO;
  membership: MembershipDTO;
  callerRole: WorkspaceRole;
  canInvite: boolean;
  members: TeamMemberDTO[];
}

export type RosterResult = { ok: true; roster: TeamRoster } | { ok: false; reason: "no-business" };

/**
 * Load the team roster for (`callerUserId`, `requestedBusinessId?`).
 * Falls back to the caller's first business when the requested workspace
 * is missing or foreign — never leaks another tenant's roster.
 */
export async function getTeamRoster(
  callerUserId: string,
  requestedBusinessId?: string | null
): Promise<RosterResult> {
  const businesses = await listUserBusinesses(callerUserId);
  if (businesses.length === 0) return { ok: false, reason: "no-business" };

  let resolved = requestedBusinessId
    ? await resolveBusinessContext(callerUserId, requestedBusinessId)
    : { ok: false as const, reason: "no-membership" as const };
  if (!resolved.ok) {
    const retry = await resolveBusinessContext(callerUserId, businesses[0].id);
    if (!retry.ok) return { ok: false, reason: "no-business" };
    resolved = retry;
  }

  const { business, membership } = resolved.context;
  requirePermission(resolved.context, "members.read");

  const rows = await listMembers(business.id);
  const members: TeamMemberDTO[] = [];
  for (const row of rows) {
    const user = await findUserById(row.userId).catch(() => null);
    const manageable = canManageMember(membership.role, row.role);
    const allowed = assignableRoles(membership.role).filter((r) =>
      canManageMember(membership.role, row.role, r)
    );
    members.push({
      ...row,
      email: user?.email ?? "Unknown user",
      name: user?.name ?? null,
      status: user?.status ?? "UNKNOWN",
      canChangeRole:
        hasPermission(membership.role, "members.update") && manageable && allowed.length > 0,
      canRemove: hasPermission(membership.role, "members.remove") && manageable,
      allowedRoles: allowed,
    });
  }
  // Stable order: owners first, then admins, then sales, then by email.
  const rank: Record<WorkspaceRole, number> = { OWNER: 0, ADMIN: 1, SALES: 2 };
  members.sort((a, b) => rank[a.role] - rank[b.role] || a.email.localeCompare(b.email));

  return {
    ok: true,
    roster: {
      business,
      membership,
      callerRole: membership.role,
      canInvite:
        hasPermission(membership.role, "members.invite") &&
        assignableRoles(membership.role).length > 0,
      members,
    },
  };
}
