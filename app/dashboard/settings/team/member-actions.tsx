"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { ConfirmDialog } from "@/src/components/ui/confirm-dialog";
import { Select } from "@/src/components/ui/select";
import { useToast } from "@/src/components/ui/toast";
import type { WorkspaceRole } from "@/src/lib/tenancy/roles";

/** Change a member's role inline. Rendered only when the caller may do so. */
export function MemberRoleSelect({
  businessId,
  targetUserId,
  targetEmail,
  currentRole,
  allowedRoles,
}: {
  businessId: string;
  targetUserId: string;
  targetEmail: string;
  currentRole: WorkspaceRole;
  allowedRoles: WorkspaceRole[];
}) {
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useToast();

  async function onChange(next: WorkspaceRole) {
    if (next === currentRole) return;
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/members/${targetUserId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: next }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast({ title: "Could not change role", description: data.error ?? "Please try again.", variant: "error" });
        router.refresh();
        return;
      }
      toast({ title: "Role updated", description: `${targetEmail} is now ${next}.`, variant: "success" });
      router.refresh();
    } catch {
      toast({ title: "Could not change role", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setPending(false);
    }
  }

  const options = Array.from(new Set([currentRole, ...allowedRoles]));

  return (
    <label className="inline-flex items-center gap-2">
      <span className="sr-only">Change role for {targetEmail}</span>
      <Select
        value={currentRole}
        disabled={pending}
        onChange={(e) => onChange(e.target.value as WorkspaceRole)}
        className="h-9 w-32"
        aria-label={`Change role for ${targetEmail}`}
      >
        {options.map((r) => (
          <option key={r} value={r}>
            {r === "OWNER" ? "Owner" : r === "ADMIN" ? "Admin" : "Sales"}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** Remove a member with confirmation. Rendered only when the caller may do so. */
export function RemoveMemberButton({
  businessId,
  targetUserId,
  targetEmail,
}: {
  businessId: string;
  targetUserId: string;
  targetEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useToast();

  async function onConfirm() {
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/members/${targetUserId}`, { method: "DELETE" });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast({ title: "Could not remove member", description: data.error ?? "Please try again.", variant: "error" });
        setOpen(false);
        return;
      }
      setOpen(false);
      toast({ title: "Member removed", description: `${targetEmail} no longer has access.`, variant: "success" });
      router.refresh();
    } catch {
      toast({ title: "Could not remove member", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`Remove ${targetEmail}`}>
        Remove
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={onConfirm}
        loading={pending}
        tone="danger"
        title="Remove team member?"
        message={`${targetEmail} will immediately lose access to this workspace.`}
        confirmLabel="Remove"
      />
    </>
  );
}
