"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Dropdown } from "@/src/components/ui/dropdown";
import { NotificationBell } from "./notification-bell";

interface HeaderProps {
  userEmail: string;
  onMenuClick: () => void;
}

/** Top bar: mobile menu button, search, notifications, user menu. */
export function Header({ userEmail, onMenuClick }: HeaderProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const businessId = searchParams.get("businessId");
  const [query, setQuery] = useState("");

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const initial = (userEmail.trim()[0] ?? "?").toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open navigation menu"
        className="cursor-pointer rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 lg:hidden"
      >
        <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20" fill="none">
          <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      <form
        role="search"
        className="hidden max-w-md flex-1 md:block"
        onSubmit={(e) => e.preventDefault()}
      >
        <label htmlFor="global-search" className="sr-only">
          Search leads
        </label>
        <div className="relative">
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
            viewBox="0 0 16 16"
            fill="none"
          >
            <path d="M7.5 13a5.5 5.5 0 100-11 5.5 5.5 0 000 11zM12 12l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            id="global-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search leads, contacts…"
            className="h-9.5 w-full rounded-lg border border-slate-200 bg-slate-50 pr-3 pl-9 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-300"
          />
        </div>
      </form>

      <div className="ml-auto flex items-center gap-1.5">
        <NotificationBell businessId={businessId} />
        <Dropdown
          label="Account"
          align="right"
          trigger={
            <span className="flex items-center gap-2 rounded-lg p-1 pr-1.5 transition-colors hover:bg-slate-100">
              <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-800">
                {initial}
              </span>
              <span className="hidden max-w-40 truncate text-sm font-medium text-slate-700 xl:block">{userEmail}</span>
            </span>
          }
          items={[
            { label: "Settings", href: "/dashboard/settings" },
            { label: "Log out", onSelect: logout, danger: true },
          ]}
        />
      </div>
    </header>
  );
}
