"use client";

/** Dashboard error island: one failing widget never freezes navigation. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col gap-6" role="alert">
      <div className="rounded-[14px] border border-red-200 bg-red-50 px-4 py-5 text-center">
        <h2 className="text-base font-semibold text-red-900">This section couldn&apos;t load</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-red-700">
          {error.message || "Something went wrong while loading the dashboard. Your other pages still work."}
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 inline-flex h-9 cursor-pointer items-center rounded-lg bg-red-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-700"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
