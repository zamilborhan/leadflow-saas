import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { StatCard } from "@/src/components/ui/stat-card";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { getRevenueSummary } from "@/src/lib/admin/billing";
import { listPaymentsAdmin } from "@/src/lib/admin/payments";
import { formatBDT } from "@/src/components/admin/format";

export const metadata = { title: "Billing — Super-admin — LeadFlow BD" };

/** Billing command center: real MRR/ARR, transactions. No card data ever. */
export default async function AdminBillingPage() {
  await requireSuperAdminForPage("/admin/billing");
  const [summary, payments] = await Promise.all([getRevenueSummary(), listPaymentsAdmin({ pageSize: 10 })]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Billing" description="Revenue state and transaction history from verified payment rows." eyebrow="Super-admin" />
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="MRR" value={formatBDT(summary.mrrMinor)} hint="Active plans at catalog price" />
        <StatCard label="ARR" value={formatBDT(summary.arrMinor)} hint="MRR × 12" />
        <StatCard label="Total Revenue" value={formatBDT(summary.totalRevenueMinor)} hint="Successful payments" />
        <StatCard label="Active Subscriptions" value={String(summary.activeSubscriptions)} hint={`${summary.newSubscriptionsMonth} new this month`} />
        <StatCard label="Past Due" value={String(summary.pastDue)} hint="Needs collection" tone={summary.pastDue > 0 ? "warning" : "neutral"} />
        <StatCard label="Cancelled" value={String(summary.cancelled)} hint="Status CANCELED" />
        <StatCard label="Failed Payments" value={String(summary.failedPayments)} hint="Needs review" tone={summary.failedPayments > 0 ? "danger" : "neutral"} />
        <StatCard label="Refunds" value="Not tracked" hint="No refund model in schema" tone="neutral" />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>Recent transactions</CardTitle>
          <CardDescription>Latest {payments.payments.length} of {payments.total} payment rows. Full history lives under Payments.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-slate-100 text-sm">
            {payments.payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="font-medium text-slate-900">{p.businessName ?? p.businessId.slice(0, 8)}</span>
                  <span className="block truncate text-xs text-slate-500">{p.tranId} · {p.planCode} · {p.status}</span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums">{formatBDT(p.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
