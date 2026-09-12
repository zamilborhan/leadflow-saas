/**
 * Billing + revenue analytics from REAL payment/subscription data.
 * Never stores or displays card data — amounts come from Payment.amountMinor.
 */
import { PaymentTable, SubscriptionTable } from "../../prisma/tables";
import { PLANS, isValidPlanCode, type PlanCode } from "../billing/catalog";
import { allOrEmpty } from "./query";

export interface RevenueSummary {
  mrrMinor: number;
  arrMinor: number;
  totalRevenueMinor: number;
  activeSubscriptions: number;
  newSubscriptionsMonth: number;
  cancelled: number;
  pastDue: number;
  failedPayments: number;
  refundsMinor: number | null;
  currency: string;
}

export interface RevenueByPlan {
  planCode: string;
  planName: string;
  subscribers: number;
  mrrMinor: number;
}

export interface RevenuePoint {
  month: string;
  revenueMinor: number;
  newSubscriptions: number;
}

function priceFor(planCode: string): number {
  if (!isValidPlanCode(planCode)) return 0;
  return PLANS[planCode as PlanCode].priceMinor;
}

function monthKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Revenue snapshot from live subscription + payment rows. */
export async function getRevenueSummary(nowMs = Date.now()): Promise<RevenueSummary> {
  const [subscriptions, payments] = await Promise.all([
    allOrEmpty(SubscriptionTable.select("planCode", "status", "createdAt").all()),
    allOrEmpty(PaymentTable.select("amountMinor", "status", "currency", "createdAt").all()),
  ]);
  const monthStart = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    1
  );
  let mrrMinor = 0;
  let activeSubscriptions = 0;
  let cancelled = 0;
  let pastDue = 0;
  let newSubscriptionsMonth = 0;
  for (const s of subscriptions) {
    if (s.status === "ACTIVE") {
      activeSubscriptions += 1;
      mrrMinor += priceFor(s.planCode);
      if (new Date(s.createdAt).getTime() >= monthStart) newSubscriptionsMonth += 1;
    } else if (s.status === "CANCELED") cancelled += 1;
    else if (s.status === "PAST_DUE") pastDue += 1;
  }
  let totalRevenueMinor = 0;
  let failedPayments = 0;
  for (const p of payments) {
    if (p.status === "SUCCESS") totalRevenueMinor += p.amountMinor;
    else if (p.status === "FAILED") failedPayments += 1;
  }
  return {
    mrrMinor,
    arrMinor: mrrMinor * 12,
    totalRevenueMinor,
    activeSubscriptions,
    newSubscriptionsMonth,
    cancelled,
    pastDue,
    failedPayments,
    // No refund model/table exists — honestly null (see unavailable note on page).
    refundsMinor: null,
    currency: "BDT",
  };
}

export async function getRevenueByPlan(): Promise<RevenueByPlan[]> {
  const subscriptions = await allOrEmpty(SubscriptionTable.select("planCode", "status").all());
  const byPlan = new Map<string, number>();
  for (const s of subscriptions) {
    if (s.status !== "ACTIVE") continue;
    byPlan.set(s.planCode, (byPlan.get(s.planCode) ?? 0) + 1);
  }
  return (Object.keys(PLANS) as PlanCode[]).map((code) => ({
    planCode: code,
    planName: PLANS[code].name,
    subscribers: byPlan.get(code) ?? 0,
    mrrMinor: (byPlan.get(code) ?? 0) * PLANS[code].priceMinor,
  }));
}

/** Last 12 months of successful-payment revenue + new subscriptions (server-aggregated). */
export async function getRevenueSeries(months = 12): Promise<RevenuePoint[]> {
  const [payments, subscriptions] = await Promise.all([
    allOrEmpty(PaymentTable.select("amountMinor", "status", "createdAt").all()),
    allOrEmpty(SubscriptionTable.select("createdAt", "status").all()),
  ]);
  const now = new Date();
  const buckets = new Map<string, RevenuePoint>();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    buckets.set(key, { month: key, revenueMinor: 0, newSubscriptions: 0 });
  }
  for (const p of payments) {
    if (p.status !== "SUCCESS") continue;
    const key = monthKey(p.createdAt);
    const bucket = key ? buckets.get(key) : undefined;
    if (bucket) bucket.revenueMinor += p.amountMinor;
  }
  for (const s of subscriptions) {
    const key = monthKey(s.createdAt);
    const bucket = key ? buckets.get(key) : undefined;
    if (bucket) bucket.newSubscriptions += 1;
  }
  return [...buckets.values()];
}
