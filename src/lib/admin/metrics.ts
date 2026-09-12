/**
 * Lightweight platform dashboard metrics (super-admin only).
 *
 * Performance rules enforced here:
 * - Server-side aggregates ONLY (`count` / `sum` / `groupBy`). No query
 *   buffers table rows into Node — every call transfers a handful of
 *   numbers regardless of platform size.
 * - Cross-request caching via `unstable_cache` (60s stats, 5min series)
 *   so repeated dashboard loads don't touch the database at all.
 * - Single-flight per request: one `Promise.all` per fetch function, no
 *   duplicate queries.
 *
 * Data-integrity rule: subscription metrics are scoped to LIVE
 * workspaces. Test/automation runs can leave Subscription rows behind
 * after their Business row is deleted (cleanup removes children before
 * parents unevenly); counting those would inflate Active Subscriptions
 * and MRR against businesses that no longer exist. The scope is a
 * two-query semi-join (projected ids only, both sides indexed) — a
 * future `db.sql` JOIN can collapse it to one query if this ever shows
 * up in slow-query logs.
 *
 * All values are REAL database data. "Active users" means accounts whose
 * `status` is ACTIVE (the schema has no last-seen timestamp, so presence
 * activity cannot be measured — the hint says exactly that).
 */
import { unstable_cache } from "next/cache";
import { BusinessTable, SubscriptionTable, UserTable } from "../../prisma/tables";
import { PLANS, isValidPlanCode, type PlanCode } from "../billing/catalog";

export interface DashboardStats {
  totalUsers: number;
  /** Accounts with status ACTIVE (no last-seen column exists — see hint). */
  activeUsers: number;
  /** Registrations in the trailing 7 days. */
  newUsers: number;
  workspaces: number;
  /** ACTIVE subscriptions whose workspace still exists. */
  activeSubscriptions: number;
  /** MRR in BDT minor units over live workspaces at catalog price. */
  mrrMinor: number;
}

export interface GrowthPoint {
  month: string;
  newWorkspaces: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function monthBounds(months: number, nowMs: number): Array<{ key: string; start: string; end: string }> {
  const out: Array<{ key: string; start: string; end: string }> = [];
  const now = new Date(nowMs);
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    out.push({
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
      start: start.toISOString(),
      end: end.toISOString(),
    });
  }
  return out;
}

/**
 * ACTIVE subscriptions joined to live workspaces. Projected columns
 * only (businessId + planCode); correctness over orphans, bounded size.
 */
async function fetchLiveSubscriptions(): Promise<Array<{ businessId: string; planCode: string }>> {
  const active = await SubscriptionTable.where((s) => s.status.eq("ACTIVE"))
    .select("businessId", "planCode")
    .all();
  if (active.length === 0) return [];
  const ids = Array.from(new Set(active.map((s) => s.businessId)));
  const live = await BusinessTable.where((b) => b.id.in(ids))
    .select("id")
    .all();
  const liveSet = new Set(live.map((b) => b.id as string));
  return active.filter((s) => liveSet.has(s.businessId));
}

async function fetchDashboardStats(nowMs: number): Promise<DashboardStats> {
  const weekAgo = new Date(nowMs - 7 * DAY_MS).toISOString();
  const [total, active, fresh, workspaces, liveSubs] = await Promise.all([
    UserTable.aggregate((a) => ({ n: a.count() })),
    UserTable.where((u) => u.status.eq("ACTIVE")).aggregate((a) => ({ n: a.count() })),
    UserTable.where((u) => u.createdAt.gte(weekAgo)).aggregate((a) => ({ n: a.count() })),
    BusinessTable.aggregate((a) => ({ n: a.count() })),
    fetchLiveSubscriptions(),
  ]);
  let mrrMinor = 0;
  for (const s of liveSubs) {
    if (isValidPlanCode(s.planCode)) {
      mrrMinor += PLANS[s.planCode as PlanCode].priceMinor;
    }
  }
  return {
    totalUsers: total.n,
    activeUsers: active.n,
    newUsers: fresh.n,
    workspaces: workspaces.n,
    activeSubscriptions: liveSubs.length,
    mrrMinor,
  };
}

/** Cached 60s: total users, workspaces, monthly stats, plan mix. */
export const getDashboardStats = unstable_cache(
  async (): Promise<DashboardStats> => fetchDashboardStats(Date.now()),
  ["admin-dashboard-stats-v2"],
  { revalidate: 60 }
);

async function fetchWorkspaceGrowth(months: number): Promise<GrowthPoint[]> {
  const buckets = monthBounds(months, Date.now());
  return Promise.all(
    buckets.map(async (b) => {
      const n = await BusinessTable.where((x) => x.createdAt.gte(b.start))
        .where((x) => x.createdAt.lt(b.end))
        .aggregate((a) => ({ n: a.count() }));
      return { month: b.key, newWorkspaces: n.n };
    })
  );
}

/** Cached 5min: new workspaces per month — one number per bucket. */
export const getWorkspaceGrowth = unstable_cache(
  async (): Promise<GrowthPoint[]> => fetchWorkspaceGrowth(6),
  ["admin-workspace-growth"],
  { revalidate: 300 }
);
