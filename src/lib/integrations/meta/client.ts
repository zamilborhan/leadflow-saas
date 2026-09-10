/**
 * Meta Graph API client abstraction (server-only).
 *
 * All Meta HTTP calls go through this module — never from Route Handlers or
 * client components directly. `fetchImpl` is injectable so tests mock the
 * Graph API without network access. Raw access tokens never appear in thrown
 * error messages (Meta error payloads are surfaced, token-bearing URLs are
 * never logged or stringified into errors).
 */

export const META_GRAPH_VERSION = "v26.0";
export const META_GRAPH_HOST = "https://graph.facebook.com";
export const META_DIALOG_HOST = "https://www.facebook.com";

/** Lead Ads webhook set, per Meta's Lead Ads integration docs. */
export const META_LEAD_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "ads_management",
  "leads_retrieval",
] as const;

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

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  /** Seconds until expiry; 0/absent for non-expiring tokens. */
  expiresIn: number;
}

export interface DebugTokenData {
  appId: string;
  userId: string;
  scopes: string[];
  expiresAt: number | null;
  isValid: boolean;
}

export interface MetaProfile {
  id: string;
  name: string;
}

export interface MetaPageInfo {
  id: string;
  name: string;
  tasks: string[];
  /** Page access token. Present only when granted; never logged or exposed. */
  pageToken: string | null;
}

export interface MetaLeadFormInfo {
  id: string;
  name: string;
  status: string;
}

export interface MetaLeadDetails {
  id: string;
  createdTime: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adsetName: string | null;
  adName: string | null;
  formId: string | null;
  fieldData: Array<{ name: string; values: string[] }>;
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

export class MetaGraphClient {
  private readonly fetchImpl: FetchImpl;
  private readonly version: string;
  private readonly baseUrlOverride?: string;

  constructor(opts?: { fetchImpl?: FetchImpl; version?: string; baseUrl?: string }) {
    // Default fetch is resolved lazily so injected mocks always win in tests.
    this.fetchImpl = opts?.fetchImpl ?? ((url, init) => fetch(url, init));
    this.version = opts?.version ?? META_GRAPH_VERSION;
    this.baseUrlOverride = opts?.baseUrl;
  }

