"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/src/lib/cn";

export interface WorkspaceOption {
  id: string;
  name: string;
}

const NAV = [
  {
    section: "Workspace",
    items: [
      { label: "Overview", href: "/dashboard", icon: OverviewIcon, exact: true },
      { label: "Leads", href: "/dashboard/leads", icon: LeadsIcon, exact: false },
      { label: "Follow-ups", href: "/dashboard/follow-ups", icon: FollowUpsIcon, exact: false },
      { label: "Analytics", href: "/dashboard/analytics", icon: AnalyticsIcon, exact: false },
      { label: "Notifications", href: "/dashboard/notifications", icon: BellIcon, exact: false },
    ],
  },
  {
    section: "Manage",
    items: [
      { label: "Settings", href: "/dashboard/settings", icon: SettingsIcon, exact: false },
      { label: "Admin", href: "/dashboard/admin", icon: AdminIcon, exact: false },
    ],
  },
];

function isActive(pathname: string, href: string, exact: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function OverviewIcon() {
  return (
    <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20" fill="none">
      <path d="M3 10.5V5.7A1.7 1.7 0 014.7 4h4.6a1.7 1.7 0 011.7 1.7v4.8a1.7 1.7 0 01-1.7 1.7H4.7A1.7 1.7 0 013 10.5zm8 5.8v-4a1.7 1.7 0 011.7-1.7h1.6a1.7 1.7 0 011.7 1.7v4a1.7 1.7 0 01-1.7 1.7h-1.6a1.7 1.7 0 01-1.7-1.7zM3 14.3v-1.1m8-4.4V5.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function LeadsIcon() {
  return (
    <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20" fill="none">
      <path d="M10 2.5c-4.4 0-7.5 3-7.5 6.9 0 2.5 1.5 4.5 3.6 5.7l-.7 2.4 2.6-1.3c.6.2 1.3.2 2 .2 4.4 0 7.5-3 7.5-6.9S14.4 2.5 10 2.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function FollowUpsIcon() {
  return (
    <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20" fill="none">
      <path d="M10 5.5V10l3 2M10 17.5a7.5 7.5 0 100-15 7.5 7.5 0 000 15z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20" fill="none">
      <path d="M10 2.5a4.5 4.5 0 00-4.5 4.5c0 4-1.5 5-1.5 5h12s-1.5-1-1.5-5A4.5 4.5 0 0010 2.5zM8.5 15a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AnalyticsIcon() {
  return (
    <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20" fill="none">
      <path d="M3 17.5h14M5.5 17.5v-6M10 17.5V7M14.5 17.5v-9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {  return (
    <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20" fill="none">
      <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm6.2-1.1l1.1.9-1.1 1.9-1.3-.5a7 7 0 01-1.6 1l-.2 1.4H9a7 7 0 01-.2-1.4 7 7 0 01-1.6-1l-1.3.5-1.1-1.9 1.1-.9a7 7 0 010-1.8l-1.1-.9 1.1-1.9 1.3.5a7 7 0 011.6-1L8.9 4H11l.2 1.4a7 7 0 011.6 1l1.3-.5 1.1 1.9-1.1.9a7 7 0 01.1.9c0 .3 0 .6-.1.8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20" fill="none">
      <path d="M10 9.5a3 3 0 100-6 3 3 0 000 6zm-5.5 8a5.5 5.5 0 0111 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 px-2" aria-label="LeadFlow BD home">
      <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-lg bg-brand-600 text-lg font-bold text-white">
        L
      </span>
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-bold text-slate-900">LeadFlow</span>
        <span className="text-[11px] font-semibold tracking-widest text-brand-700 uppercase">Bangladesh</span>
      </span>
    </Link>
  );
}

/** Application sidebar: brand, workspace switcher, sectioned nav. */
export function Sidebar({ businesses, onNavigate }: { businesses: WorkspaceOption[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentId = searchParams.get("businessId") ?? businesses[0]?.id ?? "";

  function switchWorkspace(nextId: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("businessId", nextId);
    router.replace(`${pathname}?${params.toString()}`);
    onNavigate?.();
  }

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-3 py-5">
      <Brand />
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
        <label htmlFor="workspace-switcher" className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
          Workspace
        </label>
        {businesses.length <= 1 ? (
          <p className="mt-0.5 truncate text-sm font-semibold text-slate-900">
            {businesses[0]?.name ?? "No workspace yet"}
          </p>
        ) : (
          <select
            id="workspace-switcher"
            value={currentId}
            onChange={(e) => switchWorkspace(e.target.value)}
            className="mt-1 block w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-semibold text-slate-900"
          >
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <nav aria-label="Primary" className="flex flex-col gap-5">
        {NAV.map((group) => (
          <div key={group.section}>
            <p className="px-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
              {group.section}
            </p>
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = isActive(pathname, item.href, item.exact);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                        active
                          ? "bg-brand-50 text-brand-800"
                          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                      )}
                    >
                      <span aria-hidden="true" className={active ? "text-brand-700" : "text-slate-400"}>
                        <item.icon />
                      </span>
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="mt-auto rounded-xl bg-slate-900 px-4 py-4 text-white">
        <p className="text-sm font-semibold">Never lose a lead again</p>
        <p className="mt-1 text-xs text-slate-300">Connect Facebook Lead Ads to import prospects automatically.</p>
        <Link
          href="/dashboard/settings"
          onClick={onNavigate}
          className="mt-3 inline-flex h-8 items-center rounded-lg bg-white px-3 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-100"
        >
          Connect Facebook
        </Link>
      </div>
    </div>
  );
}
