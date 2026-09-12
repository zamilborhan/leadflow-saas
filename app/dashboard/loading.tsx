import { KpiSkeletonGrid, TableSkeleton } from "@/src/components/ui/skeletons";

/** Dashboard route skeleton: header + KPIs + widgets stream in behind this. */
export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div role="status" aria-label="Loading dashboard">
        <div className="skeleton-shimmer h-3 w-28 rounded" aria-hidden="true" />
        <div className="skeleton-shimmer mt-2 h-7 w-72 max-w-full rounded" aria-hidden="true" />
        <div className="skeleton-shimmer mt-2 h-4 w-96 max-w-full rounded" aria-hidden="true" />
      </div>
      <KpiSkeletonGrid count={8} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-hidden="true">
        <div className="rounded-[14px] border border-slate-200 bg-white p-5">
          <Bar className="h-4 w-32" />
          <Bar className="mt-3 h-8 w-12" />
        </div>
        <div className="rounded-[14px] border border-slate-200 bg-white p-5">
          <Bar className="h-4 w-32" />
          <Bar className="mt-3 h-8 w-12" />
        </div>
      </div>
      <TableSkeleton rows={6} cols={5} />
    </div>
  );
}

function Bar({ className }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton-shimmer rounded ${className ?? ""}`} />;
}
