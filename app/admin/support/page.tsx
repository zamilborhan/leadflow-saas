import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { getSecuritySignals } from "@/src/lib/admin/audit";
import { listPaymentsAdmin } from "@/src/lib/admin/payments";

export const metadata = { title: "Support — Super-admin — LeadFlow BD" };

/**
 * Support center.
 * BACKEND REQUIREMENT: no ticket table exists yet, so this page triages
 * from REAL failure signals (failed payments, failed jobs/syncs) instead
 * of inventing tickets. Ticket backend contract is documented below.
 */
export default async function AdminSupportPage() {
  await requireSuperAdminForPage("/admin/support");
  const [signals, payments] = await Promise.all([
    getSecuritySignals(),
    listPaymentsAdmin({ pageSize: 20 }),
  ]);
  const queue = payments.payments.filter((p) => p.status === "FAILED");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Support" description="Failure-driven triage queue from live platform signals." eyebrow="Super-admin" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Needs attention ({queue.length})</CardTitle>
            <CardDescription>Failed payments act as the billing support queue.</CardDescription>
          </CardHeader>
          <CardContent>
            {queue.length === 0 ? (
              <p className="text-sm text-slate-500">Queue clear — no failed payments.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {queue.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="font-medium text-slate-900">{p.businessName ?? p.businessId.slice(0, 8)}</span>
                      <span className="block truncate text-xs text-slate-500">{p.tranId} · {p.planCode}</span>
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">{p.updatedAt.slice(0, 10)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Signal summary</CardTitle>
            <CardDescription>Failed jobs, syncs, and past-due subscriptions.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm text-slate-600">
              <li>Failed automation jobs: <strong>{signals.failedJobs}</strong> — see Jobs.</li>
              <li>Failed Facebook syncs: <strong>{signals.failedLeadSyncs}</strong> — see Integrations.</li>
              <li>Past-due subscriptions: <strong>{signals.pastDueSubscriptions}</strong> — see Subscriptions.</li>
              <li>Suspended workspaces: <strong>{signals.suspendedWorkspaces}</strong> — see Workspaces.</li>
            </ul>
            <div className="mt-4 rounded-lg bg-slate-50 p-4 font-mono text-xs">
              SupportTicket {"{ userId, businessId?, subject, body, priority: low|normal|high|urgent,"}
              <br />
              {"  status: open|pending|resolved, assigneeEmail?, createdAt, updatedAt }"}
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Search / filter / assign / status / priority land with the ticket table. Nothing here is mocked.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
