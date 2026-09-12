import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { listAuditEvents } from "@/src/lib/admin/audit";

export const metadata = { title: "Audit logs — Super-admin — LeadFlow BD" };

/** Audit trail: derived from real rows until the append-only AuditLog table lands. */
export default async function AdminAuditPage() {
  await requireSuperAdminForPage("/admin/audit");
  const { events, persistent } = await listAuditEvents(50);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit logs"
        description={
          persistent
            ? "Tamper-evident admin action history."
            : "Derived from live platform rows. A persistent append-only AuditLog table is the named backend requirement."
        }
        eyebrow="Super-admin"
      />
      {!persistent ? (
        <Card>
          <CardHeader>
            <CardTitle>Durability notice</CardTitle>
            <CardDescription>
              New admin actions are logged via structured server logs (logAdminAction). Backfill the
              AuditLog model — insert-only, no update/delete API — for tamper-evidence. See
              src/lib/admin/audit.ts.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Events ({events.length})</CardTitle>
          <CardDescription>Actor · action · target · timestamp.</CardDescription>
        </CardHeader>
        {events.length === 0 ? (
          <EmptyState title="No audit events" description="No suspensions, subscription changes, or payments yet." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Timestamp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium text-slate-900">{e.actor}</TableCell>
                  <TableCell><Badge variant="neutral">{e.action}</Badge></TableCell>
                  <TableCell className="max-w-72 truncate text-xs text-slate-500">{e.target}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{e.createdAt.slice(0, 16).replace("T", " ")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
