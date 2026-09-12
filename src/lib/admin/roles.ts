/**
 * Scalable super-admin permission model (server-only).
 *
 * Roles:
 *   SUPER_ADMIN  — all permissions (platform owner).
 *   ADMIN        — all permissions except settings.manage + security.view.
 *   SUPPORT_ADMIN — read customers + manage support/notifications.
 *   BILLING_ADMIN — billing + plans + subscriptions.
 *   ANALYST      — read-only analytics.
 *
 * Assignment (no DB migration required):
 *   SUPER_ADMIN_EMAILS env → SUPER_ADMIN.
 *   ADMIN_EMAILS / SUPPORT_ADMIN_EMAILS / BILLING_ADMIN_EMAILS /
 *   ANALYST_EMAILS env (optional, comma-separated) → respective role.
 *   Anyone else allowlisted nowhere → no platform access.
 *
 * Workspace roles (OWNER/ADMIN/SALES) never confer platform access.
 * Every check runs server-side via getCurrentUser() + verified email.
 */

export const ADMIN_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "SUPPORT_ADMIN",
  "BILLING_ADMIN",
  "ANALYST",
] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const PERMISSIONS = [
  "users.view",
  "users.manage",
  "workspaces.view",
  "workspaces.manage",
  "leads.view",
  "leads.manage",
  "billing.view",
  "billing.manage",
  "plans.view",
  "plans.manage",
  "analytics.view",
  "integrations.view",
  "integrations.manage",
  "support.view",
  "support.manage",
  "notifications.manage",
  "audit_logs.view",
  "security.view",
  "settings.manage",
] as const;
export type AdminPermission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  ADMIN: [
    "users.view",
    "users.manage",
    "workspaces.view",
    "workspaces.manage",
    "leads.view",
    "leads.manage",
    "billing.view",
    "plans.view",
    "analytics.view",
    "integrations.view",
    "integrations.manage",
    "support.view",
    "support.manage",
    "notifications.manage",
    "audit_logs.view",
  ],
  SUPPORT_ADMIN: [
    "users.view",
    "workspaces.view",
    "leads.view",
    "support.view",
    "support.manage",
    "notifications.manage",
    "analytics.view",
  ],
  BILLING_ADMIN: [
    "users.view",
    "workspaces.view",
    "billing.view",
    "billing.manage",
    "plans.view",
    "plans.manage",
    "analytics.view",
  ],
  ANALYST: ["analytics.view", "users.view", "workspaces.view", "leads.view", "billing.view", "plans.view"],
};

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const e = part.trim().toLowerCase();
    if (e) seen.add(e);
  }
  return [...seen];
}

/** Resolve the platform role for an email. Null = no platform access. */
export function getAdminRoleForEmail(email: string | null | undefined): AdminRole | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  if (parseList(process.env["SUPER_ADMIN_EMAILS"]).includes(normalized)) return "SUPER_ADMIN";
  if (parseList(process.env["ADMIN_EMAILS"]).includes(normalized)) return "ADMIN";
  if (parseList(process.env["SUPPORT_ADMIN_EMAILS"]).includes(normalized)) return "SUPPORT_ADMIN";
  if (parseList(process.env["BILLING_ADMIN_EMAILS"]).includes(normalized)) return "BILLING_ADMIN";
  if (parseList(process.env["ANALYST_EMAILS"]).includes(normalized)) return "ANALYST";
  return null;
}

export function hasPermission(role: AdminRole | null | undefined, permission: AdminPermission): boolean {
  if (!role) return false;
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

/** Navigation visibility: at least one of the permissions is granted. */
export function canSee(role: AdminRole | null | undefined, permissions: readonly AdminPermission[]): boolean {
  if (!role) return false;
  return permissions.some((p) => hasPermission(role, p));
}
