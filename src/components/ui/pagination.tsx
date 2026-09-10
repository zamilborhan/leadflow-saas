import { cn } from "@/src/lib/cn";

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}

/** Compact page window: first, last, and neighbors of the current page. */
function pageWindow(current: number, totalPages: number): Array<number | "…"> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const keep = new Set([1, 2, current - 1, current, current + 1, totalPages - 1, totalPages]);
  const sorted = [...keep].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  let prev = 0;
  for (const n of sorted) {
    if (n - prev > 1) out.push("…");
    out.push(n);
    prev = n;
  }
  return out;
}

/** Accessible controlled pagination with result summary. */
export function Pagination({ page, pageSize, total, onChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);

  const btn =
    "inline-flex h-9 min-w-9 cursor-pointer items-center justify-center rounded-lg px-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <nav aria-label="Pagination" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-slate-500" aria-live="polite">
        Showing <span className="font-medium text-slate-700">{from}–{to}</span> of{" "}
        <span className="font-medium text-slate-700">{total}</span> results
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={btn}
          disabled={current <= 1}
          onClick={() => onChange(current - 1)}
          aria-label="Go to previous page"
        >
          <svg aria-hidden="true" className="size-4" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {pageWindow(current, totalPages).map((n, i) =>
          n === "…" ? (
            <span key={`gap-${i}`} aria-hidden="true" className="px-1 text-sm text-slate-400">
              …
            </span>
          ) : (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              aria-label={`Go to page ${n}`}
              aria-current={n === current ? "page" : undefined}
              className={cn(btn, n === current && "bg-slate-900 font-semibold text-white hover:bg-slate-900")}
            >
              {n}
            </button>
          )
        )}
        <button
          type="button"
          className={btn}
          disabled={current >= totalPages}
          onClick={() => onChange(current + 1)}
          aria-label="Go to next page"
        >
          <svg aria-hidden="true" className="size-4" viewBox="0 0 16 16" fill="none">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
