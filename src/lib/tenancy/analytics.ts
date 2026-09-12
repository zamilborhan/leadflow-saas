/**
 * Tenant-scoped business analytics.
 *
 * HARD RULE (same as leads.ts): every read filters by `businessId` from the
 * verified `BusinessContext`. There is no function here that reads outside
 * the workspace — a foreign business id resolves through membership first
 * and can never leak another tenant's rows.
 *
 * Archived leads are excluded from every metric (consistent with the
 * dashboard). All computation lives in `analytics-core.ts` (pure,
 * unit-tested); this module only performs the scoped reads and resolves
 * agent display names.
 */
import { FollowUpTable, LeadTable } from "../../prisma/tables";
import { findUsersByIds } from "../auth/users";
import { toBusinessId } from "./businesses";
import type { BusinessContext } from "./context";
import { requirePermission } from "./policies";
import {
  bucketLeadsByDay,
  groupByAd,
  groupByAdSet,
  groupByCampaign,
  groupBySource,
  leadInScope,
  rate,
  rollUpAgents,
  summarizeFollowUps,
  type AgentSlice,
  type AnalyticsFollowUpRow,
  type AnalyticsLeadRow,
  type AnalyticsQuery,
  type DayBucket,
  type FollowUpCompletion,
  type FunnelSlice,
} from "./analytics-core";

const LEAD_FIELDS = [
  "id",
  "businessId",
  "status",
  "source",
  "campaignName",
  "adSetName",
  "adName",
  "assignedTo",
  "archivedAt",
  "createdAt",
] as const;

const FOLLOWUP_FIELDS = ["id", "businessId", "leadId", "assignedTo", "scheduledAt", "status"] as const;

export interface AgentPerformance extends AgentSlice {
  name: string | null;
  email: string | null;
}

export interface BusinessAnalytics {
  query: AnalyticsQuery;
  kpis: {
    totalLeads: number;
    convertedLeads: number;
    conversionRate: number | null;
    followUpCompletion: FollowUpCompletion;
    overdueFollowUps: number;
  };
  leadsByDay: DayBucket[];
  leadsBySource: FunnelSlice[];
  leadsByCampaign: FunnelSlice[];
  leadsByAdSet: FunnelSlice[];
  leadsByAd: FunnelSlice[];
  agents: AgentPerformance[];
}

/** Leads for analytics: scoped, de-archived, shaped for the pure core. */
async function readLeadRows(businessId: string): Promise<AnalyticsLeadRow[]> {
  const bid = toBusinessId(businessId);
  const rows = await LeadTable.where((l) => l.businessId.eq(bid))
    .select(...LEAD_FIELDS)
    .all();
  return rows
    .filter((r) => r.archivedAt === null)
    .map((r) => ({
      id: r.id,
      status: r.status,
      source: r.source,
      campaignName: r.campaignName,
      adSetName: r.adSetName,
      adName: r.adName,
      assignedTo: r.assignedTo,
      createdAt: r.createdAt,
    }));
}

/** Follow-ups for analytics: scoped to the workspace (lead scoping happens in-core). */
async function readFollowUpRows(businessId: string): Promise<AnalyticsFollowUpRow[]> {
  const bid = toBusinessId(businessId);
  const rows = await FollowUpTable.where((f) => f.businessId.eq(bid))
    .select(...FOLLOWUP_FIELDS)
    .all();
  return rows.map((r) => ({
    id: r.id,
    leadId: r.leadId,
    assignedTo: r.assignedTo,
    scheduledAt: r.scheduledAt,
    status: r.status,
  }));
}

async function resolveAgentNames(userIds: string[]): Promise<Map<string, { name: string | null; email: string | null }>> {
  // Batched parallel lookup — one logical round of queries instead of N
  // sequential awaits. Best-effort: unknown ids stay absent ("Unknown").
  const users = await findUsersByIds(userIds).catch(() => new Map());
  const out = new Map<string, { name: string | null; email: string | null }>();
  for (const [id, u] of users) out.set(id, { name: u.name, email: u.email });
  return out;
}

/**
 * Full analytics payload for the workspace. Requires `leads.read` (every
 * role holds it); agent names resolve best-effort to "Unknown" rather
 * than failing the whole payload.
 */
export async function getBusinessAnalytics(
  context: BusinessContext,
  query: AnalyticsQuery,
  nowMs = Date.now()
): Promise<BusinessAnalytics> {
  requirePermission(context, "leads.read");
  const [leadRows, followUpRows] = await Promise.all([
    readLeadRows(context.business.id),
    readFollowUpRows(context.business.id),
  ]);

  const inScope = leadRows.filter((r) => leadInScope(r, query));
  const converted = inScope.filter((r) => r.status === "CONVERTED").length;
  const followUpCompletion = summarizeFollowUps(leadRows, followUpRows, query, nowMs);
  const agentSlices = rollUpAgents(leadRows, followUpRows, query);
  const names = await resolveAgentNames(agentSlices.map((a) => a.userId));
  const agents: AgentPerformance[] = agentSlices.map((a) => ({
    ...a,
    name: names.get(a.userId)?.name ?? null,
    email: names.get(a.userId)?.email ?? null,
  }));

  return {
    query,
    kpis: {
      totalLeads: inScope.length,
      convertedLeads: converted,
      conversionRate: rate(converted, inScope.length),
      followUpCompletion,
      overdueFollowUps: followUpCompletion.overdue,
    },
    leadsByDay: bucketLeadsByDay(leadRows, query),
    leadsBySource: groupBySource(leadRows, query),
    leadsByCampaign: groupByCampaign(leadRows, query),
    leadsByAdSet: groupByAdSet(leadRows, query),
    leadsByAd: groupByAd(leadRows, query),
    agents,
  };
}
