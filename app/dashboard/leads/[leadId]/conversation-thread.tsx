import { Badge } from "@/src/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { EmptyState } from "@/src/components/ui/states";
import type { WhatsAppMessageDTO } from "@/src/lib/integrations/whatsapp/messages";

const STATUS_VARIANT = {
  QUEUED: "neutral",
  SENDING: "info",
  SENT: "success",
  DELIVERED: "success",
  READ: "success",
  RECEIVED: "neutral",
  FAILED: "danger",
} as const;

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function messageText(m: WhatsAppMessageDTO): string {
  if (m.body) return m.body;
  if (m.direction === "outbound" && m.templateName) {
    const vars = Object.entries(m.variables ?? {});
    const suffix = vars.length > 0 ? ` — ${vars.map(([, v]) => v).join(", ")}` : "";
    return `Template "${m.templateName}"${suffix}`;
  }
  return m.type === "template" ? "Template message" : `[${m.type} message]`;
}

/**
 * Unified WhatsApp conversation for a lead: inbound replies (left) and
 * outbound templates (right), oldest first, with delivery/read status.
 * Inbound-only rows (RECEIVED) and outbound receipts (SENT → DELIVERED →
 * READ) all render here — this is the conversation history.
 */
export function ConversationThread({ messages }: { messages: WhatsAppMessageDTO[] }) {
  const ordered = [...messages].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>WhatsApp conversation</CardTitle>
        <CardDescription>
          Replies and sent templates in one thread, oldest first. Delivery and read receipts update in place.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {ordered.length === 0 ? (
          <EmptyState
            title="No conversation yet"
            description="Sent templates and customer replies will appear here as one thread."
          />
        ) : (
          <ol className="flex flex-col gap-3" aria-live="polite">
            {ordered.map((m) => {
              const inbound = m.direction === "inbound";
              return (
                <li
                  key={m.id}
                  className={`flex ${inbound ? "justify-start" : "justify-end"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                      inbound
                        ? "rounded-bl-md border border-slate-200 bg-slate-50"
                        : "rounded-br-md bg-emerald-600 text-white"
                    }`}
                  >
                    <p className={`text-xs font-semibold tracking-wider uppercase ${inbound ? "text-slate-400" : "text-emerald-100"}`}>
                      {inbound ? `Inbound${m.fromPhone ? ` · ${m.fromPhone}` : ""}` : "Outbound"}
                    </p>
                    <p className={`mt-1 text-sm whitespace-pre-wrap ${inbound ? "text-slate-800" : "text-white"}`}>
                      {messageText(m)}
                    </p>
                    <div className={`mt-2 flex flex-wrap items-center gap-2 ${inbound ? "" : "justify-end"}`}>
                      <span className={`text-[11px] ${inbound ? "text-slate-400" : "text-emerald-100"}`}>
                        <time dateTime={m.createdAt}>{formatDateTime(m.createdAt)}</time>
                      </span>
                      <Badge variant={STATUS_VARIANT[m.status] ?? "neutral"}>{m.status}</Badge>
                    </div>
                    {m.status === "FAILED" && m.lastError ? (
                      <p className={`mt-1 text-xs ${inbound ? "text-red-600" : "text-red-100"}`}>{m.lastError}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
