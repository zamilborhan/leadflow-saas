# LeadFlow BD — Database

## Engine

PostgreSQL 16, running as the `postgres` service in `docker-compose.yml`
(container `leadflow-postgres`, port `5432`, data in the `postgres_data`
volume). Connection string: `DATABASE_URL` in `.env`.

## Planned domain models

Every tenant-owned model carries `businessId` for strict tenant isolation.

| Model               | Purpose                                            | Tenant-owned |
| ------------------- | -------------------------------------------------- | ------------ |
| User                | Account identity (auth)                            | —            |
| Business            | Workspace/tenant root                              | — (is one)   |
| BusinessMember      | Membership of a user in a business + role          | yes          |
| Lead                | Captured prospect, status, assignment, score       | yes          |
| LeadActivity        | Append-only timeline events for a lead             | yes          |
| LeadNote            | Agent notes on a lead                              | yes          |
| FollowUp            | Scheduled reminder/task for a lead                 | yes          |
| MetaConnection      | Meta OAuth connection per business (token encrypted) | yes        |
| MetaPage            | Cached FB pages for a business (token encrypted)   | yes          |
| MetaForm            | Connected lead form per business                   | yes          |
| MetaLeadEvent       | Inbound leadgen webhook outbox + retry state       | yes          |
| WhatsAppConnection  | WhatsApp Cloud API connection (token encrypted)    | yes          |
| WhatsAppTemplate    | Cached message templates (APPROVED-gated sending)  | yes          |
| LeadTemplateSelection | Selected template per lead                       | yes          |
| WhatsAppMessage     | Outbound/inbound messages + status tracking        | yes          |
| Plan                | Subscription plan catalog                          | — (global)   |
| Subscription        | Business subscription state                        | yes          |
| Payment             | Payment records                                    | yes          |

## Current state

Implemented (migrations `migrations/app/20260907T1155_init_auth` through
`migrations/app/20260908T1150_whatsapp_templates`):
`User`, `Session`, `PasswordResetToken`, `Business`, `BusinessMember`,
`Role`, `Permission`, `RolePermission`, `Lead`, `LeadActivity`, `LeadNote`,
`FollowUp`, `MetaConnection`, `MetaPage`, `MetaForm`, `MetaLeadEvent`,
`WhatsAppConnection`, `WhatsAppTemplate`, `LeadTemplateSelection` — multi-tenant workspace + auth + CRM +
follow-ups + Meta OAuth foundation + WhatsApp Cloud API foundation, see `docs/AUTH.md`,
`src/lib/tenancy/`, `src/lib/integrations/meta/`, and
`src/lib/integrations/whatsapp/`. OAuth and WhatsApp access tokens are
stored only as AES-256-GCM ciphertext (`MetaConnection.accessTokenEncrypted`,
`WhatsAppConnection.accessTokenEncrypted`).
`MetaLeadEvent` is the inbound leadgen webhook outbox: one row per
(businessId, leadgenId) with PENDING | PROCESSING | DONE | FAILED status,
attempts, and nextRetryAt for safe retries. `Lead` carries a
(businessId, facebookLeadId) unique constraint so redeliveries can never
create duplicate leads.
Not yet implemented:
`WhatsAppMessage`, `Plan`,
`Subscription`, `Payment` — do not treat the table above as implemented
for those models.

## Workflow (Prisma v8, TypeScript authoring)

1. Edit `src/prisma/contract.ts` (the source of truth).
2. Run `npm run contract:emit` → regenerates `contract.json` + `contract.d.ts`.
3. Plan and apply a migration (`prisma migration …`), review the SQL.
4. Access data only via `src/prisma/db.ts`, always scoped by `businessId`.

## Redis (separate store, not a replacement)

Redis 7 (`leadflow-redis`, port `6379`, `redis_data` volume) is used for
queues, background jobs, caching, and scheduled automation — never as the
system of record. Connection string: `REDIS_URL` in `.env`.