  private graphUrl(path: string, params: Record<string, string>): string {
    const base = this.baseUrlOverride ?? `${META_GRAPH_HOST}/${this.version}`;
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async getJson(url: string, fallback: string): Promise<unknown> {
    let res: Response;
    try {
      // Token travels in the query string (Meta's server-side convention);
      // it is never written to logs — only the sanitized error body surfaces.
      res = await this.fetchImpl(url);
    } catch {
      throw new MetaApiError("Meta Graph API unreachable.");
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      throw new MetaApiError(`Meta Graph API returned status ${res.status}.`);
    }
    if (!res.ok) {
      const parsed = errorMessage(payload, fallback);
      throw new MetaApiError(parsed.message, { code: parsed.code, errorType: parsed.errorType });
    }
    return payload;
  }

  private static parseToken(payload: unknown, fallback: string): TokenResponse {
    if (!payload || typeof payload !== "object") throw new MetaApiError(fallback);
    const rec = payload as Record<string, unknown>;
    if (typeof rec["access_token"] !== "string" || rec["access_token"].length === 0) {
      const parsed = errorMessage(payload, fallback);
      throw new MetaApiError(parsed.message, { code: parsed.code, errorType: parsed.errorType });
    }
    const expiresIn = typeof rec["expires_in"] === "number" ? rec["expires_in"] : 0;
    return {
      accessToken: rec["access_token"],
      tokenType: typeof rec["token_type"] === "string" ? rec["token_type"] : "bearer",
      expiresIn,
    };
  }

  /** Step 2 of the manual Login flow: code → short-lived user token (server-to-server). */
  async exchangeCodeForToken(args: {
    appId: string;
    appSecret: string;
    redirectUri: string;
    code: string;
  }): Promise<TokenResponse> {
    const payload = await this.getJson(
      this.graphUrl("/oauth/access_token", {
        client_id: args.appId,
        redirect_uri: args.redirectUri,
        client_secret: args.appSecret,
        code: args.code,
      }),
      "Failed to exchange authorization code."
    );
    return MetaGraphClient.parseToken(payload, "Failed to exchange authorization code.");
  }

  /** Swap a short-lived user token for a ~60-day long-lived token. */
  async exchangeForLongLivedToken(args: {
    appId: string;
    appSecret: string;
    shortLivedToken: string;
  }): Promise<TokenResponse> {
    const payload = await this.getJson(
      this.graphUrl("/oauth/access_token", {
        grant_type: "fb_exchange_token",
        client_id: args.appId,
        client_secret: args.appSecret,
        fb_exchange_token: args.shortLivedToken,
      }),
      "Failed to extend access token."
    );
    return MetaGraphClient.parseToken(payload, "Failed to extend access token.");
  }

  /** Verify a user token belongs to our app + user (server-side, app token auth). */
  async debugToken(args: { appId: string; appSecret: string; inputToken: string }): Promise<DebugTokenData> {
    const base = this.baseUrlOverride ?? META_GRAPH_HOST;
    const payload = await this.getJson(
      `${base}/debug_token?input_token=${encodeURIComponent(args.inputToken)}&access_token=${encodeURIComponent(`${args.appId}|${args.appSecret}`)}`,
      "Failed to inspect access token."
    );
    const data =
      payload && typeof payload === "object" && "data" in payload
        ? (payload as { data: unknown }).data
        : null;
    if (!data || typeof data !== "object") throw new MetaApiError("Failed to inspect access token.");
    const rec = data as Record<string, unknown>;
    if (rec["is_valid"] !== true) throw new MetaApiError("Access token is not valid.");
    if (typeof rec["app_id"] !== "string" || typeof rec["user_id"] !== "string") {
      throw new MetaApiError("Access token inspection returned an unexpected shape.");
    }
    return {
      appId: rec["app_id"],
      userId: rec["user_id"],
      scopes: Array.isArray(rec["scopes"]) ? rec["scopes"].filter((s): s is string => typeof s === "string") : [],
      expiresAt: typeof rec["expires_at"] === "number" ? rec["expires_at"] : null,
      isValid: true,
    };
  }

  /** Connected person's id + name for account display. */
  async getProfile(userToken: string): Promise<MetaProfile> {
    const payload = await this.getJson(
      this.graphUrl("/me", { fields: "id,name", access_token: userToken }),
      "Failed to load Meta profile."
    );
    if (!payload || typeof payload !== "object") throw new MetaApiError("Failed to load Meta profile.");
    const rec = payload as Record<string, unknown>;
    if (typeof rec["id"] !== "string" || typeof rec["name"] !== "string") {
      throw new MetaApiError("Meta profile returned an unexpected shape.");
    }
    return { id: rec["id"], name: rec["name"] };
  }

  /**
   * Pages the user can act on: `GET /me/accounts` with id, name, page
   * token, and tasks (per the Pages API getting-started docs). Page tokens
   * stay in function-local scope — callers encrypt before storing and never
   * return them in DTOs.
   */
  async listPages(userToken: string): Promise<MetaPageInfo[]> {
    const payload = await this.getJson(
      this.graphUrl("/me/accounts", {
        fields: "id,name,access_token,tasks",
        access_token: userToken,
      }),
      "Failed to list Facebook Pages."
    );
    const data =
      payload && typeof payload === "object" && "data" in payload
        ? (payload as { data: unknown }).data
        : null;
    if (!Array.isArray(data)) throw new MetaApiError("Page list returned an unexpected shape.");
    const pages: MetaPageInfo[] = [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec["id"] !== "string" || typeof rec["name"] !== "string") continue;
      pages.push({
        id: rec["id"],
        name: rec["name"],
        tasks: Array.isArray(rec["tasks"]) ? rec["tasks"].filter((t): t is string => typeof t === "string") : [],
        pageToken: typeof rec["access_token"] === "string" && rec["access_token"].length > 0 ? rec["access_token"] : null,
      });
    }
    return pages;
  }

