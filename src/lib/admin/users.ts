/**
 * Platform user directory (super-admin only).
 *
 * Reads bypass workspace membership — authorization comes from
 * `requireSuperAdmin`. Email/name come from the users table; workspace
 * memberships resolve per user. Password hashes are never selected.
 */
import { BusinessMemberTable, BusinessTable, UserTable } from "../../prisma/tables";
import { findUserById, toUserId } from "../auth/users";
import { toDbId } from "../tenancy/businesses";

export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  businessCount: number;
  createdAt: string;
}

export interface AdminUserPage {
  users: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AdminUserDetail extends AdminUserRow {
  businesses: Array<{ businessId: string; businessName: string | null; role: string }>;
}

const USER_FIELDS = ["id", "email", "name", "status", "createdAt", "updatedAt"] as const;

async function businessCountFor(userId: string): Promise<number> {
  const uid = toUserId(userId);
  const rows = await Promise.resolve(
    BusinessMemberTable.where((m) => m.userId.eq(uid))
      .select("id")
      .all()
  ).catch(() => [] as Array<{ id: string }>);
  return rows.length;
}

/** Platform user directory with workspace counts. Search matches email/name. */
export async function listUsersAdmin(query?: {
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminUserPage> {
  const needle = (query?.search ?? "").trim().toLowerCase();
  const page = Number.isFinite(query?.page) && (query?.page as number) >= 1 ? Math.floor(query?.page as number) : 1;
  const pageSize =
    Number.isFinite(query?.pageSize) && (query?.pageSize as number) >= 1
      ? Math.min(100, Math.floor(query?.pageSize as number))
      : 20;

  const rows = await UserTable.select(...USER_FIELDS).all();
  const matched = rows.filter((r) => {
    if (needle.length === 0) return true;
    return `${r.email} ${r.name ?? ""}`.toLowerCase().includes(needle);
  });
  matched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const users: AdminUserRow[] = [];
  for (const row of matched.slice((safePage - 1) * pageSize, safePage * pageSize)) {
    users.push({
      id: row.id,
      email: row.email,
      name: row.name,
      status: row.status,
      businessCount: await businessCountFor(row.id),
      createdAt: row.createdAt,
    });
  }
  return { users, total, page: safePage, pageSize, totalPages };
}

/** Single user with workspace memberships. Unknown ids → null (→ 404). */
export async function getUserAdmin(userId: string): Promise<AdminUserDetail | null> {
  let uid;
  try {
    uid = toUserId(userId);
  } catch {
    return null;
  }
  const user = await findUserById(uid).catch(() => null);
  if (!user || user.id !== userId) return null;
  const memberships = await Promise.resolve(
    BusinessMemberTable.where((m) => m.userId.eq(uid))
      .select("businessId", "role")
      .all()
  ).catch(() => [] as Array<{ businessId: string; role: string }>);
  const businesses: AdminUserDetail["businesses"] = [];
  for (const m of memberships) {
    let name: string | null = null;
    try {
      const biz = await BusinessTable.where({ id: toDbId(m.businessId) })
        .select("id", "name")
        .first();
      if (biz && biz.id === m.businessId) name = biz.name;
    } catch {
      name = null;
    }
    businesses.push({ businessId: m.businessId, businessName: name, role: m.role });
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    businessCount: memberships.length,
    createdAt: user.createdAt,
    businesses,
  };
}
