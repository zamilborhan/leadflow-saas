/**
 * Typed environment access for LeadFlow BD.
 *
 * Rules:
 * - Never hardcode secrets. Read them from the environment.
 * - `required()` throws a clear error at boot when a secret is missing
 *   (fail-fast) instead of failing obscurely at request time.
 * - Required values are exposed behind getters so importing this module
 *   never throws during builds that do not need runtime secrets.
 * - Never import this module (or its values) into client components.
 */

function read(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function required(name: string): string {
  const value = read(name);
  if (value === undefined) {
    throw new Error(`[env] Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: read("NODE_ENV") ?? "development",
  port: Number(read("PORT") ?? "3000"),
  nextAuthUrl: read("NEXTAUTH_URL") ?? "http://localhost:3000",

  get isProduction(): boolean {
    return (read("NODE_ENV") ?? "development") === "production";
  },

  /** PostgreSQL connection string. Every tenant-owned table lives in this database. */
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },

  /** Redis connection string (queues, background jobs, caching, automation). */
  get redisUrl(): string {
    return required("REDIS_URL");
  },

  get nextAuthSecret(): string {
    return required("NEXTAUTH_SECRET");
  },

  /**
   * Public app URL used to build email links (verification, reset) and
   * OAuth redirect URIs. Falls back to NEXTAUTH_URL for backwards compat.
   */
  get appUrl(): string {
    return read("APP_URL") ?? read("NEXTAUTH_URL") ?? "http://localhost:3000";
  },

  /** Meta (Facebook) app ID for Lead Ads OAuth. Server-only — never expose to clients. */
  get metaAppId(): string {
    return required("META_APP_ID");
  },

  /** Meta app secret. Server-to-server calls only — never leaves the server. */
  get metaAppSecret(): string {
    return required("META_APP_SECRET");
  },

  /**
   * 32-byte key for AES-256-GCM token encryption, as 64 hex chars or
   * 44-char base64. Never logged, never sent to clients.
   */
  get metaTokenKey(): string {
    return required("META_TOKEN_KEY");
  },

  /**
   * Optional Graph API base override (e.g. a local mock server in tests).
   * Unset in every real environment.
   */
  get metaGraphBaseUrl(): string | undefined {
    return read("META_GRAPH_BASE_URL");
  },

  /**
   * Shared secret Meta echoes back during webhook verification handshake.
   * Compared timing-safe; never logged.
   */
  get metaWebhookVerifyToken(): string {
    return required("META_WEBHOOK_VERIFY_TOKEN");
  },

  /** SSLCommerz store ID (server-only — never NEXT_PUBLIC_ prefixed). */
  get sslcommerzStoreId(): string {
    return required("SSLCOMMERZ_STORE_ID");
  },

  /** SSLCommerz store password. Server-to-server calls only. */
  get sslcommerzStoreSecret(): string {
    return required("SSLCOMMERZ_STORE_SECRET");
  },

  /**
   * "true" (default) targets the SSLCommerz sandbox host; any other value
   * targets the live host. Readiness, not secrecy — safe to log.
   */
  get sslcommerzSandbox(): boolean {
    return (read("SSLCOMMERZ_SANDBOX") ?? "true") === "true";
  },

  /**
   * Optional SSLCommerz API base override (e.g. a local mock server in
   * tests). Unset in every real environment.
   */
  get sslcommerzBaseUrl(): string | undefined {
    return read("SSLCOMMERZ_BASE_URL");
  },

  /**
   * Platform super-admin allowlist: comma-separated login emails with
   * access to /admin and /api/admin/*. Empty means no super-admins.
   * Compared case-insensitively; never exposed to clients.
   */
  get superAdminEmails(): string[] {
    const raw = read("SUPER_ADMIN_EMAILS");
    if (!raw) return [];
    const seen = new Set<string>();
    for (const part of raw.split(",")) {
      const email = part.trim().toLowerCase();
      if (email.length > 0) seen.add(email);
    }
    return [...seen].sort();
  },

  // --- User-auth OAuth (Google/Facebook sign-in). Optional: when unset the
  // provider button is hidden and the authorize route returns 503 with a
  // clear operator message instead of crashing boot. Never expose secrets
  // to client components.
  get googleClientId(): string | undefined {
    return read("GOOGLE_CLIENT_ID");
  },

  get googleClientSecret(): string | undefined {
    return read("GOOGLE_CLIENT_SECRET");
  },

  /** Facebook Login for user auth. Falls back to the Lead Ads app when no
   * dedicated login app is configured (same Meta app can serve both). */
  get facebookClientId(): string | undefined {
    return read("FACEBOOK_CLIENT_ID") ?? read("META_APP_ID");
  },

  get facebookClientSecret(): string | undefined {
    return read("FACEBOOK_CLIENT_SECRET") ?? read("META_APP_SECRET");
  },

  // --- Outbound email. `log` (default) prints to server logs for local dev;
  // `resend` posts to api.resend.com. No new npm dependency: Resend over fetch.
  get mailProvider(): string {
    return read("MAIL_PROVIDER") ?? "log";
  },

  get mailFrom(): string {
    return read("MAIL_FROM") ?? "LeadFlow BD <no-reply@localhost>";
  },

  get resendApiKey(): string | undefined {
    return read("RESEND_API_KEY");
  },

  // --- Supabase (optional auth foundation). Deliberately optional getters:
  // the app boots and all existing auth flows work with Supabase
  // unconfigured; Supabase clients throw a clear message only when actually
  // used, and the proxy skips session refresh. Only the publishable key is
  // ever referenced — no service-role or secret key exists in this codebase,
  // and NEXT_PUBLIC_ values are safe to expose to the browser by design.
  get supabaseUrl(): string | undefined {
    const raw = read("NEXT_PUBLIC_SUPABASE_URL");
    if (!raw) return undefined;
    // Normalize: Supabase project URL must be the base (https://xxx.supabase.co).
    // A common misconfiguration is pasting the REST endpoint (.../rest/v1/)
    // which breaks Auth with "Invalid path specified in request URL".
    return raw.replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
  },

  get supabasePublishableKey(): string | undefined {
    return read("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  },

  get isSupabaseConfigured(): boolean {
    return Boolean(
      read("NEXT_PUBLIC_SUPABASE_URL") && read("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
    );
  },
};

export type AppEnv = typeof env;
