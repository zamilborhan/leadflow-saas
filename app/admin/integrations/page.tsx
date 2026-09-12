import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { StatCard } from "@/src/components/ui/stat-card";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { getFacebookMonitor, getIntegrationsOverview, getWhatsAppMonitor } from "@/src/lib/admin/integrations";

export const metadata = { title: "Integrations — Super-admin — LeadFlow BD" };

function statusVariant(s: string): "success" | "warning" | "danger" | "neutral" {
  if (s === "Operational") return "success";
  if (s === "Degraded") return "warning";
  if (s === "Down") return "danger";
  return "neutral";
}

/** Integration control plane — counts and errors only, never tokens. */
export default async function AdminIntegrationsPage() {
  await requireSuperAdminForPage("/admin/integrations");
  const [overview, fb, wa] = await Promise.all([
    getIntegrationsOverview(),
    getFacebookMonitor(),
    getWhatsAppMonitor(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Integrations" description="Connection health across Facebook, WhatsApp, payments, email, and jobs. No secrets leave the server." eyebrow="Super-admin" />
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {overview.map((i) => (
          <StatCard key={i.name} label={i.name} value={String(i.connected)} hint={`${i.errors} errors · ${i.note}`} tone={i.status === "Operational" ? "success" : i.status === "Unknown" ? "neutral" : "warning"} trend={{ direction: i.status === "Operational" ? "up" : i.status === "Unknown" ? "flat" : "down", text: i.status }} />
        ))}
      </section>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Facebook Lead Ads monitoring</CardTitle>
            <CardDescription>
              {fb.connections} connections · {fb.pages} pages · {fb.forms} forms · {fb.syncedLeads} synced · {fb.failedSyncs} failed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {fb.recentErrors.length === 0 ? (
              <p className="text-sm text-slate-500">No failed syncs. Broken integrations surface here first.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {fb.recentErrors.map((e, idx) => (
                  <li key={idx} className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-slate-600">{e.error ?? e.businessId}</span>
                    <Badge variant="warning">{e.at.slice(0, 10)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>WhatsApp monitoring</CardTitle>
            <CardDescription>{wa.connections} connections · {wa.sent} sent · {wa.failed} failed.</CardDescription>
          </CardHeader>
          <CardContent>
            {wa.recentErrors.length === 0 ? (
              <p className="text-sm text-slate-500">No failed messages.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {wa.recentErrors.map((e, idx) => (
                  <li key={idx} className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-slate-600">{e.error ?? e.businessId}</span>
                    <Badge variant="warning">{e.at.slice(0, 10)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Statuses</CardTitle>
          <CardDescription>Last sync timestamps where the schema tracks them.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {overview.map((i) => (
              <li key={i.name} className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-800">{i.name}</span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">{i.lastSync ? `sync ${i.lastSync.slice(0, 10)}` : "no sync timestamp"}</span>
                  <Badge variant={statusVariant(i.status)} dot>{i.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
