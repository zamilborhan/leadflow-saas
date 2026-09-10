/**
 * WhatsApp Cloud API connection service — the only layer that touches
 * stored WhatsApp credentials.
 *
 * Security contract (mirrors the Meta connection service):
 * - Access tokens exist as plaintext only in function-local scope. They are
 *   encrypted with AES-256-GCM before any write, and never logged, never
 *   returned in DTOs, never sent to clients.
 * - All WhatsApp HTTP goes through WhatsAppCloudClient (server-to-server,
 *   Bearer auth).
 * - Connecting/disconnecting/health-checking requires `businesses.update`
 *   (OWNER/ADMIN); status reads require workspace membership (enforced by
 *   route guards via BusinessContext).
 *
 * Connect flow: the caller supplies the WABA id, phone number id, and a
 * system-user access token (from the Meta App Dashboard / Business
 * Settings, per the Cloud API get-started docs). The service verifies the
 * credentials live — the phone number must exist and belong to the given
 * WABA — then stores the encrypted token plus display metadata. Automated
 * follow-up sending is explicitly out of scope; this module only connects,
 * reports status/health, and disconnects.
 */
import { WhatsAppConnectionTable } from "../../../prisma/tables";
import { env } from "../../env";
import type { BusinessContext } from "../../tenancy/context";
import { requirePermission } from "../../tenancy/policies";
import { TenantConflict, TenantNotFound } from "../../tenancy/policies";
import { toBusinessId, toDbId } from "../../tenancy/businesses";
import { decryptToken, encryptToken } from "../meta/crypto";
import { WhatsAppCloudClient } from "./client";

export const WHATSAPP_MANAGE_PERMISSION = "businesses.update" as const;

export interface WhatsAppConnectionStatus {
  connected: boolean;
  status?: string;
  wabaId?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
  healthStatus?: string | null;
  lastCheckedAt?: string | null;
  connectedAt?: string;
  updatedAt?: string;
}

