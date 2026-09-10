"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { ConfirmDialog } from "@/src/components/ui/confirm-dialog";
import { useToast } from "@/src/components/ui/toast";
import type { FollowUpDTO } from "@/src/lib/tenancy/followups";
import { FollowUpFormDialog } from "./followup-form-dialog";
import type { AgentOption } from "../leads/lead-status";

/** Row-level follow-up actions: complete / cancel / reopen / reschedule / delete. */
export function FollowUpRowActions({
  businessId,
  followUp,
  agents,
  canAssignOthers,
  canDelete,
}: {
  businessId: string;
  followUp: FollowUpDTO;
  agents: AgentOption[];
  canAssignOthers: boolean;
  canDelete: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useToast();

  async function patch(body: Record<string, unknown>, success: string, failure: string) {
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/followups/${followUp.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast({ title: failure, description: data.error ?? "Please try again.", variant: "error" });
        router.refresh();
        return;
      }
      toast({ title: success, variant: "success" });
      router.refresh();
    } catch {
      toast({ title: failure, description: "Network error. Please try again.", variant: "error" });
    } finally {
      setPending(false);
    }
  }

  async function onDelete() {
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/followups/${followUp.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        toast({ title: "Delete failed", description: data.error ?? "Please try again.", variant: "error" });
        setConfirmDelete(false);
        return;
      }
      setConfirmDelete(false);
      toast({ title: "Follow-up deleted", variant: "success" });
      router.refresh();
    } catch {
      toast({ title: "Delete failed", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      {followUp.status === "PENDING" ? (
        <>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => patch({ status: "COMPLETED" }, "Follow-up completed", "Could not complete")}>
            Complete
          </Button>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => patch({ status: "CANCELLED" }, "Follow-up cancelled", "Could not cancel")}>
            Cancel
          </Button>
          <FollowUpFormDialog
            businessId={businessId}
            followUp={followUp}
            agents={agents}
            canAssignOthers={canAssignOthers}
            triggerLabel="Reschedule"
          />
        </>
      ) : (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => patch({ status: "PENDING" }, "Follow-up reopened", "Could not reopen")}>
          Reopen
        </Button>
      )}
      {canDelete ? (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirmDelete(true)} aria-label="Delete follow-up">
          Delete
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={onDelete}
        loading={pending}
        tone="danger"
        title="Delete follow-up?"
        message="This removes the scheduled follow-up permanently."
        confirmLabel="Delete"
      />
    </span>
  );
}
