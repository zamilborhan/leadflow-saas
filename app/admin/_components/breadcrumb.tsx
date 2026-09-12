"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LABELS: Record<string, string> = {
  admin: "Admin",
  users: "Users",
  businesses: "Workspaces",
  subscriptions: "Subscriptions",
  plans: "Plans",
  payments: "Payments",
  activity: "Activity",
  settings: "Settings",
  analytics: "Analytics",
  leads: "Leads",
  team: "Team",
  billing: "Billing",
  revenue: "Revenue",
  features: "Features",
  integrations: "Integrations",
  notifications: "Notifications",
  support: "Support",
  audit: "Audit logs",
  security: "Security",
  health: "System health",
  jobs: "Jobs",
  logs: "Logs",
  system: "System",
};

/**
 * Minimal breadcrumb: Admin / Section. Tiny client component (only
 * dynamic piece of the header); everything else is server-rendered.
 */
export function AdminBreadcrumb(): React.JSX.Element {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  // Skip resource ids (UUIDs) to keep the trail readable.
  const kept = segments
    .map((seg, index) => ({ seg, index }))
    .filter(({ seg }) => seg.length < 32);
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex min-w-0 items-center gap-1 text-[13px]">
        {kept.map(({ seg, index }, i) => {
          const href = `/${segments.slice(0, index + 1).join("/")}`;
          const isLast = i === kept.length - 1;
          const label = LABELS[seg] ?? seg;
          return (
            <li key={`${seg}-${index}`} className="flex min-w-0 items-center gap-1">
              {i > 0 ? <span aria-hidden="true" className="text-slate-300">/</span> : null}
              {isLast ? (
                <span aria-current="page" className="truncate font-semibold text-slate-900">
                  {label}
                </span>
              ) : (
                <Link href={href} className="shrink-0 text-slate-500 hover:text-slate-800">
                  {label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
