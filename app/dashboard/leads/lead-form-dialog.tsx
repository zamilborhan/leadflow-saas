"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { Modal } from "@/src/components/ui/modal";
import { Select } from "@/src/components/ui/select";
import { useToast } from "@/src/components/ui/toast";
import type { LeadDTO } from "@/src/lib/tenancy/leads";
import { LEAD_STATUSES, LEAD_STATUS_LABEL, agentLabel, type AgentOption } from "./lead-status";

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Create / edit lead dialog wired to the leads API. */
export function LeadFormDialog({
  businessId,
  lead,
  agents,
  canAssign,
  triggerLabel,
  triggerVariant = "primary",
}: {
  businessId: string;
  lead?: LeadDTO;
  agents: AgentOption[];
  canAssign: boolean;
  triggerLabel: string;
  triggerVariant?: "primary" | "outline";
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(lead?.name ?? "");
  const [email, setEmail] = useState(lead?.email ?? "");
  const [phone, setPhone] = useState(lead?.phone ?? "");
  const [status, setStatus] = useState(lead?.status ?? "NEW");
  const [source, setSource] = useState(lead?.source ?? "");
  const [campaignName, setCampaignName] = useState(lead?.campaignName ?? "");
  const [adSetName, setAdSetName] = useState(lead?.adSetName ?? "");
  const [adName, setAdName] = useState(lead?.adName ?? "");
  const [facebookLeadId, setFacebookLeadId] = useState(lead?.facebookLeadId ?? "");
  const [assignedTo, setAssignedTo] = useState(lead?.assignedTo ?? "");
  const [lastContactedAt, setLastContactedAt] = useState(isoToLocal(lead?.lastContactedAt ?? null));
  const [nextFollowUpAt, setNextFollowUpAt] = useState(isoToLocal(lead?.nextFollowUpAt ?? null));
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const editing = Boolean(lead);

  const nameError = name.trim().length === 0 ? "Lead name is required." : null;
  const emailError =
    email.trim().length > 0 && !EMAIL_RE.test(email.trim()) ? "Email is invalid." : null;
  const valid = !nameError && !emailError;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    setServerError(null);
    setPending(true);
    const body: Record<string, unknown> = {
      name: name.trim(),
      email: email.trim() === "" ? null : email.trim(),
      phone: phone.trim() === "" ? null : phone.trim(),
      status,
      source: source.trim() === "" ? null : source.trim(),
      campaignName: campaignName.trim() === "" ? null : campaignName.trim(),
      adSetName: adSetName.trim() === "" ? null : adSetName.trim(),
      adName: adName.trim() === "" ? null : adName.trim(),
      facebookLeadId: facebookLeadId.trim() === "" ? null : facebookLeadId.trim(),
      lastContactedAt: localToIso(lastContactedAt),
      nextFollowUpAt: localToIso(nextFollowUpAt),
    };
    if (canAssign) body["assignedTo"] = assignedTo === "" ? null : assignedTo;
    try {
      const res = await fetch(
        editing ? `/api/businesses/${businessId}/leads/${lead!.id}` : `/api/businesses/${businessId}/leads`,
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = (await res.json()) as { error?: string; errors?: Record<string, string> };
      if (!res.ok) {
        setServerError(data.error ?? (data.errors ? Object.values(data.errors).join(" ") : "Could not save lead."));
        return;
      }
      setOpen(false);
      toast({
        title: editing ? "Lead updated" : "Lead created",
        description: name.trim(),
        variant: "success",
      });
      router.refresh();
    } catch {
      setServerError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant={triggerVariant} onClick={() => setOpen(true)}>
        {triggerLabel}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit lead" : "Add lead"}
        description={editing ? "Update prospect details." : "Capture a prospect manually."}
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={onSubmit} loading={pending}>
              {editing ? "Save changes" : "Create lead"}
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name" required error={touched ? nameError : null}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Prospect name" />
            </Field>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                {LEAD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {LEAD_STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Email" error={touched ? emailError : null}>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="prospect@example.com" autoComplete="off" />
            </Field>
            <Field label="Phone">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+880 1XXX-XXXXXX" autoComplete="off" />
            </Field>
            <Field label="Source">
              <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="facebook, referral…" autoComplete="off" />
            </Field>
            <Field label="Campaign">
              <Input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="Campaign name" autoComplete="off" />
            </Field>
            <Field label="Ad set">
              <Input value={adSetName} onChange={(e) => setAdSetName(e.target.value)} placeholder="Ad set name" autoComplete="off" />
            </Field>
            <Field label="Ad">
              <Input value={adName} onChange={(e) => setAdName(e.target.value)} placeholder="Ad name" autoComplete="off" />
            </Field>
            <Field label="Facebook lead ID">
              <Input value={facebookLeadId} onChange={(e) => setFacebookLeadId(e.target.value)} placeholder="FB lead id" autoComplete="off" />
            </Field>
            {canAssign ? (
              <Field label="Assign to" hint="Only workspace members can be assigned.">
                <Select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                  <option value="">Unassigned</option>
                  {agents.map((a) => (
                    <option key={a.userId} value={a.userId}>
                      {agentLabel(a)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Last contacted">
              <Input type="datetime-local" value={lastContactedAt} onChange={(e) => setLastContactedAt(e.target.value)} />
            </Field>
            <Field label="Next follow-up">
              <Input type="datetime-local" value={nextFollowUpAt} onChange={(e) => setNextFollowUpAt(e.target.value)} />
            </Field>
          </div>
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
