/**
 * Workspace subscriptions: plans, billing cycles, usage, and quota gates.
 *
 * One subscription per business (unique `businessId`), created lazily as
 * FREE on first read. The monthly cycle rolls forward lazily — no cron —
 * and `currentPeriodEnd` is the renewal date. Plans come from the static
 * catalog (`catalog.ts`); the `Plan` table is introspection only.
 *
 * Enforcement invariant: every quota-consuming write (lead intake, member
 * invite, workspace creation) calls one of the `assert*Quota` gates, which
 * re-read current state server-side. No request field influences limits,
 * so crafted frontend requests cannot bypass them.
 */
import { BusinessTable, LeadTable, SubscriptionTable } from "../../prisma/tables";
import { toUserId } from "../auth/users";
import { listMembers, toBusinessId, toDbId } from "../tenancy/businesses";
import type { BusinessContext } from "../tenancy/context";
import { requireRole, TenantLimitExceeded, TenantNotFound } from "../tenancy/policies";
import { emitPaymentFailed } from "../tenancy/notifications";
import {
  DEFAULT_PLAN_CODE,
  PLANS,
  isValidPlanCode,
  monthBounds,
  rollPeriod,
  type PlanCode,
  type PlanLimits,
  type SubscriptionPatch,
} from "./catalog";
import { ensurePlanSeeds } from "./plans";

