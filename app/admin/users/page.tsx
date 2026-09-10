import Link from "next/link";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { listUsersAdmin } from "@/src/lib/admin/users";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";

export const metadata = { title: "Users — Super-admin — LeadFlow BD" };

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Platform user directory (server-rendered, search by email/name). */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const raw = params["search"];
  const search = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  // Authorize before fetching (see requireSuperAdminForPage docs).
  await requireSuperAdminForPage("/admin/users");
  const page = await listUsersAdmin({ search });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Every login on the platform and how many workspaces each belongs to."
        eyebrow="Super-admin"
      />
      <Card>
        <CardHeader>
          <CardTitle>User directory</CardTitle>
          <CardDescription>{page.total} users.</CardDescription>
        </CardHeader>
        <form method="get" className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 sm:flex-row sm:px-6">
          <label htmlFor="admin-user-search" className="sr-only">
            Search users
          </label>
          <Input
            id="admin-user-search"
            name="search"
            type="search"
            defaultValue={search}
            placeholder="Search by email or name…"
            className="max-w-sm"
          />
          <button
            type="submit"
            className="inline-flex h-10 items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700"
          >
            Search
          </button>
        </form>
        {page.users.length === 0 ? (
          <EmptyState title="No users found" description="Adjust the search query." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Workspaces</TableHead>
                <TableHead>Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium text-slate-900">
                    <Link href={`/admin/users/${u.id}`} className="hover:text-brand-700 hover:underline">
                      {u.email}
                    </Link>
                    {u.name ? <span className="block text-xs font-normal text-slate-500">{u.name}</span> : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.status === "ACTIVE" ? "success" : "neutral"} dot>{u.status}</Badge>
                  </TableCell>
                  <TableCell>{u.businessCount}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(u.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
