"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { Badge } from "@/src/components/ui/badge";
import { Card } from "@/src/components/ui/card";
import { useToast } from "@/src/components/ui/toast";
import { cn } from "@/src/lib/cn";
import type { PlanCode } from "@/src/lib/billing/catalog";

export interface BillingPlanOption {
  code: PlanCode;
  name: string;
  leadsPerMonth: number;
  maxUsers: number;
  maxBusinesses: number | null;
  priceMinor: number;
  currency: string;
}

export interface BillingView {
  subscription: {
    planCode: PlanCode;
    status: string;
    billingCycle: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
  };
  plan: BillingPlanOption;
  usage: {
    leadsUsed: number;
    leadsLimit: number;
    membersUsed: number;
    membersLimit: number;
    renewalDate: string;
  };
  plans: BillingPlanOption[];
}

const STATUS_BADGE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  ACTIVE: "success",
  PAST_DUE: "warning",
  CANCELED: "danger",
};

export interface BillingInvoice {
  id: string;
  invoiceNumber: string;
  planCode: string;
  amountMinor: number;
  currency: string;
  status: string;
  paymentStatus: string;
  createdAt: string;
}

export type PaymentResult = { outcome: "success" | "fail" | "cancel"; tranId: string | null } | null;

function formatMoney(minor: number, currency: string): string {
  const safe = Number.isSafeInteger(minor) && minor >= 0 ? minor : 0;
  const whole = Math.floor(safe / 100).toLocaleString("en-US");
  const symbol = currency === "BDT" ? "৳" : `${currency} `;
  return `${symbol}${whole}.${String(safe % 100).padStart(2, "0")}`;
}

