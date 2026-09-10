"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { ConfirmDialog } from "@/src/components/ui/confirm-dialog";
import { useToast } from "@/src/components/ui/toast";
import { PLAN_CODES, type PlanCode } from "@/src/lib/billing/catalog";

/** Suspend / reactivate + plan-change actions for one workspace. */
export function BusinessModerationActions({
  businessId,
  businessName,
  status,
  planCode,
}: {
  businessId: string;
  businessName: string;
  status: string;
  planCode: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState<"SUSPEND" | "REACTIVATE" | null>(null);
  const [plan, setPlan] = useState<PlanCode>((PLAN_CODES as readonly string[]).includes(planCode) ? (planCode as PlanCode) : "FREE");

  const suspended = status === "SUSPENDED";

  async function setStatus(next: "ACTIVE" | "SUSPENDED") {
    setPending(true);
    try {
      const res = await fetch(`/api/admin/businesses/${businessId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body as { error?: string } | null)?.error ?? `Request failed (${res.status}).`);
      }
      toast({
        title: next === "SUSPENDED" ? "Workspace suspended" : "Workspace reactivated",
        description: `${businessName} is now ${next}.`,
        variant: next === "SUSPENDED" ? "error" : "success",
      });
      router.refresh();
    } catch (err) {
      toast({
        title: "Action failed",
        description: err instanceof Error ? err.message : "Could not update workspace.",
        variant: "error",
      });
    } finally {
      setPending(false);
      setConfirm(null);
    }
  }

  async function changePlan(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const res = await fetch(`/api/admin/businesses/${businessId}/subscription`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planCode: plan }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const detail =
          (body as { errors?: Record<string, string>; error?: string } | null)?.error ??
          Object.values((body as { errors?: Record<string, string> } | null)?.errors ?? {}).join(" ") ??
          `Request failed (${res.status}).`;
        throw new Error(detail);
      }
      toast({ title: "Plan changed", description: `${businessName} is now on ${plan}.`, variant: "success" });
      router.refresh();
    } catch (err) {
      toast({
        title: "Plan change failed",
        description: err instanceof Error ? err.message : "Could not change plan.",
        variant: "error",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {suspended ? (
          <Button variant="primary" disabled={pending} onClick={() => setConfirm("REACTIVATE")}>
            Reactivate business
          </Button>
        ) : (
          <Button variant="danger" disabled={pending} onClick={() => setConfirm("SUSPEND")}>
            Suspend business
          </Button>
        )}
      </div>

      <form onSubmit={changePlan} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="admin-plan-select" className="text-sm font-medium text-slate-700">
            Change plan
          </label>
          <select
            id="admin-plan-select"
            value={plan}
            onChange={(e) => setPlan(e.target.value as PlanCode)}
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
          >
            {PLAN_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline" loading={pending}>
          Apply plan
        </Button>
      </form>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => setStatus(confirm === "SUSPEND" ? "SUSPENDED" : "ACTIVE")}
        tone={confirm === "SUSPEND" ? "danger" : "default"}
        title={confirm === "SUSPEND" ? "Suspend workspace?" : "Reactivate workspace?"}
        message={
          confirm === "SUSPEND"
            ? `Members of ${businessName} will immediately lose access and integrations will pause.`
            : `Members of ${businessName} will regain access immediately.`
        }
        confirmLabel={confirm === "SUSPEND" ? "Suspend" : "Reactivate"}
      />
    </div>
  );
}