export interface SubscriptionDTO {
  id: string;
  businessId: string;
  planCode: PlanCode;
  status: string;
  billingCycle: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsageDTO {
  leadsUsed: number;
  leadsLimit: number;
  membersUsed: number;
  membersLimit: number;
  periodStart: string;
  periodEnd: string;
  renewalDate: string;
}

export interface SubscriptionView {
  subscription: SubscriptionDTO;
  plan: PlanLimits;
  usage: UsageDTO;
  plans: PlanLimits[];
}

const SUBSCRIPTION_FIELDS = [
  "id",
  "businessId",
  "planCode",
  "status",
  "billingCycle",
  "currentPeriodStart",
  "currentPeriodEnd",
  "createdAt",
  "updatedAt",
] as const;

type SubscriptionRow = {
  id: string;
  businessId: string;
  planCode: string;
  status: string;
  billingCycle: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  createdAt: string;
  updatedAt: string;
};

function toDTO(row: SubscriptionRow): SubscriptionDTO {
  const planCode = isValidPlanCode(row.planCode) ? row.planCode : DEFAULT_PLAN_CODE;
  return {
    id: row.id,
    businessId: row.businessId,
    planCode,
    status: row.status,
    billingCycle: row.billingCycle,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function planFor(code: string): PlanLimits {
  return PLANS[isValidPlanCode(code) ? code : DEFAULT_PLAN_CODE];
}

async function findSubscription(businessId: string): Promise<SubscriptionRow | null> {
  const bid = toBusinessId(businessId);
  const rows = await SubscriptionTable.where((s) => s.businessId.eq(bid))
    .select(...SUBSCRIPTION_FIELDS)
    .all();
  return rows.find((r) => r.businessId === businessId) ?? null;
}

/**
 * Read the subscription, creating a FREE row and rolling an elapsed cycle
 * as needed. Unique-backstop re-read keeps concurrent first reads to one
 * row. Never throws for missing data — every business always resolves to
 * a usable subscription.
 */
export async function getSubscription(businessId: string, nowMs = Date.now()): Promise<SubscriptionDTO> {
  try {
    await ensurePlanSeeds();
  } catch {
    // Plan rows are introspection-only; enforcement uses the static catalog.
  }
  const existing = await findSubscription(businessId);
  if (existing) {
    if (new Date(existing.currentPeriodEnd).getTime() > nowMs) {
      return toDTO(existing);
    }
    const rolled = rollPeriod(existing.currentPeriodStart, existing.currentPeriodEnd, nowMs);
    await SubscriptionTable.where({ id: toDbId(existing.id) }).update({
      currentPeriodStart: rolled.start,
      currentPeriodEnd: rolled.end,
    } as never);
    const refreshed = await findSubscription(businessId);
    if (refreshed) return toDTO(refreshed);
    throw new TenantNotFound();
  }
  const period = monthBounds(nowMs);
  try {
    const row = await SubscriptionTable.select(...SUBSCRIPTION_FIELDS).create({
      businessId: toBusinessId(businessId),
      planCode: DEFAULT_PLAN_CODE,
      status: "ACTIVE",
      billingCycle: "MONTHLY",
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
    });
    if (row.businessId !== businessId) throw new TenantNotFound();
    return toDTO(row);
  } catch (err) {
    if (err instanceof TenantNotFound) throw err;
    // Lost the unique race — the winner's row stands.
    const winner = await findSubscription(businessId);
    if (winner) return toDTO(winner);
    throw new Error("Failed to load subscription.");
  }
}

/** Leads created in the workspace since `periodStart` (intake, incl. archived). */
export async function countPeriodLeads(businessId: string, periodStart: string): Promise<number> {
  const bid = toBusinessId(businessId);
  const since = new Date(periodStart).getTime();
  const rows = await LeadTable.where((l) => l.businessId.eq(bid)).select("id", "createdAt").all();
  return rows.filter((r) => Number.isFinite(new Date(r.createdAt).getTime()) && new Date(r.createdAt).getTime() >= since)
    .length;
}

export async function countMembers(businessId: string): Promise<number> {
  return (await listMembers(businessId)).length;
}

/** Workspaces the user owns (ownerId-gated; never another user's rows). */
export async function countOwnedBusinesses(userId: string): Promise<number> {
  const uid = toUserId(userId);
  const rows = await BusinessTable.where((b) => b.ownerId.eq(uid)).select("id").all();
  return rows.length;
}

async function maxBusinessAllowance(userId: string): Promise<number | null> {
  const uid = toUserId(userId);
  const owned = await BusinessTable.where((b) => b.ownerId.eq(uid)).select("id").all();
  let allowance: number | null = PLANS[DEFAULT_PLAN_CODE].maxBusinesses;
  for (const biz of owned) {
    const sub = await getSubscription(biz.id).catch(() => null);
    const planAllowance = sub ? planFor(sub.planCode).maxBusinesses : PLANS[DEFAULT_PLAN_CODE].maxBusinesses;
    if (planAllowance === null) return null;
    if (allowance === null || (planAllowance ?? 0) > allowance) allowance = planAllowance;
  }
  return allowance;
}

/** Full billing view for settings UI + API. Any workspace member may read. */
export async function getSubscriptionView(
  context: BusinessContext,
  nowMs = Date.now()
): Promise<SubscriptionView> {
  const sub = await getSubscription(context.business.id, nowMs);
  const plan = planFor(sub.planCode);
  const [leadsUsed, membersUsed] = await Promise.all([
    countPeriodLeads(context.business.id, sub.currentPeriodStart),
    countMembers(context.business.id),
  ]);
  return {
    subscription: sub,
    plan,
    usage: {
      leadsUsed,
      leadsLimit: plan.leadsPerMonth,
      membersUsed,
      membersLimit: plan.maxUsers,
      periodStart: sub.currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
      renewalDate: sub.currentPeriodEnd,
    },
    plans: Object.values(PLANS),
  };
}

export interface ChangeResult {
  view: SubscriptionView;
  /** True when the change reactivated a non-ACTIVE subscription. */
  reactivated: boolean;
}

/**
 * Owner-driven plan/status change. OWNER-only: billing mutations are the
 * most sensitive workspace operation. A plan change anchors a fresh
 * monthly cycle; leaving CANCELED/PAST_DUE for ACTIVE reactivates writes.
 * Transitioning to PAST_DUE notifies managers best-effort.
 */
export async function changeSubscription(
  context: BusinessContext,
  patch: SubscriptionPatch,
  nowMs = Date.now()
): Promise<ChangeResult> {
  requireRole(context, "OWNER");
  const sub = await getSubscription(context.business.id, nowMs);
  const wasActive = sub.status === "ACTIVE";
  const update: Record<string, unknown> = {};
  if (patch.planCode !== undefined && patch.planCode !== sub.planCode) {
    const period = monthBounds(nowMs);
    update["planCode"] = patch.planCode;
    update["currentPeriodStart"] = period.start;
    update["currentPeriodEnd"] = period.end;
  }
  if (patch.status !== undefined && patch.status !== sub.status) {
    update["status"] = patch.status;
  }
  if (Object.keys(update).length > 0) {
    await SubscriptionTable.where({ id: toDbId(sub.id) }).update(update as never);
  }
  const refreshed = await getSubscription(context.business.id, nowMs);
  if (patch.status === "PAST_DUE") {
    try {
      await emitPaymentFailed(context.business.id, {
        reference: `subscription:${context.business.id}:${refreshed.currentPeriodStart.slice(0, 7)}`,
        detail: "Subscription is past due. Update payment to restore full access.",
      });
    } catch {
      // Notification failure must not break the billing write.
    }
  }
  return { view: await getSubscriptionView(context, nowMs), reactivated: !wasActive && refreshed.status === "ACTIVE" };
}

/**
 * Platform-level plan/status change. Skips membership checks entirely —
 * the caller MUST hold super-admin authorization (see
 * src/lib/admin/guard.ts). Reuses the same validated patch shape and
 * cycle-anchoring semantics as the owner path above.
 */
export async function changeSubscriptionAsSystem(
  businessId: string,
  patch: SubscriptionPatch,
  nowMs = Date.now()
): Promise<{ planCode: string; status: string } | null> {
  try {
    toBusinessId(businessId);
  } catch {
    return null;
  }
  const sub = await getSubscription(businessId, nowMs).catch(() => null);
  if (!sub) return null;
  const update: Record<string, unknown> = {};
  if (patch.planCode !== undefined && patch.planCode !== sub.planCode) {
    const period = monthBounds(nowMs);
    update["planCode"] = patch.planCode;
    update["currentPeriodStart"] = period.start;
    update["currentPeriodEnd"] = period.end;
  }
  if (patch.status !== undefined && patch.status !== sub.status) {
    update["status"] = patch.status;
  }
  if (Object.keys(update).length === 0) {
    return { planCode: sub.planCode, status: sub.status };
  }
  await SubscriptionTable.where({ id: toDbId(sub.id) }).update(update as never);
  const refreshed = await getSubscription(businessId, nowMs);
  return { planCode: refreshed.planCode, status: refreshed.status };
}

/** Block quota-consuming writes unless the subscription is ACTIVE. */
function requireActiveSubscription(sub: SubscriptionDTO): void {
  if (sub.status !== "ACTIVE") {
    throw new TenantLimitExceeded(
      `Subscription is ${sub.status}. Reactivate to continue adding leads and members.`
    );
  }
}

/**
 * System-side paid activation (verified payment pipeline only — never from
 * a request handler directly). Sets the paid plan, reactivates the
 * subscription, and anchors a fresh monthly cycle starting now.
 */
export async function applyPaidActivation(
  businessId: string,
  planCode: PlanCode,
  nowMs = Date.now()
): Promise<SubscriptionDTO> {
  const sub = await getSubscription(businessId, nowMs);
  const period = monthBounds(nowMs);
  await SubscriptionTable.where({ id: toDbId(sub.id) }).update({
    planCode,
    status: "ACTIVE",
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
  } as never);
  const refreshed = await findSubscription(businessId);
  if (!refreshed) throw new TenantNotFound();
  return toDTO(refreshed);
}

/** Gate lead intake (manual creates + webhook ingestion share this). */
export async function assertLeadQuota(businessId: string, nowMs = Date.now()): Promise<void> {
  const sub = await getSubscription(businessId, nowMs);
  requireActiveSubscription(sub);
  const plan = planFor(sub.planCode);
  const used = await countPeriodLeads(businessId, sub.currentPeriodStart);
  if (used >= plan.leadsPerMonth) {
    throw new TenantLimitExceeded(
      `Monthly lead limit reached (${used}/${plan.leadsPerMonth} on ${plan.name}). Renewal: ${sub.currentPeriodEnd.slice(0, 10)}.`
    );
  }
}

/** Gate member invites. */
export async function assertMemberQuota(businessId: string, nowMs = Date.now()): Promise<void> {
  const sub = await getSubscription(businessId, nowMs);
  requireActiveSubscription(sub);
  const plan = planFor(sub.planCode);
  const used = await countMembers(businessId);
  if (used >= plan.maxUsers) {
    throw new TenantLimitExceeded(
      `Team limit reached (${used}/${plan.maxUsers} on ${plan.name}). Upgrade to invite more members.`
    );
  }
}

/** Gate workspace creation against the owner's best allowance. */
export async function assertBusinessQuota(userId: string): Promise<void> {
  const owned = await countOwnedBusinesses(userId);
  const allowance = await maxBusinessAllowance(userId);
  if (allowance !== null && owned >= allowance) {
    throw new TenantLimitExceeded(
      `Workspace limit reached (${owned} workspace${owned === 1 ? "" : "s"}). Upgrade to Agency for multiple workspaces.`
    );
  }
}
