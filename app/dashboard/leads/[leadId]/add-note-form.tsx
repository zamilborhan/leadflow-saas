"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/src/components/ui/button";
import { INPUT_BASE } from "@/src/components/ui/input";
import { cn } from "@/src/lib/cn";
import { useToast } from "@/src/components/ui/toast";

/** Note composer. Posts to the notes API; the timeline updates on refresh. */
export function AddNoteForm({ businessId, leadId }: { businessId: string; leadId: string }) {
  const [body, setBody] = useState("");
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useToast();

  const error =
    body.trim().length === 0 ? "Note must not be empty." : body.trim().length > 2000 ? "Note must be 2000 characters or fewer." : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (error) return;
    setServerError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/leads/${leadId}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: body.trim() }),
      });
      const data = (await res.json()) as { error?: string; errors?: Record<string, string> };
      if (!res.ok) {
        setServerError(data.error ?? (data.errors ? Object.values(data.errors).join(" ") : "Could not save note."));
        return;
      }
      setBody("");
      setTouched(false);
      toast({ title: "Note added", variant: "success" });
      router.refresh();
    } catch {
      setServerError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <label htmlFor="lead-note-body" className="text-sm font-medium text-slate-700">
        Add a note
      </label>
      <textarea
        id="lead-note-body"
        rows={3}
        maxLength={2001}
        placeholder="Call outcome, prospect interest, next steps…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-invalid={touched && error ? true : undefined}
        aria-describedby={touched && error ? "lead-note-error" : undefined}
        className={cn(INPUT_BASE, "min-h-20 resize-y")}
      />
      {touched && error ? (
        <p id="lead-note-error" role="alert" className="text-xs font-medium text-red-600">
          {error}
        </p>
      ) : null}
      {serverError ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {serverError}
        </p>
      ) : null}
      <div>
        <Button type="submit" size="sm" loading={pending}>
          Save note
        </Button>
      </div>
    </form>
  );
}
