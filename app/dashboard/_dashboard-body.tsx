import { getBusinessDashboard, type DashboardLead } from "@/src/lib/tenancy/dashboard";
import { Badge } from "@/src/components/ui/badge";
import { ButtonLink } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { StatCard, StatIcons } from "@/src/components/ui/stat-card";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";

const STATUS_BADGE: Record<string, "brand" | "info" | "warning" | "success" | "neutral"> = {
  NEW: "brand",
  CONTACTED: "info",
  INTERESTED: "warning",
  FOLLOW_UP: "warning",
  CONVERTED: "success",
  LOST: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  INTERESTED: "Interested",
  FOLLOW_UP: "Follow-up",
  CONVERTED: "Converted",
  LOST: "Lost",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function FunnelChart({ stages }: { stages: Array<{ label: string; value: number; tone: string }> }) {
  const max = Math.max(...stages.map((s) => s.value), 1);
  return (
    <div className="flex flex-col gap-2.5" role="img" aria-label="Pipeline by stage">
      {stages.map((s) => (
        <div key={s.label} className="grid grid-cols-[92px_1fr_40px] items-center gap-2 text-xs">
          <span className="truncate font-medium text-slate-600">{s.label}</span>
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${s.tone}`}
              style={{ width: `${Math.max(s.value > 0 ? 6 : 0, Math.round((s.value / max) * 100))}%` }}
            />
          </div>
          <span className="text-right font-bold text-slate-900 tabular-nums">{s.value}</span>
        </div>
      ))}
    </div>
  );
}

function ChartPlaceholder({ bars }: { bars: number[] }) {
  const max = Math.max(...bars, 1);
  return (
    <div aria-hidden="true" className="flex h-32 items-end gap-1.5">
      {bars.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-t bg-brand-100"
          style={{ height: `${Math.max(8, Math.round((v / max) * 100))}%` }}
        />
      ))}
    </div>
  );
}

function LeadStatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_BADGE[status] ?? "neutral"} dot>{STATUS_LABEL[status] ?? status}</Badge>;
}

function FollowUpWidget({
  title,
  items,
  businessId,
  urgent,
  emptyHint,
}: {
  title: string;
  items: Array<{ id: string; leadId: string; leadName: string; scheduledAt: string; note: string | null }>;
  businessId: string;
  urgent?: boolean;
  emptyHint: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium text-slate-500">{title}</p>
          <a
            href={`/dashboard/follow-ups?businessId=${businessId}`}
            className="text-xs font-semibold text-brand-700 hover:text-brand-800 hover:underline"
          >
            View all
          </a>
        </div>
        <p className={`mt-1 text-3xl font-bold ${urgent && items.length > 0 ? "text-red-600" : "text-slate-900"}`}>
          {items.length}
        </p>
        {items.length === 0 ? (
          <p className="mt-1 text-xs text-slate-400">{emptyHint}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3">
            {items.slice(0, 5).map((f) => (
              <li key={f.id} className="flex items-baseline justify-between gap-3 text-sm">
                <a
                  href={`/dashboard/leads/${f.leadId}?businessId=${businessId}`}
                  className="truncate font-medium text-slate-800 hover:text-brand-700 hover:underline"
                >
                  {f.leadName}
                </a>
                <span className="shrink-0 text-xs text-slate-400">{formatDate(f.scheduledAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RecentLeadsTable({ leads, businessId }: { leads: DashboardLead[]; businessId: string }) {
  if (leads.length === 0) {
    return (
      <EmptyState
        title="No leads yet"
        description="Connect Facebook Lead Ads or add your first lead manually to get started."
        action={<ButtonLink href={`/dashboard/leads?businessId=${businessId}`} size="sm">Go to Leads</ButtonLink>}
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Assigned to</TableHead>
          <TableHead>Added</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {leads.map((lead) => (
          <TableRow key={lead.id}>
            <TableCell className="font-medium text-slate-900">
              {lead.name}
              {lead.email ? <span className="block text-xs font-normal text-slate-500">{lead.email}</span> : null}
            </TableCell>
            <TableCell>
              <LeadStatusBadge status={lead.status} />
            </TableCell>
            <TableCell>{lead.source ?? "—"}</TableCell>
            <TableCell>{lead.assigneeName ?? "—"}</TableCell>
            <TableCell className="whitespace-nowrap">{formatDate(lead.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Streamed dashboard body: KPIs + follow-ups + funnel + recent leads.
 * Rendered inside `<Suspense>` so the page header paints first and this
 * streams in when the (now parallel + batched) dashboard query resolves.
 * Returns null-state via redirect contract of the caller on no-business.
 */
export async function DashboardBody({ userId, requestedBusinessId }: { userId: string; requestedBusinessId: string | null }) {
  const result = await getBusinessDashboard(userId, requestedBusinessId);
  if (!result.ok) return null;

  const { business, stats, recentLeads, followUps } = result.dashboard;
  const rate = stats.conversionRate === null ? "—" : `${stats.conversionRate.toFixed(1)}%`;
  const dueToday = followUps.today.length;
  const overdue = followUps.overdue.length;

  const funnel = [
    { label: "New", value: stats.fresh, tone: "bg-brand-500" },
    { label: "Contacted", value: stats.contacted, tone: "bg-sky-500" },
    { label: "Interested", value: stats.interested, tone: "bg-amber-500" },
    { label: "Follow-up", value: stats.followUp, tone: "bg-violet-500" },
    { label: "Converted", value: stats.converted, tone: "bg-emerald-500" },
    { label: "Lost", value: stats.lost, tone: "bg-slate-300" },
  ];

  return (
    <div className="flex flex-col gap-6" data-dashboard-body={business.id}>
      <section aria-label="Lead metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total leads" value={String(stats.total)} hint="Active leads in this workspace" icon={StatIcons.total} tone="brand" />
        <StatCard label="New leads" value={String(stats.fresh)} hint="Awaiting first contact" icon={StatIcons.fresh} tone="info" />
        <StatCard label="Follow-ups due" value={String(dueToday + overdue)} hint={overdue > 0 ? `${overdue} overdue` : "On schedule"} icon={StatIcons.followUp} tone={overdue > 0 ? "danger" : "warning"} />
        <StatCard label="Converted leads" value={String(stats.converted)} hint="Won deals" icon={StatIcons.converted} tone="success" />
        <StatCard label="Contacted leads" value={String(stats.contacted)} hint="First touch made" icon={StatIcons.contacted} tone="info" />
        <StatCard label="Interested leads" value={String(stats.interested)} hint="Prospects showing interest" icon={StatIcons.interested} tone="warning" />
        <StatCard label="Lost leads" value={String(stats.lost)} hint="Closed without conversion" icon={StatIcons.lost} tone="neutral" />
        <StatCard label="Conversion rate" value={rate} hint={stats.conversionRate === null ? "No leads yet" : "Converted ÷ total leads"} icon={StatIcons.rate} tone="brand" />
      </section>

      <section aria-label="Follow-ups" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FollowUpWidget
          title="Today's follow-ups"
          items={followUps.today}
          businessId={business.id}
          emptyHint="Nothing scheduled for today."
        />
        <FollowUpWidget
          title="Overdue follow-ups"
          items={followUps.overdue}
          businessId={business.id}
          urgent
          emptyHint="Nothing overdue. Nice work."
        />
      </section>

      <section aria-label="Pipeline and reports" className="cv-auto grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="sm:col-span-2 lg:col-span-1">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Conversion funnel</CardTitle>
              <Badge variant="success" dot>Live</Badge>
            </div>
            <CardDescription>Real stage counts for this workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            {stats.total === 0 ? (
              <EmptyState
                title="No pipeline data yet"
                description="Add leads to see your live conversion funnel."
                action={<ButtonLink href={`/dashboard/leads?businessId=${business.id}`} size="sm">Add your first lead</ButtonLink>}
              />
            ) : (
              <FunnelChart stages={funnel} />
            )}
          </CardContent>
        </Card>
        {[
          { title: "Leads by day", description: "Daily intake for the last 14 days.", bars: [4, 7, 5, 9, 6, 11, 8, 5, 7, 10, 6, 9, 7, 12] },
          { title: "Conversion by campaign", description: "Which campaigns turn into customers.", bars: [9, 5, 11, 7, 4, 8] },
        ].map((c) => (
          <Card key={c.title}>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>{c.title}</CardTitle>
                <Badge variant="neutral">Preview</Badge>
              </div>
              <CardDescription>{c.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <ChartPlaceholder bars={c.bars} />
              <p className="mt-3 text-xs text-slate-400">
                <a
                  href={`/dashboard/analytics?businessId=${business.id}`}
                  className="font-semibold text-brand-700 hover:text-brand-800 hover:underline"
                >
                  Open live analytics →
                </a>
              </p>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Recent leads</CardTitle>
          <CardDescription>Latest prospects in this workspace.</CardDescription>
        </CardHeader>
        <RecentLeadsTable leads={recentLeads} businessId={business.id} />
      </Card>
    </div>
  );
}
