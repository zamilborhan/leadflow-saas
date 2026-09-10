"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Select } from "@/src/components/ui/select";
import { useToast } from "@/src/components/ui/toast";
import { renderPreview } from "@/src/lib/integrations/whatsapp/template-parse";
import type { LeadTemplateSelectionDTO, TemplateDTO } from "@/src/lib/integrations/whatsapp/templates";

/**
 * Per-lead WhatsApp template picker. Lists APPROVED templates for
 * selection (plus the current selection even if since unapproved),
 * previews the chosen template with variables highlighted, and persists
 * via the lead template API. Gated by leads.update upstream.
 */
export function LeadTemplatePicker({
  businessId,
  leadId,
  templates,
  initial,
}: {
  businessId: string;
  leadId: string;
  templates: TemplateDTO[];
  initial: LeadTemplateSelectionDTO | null;
}) {
  const currentKey = initial ? `${initial.templateName}\u0000${initial.templateLanguage}` : "";
  const [selectedKey, setSelectedKey] = useState(currentKey);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useToast();

  const options = useMemo(() => {
    const seen = new Map<string, TemplateDTO>();
    for (const t of templates) {
      if (t.status !== "APPROVED") continue;
      seen.set(`${t.name}\u0000${t.language}`, t);
    }
    if (initial && !seen.has(currentKey)) {
      seen.set(currentKey, {
        name: initial.templateName,
        language: initial.templateLanguage,
        category: null,
        status: initial.status,
        sendable: false,
        variables: initial.variables,
        components: [],
        updatedAt: initial.updatedAt,
      });
    }
    return [...seen.entries()];
  }, [templates, initial, currentKey]);

  const chosen = options.find(([key]) => key === selectedKey)?.[1] ?? null;
  const preview = useMemo(
    () =>
      renderPreview(
        (chosen?.components ?? []).map((c) => ({ type: c.type, text: c.text })),
        {}
      ),
    [chosen]
  );
  const dirty = selectedKey !== currentKey;

  async function onSelect() {
    if (!chosen || !dirty || pending) return;
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/leads/${leadId}/template`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: chosen.name, language: chosen.language }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast({ title: "Could not select template", description: data?.error ?? "Please try again.", variant: "error" });
        return;
      }
      toast({ title: "Template selected", description: `${chosen.name} (${chosen.language}).`, variant: "success" });
      router.refresh();
    } catch {
      toast({ title: "Could not select template", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setPending(false);
    }
  }

  async function onClear() {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/leads/${leadId}/template`, { method: "DELETE" });
      if (!res.ok) {
        toast({ title: "Could not clear template", description: "Please try again.", variant: "error" });
        return;
      }
      setSelectedKey("");
      toast({ title: "Template cleared", variant: "success" });
      router.refresh();
    } catch {
      toast({ title: "Could not clear template", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>WhatsApp template</CardTitle>
        <CardDescription>Approved template pre-selected for follow-up messages.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {options.length === 0 ? (
          <p className="text-sm text-slate-500">
            No approved templates yet. Sync templates in Settings → Integrations first.
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-slate-700">Template</span>
              <Select value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)} aria-label="Select WhatsApp template">
                <option value="">No template</option>
                {options.map(([key, t]) => (
                  <option key={key} value={key} disabled={!t.sendable && key !== currentKey}>
                    {t.name} ({t.language}){t.sendable ? "" : " — not sendable"}
                  </option>
                ))}
              </Select>
            </label>
            {chosen ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{chosen.name}</span>
                  <Badge variant="neutral">{chosen.language}</Badge>
                  <Badge variant={chosen.sendable ? "success" : "warning"}>
                    {chosen.sendable ? "Sendable" : chosen.status}
                  </Badge>
                </div>
                {preview.length > 0 ? (
                  <div className="mt-2 flex flex-col gap-1">
                    {preview.map((line, i) => (
                      <p key={i} className="text-sm text-slate-600">
                        <span className="mr-2 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">
                          {line.component}
                        </span>
                        {line.text}
                      </p>
                    ))}
                  </div>
                ) : null}
                {chosen.variables.length > 0 ? (
                  <p className="mt-2 text-xs text-slate-500">
                    Variables: {chosen.variables.map((v) => `{{${v.key}}}`).join(", ")}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button onClick={onSelect} disabled={!dirty || !chosen?.sendable} loading={pending}>
                Select template
              </Button>
              {initial ? (
                <Button variant="outline" onClick={onClear} disabled={pending}>
                  Clear
                </Button>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
