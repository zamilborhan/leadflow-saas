import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { getBusinessAnalytics } from "@/src/lib/tenancy/analytics";
import type { AnalyticsQuery } from "@/src/lib/tenancy/validation";
import type { FunnelSlice } from "@/src/lib/tenancy/analytics-core";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";

function formatDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function formatPct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <p className="mt-1 text-3xl font-bold text-slate-900">{value}</p>
        <p className="mt-1 text-xs text-slate-400">{hint}</p>
      </CardContent>
    </Card>
  );
}

function DailyChart({ buckets }: { buckets: Array<{ day: string; count: number }> }) {
  const max = Math.max(...buckets.map((b) => b.count), 1);
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const step = Math.max(1, Math.ceil(buckets.length / 14));
  if (total === 0) {
    return <EmptyState title="No leads in this range" description="Widen the date range or clear the funnel filters." />;
  }
  return (
    <div role="img" aria-label={`Leads per day, ${total} total across ${buckets.length} days`} className="flex h-44 items-end gap-1">
      {buckets.map((b, i) => (
        <div key={b.day} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
          <div
            title={`${b.day}: ${b.count}`}
            className="w-full max-w-8 rounded-t bg-brand-500"
            style={{ height: `${Math.max(b.count === 0 ? 0 : 6, Math.round((b.count / max) * 100))}%` }}
          />
          <span className="truncate text-[10px] text-slate-400" aria-hidden={i % step !== 0}>
            {i % step === 0 ? formatDayLabel(b.day) : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function FunnelBars({ slices, emptyHint }: { slices: FunnelSlice[]; emptyHint: string }) {
  const max = Math.max(...slices.map((s) => s.count), 1);
  if (slices.length === 0) {
    return <EmptyState title="Nothing here yet" description={emptyHint} />;
  }
  return (
    <ul className="flex flex-col gap-3">
      {slices.slice(0, 8).map((s) => (
        <li key={s.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium text-slate-800" title={s.key}>{s.key}</span>
            <span className="shrink-0 text-xs text-slate-500">{s.count} leads · {formatPct(s.conversionRate)} converted</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${s.key}: ${s.count} leads`}>
            <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.round((s.count / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Streamed analytics body: aggregated server-side, capped slices (≤8 per
 * funnel, daily buckets only). Streams behind the header + filter bar.
 */
export async function AnalyticsBody({ userId, businessId, query }: { userId: string; businessId: string; query: AnalyticsQuery }) {
  const resolved = await resolveBusinessContext(userId, businessId).catch(() => null);
  if (!resolved?.ok) return null;
  const analytics = await getBusinessAnalytics(resolved.context, query);
  const rangeLabel = `${formatDayLabel(query.fromDay)} – ${formatDayLabel(query.toDay)}`;
  const funnelActive = query.campaign !== "" || query.adSet !== "" || query.ad !== "";
  const funnelHint = funnelActive ? `Filtered · ${rangeLabel}` : rangeLabel;

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Key metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Total leads" value={String(analytics.kpis.totalLeads)} hint={`Leads created ${rangeLabel}`} />
        <StatCard label="Converted leads" value={String(analytics.kpis.convertedLeads)} hint="Won deals in range" />
        <StatCard label="Conversion rate" value={formatPct(analytics.kpis.conversionRate)} hint={analytics.kpis.conversionRate === null ? "No leads in range" : "Converted ÷ total leads"} />
        <StatCard
          label="Follow-up completion"
          value={formatPct(analytics.kpis.followUpCompletion.completionRate)}
          hint={analytics.kpis.followUpCompletion.total === 0 ? "No follow-ups in range" : `${analytics.kpis.followUpCompletion.completed} of ${analytics.kpis.followUpCompletion.total} completed`}
        />
        <StatCard label="Pending follow-ups" value={String(analytics.kpis.followUpCompletion.pending)} hint="Scheduled or overdue, not completed" />
        <StatCard label="Overdue follow-ups" value={String(analytics.kpis.overdueFollowUps)} hint={analytics.kpis.overdueFollowUps === 0 ? "Nothing overdue. Nice work." : "Past due and still open"} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Leads by day</CardTitle>
          <CardDescription>Daily intake · {rangeLabel}.</CardDescription>
        </CardHeader>
        <CardContent>
          <DailyChart buckets={analytics.leadsByDay} />
        </CardContent>
      </Card>

      <section aria-label="Attribution" className="cv-auto grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Leads by source</CardTitle>
              <Badge variant="neutral">{analytics.leadsBySource.length}</Badge>
            </div>
            <CardDescription>Where prospects come from · {funnelHint}.</CardDescription>
          </CardHeader>
          <CardContent><FunnelBars slices={analytics.leadsBySource} emptyHint="No sources in this range." /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Leads by campaign</CardTitle>
              <Badge variant="neutral">{analytics.leadsByCampaign.length}</Badge>
            </div>
            <CardDescription>Campaign intake and win rate · {funnelHint}.</CardDescription>
          </CardHeader>
          <CardContent><FunnelBars slices={analytics.leadsByCampaign} emptyHint="No campaigns in this range." /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Leads by ad set</CardTitle>
              <Badge variant="neutral">{analytics.leadsByAdSet.length}</Badge>
            </div>
            <CardDescription>Ad set intake and win rate · {funnelHint}.</CardDescription>
          </CardHeader>
          <CardContent><FunnelBars slices={analytics.leadsByAdSet} emptyHint="No ad sets in this range." /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Leads by ad</CardTitle>
              <Badge variant="neutral">{analytics.leadsByAd.length}</Badge>
            </div>
            <CardDescription>Creative-level intake and win rate · {funnelHint}.</CardDescription>
          </CardHeader>
          <CardContent><FunnelBars slices={analytics.leadsByAd} emptyHint="No ads in this range." /></CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Sales-agent performance</CardTitle>
          <CardDescription>Assigned volume, win rate, and follow-up completion per agent.</CardDescription>
        </CardHeader>
        {analytics.agents.length === 0 ? (
          <EmptyState title="No agent activity yet" description="Assign leads to see per-agent performance." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead>Converted</TableHead>
                <TableHead>Conv. rate</TableHead>
                <TableHead>Follow-ups done</TableHead>
                <TableHead>FU completion</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analytics.agents.map((a) => (
                <TableRow key={a.userId}>
                  <TableCell className="font-medium text-slate-900">
                    {a.name ?? a.email ?? "Unknown agent"}
                    {a.email && a.name ? <span className="block text-xs font-normal text-slate-500">{a.email}</span> : null}
                  </TableCell>
                  <TableCell>{a.assigned}</TableCell>
                  <TableCell>{a.converted}</TableCell>
                  <TableCell>{formatPct(a.conversionRate)}</TableCell>
                  <TableCell>{a.followUpsCompleted} of {a.followUpsTotal}</TableCell>
                  <TableCell>{formatPct(a.followUpCompletionRate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
