import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { StatCard } from "@/src/components/ui/stat-card";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { getSecuritySignals } from "@/src/lib/admin/audit";
import { getAdminRoleForEmail, ROLE_PERMISSIONS } from "@/src/lib/admin/roles";
import { getCurrentUser } from "@/src/lib/auth/dal";

export const metadata = { title: "Security — Super-admin — LeadFlow BD" };

/** Security center: real signals + enforced guarantees. No fake threat scores. */
export default async function AdminSecurityPage() {
  await requireSuperAdminForPage("/admin/security");
  const [signals, user] = await Promise.all([getSecuritySignals(), getCurrentUser()]);
  const role = user ? (getAdminRoleForEmail(user.email) ?? "SUPER_ADMIN") : "SUPER_ADMIN";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Security center" description="Privileged-action signals and the enforced access model." eyebrow="Super-admin" />
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Suspended" value={String(signals.suspendedWorkspaces)} hint="Workspaces revoked" />
        <StatCard label="Failed Payments" value={String(signals.failedPayments)} hint="Billing risk" tone={signals.failedPayments > 0 ? "danger" : "neutral"} />
        <StatCard label="Failed Jobs" value={String(signals.failedJobs)} hint="Automation risk" tone={signals.failedJobs > 0 ? "warning" : "neutral"} />
        <StatCard label="Failed Syncs" value={String(signals.failedLeadSyncs)} hint="Meta webhook risk" tone={signals.failedLeadSyncs > 0 ? "warning" : "neutral"} />
        <StatCard label="Past Due" value={String(signals.pastDueSubscriptions)} hint="Collection risk" tone={signals.pastDueSubscriptions > 0 ? "warning" : "neutral"} />
      </section>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Your session</CardTitle>
            <CardDescription>Verified server-side on every admin render.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Email: <strong>{user?.email ?? "—"}</strong></p>
            <p className="flex items-center gap-2">Role: <Badge variant="brand">{role}</Badge></p>
            <p className="text-xs text-slate-400">Checked at {signals.checkedAt}. Admin login history and active-session revocation require a Session-activity table (backend requirement).</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Enforced guarantees</CardTitle>
            <CardDescription>What the server actually checks.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
              <li>Every /admin page awaits requireSuperAdminForPage before any query.</li>
              <li>Every /api/admin route goes through requireSuperAdmin / requirePermission.</li>
              <li>Roles come from env allowlists + verified email + ACTIVE DB status — never client input.</li>
              <li>Suspended users lose platform access even with a live session.</li>
              <li>Your role grants {ROLE_PERMISSIONS[role].length} permissions (see .env.example for role assignment).</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
