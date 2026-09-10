/**
 * Tenant-scoped in-app notifications.
 *
 * HARD RULE (same as leads.ts): every query filters by `businessId` from the
 * verified `BusinessContext`, and reads additionally filter by the caller's
 * `userId` — a member only ever sees their own rows. Cross-tenant or
 * cross-user ids resolve to null (→ 404) and are indistinguishable from
 * non-existent ids.
 *
 * Delivery model: one row per recipient. Role-awareness is a fan-out
 * decision at emit time (see NOTIFICATION_AUDIENCE in validation.ts):
 * assignments go to the assignee, connection/billing failures go to
 * OWNER + ADMIN managers, follow-up and WhatsApp alerts go to the
 * assignee (falling back to managers when unassigned).
 *
 * Recurring syncs (follow-up due/overdue, connection expiry) are
 * idempotent via `dedupeKey`: the (businessId, userId, dedupeKey) unique
 * constraint collapses re-emits, and emission is best-effort — a
 * notification failure must never break the primary flow that triggered
 * it, so emitters swallow errors after logging.
 */
import {
  FollowUpTable,
  LeadTable,
  MetaConnectionTable,
  NotificationTable,
} from "../../prisma/tables";
import { toUserId } from "../auth/users";
import { listMembers, toBusinessId, toDbId } from "./businesses";
import type { BusinessContext } from "./context";
import { assertSameBusiness, requirePermission, TenantNotFound } from "./policies";
import {
  NOTIFICATION_AUDIENCE,
  isValidNotificationType,
  type NotificationListQuery,
  type NotificationType,
} from "./notification-catalog";

export { NOTIFICATION_AUDIENCE };
export type { NotificationType };

