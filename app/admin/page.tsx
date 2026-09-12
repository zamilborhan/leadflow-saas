import { Suspense } from "react";
import { PageHeader } from "@/src/components/ui/page-header";
import { ChartSkeleton, KpiSkeletonGrid } from "@/src/components/ui/skeletons";
import { Skeleton } from "@/src/components/ui/states";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { DashboardStats } from "./_components/dashboard-stats";
import { GrowthChart } from "./_components/growth-chart";
import { RecentActivity } from "./_components/recent-activity";

export const metadata = { title: "Dashboard — Super-admin — LeadFlow" };

function ActivitySkeleton(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading activity" className="rounded-xl border border-slate-200 bg-white p-5">
      <Skeleton className="h-4 w-32" />
      <div className="mt-4 flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
}

/**
 * Lean command dashboard: 6 KPI cards, revenue chart, recent activity.
 * The shell streams immediately; each section has its own Suspense
 * boundary with a size-stable skeleton (no layout shift, no full-page
 * spinner, zero client JavaScript).
 */
export default async function AdminOverviewPage() {
  await requireSuperAdminForPage("/admin");
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Dashboard"
        description="Platform at a glance."
        eyebrow="Super-admin"
      />
      <Suspense fallback={<KpiSkeletonGrid count={6} className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" />}>
        <DashboardStats />
      </Suspense>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <Suspense fallback={<ChartSkeleton />}>
            <GrowthChart />
          </Suspense>
        </div>
        <div className="xl:col-span-2">
          <Suspense fallback={<ActivitySkeleton />}>
            <RecentActivity />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
