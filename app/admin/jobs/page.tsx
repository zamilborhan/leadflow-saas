import Link from "next/link";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { listJobsAdmin } from "@/src/lib/admin/jobs";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";

export const metadata = { title: "Jobs — Super-admin — LeadFlow BD" };

function statusVariant(status: string): "success" | "danger" | "info" | "neutral" {
  if (status === "DONE") return "success";
  if (status === "FAILED") return "danger";
  if (status === "SENDING") return "info";
  return "neutral";
}

/** Platform automation-job browser (read-only; retries stay tenant-scoped). */
export default async function AdminJobsPage({
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
  await requireSuperAdminForPage("/admin/jobs");
  const page = await listJobsAdmin({ status: get("status"), businessId: get("businessId") });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Background jobs"
        description="Automation queue across all workspaces. Read-only — retries happen on tenant job routes so the audit trail keeps a workspace actor."
        eyebrow="Super-admin"
      />
      <Card>
        <CardHeader>
          <CardTitle>Automation jobs</CardTitle>
          <CardDescription>{page.total} jobs.</CardDescription>
        </CardHeader>
        <form method="get" className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
          <select name="status" defaultValue={get("status") ?? "all"} aria-label="Filter by status" className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm">
            <option value="all">All statuses</option>
            <option value="QUEUED">Queued</option>
            <option value="SENDING">Sending</option>
            <option value="DONE">Done</option>
            <option value="FAILED">Failed</option>
          </select>
          <button type="submit" className="inline-flex h-10 items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700">
            Filter
          </button>
          {get("businessId") ? (
            <Link href="/admin/jobs" className="text-sm font-semibold text-brand-700 hover:underline">
              Clear workspace filter
            </Link>
          ) : null}
        </form>
        {page.jobs.length === 0 ? (
          <EmptyState title="No jobs found" description="Adjust the filters." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.jobs.map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="font-medium text-slate-900">
                    <Link href={`/admin/businesses/${j.businessId}`} className="hover:text-brand-700 hover:underline">
                      {j.businessName ?? `${j.businessId.slice(0, 8)}…`}
                    </Link>
                  </TableCell>
                  <TableCell>{j.trigger}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(j.status)} dot>{j.status}</Badge>
                  </TableCell>
                  <TableCell>{j.attempts}</TableCell>
                  <TableCell className="max-w-60 truncate text-xs text-slate-500">{j.lastError ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">{j.createdAt.slice(0, 10)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
