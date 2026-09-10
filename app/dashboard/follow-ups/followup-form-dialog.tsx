"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { Modal } from "@/src/components/ui/modal";
import { Select } from "@/src/components/ui/select";
import { useToast } from "@/src/components/ui/toast";
import type { FollowUpDTO } from "@/src/lib/tenancy/followups";
import { agentLabel, type AgentOption } from "../leads/lead-status";

function isoToLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Schedule / reschedule a follow-up. Create assigns (default: self). */
export function FollowUpFormDialog({
  businessId,
  leadId,
  followUp,
  agents,
  canAssignOthers,
  triggerLabel,
}: {
  businessId: string;
  /** Required for scheduling; unused when rescheduling. */
  leadId?: string;
  followUp?: FollowUpDTO;
  agents: AgentOption[];
  canAssignOthers: boolean;
  triggerLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [scheduledAt, setScheduledAt] = useState(isoToLocal(followUp?.scheduledAt ?? null));
  const [note, setNote] = useState(followUp?.note ?? "");
  const [assignedTo, setAssignedTo] = useState(followUp?.assignedTo ?? "");
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const editing = Boolean(followUp);

  const dateError = localToIso(scheduledAt) === null ? "Scheduled time must be a valid date-time." : null;
  const noteError = note.trim().length > 2000 ? "Note must be 2000 characters or fewer." : null;
  const valid = !dateError && !noteError;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    setServerError(null);
    setPending(true);
    const body: Record<string, unknown> = {
      scheduledAt: localToIso(scheduledAt),
      note: note.trim() === "" ? null : note.trim(),
    };
    if (!editing) body["assignedTo"] = assignedTo === "" ? undefined : assignedTo;
    try {
      const url = editing
        ? `/api/businesses/${businessId}/followups/${followUp!.id}`
        : `/api/businesses/${businessId}/leads/${leadId}/followups`;
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string; errors?: Record<string, string> };
      if (!res.ok) {
        setServerError(data.error ?? (data.errors ? Object.values(data.errors).join(" ") : "Could not save follow-up."));
        return;
      }
      setOpen(false);
      toast({ title: editing ? "Follow-up rescheduled" : "Follow-up scheduled", variant: "success" });
      router.refresh();
    } catch {
      setServerError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant={editing ? "outline" : "primary"} size={editing ? "sm" : "md"} onClick={() => setOpen(true)}>
        {triggerLabel}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Reschedule follow-up" : "Schedule follow-up"}
        description="Pick a time and add an optional note for the agent."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={onSubmit} loading={pending}>
              {editing ? "Save changes" : "Schedule"}
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Scheduled at" required error={touched ? dateError : null}>
            <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </Field>
          <Field label="Note" error={touched ? noteError : null}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Call agenda…" autoComplete="off" />
          </Field>
          {!editing && canAssignOthers ? (
            <Field label="Assign to" hint="Defaults to you when left blank.">
              <Select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                <option value="">Me</option>
                {agents.map((a) => (
                  <option key={a.userId} value={a.userId}>
                    {agentLabel(a)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {serverError ? (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {serverError}
            </p>
          ) : null}
        </form>
      </Modal>
    </>
  );
}
