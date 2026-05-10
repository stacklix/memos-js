# TypeScript Branch vs `golang` Branch: Current Differences

> Updated: 2026-05-10.
>
> Baseline: `chore/golang-v0.28.0-alignment@e8d0ff21` vs `golang@9bf648ac` (v0.28.0).
>
> The `golang` branch is the API/proto reference. This document tracks known implementation gaps and intentional TypeScript/Worker differences; it is not permission to introduce new API drift.

## Designed Differences

| Area | TypeScript branch | `golang` branch |
| --- | --- | --- |
| Backend runtime | Hono REST API, Node.js + SQLite, Cloudflare Workers + D1 | Go server with gRPC-Gateway REST + Connect |
| Frontend hosting | `dist/public/` served by Node or Worker Static Assets | Go Echo fileserver |
| Worker assets | Cloudflare `ASSETS.fetch` with `run_worker_first` | Not applicable |
| Object storage | `DATABASE / LOCAL / S3 / R2` | `DATABASE / LOCAL / S3` |
| SSE | Node-only; Worker SSE is excluded | Go server SSE |

## Database

| Area | TypeScript branch | `golang` branch |
| --- | --- | --- |
| Schema source | Incremental `migrations/NNNN_*.sql` | `store/migration/sqlite/*` plus `LATEST.sql` |
| Version tracking | `schema_migrations` table | No equivalent table |
| Local runtime DB | SQLite file, default `data/memos.sqlite` | SQLite/PostgreSQL/MySQL support |
| Worker DB | Cloudflare D1, migrated by Wrangler | Not applicable |
| DDL style | Uses `IF NOT EXISTS` guards | Plain DDL |

## Backend API

| Area | TypeScript branch | `golang` branch |
| --- | --- | --- |
| Transport implementation | REST only: hand-written Hono routes under `/api/v1` | REST via gRPC-Gateway under `/api/v1`, plus Connect handlers |
| Storage setting response | Adds `supportedStorageTypes`, can include `R2` | Fixed proto enum without R2 |
| Memo / attachment filters | Implements a supported CEL-like subset | Full Go/proto behavior |
| SSE route | Mounted only when Node enables SSE | Go server route is available |

## Frontend

Current frontend differences are primarily adapter/runtime related:

| File / area | Difference |
| --- | --- |
| `web/src/connect.ts` | Large custom REST adapter that converts frontend service calls to the TypeScript backend's JSON API. |
| `web/src/lib/proto-adapters.ts` | Converts REST responses into the existing frontend model types used by hooks/components. |
| Storage settings | `InstanceContext.tsx` and `StorageSection.tsx` support dynamic storage types and R2. |
| User menu | Live SSE connection indicator is removed because SSE is not available on Worker. |

## Still Excluded

- Backend/API support for R2 storage intentionally differs from upstream Go.
- Cloudflare Worker SSE remains excluded because long-lived SSE streams are not a good fit for this Worker deployment path.
