/**
 * Platform overview metrics (super-admin only).
 *
 * Every query here is intentionally platform-wide — no `businessId`
 * filter — because the caller is authorized at the platform level via
 * `requireSuperAdmin`, never via workspace membership. Nothing in this
 * module is reachable from tenant-scoped code paths.
 */
import {
  AutomationJobTable,
  BusinessTable,
  LeadTable,
  SubscriptionTable,
} from "../../prisma/tables";
import { PLANS, isValidPlanCode, type PlanCode } from "../billing/catalog";

export interface PlatformOverview {
  totalBusinesses: number;
  activeBusinesses: number;
  suspendedBusinesses: number;
  activeSubscriptions: number;
  /** Monthly recurring revenue in BDT minor units (poisha). */
  mrrMinor: number;
  /** Businesses created in the trailing 30 days. */
  newBusinesses: number;
  /** Subscriptions currently CANCELED (churned). */
  churnedBusinesses: number;
  totalLeads: number;
  failedJobs: number;
  plans: Array<{ code: PlanCode; name: string; subscribers: number }>;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function priceFor(planCode: string): number {
  if (!isValidPlanCode(planCode)) return 0;
  return PLANS[planCode].priceMinor;
}

/** Platform-wide metrics snapshot. Caller must hold super-admin authorization. */
export async function getPlatformOverview(nowMs = Date.now()): Promise<PlatformOverview> {
  const [businesses, subscriptions, leads, failedJobs] = await Promise.all([
    BusinessTable.select("id", "status", "createdAt").all(),
    SubscriptionTable.select("businessId", "planCode", "status").all(),
    LeadTable.select("id").all(),
    AutomationJobTable.where((j) => j.status.eq("FAILED")).select("id").all(),
  ]);

  const cutoff = nowMs - THIRTY_DAYS_MS;
  let activeBusinesses = 0;
  let suspendedBusinesses = 0;
  let newBusinesses = 0;
  for (const b of businesses) {
    if (b.status === "SUSPENDED") suspendedBusinesses += 1;
    else activeBusinesses += 1;
    const created = new Date(b.createdAt).getTime();
    if (Number.isFinite(created) && created >= cutoff) newBusinesses += 1;
  }

  let activeSubscriptions = 0;
  let churnedBusinesses = 0;
  let mrrMinor = 0;
  const subscribers = new Map<PlanCode, number>();
  for (const s of subscriptions) {
    if (s.status === "ACTIVE") {
      activeSubscriptions += 1;
      mrrMinor += priceFor(s.planCode);
      if (isValidPlanCode(s.planCode)) {
        subscribers.set(s.planCode, (subscribers.get(s.planCode) ?? 0) + 1);
      }
    } else if (s.status === "CANCELED") {
      churnedBusinesses += 1;
    }
  }

  return {
    totalBusinesses: businesses.length,
    activeBusinesses,
    suspendedBusinesses,
    activeSubscriptions,
    mrrMinor,
    newBusinesses,
    churnedBusinesses,
    totalLeads: leads.length,
    failedJobs: failedJobs.length,
    plans: (Object.keys(PLANS) as PlanCode[]).map((code) => ({
      code,
      name: PLANS[code].name,
      subscribers: subscribers.get(code) ?? 0,
    })),
  };
}
