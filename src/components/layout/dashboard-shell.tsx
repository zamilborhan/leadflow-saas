"use client";

import { Suspense, useState, type ReactNode } from "react";
import { ToastProvider } from "@/src/components/ui/toast";
import { Header } from "./header";
import { Sidebar, type WorkspaceOption } from "./sidebar";
import { cn } from "@/src/lib/cn";

interface DashboardShellProps {
  userEmail: string;
  avatarUrl?: string | null;
  businesses: WorkspaceOption[];
  children: ReactNode;
}

const COLLAPSE_KEY = "lf-sidebar-collapsed";

/**
 * Dashboard layout shell: collapsible sidebar on lg+, slide-over drawer
 * below lg, sticky header, toast viewport.
 */
export function DashboardShell({ userEmail, avatarUrl, businesses, children }: DashboardShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Lazy init reads the persisted preference without a post-mount effect
  // (avoids set-state-in-effect cascading renders).
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return typeof window !== "undefined" && window.localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false; // private mode — stay expanded
    }
  });

  function toggleCollapsed() {
    setCollapsed((v) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, v ? "0" : "1");
      } catch { /* ignore */ }
      return !v;
    });
  }

  return (
    <ToastProvider>
      <div className="flex min-h-screen bg-slate-100">
        {/* Desktop sidebar */}
        <aside
          className={cn(
            "sticky top-0 hidden h-screen shrink-0 border-r border-slate-200 bg-white transition-[width] duration-200 ease-out lg:block",
            collapsed ? "w-[76px]" : "w-64"
          )}
        >
          <Suspense>
            <Sidebar businesses={businesses} collapsed={collapsed} />
          </Suspense>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="absolute top-16 -right-3 flex size-6 cursor-pointer items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 shadow-sm transition-colors hover:text-slate-700"
          >
            <svg aria-hidden="true" className={cn("size-3.5 transition-transform", collapsed && "rotate-180")} viewBox="0 0 16 16" fill="none">
              <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </aside>

        {/* Mobile drawer */}
        {drawerOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label="Close navigation menu"
              onClick={() => setDrawerOpen(false)}
              className="animate-fade-in absolute inset-0 cursor-default bg-slate-950/50"
            />
            <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-pop-in bg-white shadow-xl">
              <Suspense>
                <Sidebar businesses={businesses} onNavigate={() => setDrawerOpen(false)} />
              </Suspense>
            </aside>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <Suspense>
            <Header userEmail={userEmail} avatarUrl={avatarUrl} onMenuClick={() => setDrawerOpen(true)} />
          </Suspense>
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">{children}</main>
          <footer className="border-t border-slate-200 bg-white px-6 py-4">
            <p className="mx-auto max-w-7xl text-xs text-slate-400">
              LeadFlow — capture, assign, follow up, convert.
            </p>
          </footer>
        </div>
      </div>
    </ToastProvider>
  );
}
