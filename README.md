# LeadFlow BD

Bangladesh-focused multi-tenant SaaS for businesses that generate leads from
Meta/Facebook Lead Ads: automatic lead capture, CRM, sales-agent assignment,
WhatsApp follow-up, reminders, automation, and conversion analytics.

> Status: **project initialization**. Tooling, docs, Docker, and database
> connectivity are in place. No product features (auth, CRM, Meta, WhatsApp,
> billing, AI) are implemented yet.

## Stack

Next.js 16 (App Router) · TypeScript (strict) · Tailwind CSS v4 · Prisma v8
(TypeScript-contract authoring) · PostgreSQL 16 · Redis 7 · Docker Compose

## Quickstart

```bash
npm install
cp .env.example .env      # fill in local values
docker compose up -d      # PostgreSQL + Redis
npm run contract:emit     # generate Prisma contract artifacts
npm run dev               # http://localhost:3000
```

## Scripts

| Command               | Purpose                                 |
| --------------------- | --------------------------------------- |
| `npm run dev`         | Local dev server                        |
| `npm run build`       | Production build                        |
| `npm test`            | Infra smoke tests (needs containers + `.env`) |
| `npx tsc --noEmit`    | Strict type check                       |
| `npm run lint`        | ESLint (0 errors required)              |
| `npm run contract:emit` | Regenerate `src/prisma/contract.json`/`.d.ts` |

## Docs

- `docs/PRODUCT_SPEC.md` — product, customers, MVP scope
- `docs/ARCHITECTURE.md` — stack, layout, multi-tenancy, security rules
- `docs/DATABASE.md` — planned models, Prisma workflow, current state
- `docs/DEVELOPMENT.md` — setup, verification, troubleshooting

## Project structure

```text
app/               Next.js routes and layouts
src/lib/           Shared server modules (env, future services)
src/prisma/        Data contract (contract.ts), generated artifacts, db client
tests/             Smoke/integration tests
docs/              Guides above
docker-compose.yml Local PostgreSQL + Redis
```

## Security notes

- `.env` is gitignored — never commit secrets. Production uses a secrets manager.
- Every tenant-owned resource is scoped by `businessId`; cross-tenant access is forbidden.
- See `docs/ARCHITECTURE.md` for the full rule set.
