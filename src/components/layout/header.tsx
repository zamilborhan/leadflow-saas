"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { signOutEverywhere } from "@/src/components/auth/logout-button";
import { Dropdown } from "@/src/components/ui/dropdown";
import { GlobalSearch } from "./global-search";
import { NotificationBell } from "./notification-bell";

interface HeaderProps {
  userEmail: string;
  avatarUrl?: string | null;
  onMenuClick: () => void;
}

/** Shared account avatar: provider photo when available, initial otherwise. */
export function AccountAvatar({
  email,
  avatarUrl,
  size = "md",
}: {
  email: string;
  avatarUrl?: string | null;
  size?: "md" | "lg";
}) {
  const initial = (email.trim()[0] ?? "?").toUpperCase();
  const cls = size === "lg" ? "size-14 text-xl" : "size-8 text-sm";
  if (avatarUrl) {
    return (
      // Plain img: provider avatars are remote URLs outside next/image config.
      <img
        src={avatarUrl}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        className={`${cls} shrink-0 rounded-full bg-brand-100 object-cover ring-1 ring-slate-200`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex ${cls} shrink-0 items-center justify-center rounded-full bg-brand-600 font-bold text-white`}
    >
      {initial}
    </span>
  );
}

const SEGMENT_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  leads: "Leads",
  "follow-ups": "Follow-ups",
  analytics: "Analytics",
  notifications: "Notifications",
  settings: "Settings",
  admin: "Admin",
  profile: "Profile",
  team: "Team",
  billing: "Billing",
  integrations: "Integrations",
};

interface Crumb {
  label: string;
  href: string | null;
}

/**
 * Route-driven breadcrumb crumbs (Dashboard / Section / Page). Parent crumbs
 * link back with the workspace preserved; unknown dynamic segments (lead IDs)
 * render as "Details". Pure function of pathname — no extra data fetching.
 */
function buildCrumbs(pathname: string): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "dashboard") {
    const last = parts[parts.length - 1] ?? "";
    return [{ label: SEGMENT_LABELS[last] ?? "Dashboard", href: null }];
  }
  let path = "";
  return parts.map((part, i) => {
    path += `/${part}`;
    const isLast = i === parts.length - 1;
    return { label: SEGMENT_LABELS[part] ?? "Details", href: isLast ? null : path };
  });
}

/** Top bar: mobile menu, breadcrumb, help, notifications, user menu. */
export function Header({ userEmail, avatarUrl, onMenuClick }: HeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const businessId = searchParams.get("businessId");
  const crumbs = buildCrumbs(pathname);

  async function logout() {
    await signOutEverywhere();
    router.push("/login");
    router.refresh();
  }

  function withWorkspace(href: string): string {
    if (!businessId) return href;
    const sep = href.includes("?") ? "&" : "?";
    return `${href}${sep}businessId=${encodeURIComponent(businessId)}`;
  }

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

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm">
          {crumbs.map((crumb, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <li
                key={`${crumb.label}-${i}`}
                className={isLast ? "flex min-w-0 items-center" : "hidden shrink-0 items-center sm:flex"}
              >
                {i > 0 ? (
                  <span aria-hidden="true" className="mr-1.5 shrink-0 text-slate-300">
                    /
                  </span>
                ) : null}
                {crumb.href ? (
                  <Link
                    href={withWorkspace(crumb.href)}
                    className="shrink-0 text-slate-400 transition-colors hover:text-slate-700"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="truncate font-semibold text-slate-900">
                    {crumb.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <GlobalSearch businessId={businessId} />
        <a
          href={withWorkspace("/dashboard/settings")}
          aria-label="Help and settings"
          title="Help"
          className="hidden rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 sm:block"
        >
          <svg aria-hidden="true" className="size-5" viewBox="0 0 20 20" fill="none">
            <path d="M10 17.5a7.5 7.5 0 100-15 7.5 7.5 0 000 15zM7.8 7.5c0-1.2 1-2.2 2.2-2.2 1.2 0 2.2 1 2.2 2.2 0 1.7-2.2 2-2.2 3.5M10 14.5h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </a>
        <NotificationBell businessId={businessId} />
        <span aria-hidden="true" className="mx-1 h-6 w-px bg-slate-200" />
        <Dropdown
          label="Account"
          align="right"
          trigger={
            <span className="flex items-center gap-2 rounded-lg p-1 pr-1.5 transition-colors hover:bg-slate-100">
              <AccountAvatar email={userEmail} avatarUrl={avatarUrl} />
              <span className="hidden max-w-40 truncate text-sm font-medium text-slate-700 xl:block">{userEmail}</span>
              <svg aria-hidden="true" className="hidden size-4 text-slate-400 xl:block" viewBox="0 0 16 16" fill="none">
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          }
          items={[
            { label: "Profile", href: withWorkspace("/dashboard/settings/profile") },
            { label: "Workspace settings", href: withWorkspace("/dashboard/settings") },
            { label: "Billing", href: withWorkspace("/dashboard/settings/billing") },
            { label: "Log out", onSelect: logout, danger: true },
          ]}
        />
      </div>
    </header>
  );
}
