"use client";

import { Suspense, useState, type ReactNode } from "react";
import { ToastProvider } from "@/src/components/ui/toast";
import { Header } from "./header";
import { Sidebar, type WorkspaceOption } from "./sidebar";

interface DashboardShellProps {
  userEmail: string;
  businesses: WorkspaceOption[];
  children: ReactNode;
}

/**
 * Dashboard layout shell (desktop-first, mobile responsive): fixed sidebar
 * on lg+, slide-over drawer below lg, sticky header, toast viewport.
 */
export function DashboardShell({ userEmail, businesses, children }: DashboardShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <ToastProvider>
      <div className="flex min-h-screen bg-slate-100">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-68 shrink-0 border-r border-slate-200 bg-white lg:block">
          <Suspense>
            <Sidebar businesses={businesses} />
          </Suspense>
        </aside>

        {/* Mobile drawer */}
        {drawerOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label="Close navigation menu"
              onClick={() => setDrawerOpen(false)}
              className="absolute inset-0 cursor-default bg-slate-950/50"
            />
            <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl">
              <Suspense>
                <Sidebar businesses={businesses} onNavigate={() => setDrawerOpen(false)} />
              </Suspense>
            </aside>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <Suspense>
            <Header userEmail={userEmail} onMenuClick={() => setDrawerOpen(true)} />
          </Suspense>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
          <footer className="border-t border-slate-200 bg-white px-6 py-4">
            <p className="mx-auto max-w-6xl text-xs text-slate-400">
              LeadFlow BD — Facebook lead management & WhatsApp follow-up for Bangladesh businesses.
            </p>
          </footer>
        </div>
      </div>
    </ToastProvider>
  );
}
