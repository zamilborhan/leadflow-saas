/**
 * WhatsApp Cloud API client abstraction (server-only).
 *
 * All WhatsApp HTTP goes through this module — never from Route Handlers
 * or client components directly. `fetchImpl` is injectable so tests mock
 * the Graph API without network access. Authentication uses the
 * `Authorization: Bearer` header (per the Cloud API docs), which keeps
 * tokens out of URLs entirely; raw tokens never appear in thrown error
 * messages (Meta error payloads are surfaced instead).
 *
 * This module intentionally has no project-local imports (the small
 * shared surface is duplicated from the Meta client) so unit tests can
 * import it directly under Node type-stripping.
 */

export const META_GRAPH_VERSION = "v26.0";
export const META_GRAPH_HOST = "https://graph.facebook.com";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class MetaApiError extends Error {
  readonly code?: number;
  readonly errorType?: string;
  constructor(message: string, opts?: { code?: number; errorType?: string }) {
    super(message);
    this.name = "MetaApiError";
    this.code = opts?.code;
    this.errorType = opts?.errorType;
  }
}

export interface WaPhoneNumber {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  codeVerificationStatus: string | null;
}

export interface WaHealthEntity {
  entityType: string;
  id: string;
  canSendMessage: string | null;
}

export interface WaHealth {
  canSendMessage: string | null;
  entities: WaHealthEntity[];
}

export interface WaTemplateComponent {
  type: string;
  format?: string;
  text?: string;
  example?: unknown;
  buttons?: Array<Record<string, unknown>>;
}

export interface WaMessageTemplate {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: WaTemplateComponent[];
}

function errorMessage(payload: unknown, fallback: string): { message: string; code?: number; errorType?: string } {
  if (payload && typeof payload === "object" && "error" in payload) {
    const err = (payload as { error: unknown }).error;
    if (err && typeof err === "object") {
      const rec = err as Record<string, unknown>;
      const message = typeof rec["message"] === "string" ? rec["message"] : fallback;
      const code = typeof rec["code"] === "number" ? rec["code"] : undefined;
      const errorType = typeof rec["type"] === "string" ? rec["type"] : undefined;
      return { message, code, errorType };
    }
  }
  return { message: fallback };
}

const PHONE_FIELDS = "id,display_phone_number,verified_name,quality_rating,code_verification_status";

export interface WaSendResult {
  messageId: string;
  waId: string | null;
}

export class WhatsAppCloudClient {
  private readonly fetchImpl: FetchImpl;
  private readonly version: string;
  private readonly baseUrlOverride?: string;

  constructor(opts?: { fetchImpl?: FetchImpl; version?: string; baseUrl?: string }) {
    // Default fetch is resolved lazily so injected mocks always win in tests.
    this.fetchImpl = opts?.fetchImpl ?? ((url, init) => fetch(url, init));
    this.version = opts?.version ?? META_GRAPH_VERSION;
    this.baseUrlOverride = opts?.baseUrl;
  }