  /**
   * Lead forms on a Page: `GET /{page-id}/leadgen_forms` with id, name, and
   * status (per the Lead Ads retrieving docs). Called with the Page token.
   */
  async listLeadForms(args: { pageId: string; pageToken: string }): Promise<MetaLeadFormInfo[]> {
    const payload = await this.getJson(
      this.graphUrl(`/${args.pageId}/leadgen_forms`, {
        fields: "id,name,status",
        access_token: args.pageToken,
      }),
      "Failed to list lead forms."
    );
    const data =
      payload && typeof payload === "object" && "data" in payload
        ? (payload as { data: unknown }).data
        : null;
    if (!Array.isArray(data)) throw new MetaApiError("Form list returned an unexpected shape.");
    const forms: MetaLeadFormInfo[] = [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec["id"] !== "string" || typeof rec["name"] !== "string") continue;
      forms.push({
        id: rec["id"],
        name: rec["name"],
        status: typeof rec["status"] === "string" ? rec["status"] : "UNKNOWN",
      });
    }
    return forms;
  }

  /**
   * Lead details by leadgen id: `GET /{leadgen-id}` (per the Lead Ads
   * retrieving docs). Called with the workspace's stored user token.
   * Attribution names are best-effort — Meta omits them without ad-level
   * permissions — so every field except id is nullable.
   */
  async getLeadDetails(userToken: string, leadgenId: string): Promise<MetaLeadDetails> {
    const payload = await this.getJson(
      this.graphUrl(`/${leadgenId}`, {
        fields: "id,created_time,ad_id,adset_id,campaign_id,campaign_name,adset_name,ad_name,form_id,field_data",
        access_token: userToken,
      }),
      "Failed to load lead details."
    );
    if (!payload || typeof payload !== "object") throw new MetaApiError("Lead details returned an unexpected shape.");
    const rec = payload as Record<string, unknown>;
    if (typeof rec["id"] !== "string") throw new MetaApiError("Lead details returned an unexpected shape.");
    const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    const fieldData = Array.isArray(rec["field_data"])
      ? (rec["field_data"] as unknown[]).flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const e = entry as Record<string, unknown>;
          if (typeof e["name"] !== "string") return [];
          const values = Array.isArray(e["values"])
            ? e["values"].filter((v): v is string => typeof v === "string")
            : [];
          return [{ name: e["name"] as string, values }];
        })
      : [];
    return {
      id: rec["id"] as string,
      createdTime: text(rec["created_time"]),
      adId: text(rec["ad_id"]),
      adsetId: text(rec["adset_id"]),
      campaignId: text(rec["campaign_id"]),
      campaignName: text(rec["campaign_name"]),
      adsetName: text(rec["adset_name"]),
      adName: text(rec["ad_name"]),
      formId: text(rec["form_id"]),
      fieldData,
    };
  }

  /**
   * Best-effort permission revocation on disconnect. Callers swallow
   * failures — deleting stored credentials is what disconnects the
   * workspace; revocation is a courtesy to Meta.
   */
  async revokePermissions(userToken: string): Promise<void> {
    const url = this.graphUrl("/me/permissions", { access_token: userToken });
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "DELETE" });
    } catch {
      throw new MetaApiError("Meta Graph API unreachable.");
    }
    if (!res.ok) {
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        // fall through to generic error below
      }
      const parsed = errorMessage(payload, "Failed to revoke Meta permissions.");
      throw new MetaApiError(parsed.message, { code: parsed.code, errorType: parsed.errorType });
    }
  }
}
