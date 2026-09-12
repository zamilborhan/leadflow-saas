/**
 * Recent platform activity feed from REAL data (super-admin only).
 *
 * Performance rules: every source query is `orderBy(createdAt desc)`
 * + `limit(N)` — the database returns at most a few dozen small rows,
 * never full tables. Workspace names resolve with ONE batched `in()`
 * query (no N+1). The merged feed is cached cross-request (30s).
 */
import { unstable_cache } from "next/cache";
import {
  BusinessTable,
  PaymentTable,
  SubscriptionTable,
  UserTable,
} from "../../prisma/tables";

export interface ActivityEvent {
  id: string;
  kind:
    | "user_registered"
    | "workspace_created"
    | "workspace_suspended"
    | "subscription_activated"
    | "subscription_cancelled"
    | "payment_failed";
  title: string;
  detail: string | null;
  href: string | null;
  createdAt: string;
}

const PER_SOURCE = 8;

async function fetchRecentActivity(limit: number): Promise<ActivityEvent[]> {
  const [users, businesses, subscriptions, payments] = await Promise.all([
    UserTable.select("id", "email", "createdAt")
      .orderBy((u) => u.createdAt.desc())
      .limit(PER_SOURCE)
      .all(),
    BusinessTable.select("id", "name", "status", "createdAt")
      .orderBy((b) => b.createdAt.desc())
      .limit(PER_SOURCE)
      .all(),
    SubscriptionTable.select("businessId", "planCode", "status", "updatedAt")
      .orderBy((s) => s.updatedAt.desc())
      .limit(PER_SOURCE)
      .all(),
    PaymentTable.where((p) => p.status.eq("FAILED"))
      .select("id", "businessId", "planCode", "createdAt")
      .orderBy((p) => p.createdAt.desc())
      .limit(PER_SOURCE)
      .all(),
  ]);

  const businessIds = Array.from(
    new Set([
      ...subscriptions.map((s) => s.businessId),
      ...payments.map((p) => p.businessId),
    ])
  );
  const names =
    businessIds.length > 0
      ? await BusinessTable.where((b) => b.id.in(businessIds))
          .select("id", "name")
          .all()
      : [];
  const businessName = new Map(names.map((b) => [b.id as string, b.name as string | null]));

  const events: ActivityEvent[] = [];
  for (const u of users) {
    events.push({
      id: `user:${u.id}`,
      kind: "user_registered",
      title: "New user registered",
      detail: u.email,
      href: `/admin/users/${u.id}`,
      createdAt: u.createdAt,
    });
  }
  for (const b of businesses) {
    events.push({
      id: `biz:${b.id}`,
      kind: b.status === "SUSPENDED" ? "workspace_suspended" : "workspace_created",
      title: b.status === "SUSPENDED" ? "Workspace suspended" : "New workspace created",
      detail: b.name ?? b.id,
      href: `/admin/businesses/${b.id}`,
      createdAt: b.createdAt,
    });
  }
  for (const s of subscriptions) {
    if (s.status !== "ACTIVE" && s.status !== "CANCELED") continue;
    const name = businessName.get(s.businessId);
    events.push({
      id: `sub:${s.businessId}`,
      kind: s.status === "CANCELED" ? "subscription_cancelled" : "subscription_activated",
      title: s.status === "CANCELED" ? "Subscription cancelled" : "Subscription activated",
      detail: name ? `${name} · ${s.planCode}` : `Removed workspace · ${s.planCode}`,
      href: name ? `/admin/subscriptions?search=${encodeURIComponent(s.businessId)}` : "/admin/subscriptions",
      createdAt: s.updatedAt,
    });
  }
  for (const p of payments) {
    const name = businessName.get(p.businessId);
    events.push({
      id: `pay:${p.id}`,
      kind: "payment_failed",
      title: "Payment failed",
      detail: name ? `${name} · ${p.planCode}` : `Removed workspace · ${p.planCode}`,
      href: name ? `/admin/payments?search=${encodeURIComponent(p.businessId)}` : "/admin/payments",
      createdAt: p.createdAt,
    });
  }

  events.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return events.slice(0, limit);
}

/** Cached 30s. `limit` is part of the cache key. */
export const getRecentActivity = unstable_cache(
  async (limit = 8): Promise<ActivityEvent[]> => fetchRecentActivity(limit),
  ["admin-recent-activity-v2"],
  { revalidate: 30 }
);
