import Link from "next/link";
import { forbidden, redirect } from "next/navigation";
import { getCurrentUser } from "@/src/lib/auth/dal";
import { isSuperAdmin } from "@/src/lib/admin/guard";
import { getAdminRoleForEmail, hasPermission } from "@/src/lib/admin/roles";
import { ADMIN_NAV_ITEMS } from "@/src/components/admin/nav";
import { LeadFlowLogo } from "@/src/components/brand/LeadFlowLogo";
import { ToastProvider } from "@/src/components/ui/toast";
import { AdminBreadcrumb } from "./_components/breadcrumb";

/**
 * Lean super-admin shell: compact flat sidebar (8 items), lightweight
 * header (breadcrumb + support bell + admin profile). No search bar, no
 * heavy effects. Authorization stays server-side on every render.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin");
  const role = getAdminRoleForEmail(user.email);
  if (!role && !isSuperAdmin(user)) forbidden();
  if (role && user.emailVerifiedAt === null) forbidden();
  const effectiveRole = role ?? "SUPER_ADMIN";

  const items = ADMIN_NAV_ITEMS.filter((item) => hasPermission(effectiveRole, item.permission));
  const initial = (user.email.trim()[0] ?? "?").toUpperCase();

  return (
    <ToastProvider>
      <div className="flex min-h-screen bg-slate-100">
        <aside className="sticky top-0 hidden h-screen w-52 shrink-0 border-r border-slate-800 bg-slate-950 lg:block">
          <div className="flex h-full flex-col gap-3 overflow-y-auto px-3 py-5">
            <Link href="/admin" className="flex items-center gap-2 px-1" aria-label="LeadFlow super-admin home">
              <LeadFlowLogo variant="mark" />
              <span className="flex flex-col leading-none">
                <span className="text-[15px] font-bold text-white">LeadFlow</span>
                <span className="text-[10px] font-semibold tracking-widest text-slate-400 uppercase">
                  Super-admin
                </span>
              </span>
            </Link>
            <nav aria-label="Super-admin" className="flex flex-col gap-0.5">
              {items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="mt-auto rounded-xl bg-white/5 px-3 py-2.5">
              <Link href="/dashboard" className="text-xs font-semibold text-white hover:underline">
                ← Back to workspace
              </Link>
            </div>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
            <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-2.5 sm:px-6">
              <Link href="/admin" aria-label="LeadFlow super-admin home" className="shrink-0 rounded-lg lg:hidden">
                <LeadFlowLogo variant="mark" className="size-7" />
              </Link>
              <div className="min-w-0 flex-1">
                <AdminBreadcrumb />
              </div>
              <Link
                href="/admin/support"
                aria-label="Support queue"
                title="Support queue"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              >
                <svg className="size-4.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M10 2a6 6 0 00-6 6v3.5L2.8 14h14.4L16 11.5V8a6 6 0 00-6-6zM8 16a2 2 0 004 0"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
              <div className="flex shrink-0 items-center gap-2" title={user.email}>
                <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">
                  {initial}
                </span>
                <span className="hidden max-w-40 truncate text-xs font-medium text-slate-600 md:block">
                  {user.email}
                </span>
              </div>
            </div>
            <nav aria-label="Super-admin sections" className="border-t border-slate-100 lg:hidden">
              <div className="mx-auto flex w-full max-w-6xl items-center gap-1 overflow-x-auto px-4 py-2">
                {items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </nav>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
