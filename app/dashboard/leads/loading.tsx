import { SearchSkeleton, TableSkeleton } from "@/src/components/ui/skeletons";

/** Leads route skeleton: search + table rows with stable heights (no CLS). */
export default function LeadsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div role="status" aria-label="Loading leads">
        <div className="skeleton-shimmer h-3 w-16 rounded" aria-hidden="true" />
        <div className="skeleton-shimmer mt-2 h-7 w-40 rounded" aria-hidden="true" />
      </div>
      <div className="overflow-hidden rounded-[14px] border border-slate-200 bg-white">
        <SearchSkeleton />
        <TableSkeleton rows={8} cols={5} />
      </div>
    </div>
  );
}
