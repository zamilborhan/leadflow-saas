import { requireUserForPage } from "@/src/lib/auth/dal";
import { getSubscriptionView } from "@/src/lib/billing/subscriptions";
import { listInvoiceHistory } from "@/src/lib/integrations/sslcommerz/service";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { listUserBusinesses } from "@/src/lib/tenancy/businesses";
import { Card } from "@/src/components/ui/card";
import { PageHeader } from "@/src/components/ui/page-header";
import { EmptyState } from "@/src/components/ui/states";
import { BillingForm, type PaymentResult } from "./billing-form";

export const metadata = {
  title: "Billing settings — LeadFlow BD",
};

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

/**
 * Workspace billing: current plan, live usage, renewal date, and
 * owner-gated plan/status changes. Usage is always re-read server-side,
 * so the numbers here can never drift from enforced quotas.
 */
export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUserForPage();
  const params = await searchParams;
  const requested = firstParam(params["businessId"]) || null;

  const businesses = await listUserBusinesses(user.id).catch(() => []);
  if (businesses.length === 0) {
    return (
      <Card>
        <EmptyState title="No workspace yet" description="Create a workspace to manage its subscription." />
      </Card>
    );
  }
  let resolved = requested ? await resolveBusinessContext(user.id, requested) : null;
  if (!resolved?.ok) {
    const retry = await resolveBusinessContext(user.id, businesses[0].id);
    if (!retry.ok) {
      return (
        <Card>
          <EmptyState title="No workspace yet" description="Create a workspace to manage its subscription." />
        </Card>
      );
    }
    resolved = retry;
  }
  const { business, membership } = resolved.context;

  const view = await getSubscriptionView(resolved.context);
  const invoices = await listInvoiceHistory(resolved.context).catch(() => []);

  // Browser gateway callbacks redirect here with ?payment=&tran_id=.
  // Display-only: activation state always comes from server records.
  const paymentParam = firstParam(params["payment"]);
  const paymentResult: PaymentResult =
    paymentParam === "success" || paymentParam === "fail" || paymentParam === "cancel"
      ? { outcome: paymentParam, tranId: firstParam(params["tran_id"]) || null }
      : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Billing"
        description={`Subscription for ${business.name}. Usage resets monthly.`}
      />
      <BillingForm
        businessId={business.id}
        initial={view}
        isOwner={membership.role === "OWNER"}
        invoices={invoices}
        paymentResult={paymentResult}
      />
    </div>
  );
}
