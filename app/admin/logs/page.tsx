import Link from "next/link";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { listLogsAdmin } from "@/src/lib/admin/jobs";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";

export const metadata = { title: "Logs — Super-admin — LeadFlow BD" };

function statusVariant(status: string): "success" | "danger" | "neutral" {
  if (status === "SUCCESS") return "success";
  if (status === "FAILED") return "danger";
  return "neutral";
}

/** Platform automation-log browser (read-only). */
export default async function AdminLogsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const get = (key: string): string | undefined => {
    const v = params[key];
    return Array.isArray(v) ? v[0] : (v ?? undefined);
  };
  // Authorize before fetching (see requireSuperAdminForPage docs).
  await requireSuperAdminForPage("/admin/logs");
  const page = await listLogsAdmin({ status: get("status"), businessId: get("businessId") });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Automation logs"
        description="Per-action execution trail across all workspaces, including failures and skips."
        eyebrow="Super-admin"
      />
      <Card>
        <CardHeader>
          <CardTitle>Execution logs</CardTitle>
          <CardDescription>{page.total} log rows.</CardDescription>
        </CardHeader>
        <form method="get" className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
          <select name="status" defaultValue={get("status") ?? "all"} aria-label="Filter by status" className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm">
            <option value="all">All statuses</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILED">Failed</option>
            <option value="SKIPPED">Skipped</option>
          </select>
          <button type="submit" className="inline-flex h-10 items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700">
            Filter
          </button>
          {get("businessId") ? (
            <Link href="/admin/logs" className="text-sm font-semibold text-brand-700 hover:underline">
              Clear workspace filter
            </Link>
          ) : null}
        </form>
        {page.logs.length === 0 ? (
          <EmptyState title="No logs found" description="Adjust the filters." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.logs.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium text-slate-900">
                    <Link href={`/admin/businesses/${l.businessId}`} className="hover:text-brand-700 hover:underline">
                      {l.businessName ?? `${l.businessId.slice(0, 8)}…`}
                    </Link>
                  </TableCell>
                  <TableCell>{l.trigger}</TableCell>
                  <TableCell className="text-xs">{l.action}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(l.status)} dot>{l.status}</Badge>
                  </TableCell>
                  <TableCell className="max-w-60 truncate text-xs text-slate-500">{l.detail ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">{l.createdAt.slice(0, 10)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
