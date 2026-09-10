# LeadFlow BD — Authentication

## Design

Database sessions (Next.js recommended pattern):

- `User` — id (uuidv7), unique email, optional name, nullable scrypt
  `passwordHash` (null = OAuth-only account, no password login),
  `emailVerifiedAt` (null = unverified), `status` (`ACTIVE`), timestamps.
- `Session` — opaque token stored as SHA-256 `tokenHash` (unique), `userId`,
  `expiresAt` (30 days), nullable `revokedAt`.
- `PasswordResetToken` — opaque token as `tokenHash` (unique), `userId`,
  `expiresAt` (1 hour), nullable `usedAt` (single-use).
- `OAuthAccount` — `(provider, providerUserId)` unique + `(userId, provider)`
  unique link rows for Google/Facebook identities.
- `EmailVerificationToken` — opaque token as `tokenHash` (unique), `userId`,
  `expiresAt` (24 hours), nullable `usedAt` (single-use).

The browser holds `lf_session` (httpOnly, `SameSite=Lax`, `Secure` in
production, `/`): `v1.<token>.<expMs>.<hmac>`. HMAC-SHA256 (Web Crypto, so
`proxy.ts` on the Edge and the DAL share the code) gives tamper-evidence;
the DAL re-verifies against the database on every call (revocation + user
status). Proxy checks are optimistic only.

## Endpoints

| Method | Path | Behavior |
| ------ | ---- | -------- |
| POST | `/api/auth/register` | 201 + session (+ auto workspace); 409 duplicate; 422 validation |
| POST | `/api/auth/login` | 200 + session; 401 generic (unknown/inactive/no-password/wrong identical, dummy scrypt on unknown) |
| POST | `/api/auth/logout` | Revokes session, clears cookie; idempotent 200 |
| POST | `/api/auth/forgot-password` | Always generic 200 (no enumeration); sends reset mail |
| POST | `/api/auth/reset-password` | 200; consumes token, rotates password, revokes all sessions; 400 on invalid/expired/used |
| POST | `/api/auth/verify-email/request` | Always generic 200 (no enumeration); sends verification mail |
| POST/GET | `/api/auth/verify-email/confirm` | 200; consumes token, stamps emailVerifiedAt; 400 on invalid/expired/used |
| GET | `/api/auth/oauth/:provider` | Redirect to Google/Facebook authorize (state + PKCE); 503 when unconfigured |
| GET | `/api/auth/oauth/:provider/callback` | Link-or-create, session cookie, redirect to `next` or dashboard |
| GET | `/api/me` | 200 `{user}` or 401 |
| PATCH | `/api/me` | Update name / password (current-password checked); 200 `{user}` |
| GET | `/dashboard` | Protected page (proxy redirect + DAL re-check) |
| GET | `/forgot-password`, `/reset-password`, `/verify-email` | Public auth UI pages |
| GET | `/dashboard/settings/profile` | Signed-in profile page (name, password, verification status) |

Rate limits (per IP, in-memory; see `src/lib/auth/rate-limit.ts`):
register 10/10min, login 20/10min per IP + 10/15min per email,
forgot 5/hour, reset 10/10min. `429` carries `Retry-After`.

## Security properties

- scrypt (N=16384, r=8, p=1, 64-byte key), random salt, constant-time verify.
- Passwords/tokens/hashes never appear in responses, logs, or the database
  in raw form (only hashes).
- `src/lib/auth/service.ts` is framework-free and covered by tests;
  routes translate results and set cookies via `src/lib/auth/http.ts`.

## Runtime notes (Prisma v8 rc.8)

- Models are addressed by namespace coordinate (`db.orm.public.User`;
  bare `db.orm.User` is undefined) — centralized in `src/prisma/tables.ts`.
- Collection `update()`/`delete()` terminals affect a single row; multi-row
  revocation loops explicitly (see `revokeAllUserSessions`, reset txn).

## Email delivery

`src/lib/mail/mailer.ts` (`MAIL_PROVIDER=log|resend`, `MAIL_FROM`,
`RESEND_API_KEY`): `log` prints to server logs (local-dev default, zero
dependencies); `resend` posts to api.resend.com over fetch. Registration,
forgot-password, and verification-request all send out of band — raw tokens
never appear in HTTP responses.

## Social login

Google (OAuth 2.0 + PKCE S256, `GOOGLE_CLIENT_ID/SECRET`) and Facebook
(`FACEBOOK_CLIENT_ID/SECRET`, falling back to `META_APP_ID/SECRET`).
Redirect URIs: `<APP_URL>/api/auth/oauth/<provider>/callback`. Link-or-create:
known provider id → login; email match → link (+ verify); else create a
verified, password-less user + auto workspace. Unset credentials hide nothing
client-side by accident — the authorize route returns 503 with the missing
var names, and provider tokens are exchanged for a profile then dropped.

## Workspace onboarding

Registration (email or OAuth) auto-creates `"<name>'s workspace"` with an
OWNER membership (best-effort: quota failures keep the account and the
dashboard empty-state guides manual creation). The register response carries
`businessId` for direct redirect.

## Remaining integration

None for auth mail — wire `MAIL_PROVIDER=resend` + `RESEND_API_KEY` in
production. OAuth needs real client IDs/secrets + registered redirect URIs.
