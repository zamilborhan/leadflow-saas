/**
 * Platform subscription directory (super-admin only).
 *
 * Reads bypass workspace membership — authorization comes from
 * `requireSuperAdmin`. Joins subscription rows with business names for
 * admin triage; plan pricing comes from the static catalog.
 */
import { BusinessTable, SubscriptionTable } from "../../prisma/tables";
import { toBusinessId, toDbId } from "../tenancy/businesses";
import { PLANS, isValidPlanCode, type PlanCode } from "../billing/catalog";

export interface AdminSubscriptionRow {
  businessId: string;
  businessName: string | null;
  businessStatus: string | null;
  planCode: string;
  planName: string;
  status: string;
  billingCycle: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSubscriptionPage {
  subscriptions: AdminSubscriptionRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const SUB_FIELDS = [
  "businessId",
  "planCode",
  "status",
  "billingCycle",
  "currentPeriodStart",
  "currentPeriodEnd",
  "createdAt",
  "updatedAt",
] as const;

async function businessInfo(businessId: string): Promise<{ name: string | null; status: string | null }> {
  try {
    const row = await BusinessTable.where({ id: toDbId(businessId) })
      .select("id", "name", "status")
      .first();
    if (row && row.id === businessId) return { name: row.name, status: row.status };
  } catch {
    // best-effort
  }
  return { name: null, status: null };
}

/** Platform subscription directory, newest-renewing first. */
export async function listSubscriptionsAdmin(query?: {
  search?: string;
  status?: unknown;
  planCode?: unknown;
  page?: number;
  pageSize?: number;
}): Promise<AdminSubscriptionPage> {
  const needle = (query?.search ?? "").trim().toLowerCase();
  const status =
    typeof query?.status === "string" && ["ACTIVE", "PAST_DUE", "CANCELED"].includes(query.status)
      ? query.status
      : "all";
  const planFilter =
    typeof query?.planCode === "string" && isValidPlanCode(query.planCode)
      ? (query.planCode as PlanCode)
      : "all";
  const page = Number.isFinite(query?.page) && (query?.page as number) >= 1 ? Math.floor(query?.page as number) : 1;
  const pageSize =
    Number.isFinite(query?.pageSize) && (query?.pageSize as number) >= 1
      ? Math.min(100, Math.floor(query?.pageSize as number))
      : 20;

  const rows = await SubscriptionTable.select(...SUB_FIELDS).all();
  const matched: typeof rows = [];
  for (const r of rows) {
    if (status !== "all" && r.status !== status) continue;
    if (planFilter !== "all" && r.planCode !== planFilter) continue;
    if (needle.length > 0) {
      const info = await businessInfo(r.businessId);
      const haystack = `${info.name ?? ""} ${r.businessId} ${r.planCode}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    matched.push(r);
  }
  matched.sort((a, b) => (a.currentPeriodEnd < b.currentPeriodEnd ? 1 : -1));

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const subscriptions: AdminSubscriptionRow[] = [];
  for (const r of matched.slice((safePage - 1) * pageSize, safePage * pageSize)) {
    const info = await businessInfo(r.businessId);
    const planName = isValidPlanCode(r.planCode) ? PLANS[r.planCode].name : r.planCode;
    subscriptions.push({
      businessId: r.businessId,
      businessName: info.name,
      businessStatus: info.status,
      planCode: r.planCode,
      planName,
      status: r.status,
      billingCycle: r.billingCycle,
      currentPeriodStart: r.currentPeriodStart,
      currentPeriodEnd: r.currentPeriodEnd,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  }
  return { subscriptions, total, page: safePage, pageSize, totalPages };
}

/** Single workspace subscription with business context. Unknown → null. */
export async function getSubscriptionAdmin(businessId: string): Promise<AdminSubscriptionRow | null> {
  try {
    toBusinessId(businessId);
  } catch {
    return null;
  }
  const rows = await SubscriptionTable.where((s) => s.businessId.eq(toBusinessId(businessId)))
    .select(...SUB_FIELDS)
    .all();
  const row = rows.find((r) => r.businessId === businessId) ?? null;
  if (!row) return null;
  const info = await businessInfo(businessId);
  return {
    businessId: row.businessId,
    businessName: info.name,
    businessStatus: info.status,
    planCode: row.planCode,
    planName: isValidPlanCode(row.planCode) ? PLANS[row.planCode].name : row.planCode,
    status: row.status,
    billingCycle: row.billingCycle,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
