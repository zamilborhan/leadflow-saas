"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { ConfirmDialog } from "@/src/components/ui/confirm-dialog";
import { Field, Input } from "@/src/components/ui/input";
import { useToast } from "@/src/components/ui/toast";
import type { WhatsAppConnectionStatus } from "@/src/lib/integrations/whatsapp/service";

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const HEALTH_VARIANT = {
  AVAILABLE: "success",
  LIMITED: "warning",
  BLOCKED: "danger",
} as const;

/**
 * WhatsApp Cloud API connection card. Renders redacted status only —
 * access tokens never reach the browser in any form. Credentials are
 * entered here, verified live against Meta on connect, then stored
 * encrypted server-side.
 */
export function WhatsAppConnectionCard({
  businessId,
  initial,
  canManage,
}: {
  businessId: string;
  initial: WhatsAppConnectionStatus;
  canManage: boolean;
}) {
  const [status, setStatus] = useState<WhatsAppConnectionStatus>(initial);
  const [wabaId, setWabaId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [healthPending, setHealthPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const router = useRouter();
  const toast = useToast();

  const errors = {
    wabaId: wabaId.trim() ? null : "WABA ID is required.",
    phoneNumberId: phoneNumberId.trim() ? null : "Phone number ID is required.",
    accessToken: accessToken.trim() ? null : "Access token is required.",
  };
  const valid = !errors.wabaId && !errors.phoneNumberId && !errors.accessToken;

  async function refresh() {
    try {
      const res = await fetch(`/api/businesses/${businessId}/whatsapp`, { cache: "no-store" });
      if (res.ok) setStatus((await res.json()) as WhatsAppConnectionStatus);
    } catch {
      // Stale card content is acceptable; the last known status stays shown.
    }
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setServerError(null);
    if (!valid) return;
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/whatsapp/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          wabaId: wabaId.trim(),
          phoneNumberId: phoneNumberId.trim(),
          accessToken: accessToken.trim(),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        connection?: WhatsAppConnectionStatus;
        error?: string;
        errors?: Record<string, string>;
      } | null;
      if (!res.ok || !data?.connection) {
        setServerError(
          data?.error ?? (data?.errors ? Object.values(data.errors).join(" ") : "Could not connect WhatsApp.")
        );
        return;
      }
      setStatus(data.connection);
      setWabaId("");
      setPhoneNumberId("");
      setAccessToken("");
      setTouched(false);
      toast({ title: "WhatsApp connected", variant: "success" });
      router.refresh();
    } catch {
      setServerError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function checkHealth() {
    setHealthPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/whatsapp/health`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        health?: { canSendMessage: string | null };
        error?: string;
      } | null;
      if (!res.ok) {
        toast({ title: "Health check failed", description: data?.error ?? "Please try again.", variant: "error" });
        return;
      }
      toast({
        title: "Health check complete",
        description: `Messaging status: ${data?.health?.canSendMessage ?? "unknown"}.`,
        variant: "info",
      });
      await refresh();
      router.refresh();
    } catch {
      toast({ title: "Health check failed", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setHealthPending(false);
    }
  }

  async function disconnect() {
    setPending(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/whatsapp`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast({ title: "Disconnect failed", description: data?.error ?? "Please try again.", variant: "error" });
        setConfirmOpen(false);
        return;
      }
      setConfirmOpen(false);
      toast({ title: "WhatsApp disconnected", variant: "success" });
      await refresh();
      router.refresh();
    } catch {
      toast({ title: "Disconnect failed", description: "Network error. Please try again.", variant: "error" });
    } finally {
      setPending(false);
    }
  }

  const healthVariant =
    status.healthStatus && status.healthStatus in HEALTH_VARIANT
      ? HEALTH_VARIANT[status.healthStatus as keyof typeof HEALTH_VARIANT]
      : "neutral";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>WhatsApp</CardTitle>
            <CardDescription>Send follow-ups from your WhatsApp business number.</CardDescription>
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
          <>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Phone number</dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">{status.displayPhoneNumber ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Verified name</dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">{status.verifiedName ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Phone number ID</dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">{status.phoneNumberId}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">WABA ID</dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">{status.wabaId}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Messaging health</dt>
                <dd className="mt-1">
                  <Badge variant={healthVariant}>{status.healthStatus ?? "Not checked"}</Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Last checked</dt>
                <dd className="mt-1 text-sm font-medium text-slate-900">{formatDateTime(status.lastCheckedAt)}</dd>
              </div>
            </dl>
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={checkHealth} loading={healthPending}>
                  Check health
                </Button>
                <Button variant="outline" onClick={() => setConfirmOpen(true)}>
                  Disconnect
                </Button>
              </div>
            ) : (
              <p className="text-sm text-slate-500">Only owners and admins can manage this connection.</p>
            )}
          </>
        ) : canManage ? (
          <form onSubmit={connect} className="flex flex-col gap-4">
            <Field label="WhatsApp Business Account ID" required error={touched ? errors.wabaId : null}>
              <Input
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="e.g. 123456789012345"
                autoComplete="off"
              />
            </Field>
            <Field label="Phone number ID" required error={touched ? errors.phoneNumberId : null}>
              <Input
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                placeholder="e.g. 987654321098765"
                autoComplete="off"
              />
            </Field>
            <Field
              label="System user access token"
              required
              hint="Created in Business Settings with whatsapp_business_messaging. Verified live, then stored encrypted."
              error={touched ? errors.accessToken : null}
            >
              <Input
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="Paste token (never shown again)"
                autoComplete="off"
              />
            </Field>
            {serverError ? (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                {serverError}
              </p>
            ) : null}
            <div>
              <Button type="submit" loading={pending}>
                Connect WhatsApp
              </Button>
            </div>
          </form>
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
        title="Disconnect WhatsApp?"
        message="Stored credentials are deleted. The Meta-side number registration is untouched."
        confirmLabel="Disconnect"
      />
    </Card>
  );
}