  private nodeUrl(nodeId: string, params: Record<string, string>): string {
    const base = this.baseUrlOverride ?? `${META_GRAPH_HOST}/${this.version}`;
    const url = new URL(`${base}/${nodeId}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async getJson(url: string, token: string, fallback: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new MetaApiError("WhatsApp API unreachable.");
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      throw new MetaApiError(`WhatsApp API returned status ${res.status}.`);
    }
    if (!res.ok) {
      const parsed = errorMessage(payload, fallback);
      throw new MetaApiError(parsed.message, { code: parsed.code, errorType: parsed.errorType });
    }
    return payload;
  }

  private static parsePhone(payload: unknown, fallback: string): WaPhoneNumber {
    if (!payload || typeof payload !== "object") throw new MetaApiError(fallback);
    const rec = payload as Record<string, unknown>;
    if (typeof rec["id"] !== "string") throw new MetaApiError(fallback);
    const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    return {
      id: rec["id"],
      displayPhoneNumber: text(rec["display_phone_number"]),
      verifiedName: text(rec["verified_name"]),
      qualityRating: text(rec["quality_rating"]),
      codeVerificationStatus: text(rec["code_verification_status"]),
    };
  }

  /** Single business phone number with display details (health excluded). */
  async getPhoneNumber(args: { phoneNumberId: string; token: string }): Promise<WaPhoneNumber> {
    const payload = await this.getJson(
      this.nodeUrl(args.phoneNumberId, { fields: PHONE_FIELDS }),
      args.token,
      "Failed to load WhatsApp phone number."
    );
    return WhatsAppCloudClient.parsePhone(payload, "Failed to load WhatsApp phone number.");
  }

  /** All phone numbers on a WhatsApp Business Account (`/{waba-id}/phone_numbers`). */
  async listPhoneNumbers(args: { wabaId: string; token: string }): Promise<WaPhoneNumber[]> {
    const payload = await this.getJson(
      this.nodeUrl(`${args.wabaId}/phone_numbers`, { fields: PHONE_FIELDS }),
      args.token,
      "Failed to list WhatsApp phone numbers."
    );
    const data =
      payload && typeof payload === "object" && "data" in payload
        ? (payload as { data: unknown }).data
        : null;
    if (!Array.isArray(data)) throw new MetaApiError("Phone list returned an unexpected shape.");
    const out: WaPhoneNumber[] = [];
    for (const entry of data) {
      try {
        out.push(WhatsAppCloudClient.parsePhone(entry, "skip"));
      } catch {
        continue;
      }
    }
    return out;
  }

  /**
   * Messaging health for a phone number (`health_status` field, per the
   * health-status docs). Overall status is AVAILABLE / LIMITED / BLOCKED.
   */
  async getPhoneHealth(args: { phoneNumberId: string; token: string }): Promise<WaHealth> {
    const payload = await this.getJson(
      this.nodeUrl(args.phoneNumberId, { fields: "id,health_status" }),
      args.token,
      "Failed to check WhatsApp health."
    );
    if (!payload || typeof payload !== "object") throw new MetaApiError("Health check returned an unexpected shape.");
    const rec = payload as Record<string, unknown>;
    const health = rec["health_status"];
    if (!health || typeof health !== "object") throw new MetaApiError("Health check returned an unexpected shape.");
    const h = health as Record<string, unknown>;
    const entitiesRaw = Array.isArray(h["entities"]) ? h["entities"] : [];
    const entities: WaHealthEntity[] = [];
    for (const e of entitiesRaw) {
      if (!e || typeof e !== "object") continue;
      const er = e as Record<string, unknown>;
      if (typeof er["entity_type"] !== "string" || typeof er["id"] !== "string") continue;
      entities.push({
        entityType: er["entity_type"],
        id: er["id"],
        canSendMessage: typeof er["can_send_message"] === "string" ? er["can_send_message"] : null,
      });
    }
    return {
      canSendMessage: typeof h["can_send_message"] === "string" ? h["can_send_message"] : null,
      entities,
    };
  }

  /**
   * Message templates on a WABA (`/{waba-id}/message_templates`, per the
   * template reference). Requests the fields needed for listing, preview,
   * and variable extraction. Pagination follows `paging.cursors.after`
   * until `limit` entries are collected.
   */
  async listMessageTemplates(args: {
    wabaId: string;
    token: string;
    limit?: number;
  }): Promise<WaMessageTemplate[]> {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 250);
    const out: WaMessageTemplate[] = [];
    let after: string | null = null;
    for (;;) {
      const params: Record<string, string> = {
        fields: "id,name,language,category,status,components",
        limit: String(Math.min(limit - out.length, 100)),
      };
      if (after) params["after"] = after;
      const payload = await this.getJson(
        this.nodeUrl(`${args.wabaId}/message_templates`, params),
        args.token,
        "Failed to list WhatsApp templates."
      );
      if (!payload || typeof payload !== "object" || !("data" in payload)) {
        throw new MetaApiError("Template list returned an unexpected shape.");
      }
      const data = (payload as { data: unknown }).data;
      if (!Array.isArray(data)) throw new MetaApiError("Template list returned an unexpected shape.");
      for (const entry of data) {
        const parsed = WhatsAppCloudClient.parseTemplate(entry);
        if (parsed) out.push(parsed);
        if (out.length >= limit) break;
      }
      const paging =
        payload && typeof payload === "object" && "paging" in payload
          ? (payload as { paging?: unknown }).paging
          : null;
      const cursors =
        paging && typeof paging === "object" && "cursors" in paging
          ? (paging as { cursors?: unknown }).cursors
          : null;
      const next =
        cursors && typeof cursors === "object" && "after" in cursors
          ? (cursors as { after?: unknown }).after
          : null;
      if (out.length >= limit || typeof next !== "string" || !next) break;
      after = next;
    }
    return out;
  }

  private async postJson(url: string, token: string, body: unknown, fallback: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new MetaApiError("WhatsApp API unreachable.");
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      throw new MetaApiError(`WhatsApp API returned status ${res.status}.`);
    }
    if (!res.ok) {
      const parsed = errorMessage(payload, fallback);
      throw new MetaApiError(parsed.message, { code: parsed.code, errorType: parsed.errorType });
    }
    return payload;
  }

  private static parseTemplate(entry: unknown): WaMessageTemplate | null {
    if (!entry || typeof entry !== "object") return null;
    const rec = entry as Record<string, unknown>;
    if (typeof rec["id"] !== "string" || typeof rec["name"] !== "string") return null;
    if (typeof rec["language"] !== "string" || typeof rec["status"] !== "string") return null;
    const components = Array.isArray(rec["components"])
      ? (rec["components"] as unknown[]).flatMap((c): WaTemplateComponent[] => {
          if (!c || typeof c !== "object") return [];
          const cr = c as Record<string, unknown>;
          if (typeof cr["type"] !== "string") return [];
          const component: WaTemplateComponent = { type: cr["type"] };
          if (typeof cr["format"] === "string") component.format = cr["format"];
          if (typeof cr["text"] === "string") component.text = cr["text"];
          if (cr["example"] !== undefined) component.example = cr["example"];
          if (Array.isArray(cr["buttons"])) {
            component.buttons = cr["buttons"].filter(
              (b): b is Record<string, unknown> => !!b && typeof b === "object"
            );
          }
          return [component];
        })
      : [];
    return {
      id: rec["id"],
      name: rec["name"],
      language: rec["language"],
      category: typeof rec["category"] === "string" ? rec["category"] : null,
      status: rec["status"],
      components,
    };
  }

  /**
   * Send an approved template (`POST /{phone-id}/messages`, per the
   * messages reference). Meta's acceptance response carries the wamid —
   * acceptance only, never delivery. Throws MetaApiError otherwise.
   */
  async sendTemplateMessage(args: {
    phoneNumberId: string;
    token: string;
    to: string;
    templateName: string;
    languageCode: string;
    components: Array<{ type: string; parameters: Array<Record<string, unknown>> }>;
  }): Promise<WaSendResult> {
    const payload = await this.postJson(
      this.nodeUrl(`${args.phoneNumberId}/messages`, {}),
      args.token,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: args.to,
        type: "template",
        template: {
          name: args.templateName,
          language: { code: args.languageCode },
          components: args.components,
        },
      },
      "Failed to send WhatsApp template message."
    );
    if (!payload || typeof payload !== "object" || !("messages" in payload)) {
      throw new MetaApiError("Send returned an unexpected shape.");
    }
    const messages = (payload as { messages: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new MetaApiError("Send returned an unexpected shape.");
    }
    const first = messages[0] as Record<string, unknown>;
    if (!first || typeof first !== "object" || typeof first["id"] !== "string") {
      throw new MetaApiError("Send returned an unexpected shape.");
    }
    const contactsRaw = (payload as Record<string, unknown>)["contacts"];
    const contacts = Array.isArray(contactsRaw)
      ? (contactsRaw[0] as Record<string, unknown> | undefined)
      : undefined;
    const waId = contacts && typeof contacts["wa_id"] === "string" ? contacts["wa_id"] : null;
    return { messageId: first["id"], waId };
  }
}
