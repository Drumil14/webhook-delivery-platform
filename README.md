# Webhook Delivery & Replay Platform

A hosted webhook delivery platform. This repository is currently at **Phase 0 —
scaffolding only**. No product functionality (ingestion, delivery, retries,
replay, dashboard) exists yet.

## Architecture

A modular monolith made of two long-running processes that share one PostgreSQL
database:

```
apps/web     Next.js app (dashboard + health endpoint)
apps/worker  standalone Node/TypeScript background process

packages/db      shared Prisma client (single source of DB access)
packages/shared  shared constants/types used by both apps
```

- `web` and `worker` are **separate processes** so they can be deployed and
  scaled independently (a slow web request never blocks background work, and a
  busy worker never slows the UI).
- `packages/db` is shared so both processes talk to the database through the
  exact same client and connection logic.
- `packages/shared` holds code both apps need without either depending on the
  other.

## Prerequisites

- Node.js 20.6+ (developed on Node 24)
- pnpm 11+
- A PostgreSQL database (local, or a free managed one from Neon/Supabase)

## Setup

```bash
pnpm install
cp .env.example .env      # then paste your DATABASE_URL into .env
pnpm db:generate          # generate the Prisma client
pnpm db:push              # (optional) create the placeholder table
```

## Commands

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `pnpm dev`          | Run web + worker together                           |
| `pnpm dev:web`      | Run only the web app (http://localhost:3000)        |
| `pnpm dev:worker`   | Run only the worker                                 |
| `pnpm build`        | Generate Prisma client + build the web app          |
| `pnpm typecheck`    | Type-check every package                            |
| `pnpm db:generate`  | Generate the Prisma client                          |
| `pnpm db:push`      | Push the schema to the database                     |
| `pnpm start:web`    | Start the built web app (production)                |
| `pnpm start:worker` | Start the worker (production)                        |

## Environment variables

A single repo-root `.env` is the source of truth for both apps.

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE?sslmode=require
```

## Verifying the database connection

- **Web:** open http://localhost:3000 (shows `Database: Connected`) or
  `GET /api/health` → `{ "status": "ok", "database": "connected" }`.
- **Worker:** on startup it logs `Database connection successful.` then
  `Worker ready.`

Both read the same `DATABASE_URL`, so a success in both proves they share one
database.

## Deployment (Railway / Fly.io)

Deploy two processes against the same PostgreSQL database:

- **web:** build `pnpm build`, start `pnpm start:web`
- **worker:** start `pnpm start:worker`

Set `DATABASE_URL` in each service's environment.
