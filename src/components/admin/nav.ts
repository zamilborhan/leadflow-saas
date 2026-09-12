/**
 * Super-admin navigation (server-only config).
 *
 * Deliberately flat and short: 8 items, no nesting. Each item names the
 * permission required to see it; SUPER_ADMIN sees everything. Advanced
 * sections (analytics, leads, billing, integrations, audit, health, …)
 * remain reachable from their parent pages — they are just not in the
 * primary nav, keeping the sidebar compact and fast to scan.
 */
import type { AdminPermission } from "@/src/lib/admin/roles";

export interface AdminNavItem {
  label: string;
  href: string;
  permission: AdminPermission;
}

export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { label: "Dashboard", href: "/admin", permission: "analytics.view" },
  { label: "Users", href: "/admin/users", permission: "users.view" },
  { label: "Workspaces", href: "/admin/businesses", permission: "workspaces.view" },
  { label: "Subscriptions", href: "/admin/subscriptions", permission: "billing.view" },
  { label: "Plans", href: "/admin/plans", permission: "plans.view" },
  { label: "Payments", href: "/admin/payments", permission: "billing.view" },
  { label: "Activity", href: "/admin/activity", permission: "audit_logs.view" },
  { label: "Settings", href: "/admin/settings", permission: "settings.manage" },
];
