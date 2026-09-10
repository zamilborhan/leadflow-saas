/**
 * SSLCommerz gateway client (server-only).
 *
 * All gateway HTTP goes through this module — never from Route Handlers
 * or client components directly. `fetchImpl` is injectable so tests mock
 * the gateway without network access. Store credentials travel only in
 * POST bodies to the gateway; they are never logged and never stringified
 * into thrown errors.
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class SSLCommerzError extends Error {
  readonly endpoint?: string;
  constructor(message: string, opts?: { endpoint?: string }) {
    super(message);
    this.name = "SSLCommerzError";
    this.endpoint = opts?.endpoint;
  }
}

/** Upstream outage talking to the gateway — callers answer 503 so SSLCommerz retries IPN. */
export class SslcommerzUpstreamError extends SSLCommerzError {
  constructor(message = "Payment gateway is temporarily unreachable.") {
    super(message);
    this.name = "SslcommerzUpstreamError";
  }
}

export class SSLCommerzClient {
  private readonly fetchImpl: FetchImpl;
  private readonly baseUrl: string;

  constructor(opts?: { fetchImpl?: FetchImpl; baseUrl?: string }) {
    // Default fetch is resolved lazily so injected mocks always win in tests.
    this.fetchImpl = opts?.fetchImpl ?? ((url, init) => fetch(url, init));
    this.baseUrl = (opts?.baseUrl ?? "https://sandbox.sslcommerz.com").replace(/\/$/, "");
  }

  private async postForm(path: string, params: Record<string, string>): Promise<unknown> {
    const body = new URLSearchParams(params).toString();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new SslcommerzUpstreamError();
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      throw new SSLCommerzError("Payment gateway returned an unreadable response.", { endpoint: path });
    }
    if (!res.ok) {
      throw new SSLCommerzError("Payment gateway rejected the request.", { endpoint: path });
    }
    return payload;
  }

  private async getJson(url: string, path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "GET" });
    } catch {
      throw new SslcommerzUpstreamError();
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      throw new SSLCommerzError("Payment gateway returned an unreadable response.", { endpoint: path });
    }
    if (!res.ok) {
      throw new SSLCommerzError("Payment gateway rejected the request.", { endpoint: path });
    }
    return payload;
  }

  /**
   * Create a transaction session (`POST {host}/gwprocess/v4/api.php`,
   * per the v4 docs). Returns the raw JSON — callers interpret it with
   * `parseInitResponse`.
   */
  async initSession(params: Record<string, string>): Promise<unknown> {
    return this.postForm("/gwprocess/v4/api.php", params);
  }

  /**
   * Order Validation API (`GET {host}/validator/api/
   * validationserverAPI.php?val_id&store_id&store_passwd&format=json&v=1`,
   * per the v4 docs). Returns the raw JSON — callers interpret it with
   * `parseValidationResponse`.
   */
  async validateOrder(args: { valId: string; storeId: string; storePasswd: string }): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/validator/api/validationserverAPI.php`);
    url.searchParams.set("val_id", args.valId);
    url.searchParams.set("store_id", args.storeId);
    url.searchParams.set("store_passwd", args.storePasswd);
    url.searchParams.set("format", "json");
    url.searchParams.set("v", "1");
    return this.getJson(url.toString(), "/validator/api/validationserverAPI.php");
  }
}
