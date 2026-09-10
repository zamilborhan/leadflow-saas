/**
 * Authorization policies — the enforcement layer between the workspace
 * context and tenant-owned resources.
 *
 * Two error classes with distinct HTTP mappings:
 * - `TenantAccessDenied` (403): caller is authenticated but lacks membership
 *   or the role permission for this workspace. No resource data is included.
 * - `TenantNotFound` (404): a tenant-scoped resource was not found *within
 *   the caller's workspace. Cross-tenant ids map here so Business B cannot
 *   distinguish "Lead A doesn't exist" from "Lead A belongs to Business A".
 */

import type { BusinessContext } from "./context";
import { canManageMember, hasPermission, type PermissionCode, type WorkspaceRole } from "./roles";

export class TenantAccessDenied extends Error {
  constructor(message = "Access denied for this business.") {
    super(message);
    this.name = "TenantAccessDenied";
  }
}

export class TenantNotFound extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.name = "TenantNotFound";
  }
}

/** State conflict within the workspace (e.g. completing a cancelled follow-up). Maps to 409. */
export class TenantConflict extends Error {
  constructor(message = "Conflicting state.") {
    super(message);
    this.name = "TenantConflict";
  }
}

/**
 * Subscription quota exceeded (monthly lead cap, team size, workspace
 * count) or inactive subscription. Maps to 402. Thrown only from
 * server-side gates that re-read current usage — never from client input
 * — so crafted requests cannot bypass plan limits.
 */
export class TenantLimitExceeded extends Error {
  constructor(message = "Plan limit reached.") {
    super(message);
    this.name = "TenantLimitExceeded";
  }
}

/** Throw unless the context role grants `permission`. */
export function requirePermission(context: BusinessContext, permission: PermissionCode): void {
  if (!hasPermission(context.membership.role, permission)) {
    throw new TenantAccessDenied(`Role ${context.membership.role} cannot ${permission}.`);
  }
}

/** Throw unless the context role is one of `roles`. */
export function requireRole(context: BusinessContext, ...roles: WorkspaceRole[]): void {
  if (!roles.includes(context.membership.role)) {
    throw new TenantAccessDenied(`Requires one of: ${roles.join(", ")}.`);
  }
}

/** Throw unless `actor` may manage a member holding `targetRole`. */
export function requireCanManageMember(
  context: BusinessContext,
  targetRole: WorkspaceRole,
  nextRole?: WorkspaceRole
): void {
  if (!canManageMember(context.membership.role, targetRole, nextRole)) {
    throw new TenantAccessDenied("Your role cannot manage this member.");
  }
}

/**
 * Assert a tenant-owned row belongs to the context workspace. Rows carry
 * `businessId`; any mismatch means cross-tenant access and maps to 404 so
 * the caller learns nothing about the foreign row.
 */
export function assertSameBusiness(
  context: BusinessContext,
  rowBusinessId: string | undefined | null
): void {
  if (!rowBusinessId || rowBusinessId !== context.business.id) {
    throw new TenantNotFound();
  }
}
