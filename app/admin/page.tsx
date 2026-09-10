import Link from "next/link";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { getPlatformOverview } from "@/src/lib/admin/overview";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";

export const metadata = { title: "Overview — Super-admin — LeadFlow BD" };

export function formatBDT(minor: number): string {
  const major = minor / 100;
  return `৳${major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

/**
 * Platform overview. Rendered under the allowlisted /admin layout —
 * metrics are platform-wide by design (no businessId scoping).
 */
export default async function AdminOverviewPage() {
  // Authorize before fetching: siblings render concurrently, so the
  // layout guard alone cannot stop this query from executing.
  await requireSuperAdminForPage("/admin");
  const overview = await getPlatformOverview();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Platform overview"
        description="Businesses, revenue, pipeline health, and background work across the whole platform."
        eyebrow="Super-admin"
      />

      <section aria-label="Platform metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total businesses" value={String(overview.totalBusinesses)} hint={`${overview.activeBusinesses} active · ${overview.suspendedBusinesses} suspended`} />
        <StatCard label="Active subscriptions" value={String(overview.activeSubscriptions)} hint="Subscriptions currently ACTIVE" />
        <StatCard label="MRR" value={formatBDT(overview.mrrMinor)} hint="Active plans at catalog price" />
        <StatCard label="New businesses" value={String(overview.newBusinesses)} hint="Created in the trailing 30 days" />
        <StatCard label="Churned businesses" value={String(overview.churnedBusinesses)} hint="Subscriptions currently CANCELED" />
        <StatCard label="Total leads" value={String(overview.totalLeads)} hint="Across all workspaces" />
        <StatCard label="Failed jobs" value={String(overview.failedJobs)} hint="Automation jobs needing attention" />
        <StatCard label="Suspended" value={String(overview.suspendedBusinesses)} hint="Workspaces with access revoked" />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Plans</CardTitle>
          <CardDescription>Active subscribers per plan (catalog pricing).</CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead>Subscribers</TableHead>
              <TableHead>
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview.plans.map((p) => (
              <TableRow key={p.code}>
                <TableCell className="font-medium text-slate-900">
                  {p.name} <span className="ml-1 text-xs font-normal text-slate-400">{p.code}</span>
                </TableCell>
                <TableCell>
                  <Badge variant={p.subscribers > 0 ? "brand" : "neutral"}>{String(p.subscribers)}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Link href="/admin/subscriptions" className="text-xs font-semibold text-brand-700 hover:underline">
                    View subscriptions →
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
