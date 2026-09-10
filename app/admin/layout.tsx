import Link from "next/link";
import { forbidden, redirect } from "next/navigation";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { isSuperAdmin } from "@/src/lib/admin/guard";
import { ToastProvider } from "@/src/components/ui/toast";

const NAV = [
  { label: "Overview", href: "/admin" },
  { label: "Businesses", href: "/admin/businesses" },
  { label: "Users", href: "/admin/users" },
  { label: "Plans", href: "/admin/plans" },
  { label: "Subscriptions", href: "/admin/subscriptions" },
  { label: "Payments", href: "/admin/payments" },
  { label: "System", href: "/admin/system" },
  { label: "Jobs", href: "/admin/jobs" },
  { label: "Logs", href: "/admin/logs" },
];

/**
 * Super-admin area shell.
 *
 * Explicit authorization: every /admin render re-verifies the DB session
 * (getCurrentUser) and the SUPER_ADMIN_EMAILS allowlist (isSuperAdmin).
 * Workspace roles never confer access. Unauthenticated → /login;
 * authenticated non-admins → explicit 403, no platform data rendered.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin");
  // Authenticated but not allowlisted: real 403 via `forbidden()`,
  // rendered by app/admin/forbidden.tsx. No platform data is fetched
  // or rendered on this path.
  if (!isSuperAdmin(user)) forbidden();

  return (
    <ToastProvider>
      <div className="flex min-h-screen bg-slate-100">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-slate-200 bg-slate-950 lg:block">
          <div className="flex h-full flex-col gap-4 overflow-y-auto px-4 py-6">
            <Link href="/admin" className="flex items-center gap-2.5 px-1" aria-label="LeadFlow super-admin home">
              <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-lg bg-white text-lg font-bold text-slate-950">
                L
              </span>
              <span className="flex flex-col leading-none">
                <span className="text-[15px] font-bold text-white">LeadFlow</span>
                <span className="text-[11px] font-semibold tracking-widest text-slate-400 uppercase">
                  Super-admin
                </span>
              </span>
            </Link>
            <nav aria-label="Super-admin" className="flex flex-col gap-0.5">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="mt-auto rounded-xl bg-white/5 px-4 py-3">
              <p className="truncate text-xs font-medium text-slate-300">{user.email}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">Platform staff session</p>
              <Link href="/dashboard" className="mt-2 inline-block text-xs font-semibold text-white hover:underline">
                ← Back to workspace
              </Link>
            </div>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
            <div className="mx-auto flex w-full max-w-6xl items-center gap-2 overflow-x-auto px-4 py-3 sm:px-6">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 lg:hidden"
                >
                  {item.label}
                </Link>
              ))}
              <span className="ml-auto hidden shrink-0 text-xs text-slate-400 sm:block">
                Signed in as <span className="font-semibold text-slate-600">{user.email}</span>
              </span>
            </div>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
          <footer className="border-t border-slate-200 bg-white px-6 py-4">
            <p className="mx-auto max-w-6xl text-xs text-slate-400">
              Super-admin area — platform data. Access is allowlist-gated and audited.
            </p>
          </footer>
        </div>
      </div>
    </ToastProvider>
  );
}
