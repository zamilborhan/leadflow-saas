"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { ConfirmDialog } from "@/src/components/ui/confirm-dialog";
import { EmptyState } from "@/src/components/ui/states";
import { useToast } from "@/src/components/ui/toast";
import type { MetaSelection } from "@/src/lib/integrations/meta/pages";

interface PageRow {
  metaPageId: string;
  name: string;
  tasks: string[];
  selectable: boolean;
  selected: boolean;
}

interface FormRow {
  metaFormId: string;
  name: string;
  status: string;
  connected: boolean;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface LoadedSelection {
  selection: MetaSelection;
  pages: PageRow[];
  forms: FormRow[];
}

/** Fetch selection + pages (+ forms when a page is selected). Throws on failure. */
async function fetchAll(businessId: string): Promise<LoadedSelection> {
  const [selRes, pagesRes] = await Promise.all([
    fetch(`/api/businesses/${businessId}/meta/selection`, { cache: "no-store" }),
    fetch(`/api/businesses/${businessId}/meta/pages`, { cache: "no-store" }),
  ]);
  if (!selRes.ok || !pagesRes.ok) {
    const failed = !selRes.ok ? await selRes.json().catch(() => null) : await pagesRes.json().catch(() => null);
    throw new Error((failed as { error?: string } | null)?.error ?? "Could not load Facebook data.");
  }
  const selection = (await selRes.json()) as MetaSelection;
  const listed = (await pagesRes.json()) as { pages: PageRow[] };
  let forms: FormRow[] = [];
  if (selection.page) {
    const formsRes = await fetch(`/api/businesses/${businessId}/meta/forms`, { cache: "no-store" });
    if (formsRes.ok) {
      forms = ((await formsRes.json()) as { forms: FormRow[] }).forms;
    }
  }
  return { selection, pages: listed.pages, forms };
}

/**
 * Page + lead form selection. Live Meta data loads on demand (never
 * server-rendered, so a Meta outage can't break settings); persisted
 * selection arrives via `initial` for instant paint. Tokens never reach
 * the browser — rows carry metadata only.
 */
export function MetaPagesFormsCard({
  businessId,
  canManage,
  initial,
}: {
  businessId: string;
  canManage: boolean;
  initial: MetaSelection;
}) {
  const [selection, setSelection] = useState<MetaSelection>(initial);
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [forms, setForms] = useState<FormRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmDisconnectForm, setConfirmDisconnectForm] = useState(false);
  const router = useRouter();
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await fetchAll(businessId);
      setSelection(loaded.selection);
      setPages(loaded.pages);
      setForms(loaded.forms);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load Facebook data.");
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  // Initial load only: all state updates happen in async continuations
  // (never synchronously in the effect body) with a cancellation guard.
  useEffect(() => {
    let cancelled = false;
    fetchAll(businessId).then(
      (loaded) => {
        if (cancelled) return;
        setSelection(loaded.selection);
        setPages(loaded.pages);
        setForms(loaded.forms);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load Facebook data.");
        setLoading(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  async function act(key: string, fn: () => Promise<Response>, okTitle: string) {
    setPendingAction(key);
    try {
      const res = await fn();
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string; errors?: Record<string, string> } | null;
        const message =
          data?.error ?? (data?.errors ? Object.values(data.errors).join(" ") : "Please try again.");
        toast({ title: "Action failed", description: message, variant: "error" });
        return;
      }
      toast({ title: okTitle, variant: "success" });
      await load();
      router.refresh();
    } catch {
      toast({ title: "Action failed", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setPendingAction(null);
    }
  }

  const selectPage = (metaPageId: string) =>
    act(`select-${metaPageId}`, () =>
      fetch(`/api/businesses/${businessId}/meta/pages/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metaPageId }),
      }), "Page selected");

  const connectForm = (metaFormId: string) =>
    act(`connect-${metaFormId}`, () =>
      fetch(`/api/businesses/${businessId}/meta/forms/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metaFormId }),
      }), "Lead form connected");

  const disconnectForm = () =>
    act("disconnect-form", () => fetch(`/api/businesses/${businessId}/meta/forms`, { method: "DELETE" }), "Lead form disconnected");

  const busy = (key: string) => pendingAction === key;

  if (!canManage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Page &amp; lead form</CardTitle>
          <CardDescription>Which Page and form feed this workspace.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm text-slate-700">
            Page: <span className="font-medium">{selection.page?.name ?? "Not selected"}</span>
          </p>
          <p className="text-sm text-slate-700">
            Lead form: <span className="font-medium">{selection.form?.name ?? "Not connected"}</span>
          </p>
          <p className="text-sm text-slate-500">Only owners and admins can change the Page and form.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>Page &amp; lead form</CardTitle>
            <CardDescription>Choose which Page and form feed this workspace.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
            {error} <Button variant="ghost" size="sm" onClick={() => void load()}>Retry</Button>
          </p>
        ) : null}

        <section aria-labelledby="meta-pages-heading">
          <h3 id="meta-pages-heading" className="text-sm font-semibold text-slate-900">Facebook Pages</h3>
          {pages === null ? (
            <p className="mt-2 text-sm text-slate-500" role="status">Loading pages…</p>
          ) : pages.length === 0 ? (
            <EmptyState
              title="No Pages found"
              description="The connected account has no Pages available to this app."
            />
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {pages.map((p) => (
                <li
                  key={p.metaPageId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {p.name}
                      {p.selected ? (
                        <Badge variant="success" className="ml-2">Selected</Badge>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      ID {p.metaPageId} · {p.tasks.length > 0 ? p.tasks.join(", ") : "no tasks listed"}
                    </p>
                  </div>
                  {canManage && !p.selected ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!p.selectable || busy(`select-${p.metaPageId}`)}
                      title={p.selectable ? undefined : "Page does not grant advertising access"}
                      onClick={() => void selectPage(p.metaPageId)}
                    >
                      {busy(`select-${p.metaPageId}`) ? "Selecting…" : "Select"}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="meta-forms-heading">
          <h3 id="meta-forms-heading" className="text-sm font-semibold text-slate-900">Lead forms</h3>
          {!selection.page ? (
            <p className="mt-2 text-sm text-slate-500">Select a Page above to list its lead forms.</p>
          ) : forms === null ? (
            <p className="mt-2 text-sm text-slate-500" role="status">Loading forms…</p>
          ) : forms.length === 0 ? (
            <EmptyState
              title="No lead forms"
              description={`"${selection.page.name}" has no lead forms yet. Create one in Ads Manager, then refresh.`}
            />
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {forms.map((f) => (
                <li
                  key={f.metaFormId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {f.name}
                      {f.connected ? (
                        <Badge variant="success" className="ml-2">Connected</Badge>
                      ) : (
                        <Badge variant="neutral" className="ml-2">{f.status}</Badge>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">ID {f.metaFormId}</p>
                  </div>
                  {canManage && !f.connected ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy(`connect-${f.metaFormId}`)}
                      onClick={() => void connectForm(f.metaFormId)}
                    >
                      {busy(`connect-${f.metaFormId}`) ? "Connecting…" : "Connect"}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canManage && selection.form ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <p className="text-xs text-slate-500">
                Connected {formatDateTime(selection.form.connectedAt)} — webhooks will route here.
              </p>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnectForm(true)}>
                Disconnect form
              </Button>
            </div>
          ) : null}
        </section>
      </CardContent>
      <ConfirmDialog
        open={confirmDisconnectForm}
        onClose={() => setConfirmDisconnectForm(false)}
        onConfirm={() => {
          setConfirmDisconnectForm(false);
          void disconnectForm();
        }}
        loading={pendingAction === "disconnect-form"}
        tone="danger"
        title="Disconnect lead form?"
        message="New leads will no longer be routed to this workspace from the form."
        confirmLabel="Disconnect"
      />
    </Card>
  );
}
