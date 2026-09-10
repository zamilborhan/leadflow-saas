/**
 * Pure analytics helpers: filter validation, date bucketing, and
 * aggregation math over plain row shapes.
 *
 * Framework-free and dependency-free: safe to import from unit tests via
 * Node type-stripping. The server lib (`analytics.ts`) performs the
 * tenant-scoped reads and delegates all computation here so every number
 * on the dashboard is covered without a database.
 */

export const ANALYTICS_STATUSES = ["NEW", "CONTACTED", "INTERESTED", "FOLLOW_UP", "CONVERTED", "LOST"] as const;

export const ANALYTICS_DATE_PRESETS = ["7", "14", "30", "90"] as const;
export const ANALYTICS_DEFAULT_DAYS = 30;
export const ANALYTICS_MAX_DAYS = 365;

export interface AnalyticsQuery {
  /** Inclusive UTC day bounds derived from from/to (or a day preset). */
  fromDay: string;
  toDay: string;
  /** Case-insensitive substring matches; "" disables the filter. */
  campaign: string;
  adSet: string;
  ad: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function toDayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function isRealDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const ms = toDayStartMs(day);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === day;
}

/**
 * Validate analytics filter params. All optional; invalid values fall back
 * to defaults (last 30 days, no funnel filters) instead of erroring, so a
 * hand-edited URL never breaks the page.
 */