const INVOICE_BADGE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = {
  PAID: "success",
  DRAFT: "info",
  VOID: "neutral",
  SUCCESS: "success",
  FAILED: "danger",
  CANCELLED: "warning",
  EXPIRED: "warning",
  RISK_HOLD: "warning",
  INITIATED: "info",
  PENDING: "info",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function UsageBar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const over = used >= limit;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        <span className={over ? "font-semibold text-red-600" : "text-slate-500"}>
          {used} / {limit}
        </span>
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100"
        role="img"
        aria-label={`${label}: ${used} of ${limit} used`}
      >
        <div className={cn("h-full rounded-full", over ? "bg-red-500" : "bg-brand-600")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Billing management. Plan/status changes are OWNER-only (the server
 * enforces this — the form merely hides the controls otherwise).
 */
export function BillingForm({
  businessId,
  initial,
  isOwner,
  invoices,
  paymentResult,
}: {
  businessId: string;
  initial: BillingView;
  isOwner: boolean;
  invoices: BillingInvoice[];
  paymentResult: PaymentResult;
}) {
  const router = useRouter();
  const toast = useToast();
  const [selected, setSelected] = useState<PlanCode>(initial.subscription.planCode);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [checkoutPending, setCheckoutPending] = useState(false);

  async function patch(body: Record<string, string>, actions: { onOk: () => void; okTitle: string }) {
    const res = await fetch(`/api/businesses/${businessId}/subscription`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { error?: string; errors?: Record<string, string> } | null;
    if (!res.ok) {
      setServerError(
        data?.error ?? (data?.errors ? Object.values(data.errors).join(" ") : "Could not update subscription.")
      );
      return;
    }
    setServerError(null);
    toast({ title: actions.okTitle, variant: "success" });
    actions.onOk();
    router.refresh();
  }

  async function onPlanChange(e: React.FormEvent) {
    e.preventDefault();
    if (selected === initial.subscription.planCode || pending) return;
    setPending(true);
    try {
      await patch({ planCode: selected }, { onOk: () => {}, okTitle: `Plan changed to ${selected}.` });
    } finally {
      setPending(false);
    }
  }

  /**
   * Paid checkout: creates an invoice + payment server-side and redirects
   * to the SSLCommerz gateway. The amount comes from the static catalog —
   * the request names a plan and nothing else.
   */
  async function onCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (checkoutPending) return;
    setCheckoutPending(true);
    setServerError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/payments/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planCode: selected }),
      });
      const data = (await res.json().catch(() => null)) as { gatewayUrl?: string; error?: string; errors?: Record<string, string> } | null;
      if (!res.ok || !data?.gatewayUrl) {
        setServerError(
          data?.error ?? (data?.errors ? Object.values(data.errors).join(" ") : "Could not start checkout.")
        );
        return;
      }
      window.location.href = data.gatewayUrl;
    } catch {
      setServerError("Network error. Please try again.");
    } finally {
      setCheckoutPending(false);
    }
  }

  async function onCancel() {
    if (cancelPending) return;
    setCancelPending(true);
    try {
      await patch({ status: "CANCELED" }, { onOk: () => {}, okTitle: "Subscription canceled." });
    } finally {
      setCancelPending(false);
    }
  }

  async function onReactivate() {
    if (cancelPending) return;
    setCancelPending(true);
    try {
      await patch({ status: "ACTIVE" }, { onOk: () => {}, okTitle: "Subscription reactivated." });
    } finally {
      setCancelPending(false);
    }
  }

  const sub = initial.subscription;
  const selectedPlan = initial.plans.find((p) => p.code === selected) ?? null;
  const checkoutAmount = selectedPlan && selectedPlan.priceMinor > 0 ? formatMoney(selectedPlan.priceMinor, selectedPlan.currency) : null;

  return (
    <div className="flex flex-col gap-6">
      {paymentResult ? (
        <div
          role={paymentResult.outcome === "success" ? "status" : "alert"}
          className={
            paymentResult.outcome === "success"
              ? "rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm font-medium text-emerald-800"
              : "rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm font-medium text-amber-800"
          }
        >
          {paymentResult.outcome === "success"
            ? "Payment received — your subscription activates once the gateway confirms it. This page refreshes automatically."
            : paymentResult.outcome === "fail"
              ? "The payment did not go through. No charges were applied — try again or pick another method."
              : "The payment was cancelled before completion. No charges were applied."}
        </div>
      ) : null}
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4 sm:px-6">
          <h2 className="text-base font-semibold text-slate-900">Current plan</h2>
          <Badge variant={STATUS_BADGE[sub.status] ?? "neutral"} dot>
            {sub.status}
          </Badge>
          <span className="ml-auto text-sm text-slate-500">
            Renews {formatDate(initial.usage.renewalDate)} · {sub.billingCycle === "MONTHLY" ? "Monthly" : sub.billingCycle} billing
          </span>
        </div>
        <div className="flex flex-col gap-4 px-5 py-5 sm:px-6">
          <UsageBar used={initial.usage.leadsUsed} limit={initial.usage.leadsLimit} label="Leads this month" />
          <UsageBar used={initial.usage.membersUsed} limit={initial.usage.membersLimit} label="Team members" />
          {serverError ? (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {serverError}
            </p>
          ) : null}
          {!isOwner ? (
            <p className="text-sm text-slate-500">Only the workspace owner can change the plan or subscription status.</p>
          ) : sub.status !== "ACTIVE" ? (
            <div>
              <Button onClick={onReactivate} loading={cancelPending} variant="outline">
                Reactivate subscription
              </Button>
            </div>
          ) : (
            <div>
              <Button onClick={onCancel} loading={cancelPending} variant="outline">
                Cancel subscription
              </Button>
            </div>
          )}
        </div>
      </Card>

      <form onSubmit={onPlanChange}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {initial.plans.map((p) => {
            const current = p.code === sub.planCode;
            const picked = selected === p.code;
            return (
              <button
                key={p.code}
                type="button"
                disabled={!isOwner}
                onClick={() => setSelected(p.code)}
                aria-pressed={picked}
                className={cn(
                  "rounded-xl border bg-white p-5 text-left shadow-sm transition-colors",
                  picked ? "border-brand-600 ring-1 ring-brand-600" : "border-slate-200 hover:border-slate-300",
                  !isOwner && "cursor-default opacity-90"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-base font-semibold text-slate-900">{p.name}</p>
                  {current ? <Badge variant="brand">Current</Badge> : null}
                </div>
                <p className="mt-1 text-lg font-bold text-slate-900">
                  {p.priceMinor > 0 ? formatMoney(p.priceMinor, p.currency) : "Free"}
                  {p.priceMinor > 0 ? <span className="text-sm font-normal text-slate-500"> / month</span> : null}
                </p>
                <ul className="mt-3 flex flex-col gap-1.5 text-sm text-slate-600">
                  <li>
                    <span className="font-semibold text-slate-900">{p.leadsPerMonth.toLocaleString()}</span> leads / month
                  </li>
                  <li>
                    <span className="font-semibold text-slate-900">{p.maxUsers}</span>{" "}
                    {p.maxUsers === 1 ? "user" : "users"}
                  </li>
                  <li>{p.maxBusinesses === null ? "Unlimited workspaces" : p.maxBusinesses === 1 ? "1 workspace" : `${p.maxBusinesses} workspaces`}</li>
                </ul>
              </button>
            );
          })}
        </div>
        {isOwner && selected !== sub.planCode ? (
          checkoutAmount ? (
            <div className="mt-4">
              <Button type="button" onClick={onCheckout} loading={checkoutPending}>
                {`Pay ${checkoutAmount} with SSLCommerz`}
              </Button>
              <p className="mt-2 text-xs text-slate-500">
                You will be redirected to the secure gateway. Your plan activates after payment confirmation.
              </p>
            </div>
          ) : (
            <div className="mt-4">
              <Button type="submit" loading={pending}>
                Change to {selectedPlan?.name ?? selected}
              </Button>
            </div>
          )
        ) : (
          <p className="mt-4 text-xs text-slate-500">
            Paid plans are processed securely via SSLCommerz (bKash, cards, internet banking).
          </p>
        )}
      </form>

      <Card>
        <div className="border-b border-slate-100 px-5 py-4 sm:px-6">
          <h2 className="text-base font-semibold text-slate-900">Invoices</h2>
        </div>
        {invoices.length === 0 ? (
          <p className="px-5 py-5 text-sm text-slate-500 sm:px-6">No invoices yet. Paid checkouts appear here.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center gap-2 px-5 py-3 sm:px-6">
                <span className="font-mono text-sm font-medium text-slate-900">{inv.invoiceNumber}</span>
                <span className="text-sm text-slate-500">{inv.planCode}</span>
                <span className="text-sm font-medium text-slate-700">{formatMoney(inv.amountMinor, inv.currency)}</span>
                <span className="text-xs text-slate-400">{formatDate(inv.createdAt)}</span>
                <span className="ml-auto flex items-center gap-2">
                  <Badge variant={INVOICE_BADGE[inv.status] ?? "neutral"}>{inv.status}</Badge>
                  <Badge variant={INVOICE_BADGE[inv.paymentStatus] ?? "neutral"}>{inv.paymentStatus}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
