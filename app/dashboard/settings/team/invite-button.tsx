"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { Modal } from "@/src/components/ui/modal";
import { Select } from "@/src/components/ui/select";
import { useToast } from "@/src/components/ui/toast";
import type { WorkspaceRole } from "@/src/lib/tenancy/roles";

/** Invite a member by email. Only rendered for callers with members.invite. */
export function InviteMemberDialog({
  businessId,
  allowedRoles,
}: {
  businessId: string;
  allowedRoles: WorkspaceRole[];
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>(allowedRoles.includes("SALES") ? "SALES" : allowedRoles[0]);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useToast();

  const error =
    email.trim().length === 0
      ? "Email is required."
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
        ? "Email is invalid."
        : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (error) return;
    setServerError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), role }),
      });
      const data = (await res.json()) as { error?: string; errors?: Record<string, string> };
      if (!res.ok) {
        setServerError(data.error ?? (data.errors ? Object.values(data.errors).join(" ") : "Could not invite member."));
        return;
      }
      setOpen(false);
      setEmail("");
      setTouched(false);
      toast({ title: "Invite sent", description: `${email.trim()} joined as ${role}.`, variant: "success" });
      router.refresh();
    } catch {
      setServerError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Invite member</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Invite team member"
        description="They need an account first — invite by their login email."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={onSubmit} loading={pending}>
              Send invite
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Email" required error={touched ? error : null}>
            <Input
              type="email"
              autoComplete="off"
              placeholder="teammate@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Role" hint="Admins manage the team; Sales agents work leads.">
            <Select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}>
              {allowedRoles.map((r) => (
                <option key={r} value={r}>
                  {r === "OWNER" ? "Owner" : r === "ADMIN" ? "Admin" : "Sales"}
                </option>
              ))}
            </Select>
          </Field>
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
