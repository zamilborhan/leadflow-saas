/**
 * Platform-wide lead + team directories (super-admin only).
 * Server-side search/filter/sort/pagination — never loads all rows to the browser.
 */
import { BusinessMemberTable, BusinessTable, LeadTable, UserTable } from "../../prisma/tables";
import { allOrEmpty } from "./query";
import { toBusinessId, toDbId } from "../tenancy/businesses";

export interface AdminLeadRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  source: string | null;
  businessId: string;
  businessName: string | null;
  assignedTo: string | null;
  assigneeEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminLeadPage {
  leads: AdminLeadRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AdminMemberRow {
  id: string;
  userId: string;
  email: string | null;
  businessId: string;
  businessName: string | null;
  role: string;
  createdAt: string;
}

export interface AdminMemberPage {
  members: AdminMemberRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function pageOf(page?: number, pageSize?: number): { page: number; pageSize: number } {
  const p = Number.isFinite(page) && (page as number) >= 1 ? Math.floor(page as number) : 1;
  const ps =
    Number.isFinite(pageSize) && (pageSize as number) >= 1
      ? Math.min(100, Math.floor(pageSize as number))
      : 20;
  return { page: p, pageSize: ps };
}

const LEAD_FIELDS = [
  "id",
  "businessId",
  "name",
  "email",
  "phone",
  "status",
  "source",
  "assignedTo",
  "createdAt",
  "updatedAt",
] as const;

async function businessNameOf(businessId: string): Promise<string | null> {
  try {
    const row = await BusinessTable.where({ id: toDbId(businessId) }).select("id", "name").first();
    return row && row.id === businessId ? row.name : null;
  } catch {
    return null;
  }
}

async function userEmailOf(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const rows = await allOrEmpty(UserTable.select("id", "email").all());
    return rows.find((r) => r.id === userId)?.email ?? null;
  } catch {
    return null;
  }
}

/** Platform lead directory with server-side search + filters. */
export async function listLeadsAdmin(query?: {
  search?: string;
  businessId?: string;
  status?: string;
  source?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminLeadPage> {
  const needle = (query?.search ?? "").trim().toLowerCase();
  const { page, pageSize } = pageOf(query?.page, query?.pageSize);
  let scoped: string | null = null;
  if (query?.businessId) {
    try {
      scoped = toBusinessId(query.businessId);
    } catch {
      return { leads: [], total: 0, page: 1, pageSize, totalPages: 1 };
    }
  }

  const rows = await LeadTable.select(...LEAD_FIELDS).all();
  const matched = rows.filter((r) => {
    if (scoped && r.businessId !== query?.businessId) return false;
    if (query?.status && r.status !== query.status) return false;
    if (query?.source && (r.source ?? "") !== query.source) return false;
    if (needle) {
      const hay = `${r.name} ${r.email ?? ""} ${r.phone ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  matched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const leads: AdminLeadRow[] = [];
  for (const r of matched.slice((safePage - 1) * pageSize, safePage * pageSize)) {
    const [businessName, assigneeEmail] = await Promise.all([
      businessNameOf(r.businessId),
      userEmailOf(r.assignedTo),
    ]);
    leads.push({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      status: r.status,
      source: r.source,
      businessId: r.businessId,
      businessName,
      assignedTo: r.assignedTo,
      assigneeEmail,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  }
  return { leads, total, page: safePage, pageSize, totalPages };
}

/** Platform membership directory (inspect relationships, no privilege changes here). */
export async function listMembersAdmin(query?: {
  search?: string;
  role?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminMemberPage> {
  const needle = (query?.search ?? "").trim().toLowerCase();
  const { page, pageSize } = pageOf(query?.page, query?.pageSize);
  const [memberships, users, businesses] = await Promise.all([
    allOrEmpty(BusinessMemberTable.select("id", "businessId", "userId", "role", "createdAt").all()),
    allOrEmpty(UserTable.select("id", "email").all()),
    allOrEmpty(BusinessTable.select("id", "name").all()),
  ]);
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  const nameById = new Map(businesses.map((b) => [b.id, b.name]));

  const matched = memberships.filter((m) => {
    if (query?.role && m.role !== query.role) return false;
    if (needle) {
      const hay = `${emailById.get(m.userId) ?? ""} ${nameById.get(m.businessId) ?? ""} ${m.role}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  matched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const members: AdminMemberRow[] = matched
    .slice((safePage - 1) * pageSize, safePage * pageSize)
    .map((m) => ({
      id: m.id,
      userId: m.userId,
      email: emailById.get(m.userId) ?? null,
      businessId: m.businessId,
      businessName: nameById.get(m.businessId) ?? null,
      role: m.role,
      createdAt: m.createdAt,
    }));
  return { members, total, page: safePage, pageSize, totalPages };
}
