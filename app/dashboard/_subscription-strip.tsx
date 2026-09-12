import { getSubscriptionView } from "@/src/lib/billing/subscriptions";
import { resolveBusinessContext } from "@/src/lib/tenancy/context";
import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent } from "@/src/components/ui/card";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Billing strip: independent async island. Failure-isolated (returns null
 * on error) so a billing outage never blanks the dashboard, and streamed
 * in parallel with the KPI/recent-leads body — never blocks it.
 */
export async function SubscriptionStrip({ userId, businessId }: { userId: string; businessId: string }) {
  const resolved = await resolveBusinessContext(userId, businessId).catch(() => null);
  if (!resolved?.ok) return null;
  const view = await getSubscriptionView(resolved.context).catch(() => null);
  if (!view) return null;

  const { subscription, plan, usage } = view;
  const leadsPct = usage.leadsLimit > 0 ? Math.min(100, Math.round((usage.leadsUsed / usage.leadsLimit) * 100)) : 0;
  const attention = subscription.status !== "ACTIVE" || usage.leadsUsed >= usage.leadsLimit;

  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2.5">
            <p className="text-[13px] font-medium text-slate-500">Plan</p>
            <p className="text-sm font-bold tracking-tight text-slate-900">{plan.name}</p>
            <Badge variant={subscription.status === "ACTIVE" ? "success" : "warning"} dot>
              {subscription.status}
            </Badge>
          </div>
          <p className="text-[13px] text-slate-500 sm:mx-auto">
            <span className="font-semibold text-slate-700 tabular-nums">{usage.leadsUsed} / {usage.leadsLimit}</span> leads this month
            <span aria-hidden="true" className="mx-1.5 text-slate-300">·</span>
            <span className="font-semibold text-slate-700 tabular-nums">{usage.membersUsed} / {usage.membersLimit}</span> members
            <span aria-hidden="true" className="mx-1.5 text-slate-300">·</span>
            Renews {formatDate(usage.renewalDate)}
          </p>
          <a
            href={`/dashboard/settings/billing?businessId=${businessId}`}
            className="text-xs font-semibold whitespace-nowrap text-brand-700 hover:text-brand-800 hover:underline sm:ml-auto"
          >
            Manage billing
          </a>
        </div>
        <div
          className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-100"
          role="img"
          aria-label={`Monthly lead usage: ${usage.leadsUsed} of ${usage.leadsLimit}`}
        >
          <div
            className={attention ? "h-full rounded-full bg-red-500" : "h-full rounded-full bg-brand-600"}
            style={{ width: `${leadsPct}%` }}
          />
        </div>
        {attention ? (
          <p className="mt-2 text-xs font-medium text-red-600">
            {subscription.status !== "ACTIVE"
              ? "Subscription needs attention — new leads and invites are paused until reactivated."
              : "Monthly lead allowance is exhausted — new leads are paused until renewal or upgrade."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
