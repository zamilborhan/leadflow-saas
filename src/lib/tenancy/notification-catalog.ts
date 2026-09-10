/**
 * In-app notification type catalog + list-query validation.
 * Framework-free and dependency-free: safe to import from unit tests via
 * Node type-stripping (no project-local imports).
 */

export const NOTIFICATION_TYPES = [
  "LEAD_ASSIGNED",
  "FOLLOWUP_DUE",
  "FOLLOWUP_OVERDUE",
  "WHATSAPP_FAILED",
  "FACEBOOK_EXPIRED",
  "PAYMENT_FAILED",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isValidNotificationType(type: unknown): type is NotificationType {
  return typeof type === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(type);
}

/**
 * Role-aware delivery: who may receive each notification type.
 * - "assignee": only the directly assigned user (lead/follow-up assignee).
 * - "assignee-or-managers": the assignee when set, else OWNER/ADMIN members.
 * - "managers": OWNER/ADMIN members only (connection, billing, failures).
 */
export const NOTIFICATION_AUDIENCE: Record<NotificationType, "assignee" | "assignee-or-managers" | "managers"> = {
  LEAD_ASSIGNED: "assignee",
  FOLLOWUP_DUE: "assignee-or-managers",
  FOLLOWUP_OVERDUE: "assignee-or-managers",
  WHATSAPP_FAILED: "assignee-or-managers",
  FACEBOOK_EXPIRED: "managers",
  PAYMENT_FAILED: "managers",
};

export interface NotificationListQuery {
  unreadOnly: boolean;
  limit: number;
}

/** Validate notification list query params. All optional. */
export function validateNotificationQuery(
  input: Record<string, string | string[] | undefined>
): NotificationListQuery {
  const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
  const unreadOnly = ["1", "true", "yes"].includes(first(input["unreadOnly"]).toLowerCase());
  const limitNum = Number.parseInt(first(input["limit"]), 10);
  const limit = Number.isFinite(limitNum) && limitNum >= 1 ? Math.min(limitNum, 100) : 50;
  return { unreadOnly, limit };
}
