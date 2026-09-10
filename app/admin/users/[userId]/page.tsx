import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { getUserAdmin } from "@/src/lib/admin/users";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";

export const metadata = { title: "User detail — Super-admin — LeadFlow BD" };

/** Single platform user with workspace memberships. */
export default async function AdminUserDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  // Authorize before fetching (see requireSuperAdminForPage docs).
  await requireSuperAdminForPage(`/admin/users/${userId}`);
  const user = await getUserAdmin(userId);
  if (!user) notFound();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={user.email}
        description={`${user.name ?? "No display name"} · ${user.status} · joined ${user.createdAt.slice(0, 10)}`}
        eyebrow="Super-admin · User"
        actions={
          <Link href="/admin/users" className="text-sm font-semibold text-brand-700 hover:underline">
            ← All users
          </Link>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>
            {user.businessCount} membership{user.businessCount === 1 ? "" : "s"}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm">
          <Badge variant={user.status === "ACTIVE" ? "success" : "neutral"} dot>{user.status}</Badge>
          <span className="text-slate-500">Password hashes are never displayed.</span>
        </CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>Role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {user.businesses.map((b) => (
              <TableRow key={b.businessId}>
                <TableCell className="font-medium text-slate-900">
                  <Link href={`/admin/businesses/${b.businessId}`} className="hover:text-brand-700 hover:underline">
                    {b.businessName ?? b.businessId}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="neutral">{b.role}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