export interface NotificationDTO {
  id: string;
  businessId: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  leadId: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const NOTIFICATION_FIELDS = [
  "id",
  "businessId",
  "userId",
  "type",
  "title",
  "body",
  "leadId",
  "dedupeKey",
  "readAt",
  "createdAt",
  "updatedAt",
] as const;

type NotificationRow = {
  id: string;
  businessId: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  leadId: string | null;
  dedupeKey: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toDTO(row: NotificationRow): NotificationDTO {
  return {
    id: row.id,
    businessId: row.businessId,
    userId: row.userId,
    type: row.type,
    title: row.title,
    body: row.body,
    leadId: row.leadId,
    readAt: row.readAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface EmitNotificationInput {
  type: NotificationType;
  title: string;
  body?: string;
  leadId?: string;
  /** Idempotency key; re-emits with the same key are skipped per recipient. */
  dedupeKey?: string;
  /** Recipient user ids (must be members; verified by callers via fan-out). */
  userIds: string[];
}

/**
 * Emit one notification row per recipient. Unknown types and empty titles
 * throw; duplicate (businessId, userId, dedupeKey) re-emits are skipped
 * silently (race-proof via the unique backstop). System path — callers
 * authorize at their own layer.
 */
export async function emitNotification(
  businessId: string,
  input: EmitNotificationInput
): Promise<NotificationDTO[]> {
  if (!isValidNotificationType(input.type)) {
    throw new Error(`Invalid notification type: ${String(input.type)}`);
  }
  const title = input.title.trim();
  if (title.length === 0 || title.length > 200) {
    throw new Error("Notification title is required (≤200 chars).");
  }
  const body = input.body?.trim() ? input.body.trim().slice(0, 2000) : undefined;
  const bid = toBusinessId(businessId);
  const recipients = [...new Set(input.userIds)];
  const created: NotificationDTO[] = [];
  for (const userId of recipients) {
    let uid;
    try {
      uid = toUserId(userId);
    } catch {
      continue;
    }
    if (input.dedupeKey) {
      let existing: { id: string } | null = null;
      try {
        const rows = await NotificationTable.where((n) => n.businessId.eq(bid))
          .select("id", "userId", "dedupeKey")
          .all();
        existing = rows.find((r) => r.userId === uid && r.dedupeKey === input.dedupeKey) ?? null;
      } catch {
        existing = null;
      }
      if (existing) continue;
    }
    try {
      const row = await NotificationTable.select(...NOTIFICATION_FIELDS).create({
        businessId: bid,
        userId: uid,
        type: input.type,
        title,
        ...(body !== undefined ? { body } : {}),
        ...(input.leadId !== undefined ? { leadId: toDbId(input.leadId) } : {}),
        ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
      });
      if (row.businessId !== businessId) throw new TenantNotFound();
      created.push(toDTO(row));
    } catch (err) {
      if (err instanceof TenantNotFound) throw err;
      // Concurrent emit won the unique race — the winner's row stands.
      continue;
    }
  }
  return created;
}

/** User ids of OWNER + ADMIN members (manager-only audiences). */
export async function managerUserIds(businessId: string): Promise<string[]> {
  const members = await listMembers(businessId).catch(() => []);
  return members.filter((m) => m.role === "OWNER" || m.role === "ADMIN").map((m) => m.userId);
}

/** Emit to all managers; resolves to [] (no-op) when nobody qualifies. */
export async function notifyManagers(
  businessId: string,
  input: Omit<EmitNotificationInput, "userIds">
): Promise<NotificationDTO[]> {
  const userIds = await managerUserIds(businessId);
  if (userIds.length === 0) return [];
  return emitNotification(businessId, { ...input, userIds });
}

/**
 * Resolve recipients for a type given an optional assignee, per
 * NOTIFICATION_AUDIENCE. Managers-only types ignore the assignee.
 */
export async function resolveRecipients(
  businessId: string,
  type: NotificationType,
  assigneeId: string | null
): Promise<string[]> {
  const audience = NOTIFICATION_AUDIENCE[type];
  if (audience === "managers") return managerUserIds(businessId);
  if (assigneeId) return [assigneeId];
  if (audience === "assignee-or-managers") return managerUserIds(businessId);
  return [];
}

async function scopedMine(context: BusinessContext): Promise<NotificationRow[]> {
  const businessId = toBusinessId(context.business.id);
  const uid = toUserId(context.membership.userId);
  const rows = await NotificationTable.where((n) => n.businessId.eq(businessId))
    .select(...NOTIFICATION_FIELDS)
    .all();
  return rows.filter((r) => r.userId === uid);
}

/**
 * My notifications in this workspace, newest first. Requires
 * `notifications.read` (all roles hold it — delivery was already narrowed
 * at emit time).
 */
export async function listNotifications(
  context: BusinessContext,
  query: NotificationListQuery
): Promise<NotificationDTO[]> {
  requirePermission(context, "notifications.read");
  const mine = await scopedMine(context);
  const filtered = query.unreadOnly ? mine.filter((r) => !r.readAt) : mine;
  return filtered
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, query.limit)
    .map(toDTO);
}

/** Unread badge count for the header bell. */
export async function unreadNotificationCount(context: BusinessContext): Promise<number> {
  requirePermission(context, "notifications.read");
  const mine = await scopedMine(context);
  return mine.filter((r) => !r.readAt).length;
}

/**
 * Mark one notification as read. Returns null for missing ids AND for
 * rows owned by another user/business (no existence oracle).
 */
export async function markNotificationAsRead(
  context: BusinessContext,
  notificationId: string
): Promise<NotificationDTO | null> {
  requirePermission(context, "notifications.read");
  const mine = await scopedMine(context);
  const row = mine.find((r) => r.id === notificationId) ?? null;
  if (!row) return null;
  assertSameBusiness(context, row.businessId);
  if (row.readAt) return toDTO(row);
  const now = new Date().toISOString();
  await NotificationTable.where({ id: toDbId(row.id) }).update({ readAt: now } as never);
  return toDTO({ ...row, readAt: now });
}

/** Mark all my unread notifications as read. Returns the count marked. */
export async function markAllNotificationsAsRead(context: BusinessContext): Promise<number> {
  requirePermission(context, "notifications.read");
  const mine = await scopedMine(context);
  const unread = mine.filter((r) => !r.readAt);
  const now = new Date().toISOString();
  for (const row of unread) {
    assertSameBusiness(context, row.businessId);
    await NotificationTable.where({ id: toDbId(row.id) }).update({ readAt: now } as never);
  }
  return unread.length;
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Generate FOLLOWUP_DUE (scheduled within the next 24h) and
 * FOLLOWUP_OVERDUE (past due) notifications. Idempotent per follow-up
 * (overdue) and per follow-up-day (due). Skips follow-ups on archived
 * leads. Runs on notification list/sync — no cron required.
 */
export async function syncFollowUpNotifications(
  businessId: string,
  nowMs = Date.now()
): Promise<{ created: number; skipped: number }> {
  const result = { created: 0, skipped: 0 };
  const bid = toBusinessId(businessId);
  const [followUps, leads] = await Promise.all([
    FollowUpTable.where((f) => f.businessId.eq(bid))
      .select("id", "leadId", "assignedTo", "scheduledAt", "status")
      .all(),
    LeadTable.where((l) => l.businessId.eq(bid)).select("id", "name", "assignedTo", "archivedAt").all(),
  ]);
  const leadById = new Map(leads.map((l) => [l.id as string, l]));
  const day = utcDay(nowMs);
  for (const fu of followUps) {
    if (fu.status !== "PENDING") continue;
    const lead = leadById.get(fu.leadId);
    if (!lead || lead.archivedAt) continue;
    const scheduled = new Date(fu.scheduledAt).getTime();
    if (!Number.isFinite(scheduled)) continue;
    const overdue = scheduled < nowMs;
    const dueSoon = !overdue && scheduled - nowMs <= 24 * 60 * 60 * 1000;
    if (!overdue && !dueSoon) continue;
    const type: NotificationType = overdue ? "FOLLOWUP_OVERDUE" : "FOLLOWUP_DUE";
    const when = new Date(fu.scheduledAt).toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
    const recipients = await resolveRecipients(
      businessId,
      type,
      (fu.assignedTo as string | null) ?? (lead.assignedTo as string | null) ?? null
    );
    if (recipients.length === 0) {
      result.skipped += 1;
      continue;
    }
    const made = await emitNotification(businessId, {
      type,
      title: overdue
        ? `Overdue follow-up: ${lead.name as string}`
        : `Follow-up due: ${lead.name as string}`,
      body: overdue
        ? `A follow-up for ${lead.name as string} was due ${when}.`
        : `A follow-up for ${lead.name as string} is scheduled ${when}.`,
      leadId: fu.leadId,
      dedupeKey: overdue ? `fu-overdue:${fu.id}` : `fu-due:${fu.id}:${day}`,
      userIds: recipients,
    }).catch(() => [] as NotificationDTO[]);
    result.created += made.length;
  }
  return result;
}

/**
 * Generate FACEBOOK_EXPIRED notifications when the Meta connection is
 * missing, non-ACTIVE, or past its token expiry. Idempotent per
 * business-day. Managers only.
 */
export async function syncConnectionNotifications(
  businessId: string,
  nowMs = Date.now()
): Promise<{ created: number; skipped: number }> {
  const result = { created: 0, skipped: 0 };
  const bid = toBusinessId(businessId);
  let rows: Array<{ status: string; tokenExpiresAt: string | null }> = [];
  try {
    rows = await MetaConnectionTable.where((m) => m.businessId.eq(bid))
      .select("status", "tokenExpiresAt")
      .all();
  } catch {
    return result;
  }
  if (rows.length === 0) return result;
  const expired = rows.some((r) => {
    if (r.status !== "ACTIVE") return true;
    if (!r.tokenExpiresAt) return false;
    const t = new Date(r.tokenExpiresAt).getTime();
    return Number.isFinite(t) && t <= nowMs;
  });
  if (!expired) return result;
  const made = await notifyManagers(businessId, {
    type: "FACEBOOK_EXPIRED",
    title: "Facebook connection expired",
    body: "The Facebook Lead Ads connection needs reconnecting in Settings → Integrations.",
    dedupeKey: `fb-exp:${businessId}:${utcDay(nowMs)}`,
  }).catch(() => [] as NotificationDTO[]);
  result.created += made.length;
  return result;
}

export interface PaymentFailureInput {
  reference: string;
  amount?: string;
  detail?: string;
}

/**
 * Raise a PAYMENT_FAILED notification (billing-webhook entrypoint; no
 * billing module exists yet, so this is the integration seam). Managers
 * only, idempotent per payment reference.
 */
export async function emitPaymentFailed(
  businessId: string,
  input: PaymentFailureInput
): Promise<NotificationDTO[]> {
  const reference = input.reference.trim();
  if (!reference || reference.length > 120) {
    throw new Error("Payment reference is required (≤120 chars).");
  }
  const parts = [`Payment failed (ref ${reference}).`];
  if (input.amount?.trim()) parts.push(`Amount: ${input.amount.trim().slice(0, 40)}.`);
  if (input.detail?.trim()) parts.push(input.detail.trim().slice(0, 500));
  return notifyManagers(businessId, {
    type: "PAYMENT_FAILED",
    title: "Payment failed",
    body: parts.join(" "),
    dedupeKey: `pay-fail:${reference}`,
  });
}

export interface WhatsAppFailureInput {
  leadId: string | null;
  messageId: string;
  reason: string;
}

/**
 * Raise a WHATSAPP_FAILED notification for a terminally failed outbound
 * message. Recipients: the lead assignee when set, else managers.
 * Idempotent per message row. Best-effort — never throws.
 */
export async function notifyWhatsAppFailed(
  businessId: string,
  input: WhatsAppFailureInput
): Promise<void> {
  try {
    let leadName = "a lead";
    let assignee: string | null = null;
    if (input.leadId) {
      try {
        const bid = toBusinessId(businessId);
        const lead =
          await LeadTable.where((l) => l.businessId.eq(bid))
            .select("id", "name", "assignedTo")
            .all()
            .then((rows) => rows.find((r) => r.id === input.leadId) ?? null);
        if (lead) {
          leadName = lead.name as string;
          assignee = (lead.assignedTo as string | null) ?? null;
        }
      } catch {
        // Lead lookup is cosmetic — fall back to managers below.
      }
    }
    const recipients = await resolveRecipients(businessId, "WHATSAPP_FAILED", assignee);
    if (recipients.length === 0) return;
    await emitNotification(businessId, {
      type: "WHATSAPP_FAILED",
      title: `WhatsApp failed: ${leadName}`,
      body: `A WhatsApp message for "${leadName}" failed: ${input.reason.slice(0, 300)}`,
      ...(input.leadId ? { leadId: input.leadId } : {}),
      dedupeKey: `wa-fail:${input.messageId}`,
      userIds: recipients,
    });
  } catch {
    // Notification delivery must never break the send pipeline.
  }
}
