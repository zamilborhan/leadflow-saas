/**
 * Business dashboard data loader (server-only).
 *
 * Everything is scoped to a verified workspace: the caller authenticates,
 * then either the requested business (membership re-checked) or the user's
 * first business is used. There is no code path that reads leads outside
 * the resolved `businessId`.
 */
import { LeadTable } from "../../prisma/tables";
import { findUsersByIds } from "../auth/users";
import {
  listUserBusinesses,
  toBusinessId,
  type BusinessDTO,
  type MembershipDTO,
} from "./businesses";
import { resolveBusinessContext } from "./context";
import { getFollowUpSummary, type FollowUpSummary } from "./followups";
import type { LeadDTO } from "./leads";

export interface DashboardLead extends LeadDTO {
  assigneeName: string | null;
}

export interface DashboardStats {
  total: number;
  /** Status NEW. */
  fresh: number;
  /** Status CONTACTED. */
  contacted: number;
  /** Status INTERESTED — prospects showing interest. */
  interested: number;
  /** Status FOLLOW_UP — leads in active follow-up. */
  followUp: number;
  /** Status CONVERTED. */
  converted: number;
  /** Status LOST. */
  lost: number;
  /** CONVERTED / total as a 0–100 number, or null when there are no leads. */
  conversionRate: number | null;
}

export interface BusinessDashboard {
  business: BusinessDTO;
  membership: MembershipDTO;
  stats: DashboardStats;
  recentLeads: DashboardLead[];
  followUps: FollowUpSummary;
}

export type DashboardResult =
  | { ok: true; dashboard: BusinessDashboard }
  | { ok: false; reason: "no-business" };

const LEAD_FIELDS = [
  "id",
  "businessId",
  "name",
  "email",
  "phone",
  "status",
  "source",
  "campaignName",
  "adSetName",
  "adName",
  "facebookLeadId",
  "assignedTo",
  "lastContactedAt",
  "nextFollowUpAt",
  "archivedAt",
  "createdAt",
  "updatedAt",
] as const;

function emptyStats(): DashboardStats {
  return {
    total: 0,
    fresh: 0,
    contacted: 0,
    interested: 0,
    followUp: 0,
    converted: 0,
    lost: 0,
    conversionRate: null,
  };
}

/**
 * Load the dashboard for (`userId`, `requestedBusinessId?`).
 * - No businesses → `{ ok: false, reason: "no-business" }` (empty state).
 * - Requested business without membership → falls back to the first
 *   business (never leaks the foreign workspace).
 */
export async function getBusinessDashboard(
  userId: string,
  requestedBusinessId?: string | null
): Promise<DashboardResult> {
  const businesses = await listUserBusinesses(userId);
  if (businesses.length === 0) return { ok: false, reason: "no-business" };

  let resolved = requestedBusinessId
    ? await resolveBusinessContext(userId, requestedBusinessId)
    : { ok: false as const, reason: "no-membership" as const };
  if (!resolved.ok) {
    const fallback = businesses[0];
    const retry = await resolveBusinessContext(userId, fallback.id);
    if (!retry.ok) return { ok: false, reason: "no-business" };
    resolved = retry;
  }

  const { business, membership } = resolved.context;
  const businessId = toBusinessId(business.id);

  // Scoped reads run in parallel: lead rows (stats + latest 8) and the
  // follow-up summary are independent. Stats derive from the same rows so
  // no second lead query is issued. Recent-lead assignee names resolve in
  // ONE batched parallel lookup — never N sequential round-trips.
  // createdAt desc, latest 8.
  const [rows, followUps] = await Promise.all([
    LeadTable.where((l) => l.businessId.eq(businessId))
      .where((l) => l.archivedAt.isNull())
      .select(...LEAD_FIELDS)
      .orderBy((l) => l.createdAt.desc())
      .all(),
    getFollowUpSummary(resolved.context),
  ]);

  const stats = emptyStats();
  stats.total = rows.length;
  for (const row of rows) {
    switch (row.status) {
      case "NEW":
        stats.fresh += 1;
        break;
      case "CONTACTED":
        stats.contacted += 1;
        break;
      case "INTERESTED":
        stats.interested += 1;
        break;
      case "FOLLOW_UP":
        stats.followUp += 1;
        break;
      case "CONVERTED":
        stats.converted += 1;
        break;
      case "LOST":
        stats.lost += 1;
        break;
      default:
        break;
    }
  }
  stats.conversionRate = stats.total > 0 ? (stats.converted / stats.total) * 100 : null;

  const recentLeads: DashboardLead[] = [];
  const recent = rows.slice(0, 8);
  const assigneeIds = recent
    .map((r) => r.assignedTo)
    .filter((v): v is NonNullable<typeof v> => v !== null && v !== undefined)
    .map((v) => String(v));
  const assignees = await findUsersByIds(assigneeIds);
  for (const row of recent) {
    const assignee = row.assignedTo ? (assignees.get(String(row.assignedTo)) ?? null) : null;
    const assigneeName = assignee?.status === "ACTIVE" ? (assignee.name ?? assignee.email ?? null) : null;
    recentLeads.push({
      id: row.id,
      businessId: row.businessId,
      name: row.name,
      email: row.email,
      phone: row.phone,
      status: row.status,
      source: row.source,
      campaignName: row.campaignName,
      adSetName: row.adSetName,
      adName: row.adName,
      facebookLeadId: row.facebookLeadId,
      assignedTo: row.assignedTo,
      lastContactedAt: row.lastContactedAt,
      nextFollowUpAt: row.nextFollowUpAt,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      assigneeName,
    });
  }

  return { ok: true, dashboard: { business, membership, stats, recentLeads, followUps } };
}
