import Link from "next/link";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { listSubscriptionsAdmin } from "@/src/lib/admin/subscriptions";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";

export const metadata = { title: "Subscriptions — Super-admin — LeadFlow BD" };

function statusVariant(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "ACTIVE") return "success";
  if (status === "PAST_DUE") return "warning";
  if (status === "CANCELED") return "danger";
  return "neutral";
}

/** Platform subscription directory with status/plan filters. */
export default async function AdminSubscriptionsPage({
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
  await requireSuperAdminForPage("/admin/subscriptions");
  const page = await listSubscriptionsAdmin({
    search: get("search"),
    status: get("status"),
    planCode: get("planCode"),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Subscriptions"
        description="One subscription per workspace. Change plans from the business detail view."
        eyebrow="Super-admin"
      />
      <Card>
        <CardHeader>
          <CardTitle>Subscription directory</CardTitle>
          <CardDescription>{page.total} subscriptions.</CardDescription>
        </CardHeader>
        <form method="get" className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
          <label htmlFor="admin-sub-search" className="sr-only">Search subscriptions</label>
          <Input id="admin-sub-search" name="search" type="search" defaultValue={get("search") ?? ""} placeholder="Search workspace…" className="max-w-xs" />
          <select name="status" defaultValue={get("status") ?? "all"} aria-label="Filter by status" className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm">
            <option value="all">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="PAST_DUE">Past due</option>
            <option value="CANCELED">Canceled</option>
          </select>
          <select name="planCode" defaultValue={get("planCode") ?? "all"} aria-label="Filter by plan" className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm">
            <option value="all">All plans</option>
            <option value="FREE">Free</option>
            <option value="STARTER">Starter</option>
            <option value="GROWTH">Growth</option>
            <option value="BUSINESS">Business</option>
            <option value="AGENCY">Agency</option>
          </select>
          <button type="submit" className="inline-flex h-10 items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700">
            Filter
          </button>
        </form>
        {page.subscriptions.length === 0 ? (
          <EmptyState title="No subscriptions found" description="Adjust the filters." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Renewal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.subscriptions.map((s) => (
                <TableRow key={s.businessId}>
                  <TableCell className="font-medium text-slate-900">
                    <Link href={`/admin/businesses/${s.businessId}`} className="hover:text-brand-700 hover:underline">
                      {s.businessName ?? s.businessId}
                    </Link>
                  </TableCell>
                  <TableCell>{s.planCode}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(s.status)} dot>{s.status}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{s.currentPeriodEnd.slice(0, 10)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
