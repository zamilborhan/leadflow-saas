import Link from "next/link";

/**
 * Shared 403 UI for the super-admin area. Rendered by both
 * `app/forbidden.tsx` (layout-thrown interrupts propagate to the parent
 * segment) and `app/admin/forbidden.tsx` (page-thrown interrupts stay in
 * the segment). No props, no platform data — explicit denial only.
 */
export function ForbiddenView() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-xs font-semibold tracking-wider text-red-600 uppercase">403 — Forbidden</p>
        <h1 className="mt-2 text-xl font-semibold text-slate-900">Super-admin access required</h1>
        <p className="mt-2 text-sm text-slate-500">
          This area is restricted to platform staff listed in SUPER_ADMIN_EMAILS. Workspace roles
          never grant platform access.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-flex h-10 items-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
