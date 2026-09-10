/**
 * Email verification lifecycle.
 *
 * Tokens are opaque, single-use, 24h; only SHA-256 hashes are stored.
 * `requestVerification` returns the raw token exactly once so the caller
 * (the mail sender) can deliver it. Route Handlers never put the token in
 * an HTTP response — delivery happens out of band via email.
 */
import { db } from "../../prisma/db";
import { EmailVerificationTokenTable } from "../../prisma/tables";
import { generateOpaqueToken, sha256Hex } from "./cookies";
import { findUserByEmail, toUserId } from "./users";

export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface VerifyRequest {
  /** Raw token — deliver via email, then drop. Null when no email is sent. */
  token: string | null;
}

/** Issue a fresh verification token for an active, unverified user. */
export async function requestVerification(
  email: string,
  nowMs: number = Date.now()
): Promise<VerifyRequest> {
  const user = await findUserByEmail(email);
  // No enumeration: unknown/inactive/already-verified accounts get the same
  // response shape, just without a token.
  if (!user || user.status !== "ACTIVE" || user.emailVerifiedAt !== null) {
    return { token: null };
  }
  const userId = toUserId(user.id);
  const stale = await EmailVerificationTokenTable.where((t) => t.userId.eq(userId))
    .where((t) => t.usedAt.isNull())
    .select("id")
    .all();
  for (const row of stale) {
    await EmailVerificationTokenTable.where({ id: row.id }).delete();
  }
  const token = generateOpaqueToken();
  await EmailVerificationTokenTable.create({
    userId,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(nowMs + VERIFY_TOKEN_TTL_MS).toISOString(),
  });
  return { token };
}

export type VerifyOutcome = { ok: true } | { ok: false };

/** Consume a verification token and stamp the user's emailVerifiedAt. */
export async function consumeVerificationToken(
  token: string,
  nowMs: number = Date.now()
): Promise<VerifyOutcome> {
  const tokenHash = await sha256Hex(token);
  const row = await EmailVerificationTokenTable.where({ tokenHash })
    .select("userId", "expiresAt", "usedAt")
    .first();
  if (!row) return { ok: false };
  if (row.usedAt !== null) return { ok: false };
  if (new Date(row.expiresAt).getTime() <= nowMs) return { ok: false };
  const nowIso = new Date(nowMs).toISOString();
  await db.transaction(async (tx) => {
    const txTokens = tx.orm.public.EmailVerificationToken;
    const txUsers = tx.orm.public.User;
    await txTokens.where({ tokenHash }).update({ usedAt: nowIso });
    await txUsers.where({ id: row.userId }).update({ emailVerifiedAt: nowIso });
  });
  return { ok: true };
}
