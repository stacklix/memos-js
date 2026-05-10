# memos

JavaScript/TypeScript implementation of **[memos](https://github.com/usememos/memos)**.

[English](./README.md) | [简体中文](./README.zh-CN.md)

- Backend: [Hono](https://hono.dev/) REST API under `/api/v1`
- Frontend: React + Vite SPA (`web/`)
- Deployment targets:
  - **Node.js** + SQLite
  - **Cloudflare Workers** + D1 + Static Assets

If you need the Chinese guide, I can add `README.zh-CN.md` in a follow-up.

## Repository layout

| Path | Purpose |
| --- | --- |
| `server/` | Backend source: Hono app, DB adapters, Node/Worker entrypoints |
| `web/` | Frontend source (React + Vite) |
| `dist/public/` | Frontend build output, served by Node/Worker |
| `dist/server/` | Node backend build output (`dist/server/node.js`) |
| `migrations/` | SQL migrations (`NNNN_description.sql`) for SQLite and D1 |
| `wrangler.jsonc` | Worker, D1, and static assets config |

## Requirements

- Root/backend: Node.js 18+ recommended
- Frontend (`web/`): Node.js version that satisfies `web/package.json` (`engines.node >= 24`)
- Worker deployment: Cloudflare account + D1 database

## Local development

Install dependencies:

```bash
npm install
```

### Recommended (Node API + Vite)

```bash
npm run dev
```

This runs API + web + URL helper concurrently.

- Open frontend: [http://localhost:3001](http://localhost:3001)
- Vite proxies `/api` and `/healthz` to [http://localhost:3000](http://localhost:3000)

### Run separately

```bash
npm run dev:node
npm run dev:web
```

### Worker local mode

```bash
npm run dev:worker
```

`dev:worker` ensures `dist/public` is up to date and runs local D1 migrations first.

## Common commands

| Goal | Command |
| --- | --- |
| Start API + web dev | `npm run dev` |
| Start Node backend only | `npm run dev:node` |
| Start Vite web only | `npm run dev:web` |
| Start Worker local dev | `npm run dev:worker` |
| Build frontend | `npm run build:web` |
| Build backend | `npm run build:node` |
| Build both | `npm run build` |
| Run built Node server | `npm run start:node` |
| Typecheck | `npm run typecheck` |
| Tests (once) | `npm test` |
| Tests (watch) | `npm run test:watch` |

### Database scripts

Naming convention: `db:<action>:<target>`

- actions: `migrate`, `empty`, `clear`
- targets: `sqlite`, `d1:local`, `d1:remote` (remote for migrate only)

| Goal | Command |
| --- | --- |
| Apply local SQLite migrations | `npm run db:migrate:sqlite` |
| Empty local SQLite data, keep schema | `npm run db:empty:sqlite` |
| Delete local SQLite database file | `npm run db:clear:sqlite` |
| Apply local D1 migrations | `npm run db:migrate:d1:local` |
| Apply remote D1 migrations | `npm run db:migrate:d1:remote` |
| Empty local D1 data, keep schema | `npm run db:empty:d1:local` |
| Delete local Wrangler state | `npm run db:clear:d1:local` |

For `empty` / `clear`, stop the corresponding dev server first. SQLite `empty` / `clear` and D1 local `clear` accept `-- --yes` for non-interactive runs.

## Migrations (Node + D1)

Add a new SQL file under `migrations/`:

- Filename: `NNNN_short_description.sql` (4-digit prefix)
- Keep migration version aligned with `schema_migrations`
- No TypeScript changes are required for normal schema updates

Node startup and `npm run db:migrate:sqlite` apply pending migrations by filename order.
D1 uses Wrangler migration commands on the same `migrations/` directory.

## Deployment

### Deploy to Node.js

```bash
npm run build
npm run start:node
```

At minimum, ship:

- `dist/public/`
- `dist/server/`
- `migrations/`
- production dependencies

Node serves both static files and `/api/*` from one process.

### Deploy to Cloudflare Workers

1. Configure `wrangler.jsonc` (`database_id`, Worker name, vars/secrets)
2. Build frontend:

```bash
npm run build:web
```

3. Apply remote D1 migrations:

```bash
npm run db:migrate:d1:remote
```

4. Deploy:

```bash
npx wrangler login
npm run deploy:worker
```

Current deploy scripts in `package.json`:

- `npm run deploy:worker` -> versions upload
- `npm run deploy:worker:promote` -> versions deploy
- `npm run deploy:worker:full` -> full deploy

## Environment variables (Node, selected)

| Variable | Description |
| --- | --- |
| `PORT` | Listen port, default `3000` |
| `MEMOS_STATIC_ROOT` | Override static root directory |
| `DATA_DIR` | SQLite data directory (default: `data/`) |
| `MEMOS_MIGRATIONS_DIR` | Optional absolute migration directory |
| `MEMOS_INSTANCE_URL` | External instance URL |
| `MEMOS_VERSION` | Instance version string |
| `MEMOS_DEMO` | Set to `1` for demo JWT secret mode |

## API contract

For API/proto parity, use this repository's `golang` branch as source of truth:

- `proto/`
- Go tree under `server/` and `plugin/`

Current gap documents:

- [English gap list](./DIFF-VS-GOLANG.md)
- [Chinese gap list](./DIFF-VS-GOLANG.zh-CN.md)

Note: that Go `server/` is different from this branch's TypeScript `server/`.
See `AGENTS.md` for collaboration rules.
