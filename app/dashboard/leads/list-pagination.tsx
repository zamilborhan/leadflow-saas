"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Pagination } from "@/src/components/ui/pagination";

/** Pagination bound to the list URL (?page=). */
export function LeadListPagination({
  page,
  pageSize,
  total,
}: {
  page: number;
  pageSize: number;
  total: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function onChange(next: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(next));
    router.replace(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="border-t border-slate-100 px-5 py-4 sm:px-6">
      <Pagination page={page} pageSize={pageSize} total={total} onChange={onChange} />
    </div>
  );
}
