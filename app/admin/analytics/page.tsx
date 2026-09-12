import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { StatCard } from "@/src/components/ui/stat-card";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { allOrEmpty } from "@/src/lib/admin/query";
import {
  BusinessTable,
  LeadTable,
  PaymentTable,
  SubscriptionTable,
  UserTable,
} from "@/src/prisma/tables";

export const metadata = { title: "Analytics — Super-admin — LeadFlow BD" };

function monthBuckets(months: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function keyOf(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function bar(value: number, max: number): string {
  if (max <= 0) return "";
  return "█".repeat(Math.max(value > 0 ? 1 : 0, Math.round((value / max) * 16)));
}

/**
 * Platform growth analytics. Aggregated server-side into monthly buckets
 * (12 points max) so the browser never receives raw datasets.
 */
export default async function AdminAnalyticsPage() {
  await requireSuperAdminForPage("/admin/analytics");
  const [users, businesses, leads, subscriptions, payments] = await Promise.all([
    allOrEmpty(UserTable.select("id", "createdAt").all()),
    allOrEmpty(BusinessTable.select("id", "createdAt").all()),
    allOrEmpty(LeadTable.select("id", "createdAt").all()),
    allOrEmpty(SubscriptionTable.select("businessId", "createdAt").all()),
    allOrEmpty(PaymentTable.select("id", "amountMinor", "status", "createdAt").all()),
  ]);
  const months = monthBuckets(12);
  const count = (rows: Array<{ createdAt: string }>) => {
    const m = new Map(months.map((k) => [k, 0]));
    for (const r of rows) {
      const k = keyOf(r.createdAt);
      if (k && m.has(k)) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return months.map((k) => ({ month: k, value: m.get(k) ?? 0 }));
  };
  const revenue = (() => {
    const m = new Map(months.map((k) => [k, 0]));
    for (const p of payments) {
      if (p.status !== "SUCCESS") continue;
      const k = keyOf(p.createdAt);
      if (k && m.has(k)) m.set(k, (m.get(k) ?? 0) + p.amountMinor);
    }
    return months.map((k) => ({ month: k, value: m.get(k) ?? 0 }));
  })();

  const series: Array<{ title: string; description: string; rows: Array<{ month: string; value: number }>; format?: (v: number) => string }> = [
    { title: "User growth", description: "New registrations per month.", rows: count(users) },
    { title: "Workspace growth", description: "New workspaces per month.", rows: count(businesses) },
    { title: "Lead growth", description: "New leads per month.", rows: count(leads) },
    { title: "Subscription growth", description: "New subscriptions per month.", rows: count(subscriptions) },
    {
      title: "Revenue growth",
      description: "Successful payments per month (BDT minor units).",
      rows: revenue,
      format: (v) => `৳${(v / 100).toLocaleString("en-US")}`,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Platform analytics" description="Trailing 12-month growth, aggregated server-side." eyebrow="Super-admin" />
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Users (12m)" value={String(users.length)} hint="Total registered" />
        <StatCard label="Workspaces (12m)" value={String(businesses.length)} hint="Total created" />
        <StatCard label="Leads (12m)" value={String(leads.length)} hint="Total created" />
        <StatCard label="Revenue (12m)" value={`৳${(revenue.reduce((a, r) => a + r.value, 0) / 100).toLocaleString("en-US")}`} hint="Successful payments" />
      </section>
      {series.map((s) => {
        const max = Math.max(...s.rows.map((r) => r.value), 0);
        return (
          <Card key={s.title}>
            <CardHeader>
              <CardTitle>{s.title}</CardTitle>
              <CardDescription>{s.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 font-mono text-xs text-slate-600">
                {s.rows.map((r) => (
                  <li key={r.month} className="flex items-center gap-3">
                    <span className="w-16 shrink-0">{r.month}</span>
                    <span aria-hidden="true" className="text-brand-600">{bar(r.value, max)}</span>
                    <span className="tabular-nums">{s.format ? s.format(r.value) : String(r.value)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-slate-400">
                Date ranges (today / 7d / 30d / 90d / custom) are a follow-up: bucket by day/week
                from the same server aggregation. Previous-period comparison ships on the Overview page.
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
