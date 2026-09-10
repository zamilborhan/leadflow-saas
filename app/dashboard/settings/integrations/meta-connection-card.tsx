"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/src/components/ui/badge";
import { Button, ButtonLink } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { ConfirmDialog } from "@/src/components/ui/confirm-dialog";
import { useToast } from "@/src/components/ui/toast";
import type { MetaConnectionStatus } from "@/src/lib/integrations/meta/service";
import type { MetaSelection } from "@/src/lib/integrations/meta/pages";

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Facebook Lead Ads connection card. Renders redacted status only —
 * access tokens never reach the browser in any form.
 */
export function MetaConnectionCard({
  businessId,
  initial,
  selection,
  canManage,
}: {
  businessId: string;
  initial: MetaConnectionStatus;
  selection: MetaSelection;
  canManage: boolean;
}) {
  const [status, setStatus] = useState<MetaConnectionStatus>(initial);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useToast();

  async function refresh() {
    try {
      const res = await fetch(`/api/businesses/${businessId}/meta`, { cache: "no-store" });
      if (res.ok) setStatus((await res.json()) as MetaConnectionStatus);
    } catch {
      // Stale card content is acceptable; the last known status stays shown.
    }
  }

  function connectHref(): string {
    return `/api/businesses/${businessId}/meta/connect`;
  }

  async function disconnect() {
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/meta`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast({ title: "Disconnect failed", description: data?.error ?? "Please try again.", variant: "error" });
        setConfirmOpen(false);
        return;
      }
      setConfirmOpen(false);
      toast({ title: "Facebook disconnected", variant: "success" });
      await refresh();
      router.refresh();
    } catch {
      toast({ title: "Disconnect failed", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>Facebook Lead Ads</CardTitle>
            <CardDescription>Sync leads from Facebook lead forms into this workspace.</CardDescription>
          </div>
          {status.connected ? (
            <Badge variant="success">Connected</Badge>
          ) : (
            <Badge variant="neutral">Not connected</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status.connected ? (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Account</dt>
              <dd className="mt-1 text-sm font-medium text-slate-900">{status.metaUserName ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Meta user ID</dt>
              <dd className="mt-1 text-sm font-medium text-slate-900">{status.metaUserId}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Granted scopes</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {(status.scopes ?? []).map((s) => (
                  <Badge key={s} variant="neutral">{s}</Badge>
                ))}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Token expires</dt>
              <dd className="mt-1 text-sm font-medium text-slate-900">{formatDateTime(status.tokenExpiresAt)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Page</dt>
              <dd className="mt-1 text-sm font-medium text-slate-900">{selection.page?.name ?? "Not selected"}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Lead form</dt>
              <dd className="mt-1 text-sm font-medium text-slate-900">
                {selection.form ? `${selection.form.name} (${selection.form.status})` : "Not connected"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Connected date</dt>
              <dd className="mt-1 text-sm font-medium text-slate-900">{formatDateTime(status.connectedAt)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-slate-500">
            Connect a Facebook account with access to your Pages to enable automatic lead import.
            Webhook delivery is configured in a later step.
          </p>
        )}
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {status.connected ? (
              <>
                {/* Plain link: re-OAuth requires a full browser navigation. */}
                <ButtonLink href={connectHref()} variant="outline">Reconnect</ButtonLink>
                <Button variant="outline" onClick={() => setConfirmOpen(true)}>
                  Disconnect
                </Button>
              </>
            ) : (
              // Plain link (not router navigation): the endpoint 302s to
              // Meta's dialog, which requires a full browser navigation.
              <ButtonLink href={connectHref()}>Connect Facebook</ButtonLink>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-500">Only owners and admins can manage this connection.</p>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={disconnect}
        loading={pending}
        tone="danger"
        title="Disconnect Facebook?"
        message="Automatic lead import stops immediately and stored credentials are deleted."
        confirmLabel="Disconnect"
      />
    </Card>
  );
}
