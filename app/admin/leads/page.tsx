import Link from "next/link";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { listLeadsAdmin } from "@/src/lib/admin/leads";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";

export const metadata = { title: "Leads — Super-admin — LeadFlow BD" };

/** Platform-wide lead directory: server-side search/filter, paginated. */
export default async function AdminLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const get = (k: string): string | undefined => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : (v ?? undefined);
  };
  await requireSuperAdminForPage("/admin/leads");
  const page = await listLeadsAdmin({
    search: get("search"),
    businessId: get("businessId"),
    status: get("status") || undefined,
    source: get("source") || undefined,
    page: get("page") ? Number(get("page")) : undefined,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Leads" description="Every lead on the platform. Search runs server-side; pages of 20." eyebrow="Super-admin" />
      <Card>
        <CardHeader>
          <CardTitle>Platform leads</CardTitle>
          <CardDescription>{page.total} leads · page {page.page} of {page.totalPages}.</CardDescription>
        </CardHeader>
        <form method="get" className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:px-6">
          <Input name="search" type="search" defaultValue={get("search") ?? ""} placeholder="Search name, email, phone…" className="max-w-xs" />
          <Input name="status" defaultValue={get("status") ?? ""} placeholder="Status (e.g. NEW)" className="max-w-40" />
          <Input name="source" defaultValue={get("source") ?? ""} placeholder="Source" className="max-w-40" />
          <button type="submit" className="inline-flex h-10 items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700">
            Search
          </button>
          {get("businessId") ? (
            <Link href="/admin/leads" className="text-sm font-semibold text-brand-700 hover:underline">Clear workspace filter</Link>
          ) : null}
        </form>
        {page.leads.length === 0 ? (
          <EmptyState title="No leads found" description="Adjust search or filters." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.leads.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium text-slate-900">
                    {l.name}
                    <span className="block text-xs font-normal text-slate-500">{l.email ?? l.phone ?? "—"}</span>
                  </TableCell>
                  <TableCell>
                    <Link href={`/admin/businesses/${l.businessId}`} className="hover:text-brand-700 hover:underline">
                      {l.businessName ?? `${l.businessId.slice(0, 8)}…`}
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant="neutral" dot>{l.status}</Badge></TableCell>
                  <TableCell className="text-xs text-slate-500">{l.assigneeEmail ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{l.createdAt.slice(0, 10)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