export function validateAnalyticsQuery(
  input: Record<string, string | string[] | undefined>,
  nowMs = Date.now()
): AnalyticsQuery {
  const campaign = firstParam(input["campaign"]).trim().slice(0, 200);
  const adSet = firstParam(input["adSet"]).trim().slice(0, 200);
  const ad = firstParam(input["ad"]).trim().slice(0, 200);

  const today = new Date(nowMs).toISOString().slice(0, 10);
  let fromDay = today;
  let toDay = today;

  const rawFrom = firstParam(input["from"]).trim();
  const rawTo = firstParam(input["to"]).trim();
  if (isRealDay(rawFrom) && isRealDay(rawTo)) {
    fromDay = rawFrom <= rawTo ? rawFrom : rawTo;
    toDay = rawFrom <= rawTo ? rawTo : rawFrom;
  } else {
    const daysRaw = firstParam(input["days"]).trim();
    const days = (ANALYTICS_DATE_PRESETS as readonly string[]).includes(daysRaw)
      ? Number.parseInt(daysRaw, 10)
      : ANALYTICS_DEFAULT_DAYS;
    const span = Math.min(Math.max(days, 1), ANALYTICS_MAX_DAYS);
    toDay = today;
    fromDay = new Date(toDayStartMs(today) - (span - 1) * 86_400_000).toISOString().slice(0, 10);
  }

  // Clamp absurd ranges (e.g. from=2001) to at most a year ending today.
  if (toDayStartMs(toDay) - toDayStartMs(fromDay) > (ANALYTICS_MAX_DAYS - 1) * 86_400_000) {
    fromDay = new Date(toDayStartMs(toDay) - (ANALYTICS_MAX_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  if (toDay > today) {
    const shift = toDayStartMs(toDay) - toDayStartMs(today);
    toDay = today;
    fromDay = new Date(toDayStartMs(fromDay) - shift).toISOString().slice(0, 10);
  }

  return { fromDay, toDay, campaign, adSet, ad };
}

/** UTC day bucket "YYYY-MM-DD" for an ISO timestamp. */
export function dayBucket(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 0–100 percentage rounded to 1 decimal, or null when the base is 0. */
export function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

export interface AnalyticsLeadRow {
  id: string;
  status: string;
  source: string | null;
  campaignName: string | null;
  adSetName: string | null;
  adName: string | null;
  assignedTo: string | null;
  createdAt: string;
}

export interface AnalyticsFollowUpRow {
  id: string;
  leadId: string;
  assignedTo: string | null;
  scheduledAt: string;
  status: string;
}

/** In-range (by createdAt day) + funnel-filter match. Archived rows are excluded upstream. */
export function leadInScope(row: AnalyticsLeadRow, query: AnalyticsQuery): boolean {
  const day = dayBucket(row.createdAt);
  if (!day || day < query.fromDay || day > query.toDay) return false;
  const match = (value: string | null, needle: string): boolean =>
    needle === "" || (value ?? "").toLowerCase().includes(needle.toLowerCase());
  return (
    match(row.campaignName, query.campaign) &&
    match(row.adSetName, query.adSet) &&
    match(row.adName, query.ad)
  );
}

export interface DayBucket {
  day: string;
  count: number;
}

/** One bucket per day from fromDay..toDay inclusive (zero-filled). */
export function bucketLeadsByDay(rows: AnalyticsLeadRow[], query: AnalyticsQuery): DayBucket[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!leadInScope(row, query)) continue;
    const day = dayBucket(row.createdAt);
    if (!day) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const out: DayBucket[] = [];
  for (let ms = toDayStartMs(query.fromDay); ms <= toDayStartMs(query.toDay); ms += 86_400_000) {
    const day = new Date(ms).toISOString().slice(0, 10);
    out.push({ day, count: counts.get(day) ?? 0 });
  }
  return out;
}

export interface FunnelSlice {
  key: string;
  count: number;
  converted: number;
  conversionRate: number | null;
}

function funnelSlices(
  rows: AnalyticsLeadRow[],
  query: AnalyticsQuery,
  pick: (row: AnalyticsLeadRow) => string | null
): FunnelSlice[] {
  const byKey = new Map<string, { count: number; converted: number }>();
  for (const row of rows) {
    if (!leadInScope(row, query)) continue;
    const key = (pick(row) ?? "").trim() || "Unknown";
    const slot = byKey.get(key) ?? { count: 0, converted: 0 };
    slot.count += 1;
    if (row.status === "CONVERTED") slot.converted += 1;
    byKey.set(key, slot);
  }
  return [...byKey.entries()]
    .map(([key, v]) => ({ key, count: v.count, converted: v.converted, conversionRate: rate(v.converted, v.count) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function groupBySource(rows: AnalyticsLeadRow[], query: AnalyticsQuery): FunnelSlice[] {
  return funnelSlices(rows, query, (r) => r.source);
}

export function groupByCampaign(rows: AnalyticsLeadRow[], query: AnalyticsQuery): FunnelSlice[] {
  return funnelSlices(rows, query, (r) => r.campaignName);
}

export function groupByAdSet(rows: AnalyticsLeadRow[], query: AnalyticsQuery): FunnelSlice[] {
  return funnelSlices(rows, query, (r) => r.adSetName);
}

export function groupByAd(rows: AnalyticsLeadRow[], query: AnalyticsQuery): FunnelSlice[] {
  return funnelSlices(rows, query, (r) => r.adName);
}

export interface AgentSlice {
  userId: string;
  assigned: number;
  converted: number;
  conversionRate: number | null;
  followUpsCompleted: number;
  followUpsTotal: number;
  followUpCompletionRate: number | null;
}

/**
 * Per-agent rollup over in-scope leads. Follow-up counts are joined by
 * lead assignment (agent responsible for the lead), completed = COMPLETED.
 */
export function rollUpAgents(
  rows: AnalyticsLeadRow[],
  followUps: AnalyticsFollowUpRow[],
  query: AnalyticsQuery
): AgentSlice[] {
  const inScopeIds = new Set<string>();
  const byAgent = new Map<string, { assigned: number; converted: number }>();
  for (const row of rows) {
    if (!leadInScope(row, query)) continue;
    inScopeIds.add(row.id);
    if (!row.assignedTo) continue;
    const slot = byAgent.get(row.assignedTo) ?? { assigned: 0, converted: 0 };
    slot.assigned += 1;
    if (row.status === "CONVERTED") slot.converted += 1;
    byAgent.set(row.assignedTo, slot);
  }
  const fuByAgent = new Map<string, { completed: number; total: number }>();
  for (const fu of followUps) {
    if (!inScopeIds.has(fu.leadId)) continue;
    const lead = rows.find((r) => r.id === fu.leadId);
    const owner = lead?.assignedTo;
    if (!owner) continue;
    const slot = fuByAgent.get(owner) ?? { completed: 0, total: 0 };
    slot.total += 1;
    if (fu.status === "COMPLETED") slot.completed += 1;
    fuByAgent.set(owner, slot);
  }
  const ids = new Set([...byAgent.keys(), ...fuByAgent.keys()]);
  return [...ids]
    .map((userId) => {
      const leads = byAgent.get(userId) ?? { assigned: 0, converted: 0 };
      const fu = fuByAgent.get(userId) ?? { completed: 0, total: 0 };
      return {
        userId,
        assigned: leads.assigned,
        converted: leads.converted,
        conversionRate: rate(leads.converted, leads.assigned),
        followUpsCompleted: fu.completed,
        followUpsTotal: fu.total,
        followUpCompletionRate: rate(fu.completed, fu.total),
      };
    })
    .sort((a, b) => b.assigned - a.assigned || a.userId.localeCompare(b.userId));
}

export interface FollowUpCompletion {
  total: number;
  completed: number;
  pending: number;
  overdue: number;
  completionRate: number | null;
}

/** Completion over follow-ups attached to in-scope leads. */
export function summarizeFollowUps(
  rows: AnalyticsLeadRow[],
  followUps: AnalyticsFollowUpRow[],
  query: AnalyticsQuery,
  nowMs = Date.now()
): FollowUpCompletion {
  const inScopeIds = new Set(rows.filter((r) => leadInScope(r, query)).map((r) => r.id));
  let total = 0;
  let completed = 0;
  let overdue = 0;
  for (const fu of followUps) {
    if (!inScopeIds.has(fu.leadId)) continue;
    total += 1;
    if (fu.status === "COMPLETED") completed += 1;
    else if (fu.status === "PENDING" && Number.isFinite(Date.parse(fu.scheduledAt)) && Date.parse(fu.scheduledAt) < nowMs) {
      overdue += 1;
    }
  }
  return {
    total,
    completed,
    pending: total - completed,
    overdue,
    completionRate: rate(completed, total),
  };
}
