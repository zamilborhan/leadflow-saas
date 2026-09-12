"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { EmptyState } from "@/src/components/ui/states";
import { Field, Input } from "@/src/components/ui/input";
import { Select } from "@/src/components/ui/select";
import { useToast } from "@/src/components/ui/toast";
import { renderPreview } from "@/src/lib/integrations/whatsapp/template-parse";
import type { WhatsAppMessageDTO } from "@/src/lib/integrations/whatsapp/messages";
import type { LeadTemplateSelectionDTO, TemplateDTO } from "@/src/lib/integrations/whatsapp/templates";

const STATUS_VARIANT = {
  QUEUED: "neutral",
  SENDING: "info",
  SENT: "success",
  DELIVERED: "success",
  READ: "success",
  RECEIVED: "neutral",
  FAILED: "danger",
} as const;

function messageLabel(m: WhatsAppMessageDTO): string {
  if (m.body) return m.body.length > 80 ? `${m.body.slice(0, 80)}…` : m.body;
  return m.templateName ?? m.type;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * WhatsApp composer for a lead: APPROVED template + variable values with
 * live preview, send → queued row, then POLLED status (the send response
 * is acceptance, never delivery — see module docs). History lists every
 * message with wamid/timestamp/error and retry for FAILED rows.
 * Gated by whatsapp.send upstream.
 */
export function MessageComposer({
  businessId,
  leadId,
  leadPhone,
  templates,
  selection,
  initialMessages,
}: {
  businessId: string;
  leadId: string;
  leadPhone: string;
  templates: TemplateDTO[];
  selection: LeadTemplateSelectionDTO | null;
  initialMessages: WhatsAppMessageDTO[];
}) {
  const approved = useMemo(() => templates.filter((t) => t.sendable), [templates]);
  const defaultKey = selection ? `${selection.templateName}\u0000${selection.templateLanguage}` : "";
  const [templateKey, setTemplateKey] = useState(defaultKey);
  const [values, setValues] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<WhatsAppMessageDTO[]>(initialMessages);
  const [pending, setPending] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const toast = useToast();

  const chosen = useMemo(
    () => approved.find((t) => `${t.name}\u0000${t.language}` === templateKey) ?? null,
    [approved, templateKey]
  );
  const preview = useMemo(
    () =>
      renderPreview(
        (chosen?.components ?? []).map((c) => ({ type: c.type, text: c.text })),
        values
      ),
    [chosen, values]
  );

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  function onTemplateChange(nextKey: string) {
    setTemplateKey(nextKey);
    // Reset stale variable values with the template switch itself instead
    // of a cascading effect, so one render reflects the new template.
    setValues({});
  }

  async function fetchMessage(id: string): Promise<WhatsAppMessageDTO | null> {
    try {
      const res = await fetch(`/api/businesses/${businessId}/leads/${leadId}/messages/${id}`, {
        cache: "no-store",
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { message?: WhatsAppMessageDTO };
      return data.message ?? null;
    } catch {
      return null;
    }
  }

  /** Poll until the row leaves a transient state (max ~10s), then refresh. */
  function pollStatus(id: string, rounds = 5) {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    if (rounds <= 0) {
      router.refresh();
      return;
    }
    pollTimer.current = setTimeout(async () => {
      const row = await fetchMessage(id);
      if (row) {
        setMessages((prev) => {
          const next = prev.map((m) => (m.id === id ? row : m));
          return prev.some((m) => m.id === id) ? next : [row, ...prev];
        });
        if (row.status === "QUEUED" || row.status === "SENDING") {
          pollStatus(id, rounds - 1);
          return;
        }
      }
      router.refresh();
    }, 2000);
  }

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen || pending) return;
    setPending(true);
    setServerError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/leads/${leadId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateName: chosen.name,
          templateLanguage: chosen.language,
          variables: values,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        message?: WhatsAppMessageDTO;
        error?: string;
        errors?: Record<string, string>;
      } | null;
      if (!res.ok || !data?.message) {
        setServerError(
          data?.error ?? (data?.errors ? Object.values(data.errors).join(" ") : "Could not queue message.")
        );
        return;
      }
      const row = data.message;
      setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [row, ...prev]));
      setValues({});
      toast({ title: "Message queued", description: "Status updates automatically.", variant: "success" });
      if (row.status === "QUEUED" || row.status === "SENDING") pollStatus(row.id);
      else router.refresh();
    } catch {
      setServerError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function onRetry(id: string) {
    setRetryingId(id);
    try {
      const res = await fetch(`/api/businesses/${businessId}/leads/${leadId}/messages/${id}`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        message?: WhatsAppMessageDTO;
        error?: string;
      } | null;
      if (!res.ok || !data?.message) {
        toast({ title: "Retry failed", description: data?.error ?? "Please try again.", variant: "error" });
        return;
      }
      const row = data.message;
      setMessages((prev) => prev.map((m) => (m.id === id ? row : m)));
      toast({ title: "Retry queued", variant: "success" });
      if (row.status === "QUEUED" || row.status === "SENDING") pollStatus(row.id);
      else router.refresh();
    } catch {
      toast({ title: "Retry failed", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>WhatsApp message</CardTitle>
        <CardDescription>
          Send an approved template to {leadPhone}. Sending queues the message — delivery is confirmed via status below.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {approved.length === 0 ? (
          <p className="text-sm text-slate-500">
            No approved templates yet. Sync templates in Settings → Integrations first.
          </p>
        ) : (
          <form onSubmit={onSend} className="flex flex-col gap-4">
            <Field label="Template">
              <Select value={templateKey} onChange={(e) => onTemplateChange(e.target.value)} aria-label="Select WhatsApp template">
                <option value="">Choose a template…</option>
                {approved.map((t) => (
                  <option key={`${t.name}\u0000${t.language}`} value={`${t.name}\u0000${t.language}`}>
                    {t.name} ({t.language})
                  </option>
                ))}
              </Select>
            </Field>
            {chosen && chosen.variables.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {chosen.variables.map((v) => (
                  <Field key={`${v.component}:${v.key}`} label={v.positional ? `Variable {{${v.key}}}` : `Variable {{${v.key}}}`}>
                    <Input
                      value={values[v.key] ?? ""}
                      onChange={(e) => setValues((prev) => ({ ...prev, [v.key]: e.target.value }))}
                      placeholder={`Value for {{${v.key}}}`}
                      autoComplete="off"
                    />
                  </Field>
                ))}
              </div>
            ) : null}
            {chosen ? (
              <div className="rounded-xl bg-emerald-50 px-4 py-3" aria-live="polite">
                <p className="text-xs font-semibold tracking-wider text-emerald-700 uppercase">Preview</p>
                {preview.length > 0 ? (
                  preview.map((line, i) => (
                    <p key={i} className="py-0.5 text-sm text-slate-800">
                      {line.text}
                    </p>
                  ))
                ) : (
                  <p className="py-0.5 text-sm text-slate-500">No text preview for this template.</p>
                )}
              </div>
            ) : null}
            {serverError ? (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                {serverError}
              </p>
            ) : null}
            <div>
              <Button type="submit" loading={pending} disabled={!chosen}>
                Send WhatsApp message
              </Button>
            </div>
          </form>
        )}

        <div className="flex flex-col gap-2 border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-900">Message history</h3>
          {messages.length === 0 ? (
            <EmptyState title="No messages yet" description="Sent templates, replies, and delivery status appear here." />
          ) : (
            <ul className="flex flex-col gap-2">
              {messages.map((m) => (
                <li
                  key={m.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {m.direction === "inbound" ? "↩ " : ""}
                      {messageLabel(m)}
                      <span className="ml-2 text-xs font-normal text-slate-400">
                        {m.direction === "inbound"
                          ? m.fromPhone ?? ""
                          : (m.templateLanguage ?? "")}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {m.direction === "inbound" ? "inbound · " : "outbound · "}
                      {m.messageId ? `wamid ${m.messageId.slice(0, 18)}… · ` : ""}
                      <time dateTime={m.createdAt}>{formatDateTime(m.createdAt)}</time>
                      {m.status === "FAILED" && m.lastError ? ` · ${m.lastError}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_VARIANT[m.status] ?? "neutral"}>{m.status}</Badge>
                    {m.status === "FAILED" && m.direction === "outbound" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={retryingId === m.id}
                        onClick={() => onRetry(m.id)}
                      >
                        {retryingId === m.id ? "Retrying…" : "Retry"}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
