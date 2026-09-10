/**
 * SaaS plan catalog + billing-cycle math.
 *
 * Framework-free and dependency-free: safe to import from unit tests via
 * Node type-stripping. This static catalog is the enforcement source of
 * truth — the database-backed `Plan` table mirrors it for introspection
 * and admin UIs (see `ensurePlanSeeds`), so a missing or tampered seed
 * row can never widen access.
 */

export const PLAN_CODES = ["FREE", "STARTER", "GROWTH", "BUSINESS", "AGENCY"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export interface PlanLimits {
  code: PlanCode;
  name: string;
  /** Leads that may be created per calendar month (UTC). */
  leadsPerMonth: number;
  /** Members per workspace. */
  maxUsers: number;
  /** Workspaces per owning user; null = unlimited. */
  maxBusinesses: number | null;
  /**
   * Monthly price in BDT minor units (poisha), e.g. 49000 = ৳490.00.
   * Checkout amounts are derived server-side from this table — request
   * bodies can name a plan but never set a price.
   */
  priceMinor: number;
  currency: "BDT";
}

export const PLANS: Record<PlanCode, PlanLimits> = {
  FREE: { code: "FREE", name: "Free", leadsPerMonth: 50, maxUsers: 1, maxBusinesses: 1, priceMinor: 0, currency: "BDT" },
  STARTER: { code: "STARTER", name: "Starter", leadsPerMonth: 500, maxUsers: 2, maxBusinesses: 1, priceMinor: 49000, currency: "BDT" },
  GROWTH: { code: "GROWTH", name: "Growth", leadsPerMonth: 2000, maxUsers: 5, maxBusinesses: 1, priceMinor: 149000, currency: "BDT" },
  BUSINESS: { code: "BUSINESS", name: "Business", leadsPerMonth: 10000, maxUsers: 15, maxBusinesses: 1, priceMinor: 399000, currency: "BDT" },
  AGENCY: { code: "AGENCY", name: "Agency", leadsPerMonth: 100000, maxUsers: 100, maxBusinesses: null, priceMinor: 999000, currency: "BDT" },
};

export const DEFAULT_PLAN_CODE: PlanCode = "FREE";

export function isValidPlanCode(code: unknown): code is PlanCode {
  return typeof code === "string" && (PLAN_CODES as readonly string[]).includes(code);
}

export const SUBSCRIPTION_STATUSES = ["ACTIVE", "PAST_DUE", "CANCELED"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isValidSubscriptionStatus(status: unknown): status is SubscriptionStatus {
  return typeof status === "string" && (SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

export const BILLING_CYCLES = ["MONTHLY"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export interface PeriodBounds {
  start: string;
  end: string;
}

/** UTC calendar-month bounds containing `nowMs` (end is exclusive). */
export function monthBounds(nowMs: number): PeriodBounds {
  const d = new Date(nowMs);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  return { start, end };
}

/** First instant of the month after the one containing `iso`. */
export function addOneMonth(iso: string): string {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Roll a billing period forward month-by-month until `nowMs` falls inside
 * it. Pure and loop-bounded in practice (one iteration per elapsed month).
 */
export function rollPeriod(startIso: string, endIso: string, nowMs: number): PeriodBounds {
  let start = startIso;
  let end = endIso;
  for (let i = 0; i < 1200 && new Date(end).getTime() <= nowMs; i++) {
    start = end;
    end = addOneMonth(end);
  }
  return { start, end };
}

export interface SubscriptionPatch {
  planCode?: PlanCode;
  status?: SubscriptionStatus;
}

export interface PatchValidation {
  ok: boolean;
  value?: SubscriptionPatch;
  errors: Record<string, string>;
}

/**
 * Validate an owner-driven subscription change. Unknown keys and unknown
 * plan codes are rejected — there is no code path that accepts a
 * caller-supplied limit, so crafted requests cannot widen quotas.
 */
export function validateSubscriptionPatch(input: unknown): PatchValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: { _form: "Invalid payload." } };
  }
  const obj = input as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const value: SubscriptionPatch = {};
  const allowed = new Set(["planCode", "status"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors[key] = `Unknown field: ${key}.`;
  }
  if (obj["planCode"] !== undefined) {
    if (!isValidPlanCode(obj["planCode"])) {
      errors["planCode"] = `Plan must be one of: ${PLAN_CODES.join(", ")}.`;
    } else {
      value.planCode = obj["planCode"];
    }
  }
  if (obj["status"] !== undefined) {
    if (!isValidSubscriptionStatus(obj["status"])) {
      errors["status"] = `Status must be one of: ${SUBSCRIPTION_STATUSES.join(", ")}.`;
    } else {
      value.status = obj["status"];
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (value.planCode === undefined && value.status === undefined) {
    return { ok: false, errors: { _form: "Nothing to update." } };
  }
  return { ok: true, value, errors: {} };
}
