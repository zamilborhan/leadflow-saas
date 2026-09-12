"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";

export const MAX_WORKSPACE_NAME_LENGTH = 120;
export const MIN_WORKSPACE_NAME_LENGTH = 2;

/**
 * Validate a workspace name (mirrors `validateBusinessName` server-side:
 * required, trimmed, 2–120 chars, at least one letter/number in any script).
 */
export function workspaceNameError(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return "Business name is required.";
  if (name.length < MIN_WORKSPACE_NAME_LENGTH) {
    return `Business name must be at least ${MIN_WORKSPACE_NAME_LENGTH} characters.`;
  }
  if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
    return `Business name must be ${MAX_WORKSPACE_NAME_LENGTH} characters or fewer.`;
  }
  if (!/[\p{L}\p{N}]/u.test(name)) {
    return "Business name must include a letter or number.";
  }
  return null;
}

/**
 * First-workspace creation for signed-in users who own none yet.
 *
 * Focus safety: this component has stable identity (module scope, no remount
 * keys, no inline component definitions) and renders a single persistent
 * `<input>` in a fixed position, so typing never moves or loses focus —
 * validation only swaps hint/error text beneath it.
 */
export function CreateWorkspaceForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Synchronous double-submit guard: React state updates don't apply before
  // a second rapid submit event, so a ref blocks the duplicate POST that
  // `pending` alone cannot catch.
  const submittingRef = useRef(false);

  const validationError = workspaceNameError(name);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;
    setTouched(true);
    if (validationError) return;
    submittingRef.current = true;
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/businesses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = (await res.json()) as {
        business?: { id: string };
        error?: string;
        errors?: Record<string, string>;
      };
      if (!res.ok || !data.business) {
        // The typed name is untouched, so retry keeps everything entered.
        setError(
          data.error ??
            (data.errors ? Object.values(data.errors).join(" ") : "Could not create workspace.")
        );
        return;
      }
      router.push(`/dashboard?businessId=${data.business.id}`);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      submittingRef.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <Field
        label="Business name"
        hint="Usually your business name. You can invite your team afterwards."
        required
        error={touched ? validationError : null}
      >
        <Input
          type="text"
          required
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
      <Button type="submit" loading={pending} className="w-full">
        {pending ? "Creating workspace…" : "Create workspace"}
      </Button>
    </form>
  );
}
