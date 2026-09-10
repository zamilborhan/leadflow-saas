"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { ConfirmDialog } from "@/src/components/ui/confirm-dialog";
import { Select } from "@/src/components/ui/select";
import { useToast } from "@/src/components/ui/toast";
import { LEAD_STATUSES, LEAD_STATUS_LABEL } from "../lead-status";

/** Status / contact / archive / delete actions for the lead details page. */
export function LeadDetailActions({
  businessId,
  leadId,
  leadName,
  status,
  archived,
  canEdit,
  canDelete,
}: {
  businessId: string;
  leadId: string;
  leadName: string;
  status: string;
  archived: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useToast();

  async function patch(body: Record<string, unknown>, success: { title: string; description?: string }) {
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/leads/${leadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast({ title: "Update failed", description: data.error ?? "Please try again.", variant: "error" });
        router.refresh();
        return;
      }
      toast({ ...success, variant: "success" });
      router.refresh();
    } catch {
      toast({ title: "Update failed", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setPending(false);
    }
  }

  async function onDelete() {
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/leads/${leadId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        toast({ title: "Delete failed", description: data.error ?? "Please try again.", variant: "error" });
        setConfirmDelete(false);
        return;
      }
      toast({ title: "Lead deleted", description: leadName, variant: "success" });
      router.push(`/dashboard/leads?businessId=${businessId}`);
      router.refresh();
    } catch {
      toast({ title: "Delete failed", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canEdit ? (
        <label className="inline-flex items-center gap-2 text-sm text-slate-500">
          Status
          <Select
            value={status}
            disabled={pending}
            onChange={(e) => patch({ status: e.target.value }, { title: "Status updated" })}
            className="h-9 w-40"
            aria-label="Change lead status"
          >
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LEAD_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
      {canEdit ? (
        <Button
          variant="outline"
          onClick={() =>
            patch(
              { lastContactedAt: new Date().toISOString() },
              { title: "Marked as contacted", description: "Last-contacted time updated." }
            )
          }
          disabled={pending}
        >
          Log contact
        </Button>
      ) : null}
      {canDelete ? (
        archived ? (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => patch({ archived: false }, { title: "Lead restored" })}
          >
            Restore
          </Button>
        ) : (
          <Button variant="outline" disabled={pending} onClick={() => setConfirmArchive(true)}>
            Archive
          </Button>
        )
      ) : null}
      {canDelete ? (
        <Button variant="danger" disabled={pending} onClick={() => setConfirmDelete(true)}>
          Delete
        </Button>
      ) : null}

      <ConfirmDialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={() => {
          setConfirmArchive(false);
          patch({ archived: true }, { title: "Lead archived" });
        }}
        loading={pending}
        title="Archive lead?"
        message={`${leadName} will be hidden from the active pipeline. You can restore it anytime.`}
        confirmLabel="Archive"
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={onDelete}
        loading={pending}
        tone="danger"
        title="Delete lead permanently?"
        message={`${leadName} and its history will be removed forever. This cannot be undone.`}
        confirmLabel="Delete"
      />
    </div>
  );
}
