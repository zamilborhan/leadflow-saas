import { requireUserForPage } from "@/src/lib/auth/dal";
import { getBusinessDashboard, type DashboardLead } from "@/src/lib/tenancy/dashboard";
import { getSubscriptionView, type SubscriptionView } from "@/src/lib/billing/subscriptions";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { Badge } from "@/src/components/ui/badge";
import { ButtonLink } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { CreateBusinessButton } from "./create-business-button";

export const metadata = {
  title: "Dashboard — LeadFlow BD",
};

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

/** Skeleton bar chart (decorative): stands in for reporting visuals. */
function ChartPlaceholder({ bars }: { bars: number[] }) {
  const max = Math.max(...bars, 1);
  return (
    <div aria-hidden="true" className="flex h-32 items-end gap-1.5">
      {bars.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-t bg-slate-200"
          style={{ height: `${Math.max(8, Math.round((v / max) * 100))}%` }}
        />
      ))}
    </div>
  );
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

function LeadStatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_BADGE[status] ?? "neutral"} dot>{STATUS_LABEL[status] ?? status}</Badge>;
}

/** Plan + live usage strip. Hidden when billing state is unreadable. */
function SubscriptionBanner({ businessId, view }: { businessId: string; view: SubscriptionView }) {
  const { subscription, plan, usage } = view;
  const leadsPct = usage.leadsLimit > 0 ? Math.min(100, Math.round((usage.leadsUsed / usage.leadsLimit) * 100)) : 0;
  const attention = subscription.status !== "ACTIVE" || usage.leadsUsed >= usage.leadsLimit;
  return (
    <Card>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-medium text-slate-500">Plan</p>
          <p className="text-sm font-bold text-slate-900">{plan.name}</p>
          <Badge variant={subscription.status === "ACTIVE" ? "success" : "warning"} dot>
            {subscription.status}
          </Badge>
          <p className="text-sm text-slate-500">
            {usage.leadsUsed} / {usage.leadsLimit} leads this month · {usage.membersUsed} / {usage.membersLimit} members ·
            Renews {formatDate(usage.renewalDate)}
          </p>
          <a
            href={`/dashboard/settings/billing?businessId=${businessId}`}
            className="ml-auto text-xs font-semibold text-brand-700 hover:text-brand-800 hover:underline"
          >
            Manage billing
          </a>
        </div>
        <div
          className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-100"
          role="img"
          aria-label={`Monthly lead usage: ${usage.leadsUsed} of ${usage.leadsLimit}`}
        >
          <div
            className={attention ? "h-full rounded-full bg-red-500" : "h-full rounded-full bg-brand-600"}
            style={{ width: `${leadsPct}%` }}
          />
        </div>
        {attention ? (
          <p className="mt-2 text-xs font-medium text-red-600">
            {subscription.status !== "ACTIVE"
              ? "Subscription needs attention — new leads and invites are paused until reactivated."
              : "Monthly lead allowance is exhausted — new leads are paused until renewal or upgrade."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
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
      <CardContent>
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
 * Workspace overview, scoped to the current business (?businessId= or the
 * user's first workspace). Lead metrics are real; follow-up scheduling and
 * reporting charts are explicit placeholders until their models land.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUserForPage();
  const params = await searchParams;
  const raw = params["businessId"];
  const requested = Array.isArray(raw) ? raw[0] : raw;
  const result = await getBusinessDashboard(user.id, requested ?? null);

  if (!result.ok) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={`Welcome${user.name ? `, ${user.name}` : ""}`}
          description="Create your first workspace to start capturing leads."
        />
        <Card>
          <EmptyState
            title="No workspace yet"
            description="A workspace gives your business its own isolated pipeline, team, and settings."
            action={<CreateBusinessButton />}
          />
        </Card>
      </div>
    );
  }

  const { business, stats, recentLeads, followUps } = result.dashboard;
  const rate = stats.conversionRate === null ? "—" : `${stats.conversionRate.toFixed(1)}%`;
  // Billing strip is decorative — a billing outage must never blank the dashboard.
  const resolved = await resolveBusinessContext(user.id, business.id);
  const billing = resolved.ok ? await getSubscriptionView(resolved.context).catch(() => null) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={business.name}
        description="Live pipeline metrics for this workspace."
        eyebrow="Dashboard"
        actions={
          <>
            <ButtonLink href={`/dashboard/leads?businessId=${business.id}`} variant="outline">
              View leads
            </ButtonLink>
            <ButtonLink href={`/dashboard/leads?businessId=${business.id}`}>Add lead</ButtonLink>
          </>
        }
      />

      {billing ? <SubscriptionBanner businessId={business.id} view={billing} /> : null}

      <section aria-label="Lead metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total leads" value={String(stats.total)} hint="Active leads in this workspace" />
        <StatCard label="New leads" value={String(stats.fresh)} hint="Awaiting first contact" />
        <StatCard label="Contacted leads" value={String(stats.contacted)} hint="First touch made" />
        <StatCard label="Interested leads" value={String(stats.interested)} hint="Prospects showing interest" />
        <StatCard label="Follow-up leads" value={String(stats.followUp)} hint="In active follow-up" />
        <StatCard label="Converted leads" value={String(stats.converted)} hint="Won deals" />
        <StatCard label="Lost leads" value={String(stats.lost)} hint="Closed without conversion" />
        <StatCard label="Conversion rate" value={rate} hint={stats.conversionRate === null ? "No leads yet" : "Converted ÷ total leads"} />
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

      <section aria-label="Reports preview" className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {[
          { title: "Leads by day", description: "Daily intake for the last 14 days.", bars: [4, 7, 5, 9, 6, 11, 8, 5, 7, 10, 6, 9, 7, 12] },
          { title: "Conversion by campaign", description: "Which campaigns turn into customers.", bars: [9, 5, 11, 7, 4, 8] },
          { title: "Sales agent performance", description: "Follow-ups and wins per agent.", bars: [6, 10, 7, 12, 8, 5, 9] },
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
          <CardDescription>Latest prospects in {business.name}.</CardDescription>
        </CardHeader>
        <RecentLeadsTable leads={recentLeads} businessId={business.id} />
      </Card>
    </div>
  );
}
