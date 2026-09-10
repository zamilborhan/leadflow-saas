/**
 * Workspace roles + permission matrix.
 *
 * Framework-free and dependency-free: safe to import from unit tests via
 * Node type-stripping. The database-backed `Role` / `Permission` tables
 * mirror this static catalog (see `ensureRoleSeeds` in seeds.ts); the
 * matrix below is the enforcement source of truth so authorization never
 * depends on seed state.
 */

export const ROLES = ["OWNER", "ADMIN", "SALES"] as const;
export type WorkspaceRole = (typeof ROLES)[number];

export const PERMISSIONS = [
  "businesses.read",
  "businesses.update",
  "businesses.delete",
  "members.read",
  "members.invite",
  "members.update",
  "members.remove",
  "leads.read",
  "leads.create",
  "leads.update",
  "leads.delete",
  "leads.assign",
  "followups.read",
  "followups.create",
  "followups.update",
  "followups.delete",
  "whatsapp.send",
  "automations.manage",
  "notifications.read",
] as const;
export type PermissionCode = (typeof PERMISSIONS)[number];

const ALL: PermissionCode[] = [...PERMISSIONS];

/**
 * Which permissions each workspace role grants.
 * OWNER > ADMIN > SALES. SALES is the least-privileged daily-driver role:
 * full lead workflow except delete/assign, read-only everything else.
 */
export const ROLE_PERMISSIONS: Record<WorkspaceRole, readonly PermissionCode[]> = {
  OWNER: ALL,
  ADMIN: [
    "businesses.read",
    "businesses.update",
    "members.read",
    "members.invite",
    "members.update",
    "members.remove",
    "leads.read",
    "leads.create",
    "leads.update",
    "leads.delete",
    "leads.assign",
    "followups.read",
    "followups.create",
    "followups.update",
    "followups.delete",
    "whatsapp.send",
    "automations.manage",
    "notifications.read",
  ],
  SALES: [
    "businesses.read",
    "members.read",
    "leads.read",
    "leads.create",
    "leads.update",
    "followups.read",
    "followups.create",
    "followups.update",
    "whatsapp.send",
    "notifications.read",
  ],
};

const RANK: Record<WorkspaceRole, number> = { OWNER: 3, ADMIN: 2, SALES: 1 };

export function isValidRole(role: unknown): role is WorkspaceRole {
  return typeof role === "string" && (ROLES as readonly string[]).includes(role);
}

export function isValidPermission(code: unknown): code is PermissionCode {
  return typeof code === "string" && (PERMISSIONS as readonly string[]).includes(code);
}

/** Pure policy check: does `role` grant `permission`? */
export function hasPermission(role: WorkspaceRole, permission: PermissionCode): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Rank comparison for management rules (higher rank manages lower). */
export function roleOutranks(a: WorkspaceRole, b: WorkspaceRole): boolean {
  return RANK[a] > RANK[b];
}

/**
 * Can `actorRole` change/remove a member currently holding `targetRole`,
 * optionally assigning `nextRole`?
 * - OWNER can do anything (including demoting themselves — caller must guard
 *   last-owner removal separately).
 * - ADMIN can manage ADMIN/SALES members but never touch an OWNER, and can
 *   never grant OWNER.
 * - SALES can manage nobody.
 */
export function canManageMember(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  nextRole?: WorkspaceRole
): boolean {
  if (actorRole === "OWNER") return true;
  if (actorRole !== "ADMIN") return false;
  if (targetRole === "OWNER") return false;
  if (nextRole === "OWNER") return false;
  return true;
}

/** Roles `actorRole` is allowed to invite/assign. */
export function assignableRoles(actorRole: WorkspaceRole): readonly WorkspaceRole[] {
  if (actorRole === "OWNER") return ROLES;
  if (actorRole === "ADMIN") return ["ADMIN", "SALES"];
  return [];
}
