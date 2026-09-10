# LeadFlow BD — Authentication

## Design

Database sessions (Next.js recommended pattern):

- `User` — id (uuidv7), unique email, optional name, scrypt `passwordHash`,
  `status` (`ACTIVE`), timestamps.
- `Session` — opaque token stored as SHA-256 `tokenHash` (unique), `userId`,
  `expiresAt` (30 days), nullable `revokedAt`.
- `PasswordResetToken` — opaque token as `tokenHash` (unique), `userId`,
  `expiresAt` (1 hour), nullable `usedAt` (single-use).

The browser holds `lf_session` (httpOnly, `SameSite=Lax`, `Secure` in
production, `/`): `v1.<token>.<expMs>.<hmac>`. HMAC-SHA256 (Web Crypto, so
`proxy.ts` on the Edge and the DAL share the code) gives tamper-evidence;
the DAL re-verifies against the database on every call (revocation + user
status). Proxy checks are optimistic only.

## Endpoints

| Method | Path | Behavior |
| ------ | ---- | -------- |
| POST | `/api/auth/register` | 201 + session; 409 duplicate; 422 validation |
| POST | `/api/auth/login` | 200 + session; 401 generic (unknown/inactive/wrong identical, dummy scrypt on unknown) |
| POST | `/api/auth/logout` | Revokes session, clears cookie; idempotent 200 |
| POST | `/api/auth/forgot-password` | Always generic 200 (no enumeration) |
| POST | `/api/auth/reset-password` | 200; consumes token, rotates password, revokes all sessions; 400 on invalid/expired/used |
| GET | `/api/me` | 200 `{user}` or 401 |
| GET | `/dashboard` | Protected page (proxy redirect + DAL re-check) |

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

## Remaining integration

Email delivery for reset links is not wired (no provider configured):
`forgotPasswordService` creates the token and drops it by design — wire a
mail provider at the marked integration point in `src/lib/auth/service.ts`.
