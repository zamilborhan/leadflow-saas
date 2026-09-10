# LeadFlow BD — Development Guide

## Prerequisites

- Node.js 20+ (repo tested on Node 24)
- npm 10+
- Docker Desktop (or Docker Engine + Compose v2)

## First-time setup

```bash
npm install                 # install deps (also repairs CLI shims)
cp .env.example .env        # then fill in local values (placeholders included)
docker compose up -d        # start PostgreSQL + Redis
npm run contract:emit       # generate Prisma contract.json + contract.d.ts
npm run dev                 # start Next.js at http://localhost:3000
```

## Everyday commands

| Command               | Purpose                                  |
| --------------------- | ---------------------------------------- |
| `npm run dev`         | Start the local dev server               |
| `npm run build`       | Production build                         |
| `npm test`            | Infra smoke tests (needs containers + `.env`) |
| `npx tsc --noEmit`    | Strict type check                        |
| `npm run lint`        | ESLint (0 errors required)               |
| `npm run contract:emit` | Regenerate Prisma contract artifacts   |
| `docker compose ps`   | Show service health                      |

## Verification checklist

1. `docker compose ps` → `leadflow-postgres` and `leadflow-redis` are `healthy`.
2. `npm test` → all suites pass (structure, env, Postgres `SELECT 1`, Redis `PING`).
3. `npx tsc --noEmit` → clean.
4. `npm run lint` → 0 errors.
5. `npm run dev` → homepage responds on `http://localhost:3000`.

## Environment variables

- Copy `.env.example` → `.env`. `.env` is gitignored; **never commit it**.
- Container credentials use `${VAR:-default}` substitution in
  `docker-compose.yml`; defaults are local-dev only.
- Production secrets come from a secrets manager, never from files.
- `src/lib/env.ts` is the single typed accessor (fail-fast on missing vars).

## Troubleshooting

| Symptom                          | Fix                                                        |
| -------------------------------- | ---------------------------------------------------------- |
| `prisma` not recognized          | Run `npm install` to restore `node_modules/.bin` shims    |
| DB auth failed after password change | The password is set at volume init; `docker compose down -v` (destroys local data) then `up -d`, or `ALTER USER` inside the running DB |
| Port already in use (5432/6379)  | Stop the conflicting local service or set `POSTGRES_PORT`/`REDIS_PORT` in `.env` |
| `npm test` Redis timeout         | Check `docker compose ps`; restart with `docker compose up -d` |
| Lint errors in `contract.d.ts`   | Do not hand-edit; it is generated and excluded from lint  |

## Out of scope for now

Authentication, CRM, Meta/Facebook, WhatsApp, billing, and AI features are
explicitly deferred. Keep changes modular so those features can build on this
foundation.