export interface StoredConnection {
  id: string;
  businessId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  accessTokenEncrypted: string;
  healthStatus: string | null;
  lastCheckedAt: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const CONNECTION_FIELDS = [
  "id",
  "businessId",
  "wabaId",
  "phoneNumberId",
  "displayPhoneNumber",
  "verifiedName",
  "accessTokenEncrypted",
  "healthStatus",
  "lastCheckedAt",
  "status",
  "createdAt",
  "updatedAt",
] as const;

function defaultClient(): WhatsAppCloudClient {
  const baseUrl = env.metaGraphBaseUrl;
  return new WhatsAppCloudClient(baseUrl ? { baseUrl } : undefined);
}

export async function findConnection(businessId: string): Promise<StoredConnection | null> {
  let bid;
  try {
    bid = toBusinessId(businessId);
  } catch {
    return null;
  }
  const row = await WhatsAppConnectionTable.where((m) => m.businessId.eq(bid))
    .select(...CONNECTION_FIELDS)
    .first();
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.businessId,
    wabaId: row.wabaId,
    phoneNumberId: row.phoneNumberId,
    displayPhoneNumber: row.displayPhoneNumber,
    verifiedName: row.verifiedName,
    accessTokenEncrypted: row.accessTokenEncrypted,
    healthStatus: row.healthStatus,
    lastCheckedAt: row.lastCheckedAt,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toStatus(row: StoredConnection | null): WhatsAppConnectionStatus {
  if (!row || row.status !== "ACTIVE") return { connected: false };
  return {
    connected: true,
    status: row.status,
    wabaId: row.wabaId,
    phoneNumberId: row.phoneNumberId,
    displayPhoneNumber: row.displayPhoneNumber,
    verifiedName: row.verifiedName,
    healthStatus: row.healthStatus,
    lastCheckedAt: row.lastCheckedAt,
    connectedAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface WhatsAppConnectInput {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
}

/**
 * Connect WhatsApp: verify the credentials live (phone exists and belongs
 * to the WABA), then upsert the encrypted connection. Throws TenantConflict
 * (409) when Meta rejects the credentials or the number belongs elsewhere.
 */
export async function connectWhatsApp(
  context: BusinessContext,
  input: WhatsAppConnectInput,
  client?: WhatsAppCloudClient
): Promise<WhatsAppConnectionStatus> {
  requirePermission(context, WHATSAPP_MANAGE_PERMISSION);
  const api = client ?? defaultClient();

  let phone;
  try {
    phone = await api.getPhoneNumber({ phoneNumberId: input.phoneNumberId, token: input.accessToken });
  } catch (err) {
    throw new TenantConflict(
      err instanceof Error ? `WhatsApp rejected the credentials: ${err.message}` : "WhatsApp rejected the credentials."
    );
  }
  const wabaNumbers = await api
    .listPhoneNumbers({ wabaId: input.wabaId, token: input.accessToken })
    .catch(() => null);
  if (!wabaNumbers || !wabaNumbers.some((n) => n.id === input.phoneNumberId)) {
    throw new TenantConflict("Phone number does not belong to this WhatsApp Business Account.");
  }

  const businessId = toBusinessId(context.business.id);
  const encrypted = await encryptToken(input.accessToken, env.metaTokenKey);
  const existing = await findConnection(context.business.id);
  if (existing) {
    await WhatsAppConnectionTable.where({ id: toDbId(existing.id) }).update({
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: phone.displayPhoneNumber,
      verifiedName: phone.verifiedName,
      accessTokenEncrypted: encrypted,
      healthStatus: null,
      lastCheckedAt: null,
      status: "ACTIVE",
    } as never);
  } else {
    await WhatsAppConnectionTable.select("id").create({
      businessId,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: phone.displayPhoneNumber,
      verifiedName: phone.verifiedName,
      accessTokenEncrypted: encrypted,
      status: "ACTIVE",
    });
  }
  const row = await findConnection(context.business.id);
  return toStatus(row);
}

/** Redacted connection status — safe for API responses and UI. */
export async function getWhatsAppStatus(context: BusinessContext): Promise<WhatsAppConnectionStatus> {
  const row = await findConnection(context.business.id);
  return toStatus(row);
}

export interface WhatsAppHealth {
  canSendMessage: string | null;
  checkedAt: string;
  entities: Array<{ entityType: string; id: string; canSendMessage: string | null }>;
}

/**
 * Live health check against Meta (`health_status` on the phone number).
 * Persists the overall status + check time for display; returns the full
 * entity breakdown. Meta failures surface as TenantConflict (409) with the
 * sanitized Meta message.
 */
export async function checkWhatsAppHealth(
  context: BusinessContext,
  client?: WhatsAppCloudClient
): Promise<WhatsAppHealth> {
  requirePermission(context, WHATSAPP_MANAGE_PERMISSION);
  const row = await findConnection(context.business.id);
  if (!row || row.status !== "ACTIVE") throw new TenantNotFound("No active WhatsApp connection.");
  let token: string;
  try {
    token = await decryptToken(row.accessTokenEncrypted, env.metaTokenKey);
  } catch {
    throw new TenantConflict("Stored credentials are unreadable. Reconnect WhatsApp.");
  }
  let health;
  try {
    health = await (client ?? defaultClient()).getPhoneHealth({
      phoneNumberId: row.phoneNumberId,
      token,
    });
  } catch (err) {
    throw new TenantConflict(
      err instanceof Error ? `WhatsApp health check failed: ${err.message}` : "WhatsApp health check failed."
    );
  }
  const checkedAt = new Date().toISOString();
  await WhatsAppConnectionTable.where({ id: toDbId(row.id) }).update({
    healthStatus: health.canSendMessage,
    lastCheckedAt: checkedAt,
  } as never);
  return { canSendMessage: health.canSendMessage, checkedAt, entities: health.entities };
}

/** Disconnect: delete stored credentials. Requires businesses.update. */
export async function disconnectWhatsApp(context: BusinessContext): Promise<boolean> {
  requirePermission(context, WHATSAPP_MANAGE_PERMISSION);
  const row = await findConnection(context.business.id);
  if (!row) return false;
  await WhatsAppConnectionTable.where({ id: toDbId(row.id) }).delete();
  return true;
}

/** Decrypt the stored token for server-side Graph calls. Never expose. */
export async function getDecryptedWhatsAppToken(context: BusinessContext): Promise<string | null> {
  const row = await findConnection(context.business.id);
  if (!row || row.status !== "ACTIVE") return null;
  return decryptToken(row.accessTokenEncrypted, env.metaTokenKey);
}
