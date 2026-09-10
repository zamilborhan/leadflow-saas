/**
 * Database-backed sessions.
 *
 * - The cookie carries an opaque token; the DB stores only its SHA-256 hash.
 * - `resolveSession` is the secure check: signature + expiry + DB row +
 *   revocation + user status.
 * - `parseSessionCookie` (cookies.ts) is the optimistic check for `proxy.ts`.
 */
import { SessionTable } from "../../prisma/tables";
import {
  generateOpaqueToken,
  parseSessionCookie,
  sha256Hex,
  signSessionCookie,
  SESSION_TTL_MS,
} from "./cookies";
import { findActiveUserById, toUserId, type UserDTO, type UserId } from "./users";

export interface CreatedSession {
  cookieValue: string;
  expiresAtMs: number;
}

export async function createSession(
  userId: string | UserId,
  nowMs: number = Date.now()
): Promise<CreatedSession> {
  const token = generateOpaqueToken();
  const tokenHash = await sha256Hex(token);
  const expiresAtMs = nowMs + SESSION_TTL_MS;
  await SessionTable.create({
    userId: typeof userId === "string" ? toUserId(userId) : userId,
    tokenHash,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  const cookieValue = await signSessionCookie(token, expiresAtMs);
  return { cookieValue, expiresAtMs };
}

interface SessionRow {
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
}

async function findSessionRow(tokenHash: string): Promise<SessionRow | null> {
  const row = await SessionTable.where({ tokenHash })
    .select("userId", "expiresAt", "revokedAt")
    .first();
  if (!row) return null;
  return { userId: row.userId, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
}

function isLive(expiresAt: string, revokedAt: string | null, nowMs: number): boolean {
  if (revokedAt !== null) return false;
  const exp = new Date(expiresAt).getTime();
  if (!Number.isFinite(exp) || exp <= nowMs) return false;
  return true;
}

/**
 * Secure session resolution. Returns the active user DTO, or null when the
 * cookie is missing, tampered, expired, revoked, or the user is inactive.
 */
export async function getSessionUser(
  cookieValue: string | undefined | null,
  nowMs: number = Date.now()
): Promise<UserDTO | null> {
  const parsed = await parseSessionCookie(cookieValue, undefined, nowMs);
  if (!parsed) return null;
  const row = await findSessionRow(await sha256Hex(parsed.token));
  if (!row || !isLive(row.expiresAt, row.revokedAt, nowMs)) return null;
  return findActiveUserById(row.userId);
}

/** Revoke the session identified by a cookie value. Idempotent. */
export async function revokeSessionByCookie(
  cookieValue: string | undefined | null,
  nowMs: number = Date.now()
): Promise<void> {
  const parsed = await parseSessionCookie(cookieValue, undefined, nowMs);
  if (!parsed) return;
  const tokenHash = await sha256Hex(parsed.token);
  await SessionTable.where({ tokenHash }).update({
    revokedAt: new Date(nowMs).toISOString(),
  });
}

/**
 * Revoke every live session of a user (used after password reset).
 * NOTE: this runtime's `update()` terminal affects a single row, so
 * multi-row revocation loops over the live ids explicitly.
 */
export async function revokeAllUserSessions(
  userId: string | UserId,
  nowMs: number = Date.now()
): Promise<number> {
  const id = typeof userId === "string" ? toUserId(userId) : userId;
  const nowIso = new Date(nowMs).toISOString();
  const live = await SessionTable.where((s) => s.userId.eq(id))
    .where((s) => s.revokedAt.isNull())
    .select("id")
    .all();
  for (const row of live) {
    await SessionTable.where({ id: row.id }).update({ revokedAt: nowIso });
  }
  return live.length;
}
