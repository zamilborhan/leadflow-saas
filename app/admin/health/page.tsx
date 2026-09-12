import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { getSystemHealth } from "@/src/lib/admin/system";
import { getFacebookMonitor, getWhatsAppMonitor } from "@/src/lib/admin/integrations";

export const metadata = { title: "System health — Super-admin — LeadFlow BD" };

function variant(ok: boolean | null): "success" | "danger" | "neutral" {
  if (ok === true) return "success";
  if (ok === false) return "danger";
  return "neutral";
}

/** System health from live probes — never faked. */
export default async function AdminHealthPage() {
  await requireSuperAdminForPage("/admin/health");
  const [health, fb, wa] = await Promise.all([
    getSystemHealth(),
    getFacebookMonitor().catch(() => null),
    getWhatsAppMonitor().catch(() => null),
  ]);
  const services: Array<{ name: string; ok: boolean | null; detail: string }> = [
    { name: "Database", ok: health.database.ok, detail: health.database.latencyMs === null ? "unreachable" : `${health.database.latencyMs}ms` },
    { name: "Authentication", ok: true, detail: "session DAL verified this render" },
    { name: "Meta app config", ok: health.integrations.metaConfigured ? true : null, detail: health.integrations.metaConfigured ? "META_APP_ID + secret set" : "not configured" },
    { name: "WhatsApp config", ok: health.integrations.whatsappConfigured ? true : null, detail: health.integrations.whatsappConfigured ? "token set" : "not configured" },
    { name: "Payments config", ok: health.integrations.sslcommerzConfigured ? true : null, detail: health.integrations.sslcommerzConfigured ? "store credentials set" : "not configured" },
    { name: "Redis / queues", ok: health.integrations.redisConfigured ? true : null, detail: health.integrations.redisConfigured ? "REDIS_URL set" : "not configured" },
    { name: "Facebook sync", ok: fb ? fb.failedSyncs === 0 : null, detail: fb ? `${fb.failedSyncs} failed syncs` : "unknown" },
    { name: "WhatsApp delivery", ok: wa ? wa.failed === 0 : null, detail: wa ? `${wa.failed} failed messages` : "unknown" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="System health" description={`Probed at ${health.checkedAt} · Node ${health.runtime.node} · uptime ${health.runtime.uptimeSeconds}s.`} eyebrow="Super-admin" />
      <Card>
        <CardHeader>
          <CardTitle>
            Platform status{" "}
            <Badge variant={health.ok ? "success" : "danger"} dot>{health.ok ? "Operational" : "Attention"}</Badge>
          </CardTitle>
          <CardDescription>Operational / Unknown (unconfigured) — never fabricated latency.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-slate-100 text-sm">
            {services.map((s) => (
              <li key={s.name} className="flex items-center justify-between gap-2 py-2">
                <span className="font-medium text-slate-800">{s.name}</span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">{s.detail}</span>
                  <Badge variant={variant(s.ok)} dot>{s.ok === null ? "Unknown" : s.ok ? "Operational" : "Down"}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Table counts</CardTitle>
          <CardDescription>Liveness proof per store (null = query failed).</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-wrap gap-2 text-sm">
            {Object.entries(health.tables).map(([k, v]) => (
              <li key={k}><Badge variant={v === null ? "danger" : "neutral"}>{k}: {v === null ? "error" : v}</Badge></li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
