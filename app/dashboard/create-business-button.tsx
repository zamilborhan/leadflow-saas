"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { Modal } from "@/src/components/ui/modal";

/** First-workspace creation for users without a business yet. */
export function CreateBusinessButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  const validationError = name.trim().length === 0 ? "Business name is required." : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (validationError) return;
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/businesses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = (await res.json()) as { business?: { id: string }; error?: string; errors?: Record<string, string> };
      if (!res.ok || !data.business) {
        setError(data.error ?? (data.errors ? Object.values(data.errors).join(" ") : "Could not create workspace."));
        return;
      }
      setOpen(false);
      router.push(`/dashboard?businessId=${data.business.id}`);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Create workspace</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create workspace"
        description="Your business gets its own isolated pipeline, team, and settings."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={onSubmit} loading={pending}>
              Create
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Business name" required error={touched ? validationError : null}>
            <Input
              type="text"
              autoComplete="organization"
              placeholder="e.g. Uddin Coaching Center"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {error ? (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {error}
            </p>
          ) : null}
        </form>
      </Modal>
    </>
  );
}
