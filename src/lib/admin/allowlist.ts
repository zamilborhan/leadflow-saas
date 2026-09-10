/**
 * Super-admin allowlist helpers.
 *
 * Framework-free and dependency-free: safe to import from unit tests via
 * Node type-stripping. Platform super-admins are declared out-of-band via
 * the SUPER_ADMIN_EMAILS environment variable (comma-separated) — never
 * via workspace roles, so no tenant membership can ever confer platform
 * access.
 */

/** Parse the SUPER_ADMIN_EMAILS value into a normalized email set. */
export function parseSuperAdminAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const email = part.trim().toLowerCase();
    if (email.length > 0) seen.add(email);
  }
  return [...seen].sort();
}

/** True when `email` is allowlisted (case-insensitive, trimmed). */
export function isSuperAdminEmail(email: string | null | undefined, allowlistRaw: string | undefined | null): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return parseSuperAdminAllowlist(allowlistRaw).includes(normalized);
}
