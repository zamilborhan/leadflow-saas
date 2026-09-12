import { Suspense } from "react";
import { requireUserForPage } from "@/src/lib/auth/dal";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { validateAnalyticsQuery } from "@/src/lib/tenancy/validation";
import { Card } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { ChartSkeleton, KpiSkeletonGrid } from "@/src/components/ui/skeletons";
import { AnalyticsFilterBar } from "./filter-bar";
import { AnalyticsBody } from "./_analytics-body";

export const metadata = {
  title: "Analytics — LeadFlow BD",
};

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function BodyFallback() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <KpiSkeletonGrid count={6} />
      <ChartSkeleton title="Loading analytics charts" />
    </div>
  );
}

/**
 * Analytics — header + filters paint instantly; aggregated metrics stream
 * behind via `<Suspense>`. Charts are pure CSS (no chart dependency, no
 * client JS) with capped server-side datasets.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUserForPage();
  const params = await searchParams;

  const businesses = await listUserBusinesses(user.id).catch(() => []);
  if (businesses.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Analytics" description="Funnel metrics for this workspace." eyebrow="Analytics" />
        <Card><EmptyState title="No workspace yet" description="Create a workspace to start measuring your funnel." /></Card>
      </div>
    );
  }
  const requested = firstParam(params["businessId"]) || null;
  let resolved = requested ? await resolveBusinessContext(user.id, requested).catch(() => null) : null;
  if (!resolved?.ok) {
    const retry = await resolveBusinessContext(user.id, businesses[0].id).catch(() => null);
    if (!retry?.ok) {
      return (
        <div className="flex flex-col gap-6">
          <PageHeader title="Analytics" description="Funnel metrics for this workspace." eyebrow="Analytics" />
          <Card><EmptyState title="No workspace yet" description="Create a workspace to start measuring your funnel." /></Card>
        </div>
      );
    }
    resolved = retry;
  }
  const { business } = resolved.context;

  const raw: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(params)) raw[k] = v;
  const query = validateAnalyticsQuery(raw);

  const rawDays = firstParam(params["days"]);
  const hasCustomRange = firstParam(params["from"]) !== "" || firstParam(params["to"]) !== "";
  const daysValue = hasCustomRange ? "custom" : ["7", "14", "30", "90"].includes(rawDays) ? rawDays : "30";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Analytics" description={`Funnel metrics for ${business.name}.`} eyebrow="Analytics" />

      <Card>
        <AnalyticsFilterBar
          businessId={business.id}
          initial={{
            days: daysValue,
            from: firstParam(params["from"]),
            to: firstParam(params["to"]),
            campaign: query.campaign,
            adSet: query.adSet,
            ad: query.ad,
          }}
        />
      </Card>

      <Suspense fallback={<BodyFallback />}>
        <AnalyticsBody userId={user.id} businessId={business.id} query={query} />
      </Suspense>
    </div>
  );
}
