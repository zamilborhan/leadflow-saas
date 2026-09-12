import { Badge } from "@/src/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/src/components/ui/table";
import { requireSuperAdminForPage } from "@/src/lib/admin/guard";
import { listFeaturesAdmin } from "@/src/lib/admin/features";

export const metadata = { title: "Features — Super-admin — LeadFlow BD" };

/**
 * Centralized feature-flag matrix. Plan defaults are enforced by
 * hasFeatureAccess(); global kill-switches via FEATURE_<KEY>_ENABLED;
 * per-workspace overrides are a named backend requirement (no scattered
 * `plan === "pro"` checks).
 */
export default async function AdminFeaturesPage() {
  await requireSuperAdminForPage("/admin/features");
  const features = listFeaturesAdmin();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Feature management"
        description="One matrix for every product gate. App code calls hasFeatureAccess() — never inline plan comparisons."
        eyebrow="Super-admin"
      />
      <Card>
        <CardHeader>
          <CardTitle>Feature × plan matrix</CardTitle>
          <CardDescription>
            Global kill-switch: set FEATURE_&lt;KEY&gt;_ENABLED=false. Per-workspace overrides require
            the future FeatureOverride table (see src/lib/admin/features.ts).
          </CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Feature</TableHead>
              <TableHead>Global</TableHead>
              <TableHead>Free</TableHead>
              <TableHead>Starter</TableHead>
              <TableHead>Growth</TableHead>
              <TableHead>Business</TableHead>
              <TableHead>Agency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {features.map((f) => (
              <TableRow key={f.key}>
                <TableCell className="font-medium text-slate-900">
                  {f.name}
                  <span className="block text-xs font-normal text-slate-500">{f.description}</span>
                </TableCell>
                <TableCell>
                  <Badge variant={f.globallyEnabled ? "success" : "danger"} dot>
                    {f.globallyEnabled ? "On" : "Off"}
                  </Badge>
                </TableCell>
                {(["FREE", "STARTER", "GROWTH", "BUSINESS", "AGENCY"] as const).map((p) => (
                  <TableCell key={p}>
                    <Badge variant={f.plans.includes(p) ? "brand" : "neutral"}>
                      {f.plans.includes(p) ? "✓" : "—"}
                    </Badge>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
