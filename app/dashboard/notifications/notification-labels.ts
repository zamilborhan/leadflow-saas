/** Shared notification type presentation (server + client safe). */
export const NOTIFICATION_TYPE_LABEL: Record<string, string> = {
  LEAD_ASSIGNED: "Lead assigned",
  FOLLOWUP_DUE: "Follow-up due",
  FOLLOWUP_OVERDUE: "Follow-up overdue",
  WHATSAPP_FAILED: "WhatsApp failed",
  FACEBOOK_EXPIRED: "Facebook expired",
  PAYMENT_FAILED: "Payment failed",
};

export const NOTIFICATION_TYPE_BADGE: Record<string, "brand" | "info" | "warning" | "danger" | "neutral"> = {
  LEAD_ASSIGNED: "info",
  FOLLOWUP_DUE: "warning",
  FOLLOWUP_OVERDUE: "danger",
  WHATSAPP_FAILED: "danger",
  FACEBOOK_EXPIRED: "warning",
  PAYMENT_FAILED: "danger",
};

export function formatDateTime(iso: string | null): string {
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
