import Link from "next/link";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Input } from "@/src/components/ui/input";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { listPaymentsAdmin } from "@/src/lib/admin/payments";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { formatBDT } from "@/src/components/admin/format";

export const metadata = { title: "Payments — Super-admin — LeadFlow BD" };

/** Platform payment history, optionally scoped to one workspace. */
export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const raw = params["businessId"];
  const businessId = Array.isArray(raw) ? raw[0] : raw;
  // Authorize before fetching (see requireSuperAdminForPage docs).
  await requireSuperAdminForPage("/admin/payments");
  const page = await listPaymentsAdmin({ businessId: businessId ?? undefined });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Payments"
        description="SSLCommerz attempts across the platform. Tokens and secrets are never shown here."
        eyebrow="Super-admin"
      />
      <Card>
        <CardHeader>
          <CardTitle>Payment history</CardTitle>
          <CardDescription>
            {page.total} payment{page.total === 1 ? "" : "s"}
            {businessId ? (
              <>
                {" "}for workspace{" "}
                <Link href={`/admin/businesses/${businessId}`} className="font-semibold text-brand-700 hover:underline">
                  {businessId.slice(0, 8)}…
                </Link>{" "}
                · <Link href="/admin/payments" className="font-semibold text-brand-700 hover:underline">Clear filter</Link>
              </>
            ) : null}
            .
          </CardDescription>
        </CardHeader>
        <form method="get" className="flex flex-col gap-2 border-b border-slate-100 px-5 py-4 sm:flex-row sm:px-6">
          <label htmlFor="admin-payment-business" className="sr-only">Filter by workspace id</label>
          <Input id="admin-payment-business" name="businessId" defaultValue={businessId ?? ""} placeholder="Filter by workspace id…" className="max-w-sm" />
          <button type="submit" className="inline-flex h-10 items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700">
            Filter
          </button>
        </form>
        {page.payments.length === 0 ? (
          <EmptyState title="No payments found" description="No payment attempts match this filter yet." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transaction</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs text-slate-900">{p.tranId}</TableCell>
                  <TableCell>
                    <Link href={`/admin/businesses/${p.businessId}`} className="hover:text-brand-700 hover:underline">
                      {p.businessName ?? `${p.businessId.slice(0, 8)}…`}
                    </Link>
                  </TableCell>
                  <TableCell>{p.planCode}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatBDT(p.amountMinor)} {p.currency}</TableCell>
                  <TableCell>
                    <Badge variant={p.status === "SUCCESS" ? "success" : p.status === "FAILED" ? "danger" : "neutral"}>
                      {p.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-slate-500">{p.invoiceNumber ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">{p.createdAt.slice(0, 10)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
