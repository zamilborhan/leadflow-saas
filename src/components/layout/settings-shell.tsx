"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/src/lib/cn";
import { PageHeader } from "@/src/components/ui/page-header";

const TABS = [
  { label: "General", href: "/dashboard/settings" },
  { label: "Profile", href: "/dashboard/settings/profile" },
  { label: "Team", href: "/dashboard/settings/team" },
  { label: "Billing", href: "/dashboard/settings/billing" },
  { label: "Integrations", href: "/dashboard/settings/integrations" },
  { label: "Notifications", href: "/dashboard/settings/notifications" },
];

/**
 * Settings layout: page header + tab nav + content. Tabs use aria-current
 * so assistive tech announces the active section.
 */
export function SettingsShell({
  title = "Settings",
  description = "Manage your workspace, team, and preferences.",
  children,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const businessId = searchParams.get("businessId");
  function withWorkspace(href: string): string {
    if (!businessId) return href;
    const sep = href.includes("?") ? "&" : "?";
    return `${href}${sep}businessId=${encodeURIComponent(businessId)}`;
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description={description} eyebrow="Workspace" />
      <nav aria-label="Settings sections" className="border-b border-slate-200">
        <ul className="-mb-px flex gap-1 overflow-x-auto">
          {TABS.map((tab) => {
            const active = pathname === tab.href;
            return (
              <li key={tab.href}>
                <Link
                  href={withWorkspace(tab.href)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "block border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
                    active
                      ? "border-brand-600 text-brand-800"
                      : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"
                  )}
                >
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div>{children}</div>
    </div>
  );
}
