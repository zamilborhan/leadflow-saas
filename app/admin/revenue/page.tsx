import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { StatCard } from "@/src/components/ui/stat-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { getRevenueByPlan, getRevenueSeries, getRevenueSummary } from "@/src/lib/admin/billing";
import { formatBDT } from "@/src/components/admin/format";

export const metadata = { title: "Revenue — Super-admin — LeadFlow BD" };

/** Revenue analytics from actual payment/subscription data. */
export default async function AdminRevenuePage() {
  await requireSuperAdminForPage("/admin/revenue");
  const [summary, byPlan, series] = await Promise.all([
    getRevenueSummary(),
    getRevenueByPlan(),
    getRevenueSeries(12),
  ]);
  const max = Math.max(...series.map((s) => s.revenueMinor), 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Revenue analytics" description="MRR, growth, plan mix, and churn from live data." eyebrow="Super-admin" />
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="MRR" value={formatBDT(summary.mrrMinor)} hint="Active subscriptions" />
        <StatCard label="ARR" value={formatBDT(summary.arrMinor)} hint="MRR × 12" />
        <StatCard label="New (month)" value={String(summary.newSubscriptionsMonth)} hint="Activations this month" />
        <StatCard label="Churned" value={String(summary.cancelled)} hint="Canceled subscriptions" />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>Revenue by month</CardTitle>
          <CardDescription>Successful payments, server-aggregated (12 months).</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 font-mono text-xs text-slate-600">
            {series.map((s) => (
              <li key={s.month} className="flex items-center gap-3">
                <span className="w-16 shrink-0">{s.month}</span>
                <span aria-hidden="true" className="text-emerald-600">
                  {"█".repeat(max > 0 ? Math.max(s.revenueMinor > 0 ? 1 : 0, Math.round((s.revenueMinor / max) * 16)) : 0)}
                </span>
                <span className="tabular-nums">{formatBDT(s.revenueMinor)} · {s.newSubscriptions} new subs</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Revenue by plan</CardTitle>
          <CardDescription>Active-subscriber mix at catalog price.</CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead>Subscribers</TableHead>
              <TableHead>MRR</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {byPlan.map((p) => (
              <TableRow key={p.planCode}>
                <TableCell className="font-medium text-slate-900">
                  {p.planName} <span className="ml-1 text-xs font-normal text-slate-400">{p.planCode}</span>
                </TableCell>
                <TableCell><Badge variant={p.subscribers > 0 ? "brand" : "neutral"}>{String(p.subscribers)}</Badge></TableCell>
                <TableCell className="tabular-nums">{formatBDT(p.mrrMinor)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
