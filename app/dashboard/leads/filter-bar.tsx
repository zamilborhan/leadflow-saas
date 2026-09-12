"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import { Select } from "@/src/components/ui/select";
import { LEAD_STATUSES, LEAD_STATUS_LABEL, type AgentOption } from "./lead-status";

const SEARCH_DEBOUNCE_MS = 400;

export interface LeadFilters {
  search: string;
  status: string;
  assignee: string;
  archived: string;
  sort: string;
  dir: string;
  pageSize: number;
}

/** Toolbar driving the list URL: search (submit), filters, sort, page size. */
export function LeadFilterBar({
  businessId,
  initial,
  agents,
}: {
  businessId: string;
  initial: LeadFilters;
  agents: AgentOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(initial.search);
  const firstRender = useRef(true);

  function navigate(overrides: Partial<LeadFilters> & { page?: number }) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("businessId", businessId);
    const next = { ...initial, search, ...overrides };
    params.set("search", next.search);
    params.set("status", next.status);
    params.set("assignee", next.assignee);
    params.set("archived", next.archived);
    params.set("sort", next.sort);
    params.set("dir", next.dir);
    params.set("pageSize", String(next.pageSize));
    params.set("page", String(overrides.page ?? 1));
    router.replace(`${pathname}?${params.toString()}`);
  }

  // Debounced auto-search: typing filters without hammering navigation —
  // one replace per pause, Enter still submits instantly. Skips the first
  // render so back/forward + filter selects don't double-navigate.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (search === initial.search) return;
    const t = setTimeout(() => navigate({ search }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  return (
    <form
      className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 sm:px-6 lg:flex-row lg:items-center"
      onSubmit={(e) => {
        e.preventDefault();
        navigate({});
      }}
    >
      <div className="flex flex-1 gap-2">
        <label htmlFor="lead-search" className="sr-only">
          Search leads
        </label>
        <Input
          id="lead-search"
          type="search"
          placeholder="Search name, email, phone, campaign…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="lg:max-w-xs"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label htmlFor="lead-status" className="sr-only">
          Filter by status
        </label>
        <Select
          id="lead-status"
          value={initial.status}
          onChange={(e) => navigate({ status: e.target.value })}
          className="sm:w-44"
        >
          <option value="">All statuses</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {LEAD_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <label htmlFor="lead-assignee" className="sr-only">
          Filter by assignee
        </label>
        <Select
          id="lead-assignee"
          value={initial.assignee}
          onChange={(e) => navigate({ assignee: e.target.value })}
          className="sm:w-44"
        >
          <option value="">All agents</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
          {agents.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.name ?? a.email}
            </option>
          ))}
        </Select>
        <label htmlFor="lead-archived" className="sr-only">
          Archived state
        </label>
        <Select
          id="lead-archived"
          value={initial.archived}
          onChange={(e) => navigate({ archived: e.target.value })}
          className="sm:w-40"
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </Select>
      </div>
    </form>
  );
}
