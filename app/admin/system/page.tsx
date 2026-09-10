import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { getSystemHealth } from "@/src/lib/admin/system";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";

export const metadata = { title: "System — Super-admin — LeadFlow BD" };

/** Platform health: liveness probes only — never secrets. */
export default async function AdminSystemPage() {
  // Authorize before fetching (see requireSuperAdminForPage docs).
  await requireSuperAdminForPage("/admin/system");
  const health = await getSystemHealth();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="System health"
        description={`Checked at ${health.checkedAt}. Environment is reported as configured/unset — never secret values.`}
        eyebrow="Super-admin"
        actions={<Badge variant={health.ok ? "success" : "danger"} dot>{health.ok ? "HEALTHY" : "DEGRADED"}</Badge>}
      />

      <section aria-label="Health summary" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent>
            <p className="text-sm font-medium text-slate-500">Database</p>
            <p className="mt-1 text-3xl font-bold text-slate-900">{health.database.ok ? "Up" : "Down"}</p>
            <p className="mt-1 text-xs text-slate-400">
              {health.database.latencyMs === null ? "No probe latency" : `${health.database.latencyMs} ms probe`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm font-medium text-slate-500">Runtime</p>
            <p className="mt-1 text-3xl font-bold text-slate-900">{health.runtime.node}</p>
            <p className="mt-1 text-xs text-slate-400">Uptime {health.runtime.uptimeSeconds}s</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm font-medium text-slate-500">Stores</p>
            <p className="mt-1 text-3xl font-bold text-slate-900">{Object.values(health.tables).every((c) => c !== null) ? "OK" : "Error"}</p>
            <p className="mt-1 text-xs text-slate-400">Null = store unreachable</p>
          </CardContent>
        </Card>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Table counts</CardTitle>
            <CardDescription>Probe counts that prove each store answers.</CardDescription>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Table</TableHead>
                <TableHead>Rows</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(health.tables).map(([label, count]) => (
                <TableRow key={label}>
                  <TableCell className="font-medium text-slate-900">{label}</TableCell>
                  <TableCell>{count === null ? <Badge variant="danger">unreachable</Badge> : count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Integrations</CardTitle>
            <CardDescription>Configured / unset booleans only.</CardDescription>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Integration</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(
                [
                  ["Meta (Lead Ads)", health.integrations.metaConfigured],
                  ["WhatsApp", health.integrations.whatsappConfigured],
                  ["SSLCommerz", health.integrations.sslcommerzConfigured],
                  ["Redis", health.integrations.redisConfigured],
                ] as Array<[string, boolean]>
              ).map(([label, configured]) => (
                <TableRow key={label}>
                  <TableCell className="font-medium text-slate-900">{label}</TableCell>
                  <TableCell>
                    <Badge variant={configured ? "success" : "neutral"} dot>
                      {configured ? "Configured" : "Not set"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
