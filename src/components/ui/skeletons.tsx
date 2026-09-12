import { cn } from "@/src/lib/cn";

/**
 * Performance-first loading shapes: fixed heights / widths so skeletons
 * reserve the same space as real content (CLS ≤ 0.1). All decorative
 * (`aria-hidden`), announced once via the parent `role="status"`.
 */

function Bar({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("skeleton-shimmer rounded", className)} />;
}

export function KpiSkeletonGrid({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading metrics" className={className ?? cn("grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4")}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} aria-hidden="true" className="rounded-[14px] border border-slate-200 bg-white p-5">
          <Bar className="h-3 w-20" />
          <Bar className="mt-3 h-8 w-16" />
          <Bar className="mt-3 h-2.5 w-3/4" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading table" className="flex flex-col gap-2 p-5">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} aria-hidden="true" className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <Bar key={c} className={cn("h-9 flex-1", c === 0 && "max-w-48")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function PipelineSkeleton() {
  return (
    <div role="status" aria-label="Loading pipeline" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} aria-hidden="true" className="rounded-[14px] border border-slate-200 bg-white p-5">
          <Bar className="h-4 w-28" />
          <div className="mt-4 flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, j) => (
              <Bar key={j} className="h-14 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ title = "Loading chart" }: { title?: string }) {
  return (
    <div role="status" aria-label={title} className="rounded-[14px] border border-slate-200 bg-white p-5">
      <Bar className="h-4 w-40" />
      <Bar className="mt-2 h-3 w-56" />
      <div aria-hidden="true" className="mt-4 flex h-44 items-end gap-1.5">
        {Array.from({ length: 14 }).map((_, i) => (
          <div
            key={i}
            className="skeleton-shimmer w-full flex-1 rounded-t"
            style={{ height: `${18 + ((i * 37) % 70)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export function SearchSkeleton() {
  return (
    <div role="status" aria-label="Loading filters" className="flex flex-col gap-3 px-5 py-4 sm:px-6 lg:flex-row">
      <Bar className="h-10 flex-1 lg:max-w-xs" />
      <div aria-hidden="true" className="flex gap-3">
        <Bar className="h-10 w-36" />
        <Bar className="hidden h-10 w-36 sm:block" />
      </div>
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div>
        <Bar className="h-3 w-24" />
        <Bar className="mt-2 h-7 w-64" />
        <Bar className="mt-2 h-4 w-96 max-w-full" />
      </div>
      <KpiSkeletonGrid count={4} />
      <TableSkeleton />
    </div>
  );
}
