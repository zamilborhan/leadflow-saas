/**
 * Meta (Facebook Lead Ads) connection service — the only layer that touches
 * stored credentials.
 *
 * Security contract:
 * - Access tokens exist as plaintext only in function-local scope. They are
 *   encrypted with AES-256-GCM before any write, and never logged, never
 *   returned in DTOs, never sent to clients.
 * - All Meta HTTP goes through MetaGraphClient (server-to-server). The app
 *   secret never leaves the server.
 * - OAuth `state` binds business + initiating user + expiry (see state.ts);
 *   the callback re-verifies the session user against it.
 * - Connecting/disconnecting requires `businesses.update` (OWNER/ADMIN);
 *   status reads require workspace membership (enforced by route guards via
 *   BusinessContext).
 */
import { MetaConnectionTable } from "../../../prisma/tables";
import { env } from "../../env";
import type { BusinessContext } from "../../tenancy/context";
import { requirePermission } from "../../tenancy/policies";
import { toBusinessId, toDbId } from "../../tenancy/businesses";
import { decryptToken, encryptToken } from "./crypto";
import { META_DIALOG_HOST, META_LEAD_SCOPES, MetaGraphClient } from "./client";
import { signOAuthState, verifyOAuthState } from "./state";

export const META_MANAGE_PERMISSION = "businesses.update" as const;

export interface MetaConnectionStatus {
  connected: boolean;
  status?: string;
  metaUserId?: string;
  metaUserName?: string | null;
  scopes?: string[];
  tokenExpiresAt?: string | null;
  connectedAt?: string;
  updatedAt?: string;
}

