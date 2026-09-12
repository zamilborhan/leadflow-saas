import Link from "next/link";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { listMembersAdmin } from "@/src/lib/admin/leads";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";

export const metadata = { title: "Team — Super-admin — LeadFlow BD" };

/**
 * Platform-wide membership visibility (read-only). Role changes happen
 * inside workspaces — this page never escalates privileges.
 */
export default async function AdminTeamPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const get = (k: string): string | undefined => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : (v ?? undefined);
  };
  await requireSuperAdminForPage("/admin/team");
  const page = await listMembersAdmin({ search: get("search"), role: get("role") || undefined });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Team members" description="Every workspace membership on the platform. Read-only — no privilege changes here." eyebrow="Super-admin" />
      <Card>
        <CardHeader>
          <CardTitle>Memberships</CardTitle>
          <CardDescription>{page.total} memberships.</CardDescription>
        </CardHeader>
        <form method="get" className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 sm:flex-row sm:px-6">
          <Input name="search" type="search" defaultValue={get("search") ?? ""} placeholder="Search email, workspace, role…" className="max-w-sm" />
          <select name="role" defaultValue={get("role") ?? ""} aria-label="Filter by role" className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm">
            <option value="">All roles</option>
            <option value="OWNER">Owner</option>
            <option value="ADMIN">Admin</option>
            <option value="SALES">Sales</option>
          </select>
          <button type="submit" className="inline-flex h-10 items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700">
            Filter
          </button>
        </form>
        {page.members.length === 0 ? (
          <EmptyState title="No memberships found" description="Adjust the filters." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium text-slate-900">
                    <Link href={`/admin/users/${m.userId}`} className="hover:text-brand-700 hover:underline">
                      {m.email ?? m.userId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/admin/businesses/${m.businessId}`} className="hover:text-brand-700 hover:underline">
                      {m.businessName ?? `${m.businessId.slice(0, 8)}…`}
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant={m.role === "OWNER" ? "brand" : "neutral"} dot>{m.role}</Badge></TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{m.createdAt.slice(0, 10)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
