import { PipelineSkeleton } from "@/src/components/ui/skeletons";

/** Follow-ups route skeleton: column shapes with stable heights. */
export default function FollowUpsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div role="status" aria-label="Loading follow-ups">
        <div className="skeleton-shimmer h-3 w-24 rounded" aria-hidden="true" />
        <div className="skeleton-shimmer mt-2 h-7 w-52 rounded" aria-hidden="true" />
      </div>
      <PipelineSkeleton />
    </div>
  );
}
