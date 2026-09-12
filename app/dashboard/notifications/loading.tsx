import { TableSkeleton } from "@/src/components/ui/skeletons";

/** Notifications route skeleton. */
export default function NotificationsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div role="status" aria-label="Loading notifications">
        <div className="skeleton-shimmer h-3 w-24 rounded" aria-hidden="true" />
        <div className="skeleton-shimmer mt-2 h-7 w-52 rounded" aria-hidden="true" />
      </div>
      <div className="overflow-hidden rounded-[14px] border border-slate-200 bg-white">
        <TableSkeleton rows={6} cols={3} />
      </div>
    </div>
  );
}
