/**
 * Password-reset token lifecycle.
 *
 * Tokens are opaque, single-use, short-lived; only SHA-256 hashes are stored.
 * `requestPasswordReset` returns the raw token exactly once so the caller
 * (the email sender) can deliver it. Route Handlers must never put the token
 * in an HTTP response — delivery happens out of band via email.
 */
import { db } from "../../prisma/db";
import { PasswordResetTokenTable } from "../../prisma/tables";
import { generateOpaqueToken, sha256Hex, RESET_TOKEN_TTL_MS } from "./cookies";
import { findUserByEmail, toUserId } from "./users";

export interface ResetRequest {
  /** Raw token — deliver via email, then drop. Null when no email is sent. */
  token: string | null;
}

export async function requestPasswordReset(
  email: string,
  nowMs: number = Date.now()
): Promise<ResetRequest> {
  const user = await findUserByEmail(email);
  // No enumeration: inactive/unknown accounts get the same response shape,
  // just without a token.
  if (!user || user.status !== "ACTIVE") return { token: null };

  // Keep one live token per user: drop stale unused ones first.
  // NOTE: `delete()` affects a single row per call — loop explicitly.
  const userId = toUserId(user.id);
  const stale = await PasswordResetTokenTable.where((t) => t.userId.eq(userId))
    .where((t) => t.usedAt.isNull())
    .select("id")
    .all();
  for (const row of stale) {
    await PasswordResetTokenTable.where({ id: row.id }).delete();
  }

  const token = generateOpaqueToken();
  await PasswordResetTokenTable.create({
    userId,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(nowMs + RESET_TOKEN_TTL_MS).toISOString(),
  });
  return { token };
}

export type ResetOutcome =
  | { ok: true }
  | { ok: false; reason: "invalid" | "expired" | "used" };

/**
 * Consume a reset token: set the new password, mark the token used, and
 * revoke every session (the password change logs the user out everywhere).
 * Atomic via transaction.
 */
export async function consumePasswordResetToken(
  token: string,
  newPasswordHash: string,
  nowMs: number = Date.now()
): Promise<ResetOutcome> {
  const tokenHash = await sha256Hex(token);
  const row = await PasswordResetTokenTable.where({ tokenHash })
    .select("userId", "expiresAt", "usedAt")
    .first();
  if (!row) return { ok: false, reason: "invalid" };
  if (row.usedAt !== null) return { ok: false, reason: "used" };
  if (new Date(row.expiresAt).getTime() <= nowMs) return { ok: false, reason: "expired" };

  const nowIso = new Date(nowMs).toISOString();
  await db.transaction(async (tx) => {
    const txResetTokens = tx.orm.public.PasswordResetToken;
    const txUsers = tx.orm.public.User;
    const txSessions = tx.orm.public.Session;
    await txResetTokens.where({ tokenHash }).update({ usedAt: nowIso });
    await txUsers.where({ id: row.userId }).update({ passwordHash: newPasswordHash });
    // Single-row `update()` semantics: revoke each live session explicitly.
    const live = await txSessions
      .where((s) => s.userId.eq(row.userId))
      .where((s) => s.revokedAt.isNull())
      .select("id")
      .all();
    for (const session of live) {
      await txSessions.where({ id: session.id }).update({ revokedAt: nowIso });
    }
  });
  return { ok: true };
}
