import Link from "next/link";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { getRecentActivity } from "@/src/lib/admin/activity";

export const metadata = { title: "Activity — Super-admin — LeadFlow" };

const PAGE_SIZE = 20;

function kindVariant(kind: string): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (kind === "payment_failed") return "danger";
  if (kind === "subscription_cancelled" || kind === "workspace_suspended") return "warning";
  if (kind === "subscription_activated") return "success";
  return "neutral";
}

/**
 * Platform activity with server-side pagination (link-based, zero JS).
 * The feed query itself is limit-bounded and cached; pages slice it.
 */
export default async function AdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireSuperAdminForPage("/admin/activity");
  const params = await searchParams;
  const raw = params["page"];
  const requested = Array.isArray(raw) ? raw[0] : raw;
  const feed = await getRecentActivity(100);
  const totalPages = Math.max(1, Math.ceil(feed.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number(requested) || 1), totalPages);
  const rows = feed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Activity" description="Latest platform events across users, workspaces, and billing." eyebrow="Super-admin" />
      <Card>
        <CardHeader>
          <CardTitle>Platform activity</CardTitle>
          <CardDescription>
            {feed.length} recent events · page {page} of {totalPages}.
          </CardDescription>
        </CardHeader>
        {rows.length === 0 ? (
          <EmptyState title="No recent activity" description="Events will appear here as the platform is used." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead>Detail</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="font-medium text-slate-900">
                        <Badge variant={kindVariant(e.kind)} dot>{e.title}</Badge>
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-xs text-slate-500">
                        {e.href ? (
                          <Link href={e.href} className="hover:text-brand-700 hover:underline">
                            {e.detail ?? "—"}
                          </Link>
                        ) : (
                          (e.detail ?? "—")
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{e.createdAt.slice(0, 10)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {totalPages > 1 ? (
              <nav aria-label="Activity pages" className="flex items-center justify-between border-t border-slate-100 px-5 py-3">
                {page > 1 ? (
                  <Link href={`/admin/activity?page=${page - 1}`} className="text-sm font-semibold text-brand-700 hover:underline">
                    ← Newer
                  </Link>
                ) : (
                  <span />
                )}
                <span className="text-xs text-slate-400">Page {page} of {totalPages}</span>
                {page < totalPages ? (
                  <Link href={`/admin/activity?page=${page + 1}`} className="text-sm font-semibold text-brand-700 hover:underline">
                    Older →
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
