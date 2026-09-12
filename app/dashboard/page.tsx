import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireUserForPage } from "@/src/lib/auth/dal";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { ButtonLink } from "@/src/components/ui/button";
import { PageHeader } from "@/src/components/ui/page-header";
import { KpiSkeletonGrid, TableSkeleton } from "@/src/components/ui/skeletons";
import { DashboardBody } from "./_dashboard-body";
import { SubscriptionStrip } from "./_subscription-strip";

export const metadata = {
  title: "Dashboard — LeadFlow",
};

function BodyFallback() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <KpiSkeletonGrid count={8} />
      <TableSkeleton rows={6} cols={5} />
    </div>
  );
}

function BillingFallback() {
  return (
    <div
      role="status"
      aria-label="Loading plan usage"
      className="rounded-[14px] border border-slate-200 bg-white p-5"
    >
      <div aria-hidden="true" className="skeleton-shimmer h-4 w-48 rounded" />
      <div aria-hidden="true" className="skeleton-shimmer mt-3 h-2 w-full rounded-full" />
    </div>
  );
}

/**
 * Workspace overview — streaming-first:
 * 1. Resolve user + workspace (2 fast queries) and paint the header instantly.
 * 2. KPIs / follow-ups / funnel / recent leads stream via `<Suspense>`.
 * 3. Billing strip streams independently and can never block or blank the page.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUserForPage();
  const params = await searchParams;
  const raw = params["businessId"];
  const requested = Array.isArray(raw) ? raw[0] ?? null : (raw ?? null);

  const businesses = await listUserBusinesses(user.id).catch(() => []);
  if (businesses.length === 0) redirect("/onboarding/workspace");
  const candidate = requested ?? businesses[0].id;
  const resolved = await resolveBusinessContext(user.id, candidate).catch(() => null);
  const business = resolved?.ok ? resolved.context.business : businesses[0];
  if (!resolved?.ok && !business) redirect("/onboarding/workspace");

  const hour = new Date().getHours();
  const daypart = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = user.email.split("@")[0].replace(/[._-]+/g, " ").trim().split(" ")[0] ?? "there";
  const displayName = firstName.charAt(0).toUpperCase() + firstName.slice(1);
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="flex flex-col gap-6">
      {!user.emailVerifiedAt ? (
        <div className="rounded-[14px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
          <span className="font-semibold">Verify your email</span> to unlock all features.{" "}
          <a href="/verify-email" className="font-semibold text-brand-700 hover:text-brand-800 hover:underline">
            Verify now →
          </a>
        </div>
      ) : null}
      <PageHeader
        title={`${daypart}, ${displayName}`}
        description={`Here's what's happening with ${business.name} today · ${today}.`}
        eyebrow={business.name}
        actions={
          <>
            <ButtonLink href={`/dashboard/leads?businessId=${business.id}`} variant="outline">
              View leads
            </ButtonLink>
            <ButtonLink href={`/dashboard/leads?businessId=${business.id}`}>Add lead</ButtonLink>
          </>
        }
      />

      <Suspense fallback={<BillingFallback />}>
        <SubscriptionStrip userId={user.id} businessId={business.id} />
      </Suspense>

      <Suspense fallback={<BodyFallback />}>
        <DashboardBody userId={user.id} requestedBusinessId={requested} />
      </Suspense>
    </div>
  );
}
