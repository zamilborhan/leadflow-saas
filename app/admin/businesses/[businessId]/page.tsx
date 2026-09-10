import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { getBusinessAdmin, getBusinessUsageAdmin } from "@/src/lib/admin/businesses";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { listPaymentsAdmin } from "@/src/lib/admin/payments";
import { BusinessModerationActions } from "./actions";
import { formatBDT } from "../../page";

export const metadata = { title: "Business detail — Super-admin — LeadFlow BD" };

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Workspace detail: profile, subscription, usage, members, payment history + moderation. */
export default async function AdminBusinessDetailPage({
  params,
}: {
  params: Promise<{ businessId: string }>;
}) {
  const { businessId } = await params;
  // Authorize before fetching (see requireSuperAdminForPage docs).
  await requireSuperAdminForPage(`/admin/businesses/${businessId}`);
  const business = await getBusinessAdmin(businessId);
  if (!business) notFound();
  const [usage, payments] = await Promise.all([
    getBusinessUsageAdmin(businessId),
    listPaymentsAdmin({ businessId, pageSize: 10 }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={business.name}
        description={`Owner: ${business.ownerEmail ?? business.ownerId} · Created ${formatDate(business.createdAt)}`}
        eyebrow="Super-admin · Business"
        actions={
          <Link href="/admin/businesses" className="text-sm font-semibold text-brand-700 hover:underline">
            ← All businesses
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Status & subscription</CardTitle>
            <CardDescription>Live platform view of this workspace.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p>
              Status: <Badge variant={business.status === "SUSPENDED" ? "danger" : "success"} dot>{business.status}</Badge>
            </p>
            <p>
              Plan: <span className="font-semibold text-slate-900">{business.planCode}</span>{" "}
              <Badge variant={business.subscriptionStatus === "ACTIVE" ? "success" : "warning"}>
                {business.subscriptionStatus}
              </Badge>
            </p>
            <p className="text-slate-600">
              Renewal: {formatDate(business.renewalDate ?? null)} · Leads this period:{" "}
              {usage?.leadsThisPeriod ?? "—"} · Members: {usage?.members ?? business.memberCount} · Total leads:{" "}
              {business.leadCount}
            </p>
            <BusinessModerationActions
              businessId={business.id}
              businessName={business.name}
              status={business.status}
              planCode={business.planCode}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>{business.members.length} membership rows.</CardDescription>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {business.members.map((m) => (
                <TableRow key={m.userId}>
                  <TableCell className="font-medium text-slate-900">{m.email ?? m.userId}</TableCell>
                  <TableCell>
                    <Badge variant="neutral">{m.role}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Payment history</CardTitle>
          <CardDescription>
            Latest {payments.payments.length} of {payments.total} attempts for this workspace.{" "}
            <Link href={`/admin/payments?businessId=${business.id}`} className="font-semibold text-brand-700 hover:underline">
              View all →
            </Link>
          </CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Transaction</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.payments.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs text-slate-900">{p.tranId}</TableCell>
                <TableCell>{p.planCode}</TableCell>
                <TableCell>{formatBDT(p.amountMinor)}</TableCell>
                <TableCell>
                  <Badge variant={p.status === "SUCCESS" ? "success" : p.status === "FAILED" ? "danger" : "neutral"}>
                    {p.status}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(p.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
