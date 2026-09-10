import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { listPlans } from "@/src/lib/billing/plans";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { formatBDT } from "../page";

export const metadata = { title: "Plans — Super-admin — LeadFlow BD" };

/** Plan catalog: limits + pricing (read-only; enforcement uses the static catalog). */
export default async function AdminPlansPage() {
  // Authorize before fetching (see requireSuperAdminForPage docs).
  await requireSuperAdminForPage("/admin/plans");
  const plans = await listPlans();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Plans"
        description="Catalog limits and pricing. Plan rows mirror the static catalog for introspection — enforcement never trusts the database row."
        eyebrow="Super-admin"
      />
      <Card>
        <CardHeader>
          <CardTitle>Plan catalog</CardTitle>
          <CardDescription>{plans.length} plans · prices in BDT.</CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead>Leads / mo</TableHead>
              <TableHead>Members</TableHead>
              <TableHead>Workspaces</TableHead>
              <TableHead>Price / mo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plans.map((p) => (
              <TableRow key={p.code}>
                <TableCell className="font-medium text-slate-900">
                  {p.name} <Badge variant="neutral" className="ml-1">{p.code}</Badge>
                </TableCell>
                <TableCell>{p.leadsPerMonth.toLocaleString()}</TableCell>
                <TableCell>{p.maxUsers}</TableCell>
                <TableCell>{p.maxBusinesses === null ? "Unlimited" : p.maxBusinesses}</TableCell>
                <TableCell className="font-semibold text-slate-900">{formatBDT(p.priceMinor)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
