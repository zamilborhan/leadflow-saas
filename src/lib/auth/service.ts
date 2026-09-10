/**
 * Auth use-cases. Framework-free: no Next.js imports, so this layer is
 * directly unit-testable against the real database. Route Handlers translate
 * `ServiceResult` into HTTP responses + cookies.
 */
import { hashPassword, verifyPassword, dummyVerify } from "./password";
import {
  validateRegister,
  validateLogin,
  validateForgotPassword,
  validateResetPassword,
} from "./validation";
import { authRateLimiter, RATE_LIMITS } from "./rate-limit";
import {
  createUser,
  findUserByEmail,
  toPublicUser,
} from "./users";
import {
  createSession,
  getSessionUser,
  revokeSessionByCookie,
} from "./sessions";
import {
  requestPasswordReset,
  consumePasswordResetToken,
} from "./password-reset";

export interface ServiceResult {
  status: number;
  body: unknown;
  /** Set the session cookie. */
  setCookie?: { value: string; maxAge: number };
  /** Clear the session cookie. */
  clearCookie?: boolean;
  retryAfterMs?: number;
}

const GENERIC_LOGIN_FAILURE = "Invalid email or password.";
const GENERIC_RESET_RESPONSE =
  "If an account exists for this email, a password reset link has been sent.";
const GENERIC_RESET_FAILURE = "Invalid or expired reset token.";

function rateLimited(retryAfterMs: number): ServiceResult {
  return {
    status: 429,
    body: { error: "Too many attempts. Please try again later." },
    retryAfterMs: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

export async function registerService(input: unknown, ip: string): Promise<ServiceResult> {
  const parsed = validateRegister(input);
  if (!parsed.ok || !parsed.value) return { status: 422, body: { errors: parsed.errors } };

  const budget = RATE_LIMITS.register;
  const decision = authRateLimiter.check(`register:${ip}`, budget.limit, budget.windowMs);
  if (!decision.allowed) return rateLimited(decision.retryAfterMs);

  const existing = await findUserByEmail(parsed.value.email);
  if (existing) {
    return { status: 409, body: { error: "An account with this email already exists." } };
  }

  const passwordHash = await hashPassword(parsed.value.password);
  const user = await createUser({
    email: parsed.value.email,
    ...(parsed.value.name !== undefined ? { name: parsed.value.name } : {}),
    passwordHash,
  });
  const session = await createSession(user.id);
  return {
    status: 201,
    body: { user: toPublicUser(user) },
    setCookie: {
      value: session.cookieValue,
      maxAge: Math.floor((session.expiresAtMs - Date.now()) / 1000),
    },
  };
}

export async function loginService(input: unknown, ip: string): Promise<ServiceResult> {
  const parsed = validateLogin(input);
  if (!parsed.ok || !parsed.value) return { status: 422, body: { errors: parsed.errors } };

  const ipBudget = RATE_LIMITS.loginIp;
  const ipDecision = authRateLimiter.check(`login:ip:${ip}`, ipBudget.limit, ipBudget.windowMs);
  if (!ipDecision.allowed) return rateLimited(ipDecision.retryAfterMs);
  const emailBudget = RATE_LIMITS.loginEmail;
  const emailDecision = authRateLimiter.check(
    `login:email:${parsed.value.email}`,
    emailBudget.limit,
    emailBudget.windowMs
  );
  if (!emailDecision.allowed) return rateLimited(emailDecision.retryAfterMs);

  const user = await findUserByEmail(parsed.value.email);
  if (!user || user.status !== "ACTIVE") {
    // Identical observable behavior for unknown/inactive accounts.
    await dummyVerify(parsed.value.password);
    return { status: 401, body: { error: GENERIC_LOGIN_FAILURE } };
  }
  const ok = await verifyPassword(parsed.value.password, user.passwordHash);
  if (!ok) {
    return { status: 401, body: { error: GENERIC_LOGIN_FAILURE } };
  }
  const session = await createSession(user.id);
  return {
    status: 200,
    body: {
      user: toPublicUser({
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status,
        createdAt: user.createdAt,
      }),
    },
    setCookie: {
      value: session.cookieValue,
      maxAge: Math.floor((session.expiresAtMs - Date.now()) / 1000),
    },
  };
}

export async function logoutService(cookieValue: string | undefined | null): Promise<ServiceResult> {
  // Idempotent: revoking a missing/invalid cookie is still success.
  await revokeSessionByCookie(cookieValue);
  return { status: 200, body: { ok: true }, clearCookie: true };
}

export async function forgotPasswordService(input: unknown, ip: string): Promise<ServiceResult> {
  const parsed = validateForgotPassword(input);
  if (!parsed.ok || !parsed.value) return { status: 422, body: { errors: parsed.errors } };

  const budget = RATE_LIMITS.forgotPassword;
  const decision = authRateLimiter.check(`forgot:${ip}`, budget.limit, budget.windowMs);
  if (!decision.allowed) return rateLimited(decision.retryAfterMs);

  const { token } = await requestPasswordReset(parsed.value.email);
  if (token) {
    // Email delivery integration point: hand `token` to the mail provider
    // inside a single-use reset URL. There is no provider configured yet,
    // so the token is intentionally dropped here — it MUST NOT be returned
    // in the HTTP response. See docs/DEVELOPMENT.md.
    void token;
  }
  return { status: 200, body: { message: GENERIC_RESET_RESPONSE } };
}

export async function resetPasswordService(input: unknown, ip: string): Promise<ServiceResult> {
  const parsed = validateResetPassword(input);
  if (!parsed.ok || !parsed.value) return { status: 422, body: { errors: parsed.errors } };

  const budget = RATE_LIMITS.resetPassword;
  const decision = authRateLimiter.check(`reset:${ip}`, budget.limit, budget.windowMs);
  if (!decision.allowed) return rateLimited(decision.retryAfterMs);

  const passwordHash = await hashPassword(parsed.value.password);
  const outcome = await consumePasswordResetToken(parsed.value.token, passwordHash);
  if (!outcome.ok) {
    return { status: 400, body: { error: GENERIC_RESET_FAILURE } };
  }
  return { status: 200, body: { message: "Password has been reset. Please log in." } };
}

export async function meService(cookieValue: string | undefined | null): Promise<ServiceResult> {
  const user = await getSessionUser(cookieValue);
  if (!user) return { status: 401, body: { error: "Not authenticated." } };
  return { status: 200, body: { user: toPublicUser(user) } };
}
