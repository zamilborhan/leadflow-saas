import { ChartSkeleton, KpiSkeletonGrid } from "@/src/components/ui/skeletons";

/** Analytics route skeleton: KPIs first, charts stream behind. */
export default function AnalyticsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div role="status" aria-label="Loading analytics">
        <div className="skeleton-shimmer h-3 w-20 rounded" aria-hidden="true" />
        <div className="skeleton-shimmer mt-2 h-7 w-48 rounded" aria-hidden="true" />
      </div>
      <div className="overflow-hidden rounded-[14px] border border-slate-200 bg-white" aria-hidden="true">
        <div className="skeleton-shimmer m-4 h-10 rounded" />
      </div>
      <KpiSkeletonGrid count={6} />
      <ChartSkeleton title="Loading analytics charts" />
    </div>
  );
}
