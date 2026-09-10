/**
 * Platform business directory + moderation (super-admin only).
 *
 * Reads bypass workspace membership entirely — authorization comes from
 * `requireSuperAdmin` at the route/layout layer, never from a
 * BusinessContext. Suspend/reactivate flips the `Business.status` flag
 * that `resolveBusinessContext`, webhooks, and the worker enforce.
 */
import {
  BusinessMemberTable,
  BusinessTable,
  LeadTable,
  SubscriptionTable,
} from "../../prisma/tables";
import { findUserById } from "../auth/users";
import { toBusinessId, toDbId } from "../tenancy/businesses";
import { countMembers, countPeriodLeads, getSubscription } from "../billing/subscriptions";
import type { PlanCode } from "../billing/catalog";

export type BusinessStatusFilter = "all" | "ACTIVE" | "SUSPENDED";

export interface AdminBusinessRow {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail: string | null;
  status: string;
  planCode: string;
  subscriptionStatus: string;
  memberCount: number;
  leadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminBusinessPage {
  businesses: AdminBusinessRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AdminBusinessDetail extends AdminBusinessRow {
  members: Array<{ userId: string; email: string | null; role: string }>;
  renewalDate: string | null;
}

const BUSINESS_FIELDS = ["id", "name", "ownerId", "status", "createdAt", "updatedAt"] as const;

type BusinessRow = {
  id: string;
  name: string;
  ownerId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

async function subscriptionOf(
  businessId: string
): Promise<{ planCode: string; status: string; currentPeriodEnd: string } | null> {
  const bid = toBusinessId(businessId);
  const rows = await SubscriptionTable.where((s) => s.businessId.eq(bid))
    .select("businessId", "planCode", "status", "currentPeriodEnd")
    .all();
  const match = rows.find((r) => r.businessId === businessId) ?? null;
  return match ? { planCode: match.planCode, status: match.status, currentPeriodEnd: match.currentPeriodEnd } : null;
}

async function toAdminRow(row: BusinessRow): Promise<AdminBusinessRow> {
  const [owner, sub, members, leads] = await Promise.all([
    findUserById(row.ownerId).catch(() => null),
    subscriptionOf(row.id).catch(() => null),
    Promise.resolve(
      BusinessMemberTable.where((m) => m.businessId.eq(toBusinessId(row.id)))
        .select("id")
        .all()
    ).catch(() => [] as Array<{ id: string }>),
    Promise.resolve(
      LeadTable.where((l) => l.businessId.eq(toBusinessId(row.id)))
        .select("id")
        .all()
    ).catch(() => [] as Array<{ id: string }>),
  ]);
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    ownerEmail: owner?.email ?? null,
    status: row.status,
    planCode: sub?.planCode ?? "FREE",
    subscriptionStatus: sub?.status ?? "NONE",
    memberCount: members.length,
    leadCount: leads.length,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeStatusFilter(value: unknown): BusinessStatusFilter {
  return value === "ACTIVE" || value === "SUSPENDED" ? value : "all";
}

/**
 * Platform business directory. `search` matches name or owner email
 * (case-insensitive); `status` narrows to ACTIVE/SUSPENDED.
 */
export async function listBusinessesAdmin(query?: {
  search?: string;
  status?: unknown;
  page?: number;
  pageSize?: number;
}): Promise<AdminBusinessPage> {
  const needle = (query?.search ?? "").trim().toLowerCase();
  const status = normalizeStatusFilter(query?.status);
  const page = Number.isFinite(query?.page) && (query?.page as number) >= 1 ? Math.floor(query?.page as number) : 1;
  const pageSize =
    Number.isFinite(query?.pageSize) && (query?.pageSize as number) >= 1
      ? Math.min(100, Math.floor(query?.pageSize as number))
      : 20;

  const rows = await BusinessTable.select(...BUSINESS_FIELDS).all();
  const matched: BusinessRow[] = [];
  for (const row of rows) {
    if (status !== "all" && row.status !== status) continue;
    if (needle.length > 0) {
      const owner = await findUserById(row.ownerId).catch(() => null);
      const haystack = `${row.name} ${owner?.email ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    matched.push(row);
  }
  matched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const slice = matched.slice((safePage - 1) * pageSize, safePage * pageSize);
  const businesses: AdminBusinessRow[] = [];
  for (const row of slice) {
    businesses.push(await toAdminRow(row));
  }
  return { businesses, total, page: safePage, pageSize, totalPages };
}

/** Single workspace with members + renewal. Unknown ids → null (→ 404). */
export async function getBusinessAdmin(businessId: string): Promise<AdminBusinessDetail | null> {
  let bid;
  try {
    bid = toBusinessId(businessId);
  } catch {
    return null;
  }
  const row = await BusinessTable.where({ id: bid })
    .select(...BUSINESS_FIELDS)
    .first();
  if (!row || row.id !== businessId) return null;
  const base = await toAdminRow(row);
  const [members, sub] = await Promise.all([
    Promise.resolve(
      BusinessMemberTable.where((m) => m.businessId.eq(bid))
        .select("userId", "role")
        .all()
    ).catch(() => [] as Array<{ userId: string; role: string }>),
    subscriptionOf(businessId).catch(() => null),
  ]);
  const enriched = [];
  for (const m of members) {
    const user = await findUserById(m.userId).catch(() => null);
    enriched.push({ userId: m.userId, email: user?.email ?? null, role: m.role });
  }
  return { ...base, members: enriched, renewalDate: sub?.currentPeriodEnd ?? null };
}

export type BusinessModeration = "ACTIVE" | "SUSPENDED";

/**
 * Suspend or reactivate a workspace. Suspension flips the flag that member
 * routes, pages, webhooks, and the worker enforce — members keep their
 * rows but lose all access until reactivation. Unknown ids → null.
 */
export async function setBusinessStatus(
  businessId: string,
  status: BusinessModeration
): Promise<AdminBusinessRow | null> {
  let bid;
  try {
    bid = toBusinessId(businessId);
  } catch {
    return null;
  }
  const existing = await BusinessTable.where({ id: bid })
    .select(...BUSINESS_FIELDS)
    .first();
  if (!existing || existing.id !== businessId) return null;
  if (existing.status !== status) {
    await BusinessTable.where({ id: toDbId(existing.id) }).update({ status } as never);
  }
  const refreshed = await BusinessTable.where({ id: bid })
    .select(...BUSINESS_FIELDS)
    .first();
  if (!refreshed) return null;
  return toAdminRow(refreshed);
}

/**
 * Platform plan/status change. Unlike the owner-driven
 * `changeSubscription`, this path carries no membership requirement —
 * the caller must hold super-admin authorization. A plan change anchors
 * a fresh monthly cycle via the shared billing helper.
 */
export async function adminChangeSubscription(
  businessId: string,
  patch: { planCode?: PlanCode; status?: string }
): Promise<{ planCode: string; status: string } | null> {
  const { changeSubscriptionAsSystem } = await import("../billing/subscriptions");
  const { isValidSubscriptionStatus } = await import("../billing/catalog");
  if (patch.status !== undefined && !isValidSubscriptionStatus(patch.status)) return null;
  return changeSubscriptionAsSystem(businessId, {
    ...(patch.planCode !== undefined ? { planCode: patch.planCode } : {}),
    ...(patch.status !== undefined && isValidSubscriptionStatus(patch.status) ? { status: patch.status } : {}),
  });
}

/** Usage snapshot for the admin detail view (best-effort, never throws). */
export async function getBusinessUsageAdmin(
  businessId: string
): Promise<{ leadsThisPeriod: number; members: number } | null> {
  try {
    const sub = await getSubscription(businessId).catch(() => null);
    const [leads, members] = await Promise.all([
      sub ? countPeriodLeads(businessId, sub.currentPeriodStart).catch(() => 0) : Promise.resolve(0),
      countMembers(businessId).catch(() => 0),
    ]);
    return { leadsThisPeriod: leads, members };
  } catch {
    return null;
  }
}
