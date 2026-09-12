/**
 * Audit trail + security-center reads (super-admin only).
 *
 * BACKEND REQUIREMENT: there is no dedicated `AuditLog` table yet, so
 * persistent, tamper-evident admin-action history requires a new
 * append-only model (proposed below). Until it lands:
 *  - `logAdminAction()` emits a structured server log line (Vercel/log
 *    drain can retain it) and returns the event.
 *  - `listAuditEvents()` derives a read-only trail from REAL existing
 *    rows (suspensions, subscription updates, failed payments, failed
 *    jobs/webhooks) so the UI never shows fake entries.
 *
 * Proposed model (additive, non-destructive):
 *   AuditLog { id, actorEmail, action, targetType, targetId, metadataJson,
 *              createdAt } — insert-only; no update/delete API.
 */
import { allOrEmpty } from "./query";

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  target: string;
  createdAt: string;
  metadata: string | null;
}

export async function logAdminAction(input: {
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    actor: input.actorEmail,
    action: input.action,
    target: `${input.targetType}:${input.targetId}`,
    createdAt: new Date().toISOString(),
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  };
  // Structured log line — the only durable sink until AuditLog lands.
  console.info("[admin-audit]", JSON.stringify(event));
  return event;
}

/** Derived read-only trail from real platform rows. */
export async function listAuditEvents(limit = 50): Promise<{ events: AuditEvent[]; persistent: false }> {
  const { BusinessTable, SubscriptionTable, PaymentTable } = await import("../../prisma/tables");
  const [businesses, subscriptions, payments] = await Promise.all([
    allOrEmpty(BusinessTable.select("id", "name", "status", "updatedAt").all()),
    allOrEmpty(SubscriptionTable.select("businessId", "planCode", "status", "updatedAt").all()),
    allOrEmpty(PaymentTable.select("id", "businessId", "status", "planCode", "updatedAt").all()),
  ]);
  const events: AuditEvent[] = [];
  for (const b of businesses.filter((x) => x.status === "SUSPENDED")) {
    events.push({
      id: `audit-biz-${b.id}`,
      actor: "system",
      action: "workspace.suspended",
      target: `business:${b.id} (${b.name})`,
      createdAt: b.updatedAt,
      metadata: null,
    });
  }
  for (const s of subscriptions) {
    events.push({
      id: `audit-sub-${s.businessId}`,
      actor: "system",
      action: `subscription.${s.status.toLowerCase()}`,
      target: `business:${s.businessId} plan=${s.planCode}`,
      createdAt: s.updatedAt,
      metadata: null,
    });
  }
  for (const p of payments.filter((x) => ["FAILED", "SUCCESS"].includes(x.status))) {
    events.push({
      id: `audit-pay-${p.id}`,
      actor: "system",
      action: `payment.${p.status.toLowerCase()}`,
      target: `business:${p.businessId} plan=${p.planCode}`,
      createdAt: p.updatedAt,
      metadata: null,
    });
  }
  events.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { events: events.slice(0, limit), persistent: false };
}

export interface SecuritySignal {
  suspendedWorkspaces: number;
  failedPayments: number;
  failedJobs: number;
  failedLeadSyncs: number;
  pastDueSubscriptions: number;
  checkedAt: string;
}

/** Security-center signals from real data (no fake threat scores). */
export async function getSecuritySignals(): Promise<SecuritySignal> {
  const { AutomationJobTable, BusinessTable, MetaLeadEventTable, PaymentTable, SubscriptionTable } =
    await import("../../prisma/tables");
  const [businesses, payments, jobs, metaEvents, subscriptions] = await Promise.all([
    allOrEmpty(BusinessTable.select("id", "status").all()),
    allOrEmpty(PaymentTable.select("id", "status").all()),
    allOrEmpty(AutomationJobTable.where((j) => j.status.eq("FAILED")).select("id").all()),
    allOrEmpty(MetaLeadEventTable.select("id", "status").all()),
    allOrEmpty(SubscriptionTable.select("businessId", "status").all()),
  ]);
  return {
    suspendedWorkspaces: businesses.filter((b) => b.status === "SUSPENDED").length,
    failedPayments: payments.filter((p) => p.status === "FAILED").length,
    failedJobs: jobs.length,
    failedLeadSyncs: metaEvents.filter((e) => e.status === "FAILED").length,
    pastDueSubscriptions: subscriptions.filter((s) => s.status === "PAST_DUE").length,
    checkedAt: new Date().toISOString(),
  };
}