interface StoredConnection {
  id: string;
  businessId: string;
  metaUserId: string;
  metaUserName: string | null;
  accessTokenEncrypted: string;
  tokenExpiresAt: string | null;
  scopes: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const CONNECTION_FIELDS = [
  "id",
  "businessId",
  "metaUserId",
  "metaUserName",
  "accessTokenEncrypted",
  "tokenExpiresAt",
  "scopes",
  "status",
  "createdAt",
  "updatedAt",
] as const;

async function findConnection(businessId: string): Promise<StoredConnection | null> {
  let bid;
  try {
    bid = toBusinessId(businessId);
  } catch {
    return null;
  }
  const row = await MetaConnectionTable.where((m) => m.businessId.eq(bid))
    .select(...CONNECTION_FIELDS)
    .first();
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.businessId,
    metaUserId: row.metaUserId,
    metaUserName: row.metaUserName,
    accessTokenEncrypted: row.accessTokenEncrypted,
    tokenExpiresAt: row.tokenExpiresAt,
    scopes: row.scopes,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toStatus(row: StoredConnection | null): MetaConnectionStatus {
  if (!row || row.status !== "ACTIVE") return { connected: false };
  return {
    connected: true,
    status: row.status,
    metaUserId: row.metaUserId,
    metaUserName: row.metaUserName,
    scopes: row.scopes.split(" ").filter(Boolean),
    tokenExpiresAt: row.tokenExpiresAt,
    connectedAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function callbackUrl(appUrl: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/meta/callback`;
}

export function metaCallbackUrl(appUrl: string = env.nextAuthUrl): string {
  return callbackUrl(appUrl);
}

/**
 * Step 1: build the Meta Login dialog URL. The caller must already hold an
 * authorized context (businesses.update).
 */
export async function buildConnectUrl(
  context: BusinessContext,
  opts?: { appId?: string; appUrl?: string }
): Promise<string> {
  requirePermission(context, META_MANAGE_PERMISSION);
  const appId = opts?.appId ?? env.metaAppId;
  const state = await signOAuthState(context.business.id, context.membership.userId, {
    secret: env.nextAuthSecret,
  });
  const url = new URL(`${META_DIALOG_HOST}/v26.0/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", callbackUrl(opts?.appUrl ?? env.nextAuthUrl));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", META_LEAD_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

export interface CallbackResult {
  businessId: string;
}

export class MetaOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaOAuthError";
  }
}

/**
 * Step 2: handle the Meta redirect. Verifies state, checks the session user
 * matches the flow initiator, exchanges the code server-side, extends to a
 * long-lived token, verifies app/user binding, and upserts the encrypted
 * connection. Throws MetaOAuthError (safe to surface) on any failure.
 */
export async function handleMetaCallback(args: {
  code?: string | null;
  state?: string | null;
  sessionUserId: string;
  error?: string | null;
  errorDescription?: string | null;
  client?: MetaGraphClient;
  appId?: string;
  appSecret?: string;
  appUrl?: string;
}): Promise<CallbackResult> {
  if (args.error) {
    throw new MetaOAuthError("Meta authorization was declined or failed.");
  }
  if (!args.code) {
    throw new MetaOAuthError("Missing authorization code from Meta.");
  }
  const payload = await verifyOAuthState(args.state, { secret: env.nextAuthSecret });
  if (!payload) {
    throw new MetaOAuthError("Invalid or expired OAuth state.");
  }
  if (payload.userId !== args.sessionUserId) {
    throw new MetaOAuthError("OAuth session mismatch.");
  }
  // TOCTOU: the initiator may have been demoted/removed after starting the
  // flow. Re-verify live membership + manage permission before writing
  // credentials — the state signature alone is not authorization.
  try {
    const { resolveBusinessContext } = await import("../../tenancy/context");
    const resolved = await resolveBusinessContext(args.sessionUserId, payload.businessId);
    if (!resolved.ok) throw new MetaOAuthError("Access denied for this business.");
    requirePermission(resolved.context, META_MANAGE_PERMISSION);
  } catch (err) {
    if (err instanceof MetaOAuthError) throw err;
    throw new MetaOAuthError("Access denied for this business.");
  }
  // Single-use state nonce: reject replays within the TTL.
  {
    const { consumeOAuthNonce } = await import("./state");
    if (!consumeOAuthNonce(payload.nonce, payload.exp)) {
      throw new MetaOAuthError("Invalid or expired OAuth state.");
    }
  }

  const appId = args.appId ?? env.metaAppId;
  const appSecret = args.appSecret ?? env.metaAppSecret;
  const redirectUri = callbackUrl(args.appUrl ?? env.nextAuthUrl);
  const client = args.client ?? new MetaGraphClient();

  // Server-to-server from here on: secret + tokens never touch the client.
  const shortLived = await client.exchangeCodeForToken({
    appId,
    appSecret,
    redirectUri,
    code: args.code,
  });
  const longLived = await client.exchangeForLongLivedToken({
    appId,
    appSecret,
    shortLivedToken: shortLived.accessToken,
  });
  const debug = await client.debugToken({ appId, appSecret, inputToken: longLived.accessToken });
  // Binding checks per Meta's manual-flow docs: the token must be valid and
  // issued for this app. Session binding was already verified via `state`.
  if (debug.appId !== appId) {
    throw new MetaOAuthError("Token was not issued for this app.");
  }
  const profile = await client.getProfile(longLived.accessToken);

  const scopes = debug.scopes.length > 0 ? debug.scopes : [...META_LEAD_SCOPES];
  const encrypted = await encryptToken(longLived.accessToken, env.metaTokenKey);
  const expiresAt =
    longLived.expiresIn > 0
      ? new Date(Date.now() + longLived.expiresIn * 1000).toISOString()
      : debug.expiresAt
        ? new Date(debug.expiresAt * 1000).toISOString()
        : null;

  const businessId = toBusinessId(payload.businessId);
  const existing = await findConnection(payload.businessId);
  if (existing) {
    await MetaConnectionTable.where({ id: toDbId(existing.id) }).update({
      metaUserId: profile.id,
      metaUserName: profile.name,
      accessTokenEncrypted: encrypted,
      tokenExpiresAt: expiresAt,
      scopes: scopes.join(" "),
      status: "ACTIVE",
    } as never);
  } else {
    await MetaConnectionTable.select("id").create({
      businessId,
      metaUserId: profile.id,
      metaUserName: profile.name,
      accessTokenEncrypted: encrypted,
      tokenExpiresAt: expiresAt,
      scopes: scopes.join(" "),
      status: "ACTIVE",
    });
  }
  return { businessId: payload.businessId };
}

/** Redacted connection status — safe for API responses and UI. */
export async function getMetaConnectionStatus(context: BusinessContext): Promise<MetaConnectionStatus> {
  const row = await findConnection(context.business.id);
  return toStatus(row);
}

/**
 * Disconnect: best-effort Meta-side revocation, then delete stored
 * credentials. Revocation failure never blocks local disconnect.
 */
export async function disconnectMetaConnection(
  context: BusinessContext,
  client?: MetaGraphClient
): Promise<boolean> {
  requirePermission(context, META_MANAGE_PERMISSION);
  const row = await findConnection(context.business.id);
  if (!row) return false;
  try {
    const token = await decryptToken(row.accessTokenEncrypted, env.metaTokenKey);
    await (client ?? new MetaGraphClient()).revokePermissions(token);
  } catch {
    // Local disconnect proceeds regardless; nothing secret is logged.
  }
  await MetaConnectionTable.where({ id: toDbId(row.id) }).delete();
  return true;
}

/** Decrypt the stored token for server-side Graph calls. Never expose. */
export async function getDecryptedMetaToken(context: BusinessContext): Promise<string | null> {
  const row = await findConnection(context.business.id);
  if (!row || row.status !== "ACTIVE") return null;
  return decryptToken(row.accessTokenEncrypted, env.metaTokenKey);
}
