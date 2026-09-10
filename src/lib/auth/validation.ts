/**
 * Input validation for auth flows. Every Route Handler validates untrusted
 * input through these helpers before touching the database.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_NAME_LENGTH = 100;

// Practical (not RFC-complete) email check: one @, dot in domain, no spaces.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FieldErrors = Record<string, string[]>;

export function isValidEmailShape(email: unknown): email is string {
  return (
    typeof email === "string" &&
    email.length > 0 &&
    email.length <= MAX_EMAIL_LENGTH &&
    EMAIL_RE.test(email)
  );
}

/** Normalize for storage/lookup: trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateRegister(input: unknown): {
  ok: boolean;
  errors: FieldErrors;
  value?: { email: string; password: string; name?: string };
} {
  const errors: FieldErrors = {};
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: { _form: ["Invalid request body."] } };
  }
  const body = input as Record<string, unknown>;

  const rawEmail = typeof body.email === "string" ? body.email.trim() : "";
  if (!isValidEmailShape(rawEmail)) {
    errors.email = ["Enter a valid email address."];
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = [`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`];
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    errors.password = ["Password is too long."];
  }
  let name: string | undefined;
  if (body.name !== undefined && body.name !== null && body.name !== "") {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      errors.name = ["Name must be a non-empty string."];
    } else if (body.name.trim().length > MAX_NAME_LENGTH) {
      errors.name = ["Name is too long."];
    } else {
      name = body.name.trim();
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: {},
    value: { email: normalizeEmail(rawEmail), password, ...(name ? { name } : {}) },
  };
}

export function validateLogin(input: unknown): {
  ok: boolean;
  errors: FieldErrors;
  value?: { email: string; password: string };
} {
  const errors: FieldErrors = {};
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: { _form: ["Invalid request body."] } };
  }
  const body = input as Record<string, unknown>;
  const rawEmail = typeof body.email === "string" ? body.email.trim() : "";
  // Intentionally shape-only: existence is never revealed here.
  if (!isValidEmailShape(rawEmail)) {
    errors.email = ["Enter a valid email address."];
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length === 0) {
    errors.password = ["Password is required."];
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    errors.password = ["Password is too long."];
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, errors: {}, value: { email: normalizeEmail(rawEmail), password } };
}

export function validateForgotPassword(input: unknown): {
  ok: boolean;
  errors: FieldErrors;
  value?: { email: string };
} {
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: { _form: ["Invalid request body."] } };
  }
  const rawEmail =
    typeof (input as Record<string, unknown>).email === "string"
      ? ((input as Record<string, unknown>).email as string).trim()
      : "";
  // Shape is validated so callers send sane payloads, but the response never
  // reveals whether the account exists (checked after this returns).
  if (!isValidEmailShape(rawEmail)) {
    return { ok: false, errors: { email: ["Enter a valid email address."] } };
  }
  return { ok: true, errors: {}, value: { email: normalizeEmail(rawEmail) } };
}

export function validateResetPassword(input: unknown): {
  ok: boolean;
  errors: FieldErrors;
  value?: { token: string; password: string };
} {
  const errors: FieldErrors = {};
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: { _form: ["Invalid request body."] } };
  }
  const body = input as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length < 16 || token.length > 256) {
    errors.token = ["Invalid or expired reset token."];
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = [`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`];
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    errors.password = ["Password is too long."];
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, errors: {}, value: { token, password } };
}
