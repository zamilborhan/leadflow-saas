/**
 * Static Role / Permission catalog seeding.
 *
 * The `Role` / `Permission` / `RolePermission` tables mirror the static
 * matrix in `roles.ts` for introspection/admin UIs. Enforcement never reads
 * these tables (see roles.ts) so a missing seed can't open access — but we
 * seed them anyway so the data model requirement is fully realized.
 */
import { PermissionTable, RolePermissionTable, RoleTable } from "../../prisma/tables";
import { toDbId } from "./businesses";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "./roles";

const ROLE_DESCRIPTIONS: Record<string, string> = {
  OWNER: "Business owner. Full control including deleting the business.",
  ADMIN: "Workspace admin. Manages team and all leads, cannot delete the business.",
  SALES: "Sales agent. Works leads, read-only everything else.",
};

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  "businesses.read": "View business workspace details.",
  "businesses.update": "Update business workspace details.",
  "businesses.delete": "Delete the business workspace.",
  "members.read": "List workspace members.",
  "members.invite": "Invite new members.",
  "members.update": "Change member roles.",
  "members.remove": "Remove members.",
  "leads.read": "View leads.",
  "leads.create": "Create leads.",
  "leads.update": "Update leads.",
  "leads.delete": "Delete leads.",
  "leads.assign": "Assign leads to agents.",
  "followups.read": "View follow-ups.",
  "followups.create": "Schedule follow-ups.",
  "followups.update": "Complete, cancel, or reschedule follow-ups.",
  "followups.delete": "Delete follow-ups.",
  "whatsapp.send": "Send WhatsApp template messages.",
  "automations.manage": "Manage automation rules and retry automation jobs.",
  "notifications.read": "View in-app notifications.",
};

/** Idempotent: creates missing Role / Permission / RolePermission rows. */
export async function ensureRoleSeeds(): Promise<void> {
  const roleIdByName = new Map<string, string>();
  for (const name of ROLES) {
    const existing = await RoleTable.where({ name }).select("id").first();
    if (existing) {
      roleIdByName.set(name, existing.id);
      continue;
    }
    const created = await RoleTable.select("id").create({
      name,
      description: ROLE_DESCRIPTIONS[name] ?? null,
    });
    roleIdByName.set(name, created.id);
  }

  const permIdByCode = new Map<string, string>();
  for (const code of PERMISSIONS) {
    const existing = await PermissionTable.where({ code }).select("id").first();
    if (existing) {
      permIdByCode.set(code, existing.id);
      continue;
    }
    const created = await PermissionTable.select("id").create({
      code,
      description: PERMISSION_DESCRIPTIONS[code] ?? null,
    });
    permIdByCode.set(code, created.id);
  }

  for (const role of ROLES) {
    const roleId = toDbId(roleIdByName.get(role)!);
    for (const code of ROLE_PERMISSIONS[role]) {
      const permissionId = toDbId(permIdByCode.get(code)!);
      const existing = await RolePermissionTable.where((r) => r.roleId.eq(roleId))
        .select("id", "permissionId")
        .all();
      if (existing.some((r) => r.permissionId === permissionId)) continue;
      await RolePermissionTable.create({ roleId, permissionId });
    }
  }
}
