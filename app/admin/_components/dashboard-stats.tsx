import Link from "next/link";
import { StatCard } from "@/src/components/ui/stat-card";
import { formatBDT } from "@/src/components/admin/format";
import { getDashboardStats } from "@/src/lib/admin/metrics";

/**
 * Six compact KPI cards. Streams in via Suspense; a failed fetch renders
 * a lightweight inline error with a retry link (no full-page spinner,
 * no client JS).
 */
export async function DashboardStats(): Promise<React.JSX.Element> {
  const stats = await getDashboardStats().catch(() => null);
  if (!stats) {
    return (
      <section aria-label="Platform metrics error" className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center">
        <p className="text-sm font-medium text-slate-700">Unable to load metrics.</p>
        <Link href="/admin" className="mt-1 inline-block text-sm font-semibold text-brand-700 hover:underline">
          Retry
        </Link>
      </section>
    );
  }
  return (
    <section aria-label="Platform metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatCard label="Total Users" value={String(stats.totalUsers)} hint="Registered logins" />
      <StatCard label="Active Users" value={String(stats.activeUsers)} hint="ACTIVE status" />
      <StatCard label="Workspaces" value={String(stats.workspaces)} hint="Businesses" />
      <StatCard label="Active Subscriptions" value={String(stats.activeSubscriptions)} hint="Live workspaces" />
        <StatCard label="Monthly Revenue" value={formatBDT(stats.mrrMinor)} hint="MRR · live workspaces" />
      <StatCard label="New Users" value={String(stats.newUsers)} hint="Trailing 7 days" />
    </section>
  );
}
