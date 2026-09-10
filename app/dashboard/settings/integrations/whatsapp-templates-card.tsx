"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { EmptyState } from "@/src/components/ui/states";
import { Modal } from "@/src/components/ui/modal";
import { useToast } from "@/src/components/ui/toast";
import { renderPreview } from "@/src/lib/integrations/whatsapp/template-parse";
import type { TemplateDTO } from "@/src/lib/integrations/whatsapp/templates";

const STATUS_VARIANT: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  APPROVED: "success",
  PENDING: "warning",
  IN_APPEAL: "warning",
  REJECTED: "danger",
  PAUSED: "warning",
  DISABLED: "danger",
};

/**
 * Workspace template catalog: cached list with status badges and preview,
 * plus manual sync from Meta. Management (sync) requires businesses.update;
 * listing is membership-gated upstream. No tokens involved — metadata only.
 */
export function WhatsAppTemplatesCard({
  businessId,
  canManage,
  initial,
}: {
  businessId: string;
  canManage: boolean;
  initial: TemplateDTO[];
}) {
  const [templates, setTemplates] = useState<TemplateDTO[]>(initial);
  const [syncing, setSyncing] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const router = useRouter();
  const toast = useToast();

  async function refresh() {
    try {
      const res = await fetch(`/api/businesses/${businessId}/whatsapp/templates`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { templates: TemplateDTO[] };
        setTemplates(data.templates);
      }
    } catch {
      // Stale list is acceptable; the last known catalog stays shown.
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/whatsapp/templates/sync`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        synced?: number;
        pruned?: number;
        error?: string;
      } | null;
      if (!res.ok) {
        toast({ title: "Sync failed", description: data?.error ?? "Please try again.", variant: "error" });
        return;
      }
      toast({
        title: "Templates synced",
        description: `${data?.synced ?? 0} cached${data?.pruned ? `, ${data.pruned} removed` : ""}.`,
        variant: "success",
      });
      await refresh();
      router.refresh();
    } catch {
      toast({ title: "Sync failed", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setSyncing(false);
    }
  }

  const preview = previewKey ? templates.find((t) => `${t.name}\u0000${t.language}` === previewKey) ?? null : null;
  const previewLines = preview
    ? renderPreview(preview.components.map((c) => ({ type: c.type, text: c.text })), {})
    : [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>Message templates</CardTitle>
            <CardDescription>Approved templates agents can select for follow-ups.</CardDescription>
          </div>
          {canManage ? (
            <Button variant="outline" size="sm" onClick={sync} loading={syncing}>
              Sync from Meta
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {templates.length === 0 ? (
          <EmptyState
            title="No templates yet"
            description="Sync templates from your WhatsApp Business Account to review and preview them here."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {templates.map((t) => {
              const key = `${t.name}\u0000${t.language}`;
              return (
                <li
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {t.name}
                      <span className="ml-2 text-xs font-normal text-slate-400">{t.language}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {[t.category, t.variables.length > 0 ? `${t.variables.length} variable${t.variables.length === 1 ? "" : "s"}` : "no variables"]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_VARIANT[t.status] ?? "neutral"}>{t.status}</Badge>
                    <Button variant="ghost" size="sm" onClick={() => setPreviewKey(key)}>
                      Preview
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!canManage ? (
          <p className="mt-3 text-sm text-slate-500">Only owners and admins can sync templates.</p>
        ) : null}
      </CardContent>
      <Modal open={preview !== null} onClose={() => setPreviewKey(null)} title={preview?.name ?? "Preview"} size="sm">
        {preview ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Badge variant="neutral">{preview.language}</Badge>
              <Badge variant={preview.sendable ? "success" : "warning"}>
                {preview.sendable ? "Sendable" : preview.status}
              </Badge>
            </div>
            {previewLines.length > 0 ? (
              <div className="rounded-xl bg-emerald-50 px-4 py-3">
                {previewLines.map((line, i) => (
                  <p key={i} className="py-0.5 text-sm text-slate-800">
                    {line.text}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500">This template has no text preview.</p>
            )}
            {preview.variables.length > 0 ? (
              <p className="text-xs text-slate-500">
                Variables: {preview.variables.map((v) => `{{${v.key}}}`).join(", ")}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}
