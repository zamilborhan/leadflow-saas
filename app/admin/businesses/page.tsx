import Link from "next/link";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { listBusinessesAdmin } from "@/src/lib/admin/businesses";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";

export const metadata = { title: "Businesses — Super-admin — LeadFlow BD" };

function statusVariant(status: string): "success" | "danger" | "neutral" {
  if (status === "ACTIVE") return "success";
  if (status === "SUSPENDED") return "danger";
  return "neutral";
}

/** Platform business directory with search + status filter (server-rendered). */
export default async function AdminBusinessesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  // Authorize before fetching (see requireSuperAdminForPage docs).
  await requireSuperAdminForPage("/admin/businesses");
  const get = (key: string): string | undefined => {
    const v = params[key];
    return Array.isArray(v) ? v[0] : (v ?? undefined);
  };
  const search = get("search") ?? "";
  const statusParam = get("status");
  const status = statusParam === "ACTIVE" || statusParam === "SUSPENDED" ? statusParam : undefined;
  const page = await listBusinessesAdmin({ search, status });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Businesses"
        description="View workspaces, suspend abusive tenants, or reactivate them after review."
        eyebrow="Super-admin"
      />

      <Card>
        <CardHeader>
          <CardTitle>Workspace directory</CardTitle>
          <CardDescription>
            {page.total} workspace{page.total === 1 ? "" : "s"} · search matches name or owner email.
          </CardDescription>
        </CardHeader>
        <form method="get" className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
          <label htmlFor="admin-business-search" className="sr-only">
            Search businesses
          </label>
          <Input
            id="admin-business-search"
            name="search"
            type="search"
            defaultValue={search}
            placeholder="Search by name or owner email…"
            className="max-w-sm"
          />
          <select
            name="status"
            defaultValue={status ?? "all"}
            aria-label="Filter by status"
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
          >
            <option value="all">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
          </select>
          <button
            type="submit"
            className="inline-flex h-10 items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700"
          >
            Filter
          </button>
        </form>
        {page.businesses.length === 0 ? (
          <EmptyState title="No businesses found" description="Adjust the search or status filter." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Leads</TableHead>
                <TableHead>Members</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.businesses.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium text-slate-900">
                    <Link href={`/admin/businesses/${b.id}`} className="hover:text-brand-700 hover:underline">
                      {b.name}
                    </Link>
                    {b.ownerEmail ? <span className="block text-xs font-normal text-slate-500">{b.ownerEmail}</span> : null}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs font-semibold text-slate-700">{b.planCode}</span>
                    <span className="block text-[11px] text-slate-400">{b.subscriptionStatus}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(b.status)} dot>{b.status}</Badge>
                  </TableCell>
                  <TableCell>{b.leadCount}</TableCell>
                  <TableCell>{b.memberCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
