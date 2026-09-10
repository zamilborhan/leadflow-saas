/**
 * Current business / workspace context.
 *
 * The "current business" is never trusted from the client alone: every
 * resolver takes the authenticated `userId` plus a client-supplied
 * `requestedBusinessId` and re-verifies membership against the database.
 * Non-members always resolve to `ok: false` with no business data, so a
 * forged `x-business-id` header reveals nothing.
 */
import {
  findMembership,
  getBusinessForMember,
  type BusinessDTO,
  type MembershipDTO,
} from "./businesses";

export interface BusinessContext {
  business: BusinessDTO;
  membership: MembershipDTO;
}

export type ContextResult = { ok: true; context: BusinessContext } | { ok: false; reason: "no-membership" };

/**
 * Resolve the workspace context for (`userId`, `requestedBusinessId`).
 * Returns `ok: false` when the business is missing, the id is malformed,
 * the user is not a member, or the workspace is suspended — all four are
 * indistinguishable on purpose.
 */
export async function resolveBusinessContext(
  userId: string,
  requestedBusinessId: string | undefined | null
): Promise<ContextResult> {
  if (!requestedBusinessId) return { ok: false, reason: "no-membership" };
  const membership = await findMembership(userId, requestedBusinessId);
  if (!membership) return { ok: false, reason: "no-membership" };
  const business = await getBusinessForMember(userId, requestedBusinessId);
  if (!business) return { ok: false, reason: "no-membership" };
  if (business.status === "SUSPENDED") return { ok: false, reason: "no-membership" };
  return { ok: true, context: { business, membership } };
}

/**
 * Extract the client-requested business id from a Request: explicit
 * `x-business-id` header first, then `?businessId=` query param.
 * Still untrusted — pass through resolveBusinessContext before use.
 */
export function getRequestedBusinessId(req: Request): string | null {
  const header = req.headers.get("x-business-id");
  if (header && header.trim().length > 0) return header.trim();
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("businessId");
    return q && q.trim().length > 0 ? q.trim() : null;
  } catch {
    return null;
  }
}
