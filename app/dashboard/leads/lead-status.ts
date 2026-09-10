/** Shared lead-status presentation (server + client safe). */
export const LEAD_STATUSES = ["NEW", "CONTACTED", "INTERESTED", "FOLLOW_UP", "CONVERTED", "LOST"] as const;

export const LEAD_STATUS_LABEL: Record<string, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  INTERESTED: "Interested",
  FOLLOW_UP: "Follow-up",
  CONVERTED: "Converted",
  LOST: "Lost",
};

export const LEAD_STATUS_BADGE: Record<string, "brand" | "info" | "warning" | "success" | "neutral"> = {
  NEW: "brand",
  CONTACTED: "info",
  INTERESTED: "warning",
  FOLLOW_UP: "warning",
  CONVERTED: "success",
  LOST: "neutral",
};

export interface AgentOption {
  userId: string;
  email: string;
  name: string | null;
  role: string;
}

export function agentLabel(a: AgentOption): string {
  return a.name ? `${a.name} (${a.email})` : a.email;
}

/** Timeline event presentation (server + client safe). */
export const ACTIVITY_LABEL: Record<string, string> = {
  CREATED: "Lead created",
  ASSIGNED: "Lead assigned",
  STATUS_CHANGED: "Status changed",
  NOTE_ADDED: "Note added",
  FOLLOW_UP_CREATED: "Follow-up created",
  FOLLOW_UP_COMPLETED: "Follow-up completed",
  WHATSAPP_SENT: "WhatsApp sent",
  WHATSAPP_RECEIVED: "WhatsApp received",
};

export const ACTIVITY_BADGE: Record<string, "brand" | "info" | "warning" | "success" | "neutral"> = {
  CREATED: "brand",
  ASSIGNED: "info",
  STATUS_CHANGED: "warning",
  NOTE_ADDED: "neutral",
  FOLLOW_UP_CREATED: "info",
  FOLLOW_UP_COMPLETED: "success",
  WHATSAPP_SENT: "success",
  WHATSAPP_RECEIVED: "neutral",
};

/** Events agents may log manually; system types are auto-emitted by lead flows. */
export const MANUAL_ACTIVITY_TYPES = [
  "FOLLOW_UP_CREATED",
  "FOLLOW_UP_COMPLETED",
  "WHATSAPP_SENT",
  "WHATSAPP_RECEIVED",
] as const;

/** Follow-up display statuses (OVERDUE is derived, never stored). */
export const FOLLOW_UP_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  OVERDUE: "Overdue",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const FOLLOW_UP_STATUS_BADGE: Record<string, "info" | "danger" | "success" | "neutral"> = {
  PENDING: "info",
  OVERDUE: "danger",
  COMPLETED: "success",
  CANCELLED: "neutral",
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
