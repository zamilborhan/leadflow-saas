"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { INPUT_BASE } from "@/src/components/ui/input";
import { Select } from "@/src/components/ui/select";
import { cn } from "@/src/lib/cn";
import { useToast } from "@/src/components/ui/toast";
import { ACTIVITY_LABEL, MANUAL_ACTIVITY_TYPES } from "../lead-status";

/**
 * Manual event logger for follow-up and WhatsApp activity.
 * System events (created/assigned/status/note) are auto-emitted and
 * rejected by the API.
 */
export function LogActivityForm({ businessId, leadId }: { businessId: string; leadId: string }) {
  const [type, setType] = useState<string>(MANUAL_ACTIVITY_TYPES[0]);
  const [body, setBody] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useToast();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/leads/${leadId}/activities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, body: body.trim() === "" ? undefined : body.trim() }),
      });
      const data = (await res.json()) as { error?: string; errors?: Record<string, string> };
      if (!res.ok) {
        setServerError(data.error ?? (data.errors ? Object.values(data.errors).join(" ") : "Could not log activity."));
        return;
      }
      setBody("");
      toast({ title: "Activity logged", description: ACTIVITY_LABEL[type] ?? type, variant: "success" });
      router.refresh();
    } catch {
      setServerError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2 border-t border-slate-100 pt-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="log-activity-type" className="text-sm font-medium text-slate-700">
            Log update
          </label>
          <Select id="log-activity-type" value={type} onChange={(e) => setType(e.target.value)}>
            {MANUAL_ACTIVITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACTIVITY_LABEL[t]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="log-activity-body" className="text-sm font-medium text-slate-700">
            Details <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            id="log-activity-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Call summary, message snippet…"
            maxLength={2000}
            className={cn(INPUT_BASE, "h-10")}
          />
        </div>
        <Button type="submit" loading={pending}>
          Log
        </Button>
      </div>
      {serverError ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {serverError}
        </p>
      ) : null}
    </form>
  );
}
