/**
 * SSLCommerz connection config (pure — no imports, unit-testable).
 *
 * Credentials always come from the environment (see `env.ts`); this module
 * only validates a plain env-like record so tests can exercise the
 * missing-credential path without touching process state or the network.
 */

export const SSLCOMMERZ_SANDBOX_HOST = "https://sandbox.sslcommerz.com";
export const SSLCOMMERZ_LIVE_HOST = "https://securepay.sslcommerz.com";

export interface SslcommerzConfig {
  storeId: string;
  storeSecret: string;
  sandbox: boolean;
  /** API base URL (host only, no trailing path). */
  baseUrl: string;
}

export class SslcommerzConfigError extends Error {
  constructor(message = "Payment gateway is not configured.") {
    super(message);
    this.name = "SslcommerzConfigError";
  }
}

interface EnvLike {
  SSLCOMMERZ_STORE_ID?: string | undefined;
  SSLCOMMERZ_STORE_SECRET?: string | undefined;
  SSLCOMMERZ_SANDBOX?: string | undefined;
  SSLCOMMERZ_BASE_URL?: string | undefined;
  [key: string]: string | undefined;
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve gateway config from the environment. Throws
 * SslcommerzConfigError (never the raw env error) when credentials are
 * missing so routes can answer 503 instead of crashing.
 */
export function sslcommerzConfig(envLike: EnvLike): SslcommerzConfig {
  const storeId = nonEmpty(envLike.SSLCOMMERZ_STORE_ID);
  const storeSecret = nonEmpty(envLike.SSLCOMMERZ_STORE_SECRET);
  if (!storeId || !storeSecret) {
    throw new SslcommerzConfigError(
      "Payment gateway is not configured. Set SSLCOMMERZ_STORE_ID and SSLCOMMERZ_STORE_SECRET."
    );
  }
  const sandbox = (envLike.SSLCOMMERZ_SANDBOX ?? "true") === "true";
  const override = nonEmpty(envLike.SSLCOMMERZ_BASE_URL)?.replace(/\/$/, "");
  return {
    storeId,
    storeSecret,
    sandbox,
    baseUrl: override ?? (sandbox ? SSLCOMMERZ_SANDBOX_HOST : SSLCOMMERZ_LIVE_HOST),
  };
}
