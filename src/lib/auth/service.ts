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
  validateProfileUpdate,
} from "./validation";
import { authRateLimiter, RATE_LIMITS } from "./rate-limit";
import {
  createUser,
  findUserByEmail,
  findUserById,
  toPublicUser,
  toUserId,
} from "./users";
import {
  createSession,
  getSessionUser,
  revokeSessionByCookie,
} from "./sessions";
import { getCurrentUser } from "./dal";
import {
  requestPasswordReset,
  consumePasswordResetToken,
} from "./password-reset";
import {
  requestVerification,
  consumeVerificationToken,
} from "./verification";
import { sendMail } from "../mail/mailer";
import { resetMail, resetUrl, verificationMail, verificationUrl } from "../mail/templates";

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
const GENERIC_VERIFY_RESPONSE =
  "If an account exists for this email, a verification link has been sent.";
const GENERIC_VERIFY_FAILURE = "Invalid or expired verification link.";

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
  // Per-email + global buckets so rotating X-Forwarded-For alone never
  // resets the budget (header is client-controlled; see getClientIp).
  const emailBudget = RATE_LIMITS.registerEmail;
  const emailDecision = authRateLimiter.check(
    `register:email:${parsed.value.email}`,
    emailBudget.limit,
    emailBudget.windowMs
  );
  if (!emailDecision.allowed) return rateLimited(emailDecision.retryAfterMs);
  const globalBudget = RATE_LIMITS.registerGlobal;
  const globalDecision = authRateLimiter.check(`register:global`, globalBudget.limit, globalBudget.windowMs);
  if (!globalDecision.allowed) return rateLimited(globalDecision.retryAfterMs);

  const existing = await findUserByEmail(parsed.value.email);
  if (existing) {
    // No enumeration: identical observable timing + a generic success-shaped
    // response. Never reveal whether the email exists, never set a session.
    await dummyVerify(parsed.value.password);
    return {
      status: 200,
      body: { message: "If this email is new, an account was created. Check your inbox to verify." },
    };
  }

  const passwordHash = await hashPassword(parsed.value.password);
  const user = await createUser({
    email: parsed.value.email,
    ...(parsed.value.name !== undefined ? { name: parsed.value.name } : {}),
    passwordHash,
  });
  const session = await createSession(user.id);

  // Workspace auto-creation (onboarding decision: automatic). Best-effort:
  // quota failures leave the user without a workspace and the dashboard
  // empty-state guides manual creation.
  let businessId: string | null = null;
  try {
    const { ensureRoleSeeds } = await import("../tenancy/seeds");
    const { createBusiness } = await import("../tenancy/businesses");
    await ensureRoleSeeds();
    const base = parsed.value.name?.trim() || parsed.value.email.split("@")[0] || "My";
    const business = await createBusiness(user.id, `${base}'s workspace`.slice(0, 120));
    businessId = business.id;
  } catch (err) {
    console.warn("[auth] auto workspace creation skipped", {
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  // Verification email (out-of-band; never in the response body).
  try {
    const { token } = await requestVerification(user.email);
    if (token) await sendMail(verificationMail(user.email, verificationUrl(token)));
  } catch (err) {
    console.warn("[auth] verification mail skipped", {
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  return {
    status: 201,
    body: { user: toPublicUser(user), ...(businessId ? { businessId } : {}) },
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
  // OAuth-only accounts have no password: same generic failure, no enumeration.
  if (!user.passwordHash) {
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
        emailVerifiedAt: user.emailVerifiedAt,
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
  const forgotEmailBudget = RATE_LIMITS.forgotEmail;
  const forgotEmailDecision = authRateLimiter.check(
    `forgot:email:${parsed.value.email}`,
    forgotEmailBudget.limit,
    forgotEmailBudget.windowMs
  );
  if (!forgotEmailDecision.allowed) return rateLimited(forgotEmailDecision.retryAfterMs);

  const { token } = await requestPasswordReset(parsed.value.email);
  if (token) {
    // Delivered out of band via the mail provider — never in the response.
    try {
      await sendMail(resetMail(parsed.value.email, resetUrl(token)));
    } catch (err) {
      console.warn("[auth] reset mail failed", {
        message: err instanceof Error ? err.message : "unknown",
      });
    }
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
  // Bridged read: database session first, Supabase fallback (profile page
  // works for Supabase users; writes stay on updateProfileService, lf-only).
  const user = (await getSessionUser(cookieValue)) ?? (await getCurrentUser());
  if (!user) return { status: 401, body: { error: "Not authenticated." } };
  return { status: 200, body: { user: toPublicUser(user) } };
}

export async function requestVerificationService(
  input: unknown,
  ip: string
): Promise<ServiceResult> {
  const parsed = validateForgotPassword(input);
  if (!parsed.ok || !parsed.value) return { status: 422, body: { errors: parsed.errors } };

  const budget = RATE_LIMITS.forgotPassword;
  const decision = authRateLimiter.check(`verify:${ip}`, budget.limit, budget.windowMs);
  if (!decision.allowed) return rateLimited(decision.retryAfterMs);
  const verifyEmailBudget = RATE_LIMITS.forgotEmail;
  const verifyEmailDecision = authRateLimiter.check(
    `verify:email:${parsed.value.email}`,
    verifyEmailBudget.limit,
    verifyEmailBudget.windowMs
  );
  if (!verifyEmailDecision.allowed) return rateLimited(verifyEmailDecision.retryAfterMs);

  const { token } = await requestVerification(parsed.value.email);
  if (token) {
    try {
      await sendMail(verificationMail(parsed.value.email, verificationUrl(token)));
    } catch (err) {
      console.warn("[auth] verification mail failed", {
        message: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  return { status: 200, body: { message: GENERIC_VERIFY_RESPONSE } };
}

export async function confirmVerificationService(
  input: unknown,
  ip: string
): Promise<ServiceResult> {
  const token =
    typeof input === "object" && input !== null
      ? String((input as Record<string, unknown>)["token"] ?? "").trim()
      : "";
  if (token.length < 16 || token.length > 256) {
    return { status: 400, body: { error: GENERIC_VERIFY_FAILURE } };
  }
  const budget = RATE_LIMITS.verifyConfirm;
  const decision = authRateLimiter.check(`verify-confirm:${ip}`, budget.limit, budget.windowMs);
  if (!decision.allowed) return rateLimited(decision.retryAfterMs);

  const outcome = await consumeVerificationToken(token);
  if (!outcome.ok) return { status: 400, body: { error: GENERIC_VERIFY_FAILURE } };
  return { status: 200, body: { message: "Email verified. You can now use all features." } };
}

export async function updateProfileService(
  cookieValue: string | undefined | null,
  input: unknown
): Promise<ServiceResult> {
  const parsed = validateProfileUpdate(input);
  if (!parsed.ok || !parsed.value) return { status: 422, body: { errors: parsed.errors } };

  // Legacy database user: name/password live in our own User row.
  const sessionUser = await getSessionUser(cookieValue);
  if (sessionUser) {
    const { UserTable } = await import("../../prisma/tables");
    const uid = toUserId(sessionUser.id);
    const patch: { name?: string | null; passwordHash?: string } = {};
    if (parsed.value.name !== undefined) patch.name = parsed.value.name;
    if (parsed.value.newPassword !== undefined) {
      const full = await findUserByEmail(sessionUser.email);
      if (full?.passwordHash) {
        const ok = await verifyPassword(parsed.value.currentPassword ?? "", full.passwordHash);
        if (!ok) return { status: 401, body: { error: "Current password is incorrect." } };
      } else {
        // OAuth-only account: a hijacked session alone must not install a
        // persistent password credential. Require inbox proof via the
        // password-reset flow instead.
        return {
          status: 403,
          body: { error: "Password setup requires email verification. Use the password reset flow." },
        };
      }
      patch.passwordHash = await hashPassword(parsed.value.newPassword);
    }
    if (Object.keys(patch).length > 0) {
      await UserTable.where({ id: uid }).update(patch);
    }
    const fresh = await findUserById(sessionUser.id);
    if (!fresh) return { status: 401, body: { error: "Not authenticated." } };
    return { status: 200, body: { user: toPublicUser(fresh) } };
  }

  // Supabase user: name/password live in Supabase Auth. The email address is
  // deliberately never writable here — changing it must go through
  // Supabase's own verification flow, never around it.
  const { getSupabaseUser } = await import("./supabase-user");
  const supaUser = await getSupabaseUser();
  if (!supaUser) return { status: 401, body: { error: "Not authenticated." } };
  try {
    const { createClient } = await import("../supabase/server");
    const supabase = await createClient();
    if (parsed.value.newPassword !== undefined) {
      // Session alone must not install a persistent credential without
      // proof of inbox control. Supabase password changes go through its
      // own verified reset/recovery flow, never this session endpoint.
      return {
        status: 403,
        body: { error: "Password change for Supabase accounts requires the verified reset flow." },
      };
    }
    if (parsed.value.name !== undefined) {
      const { error } = await supabase.auth.updateUser({
        data: { full_name: parsed.value.name },
      });
      if (error) return { status: 400, body: { error: error.message } };
    }
  } catch {
    return { status: 500, body: { error: "Could not update profile. Please try again." } };
  }
  const fresh = await getSupabaseUser();
  if (!fresh) return { status: 401, body: { error: "Not authenticated." } };
  return { status: 200, body: { user: toPublicUser(fresh) } };
}
