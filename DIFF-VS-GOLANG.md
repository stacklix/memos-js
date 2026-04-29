# Current Branch (`master`) vs `golang` Branch: Remaining Differences

> Updated: 2026-04-29. Baseline: `master` vs `golang@9bf648ac` (v0.28.0).
> REST API contract reference: [https://usememos.com/docs/api/0-28-0](https://usememos.com/docs/api/0-28-0) and `golang:proto/gen/openapi.yaml`.
>
> **Excluded by design** (will not be closed in this fork):
> - Instance `STORAGE` setting backend API + dynamic `supportedStorageTypes` frontend rendering
> - SSE endpoint on Cloudflare Worker (CF streaming is not compatible with long-lived SSE)

---

## 1) Database schema differences

### 1.1 Table-level comparison (`migrations/0001_initial.sql` vs `store/migration/sqlite/LATEST.sql`)

The 9 original business tables are **structurally identical** across both branches (column names, types, constraints, and defaults match):

`system_setting`, `user`, `user_setting`, `memo`, `memo_relation`, `attachment`, `idp`, `inbox`, `reaction`, `memo_share`

### 1.2 Tables exclusive to `golang` (not yet in `master`)

| Table | Purpose |
| --- | --- |
| `user_identity` | Stores linked SSO / OAuth2 identities per user; supports the new `linkedIdentities` REST endpoints |

`user_identity` schema in `golang`:
```sql
CREATE TABLE user_identity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  provider   TEXT    NOT NULL,
  extern_uid TEXT    NOT NULL,
  created_ts BIGINT  NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT  NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE (provider, extern_uid),
  UNIQUE (user_id, provider)
);
CREATE INDEX idx_user_identity_user_id ON user_identity(user_id);
```

### 1.3 Tables exclusive to `master`

| Table | Purpose |
| --- | --- |
| `schema_migrations(version INTEGER PK)` | Node incremental migration bookkeeping; not present in `golang` |

### 1.4 DDL-level differences (non-semantic)

| Difference | `master` | `golang` |
| --- | --- | --- |
| `CREATE TABLE` guard | `CREATE TABLE IF NOT EXISTS` | `CREATE TABLE` |
| Index guard | `CREATE INDEX IF NOT EXISTS` | `CREATE INDEX` |

### 1.5 Migration mechanism

| Item | `master` | `golang` |
| --- | --- | --- |
| Evolution model | Incremental `migrations/NNNN_*.sql` files | `store/migration/sqlite/*` version dirs + `LATEST.sql` |
| Version tracking | Writes explicit `schema_migrations` records | No equivalent table |

---

## 2) Backend API differences (`server/routes/v1` vs `golang`)

> Reference: `golang:proto/gen/openapi.yaml` (auto-generated from proto definitions).

### 2.1 Missing endpoints in `master`

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/sse` | SSE endpoint exists in `master` but only for **Node.js** (`enableSSE: true`). CF Worker does not mount it (streaming incompatible). `golang` has it unconditionally. |
| `POST` | `/api/v1/ai:transcribe` | AI audio transcription via instance AI provider. Requires `AIService` and `instance/settings/AI` configuration. **Not implemented** in `master`. |
| `GET` | `/api/v1/users/{user}/linkedIdentities` | List linked SSO identities for a user. Requires the `user_identity` table (see §1.2). **Not implemented** in `master`. |
| `GET` | `/api/v1/users/{user}/linkedIdentities/{linkedIdentity}` | Get a specific linked SSO identity. **Not implemented** in `master`. |
| `DELETE` | `/api/v1/users/{user}/linkedIdentities/{linkedIdentity}` | Unlink a specific SSO identity. **Not implemented** in `master`. |

> **Note:** `GET /api/v1/users/{user}:getStats` **is implemented** in `master` (handled inside the wildcard `GET /users/:username` handler via suffix matching), despite not being a named route.

### 2.2 Path differences (master deviates from golang contract)

| Resource | `master` path | `golang` / OpenAPI path | Impact |
| --- | --- | --- | --- |
| Instance settings (GET) | `GET /api/v1/instance/settings/{KEY}` | `GET /api/v1/{name=instance/settings/*}` | Both resolve to the same effective path; `master` uses a simpler param extraction. |
| Instance settings (PATCH) | `PATCH /api/v1/instance/settings/{KEY}` | `PATCH /api/v1/{setting.name=instance/settings/*}` | Same as above. |

### 2.3 Semantic / field differences in existing routes

| Module | `master` behavior | `golang` behavior |
| --- | --- | --- |
| **Instance `STORAGE` setting** | Returns extra `supportedStorageTypes` (dynamic, includes `R2`) | Fixed enum `DATABASE/LOCAL/S3`; no dynamic field — **excluded by design** |
| **Instance `AI` setting** | `instance/settings/AI` key is **not persisted** (no backend handler) | Full `AIService` + AI instance settings (`InstanceSetting_Key.AI`) |
| **Memo `filter` / CEL** | Subset implementation in `server/lib/memo-filter.ts` (covers common patterns used by the web client: creator, visibility, tag, pinned, time range, content.contains) | Full CEL compilation semantics |
| **API transport** | `web/src/connect.ts` implements a **custom REST client** (~1110 lines) that translates gRPC-style service calls into plain JSON REST calls | `web/src/connect.ts` uses **Connect gRPC/protocol transport** via `@connectrpc/connect-web` (~203 lines); native binary+JSON Connect protocol |

### 2.4 Resolved gaps

| Module | Status |
| --- | --- |
| Auth endpoints (`/signin`, `/signout`, `/refresh`, `/me`) | ✅ Fully aligned |
| User CRUD, PAT, webhook, notification, shortcut endpoints | ✅ Fully aligned |
| Memo CRUD, comments, reactions, relations, shares | ✅ Fully aligned |
| `DELETE /memos/{memo}` soft-delete / `?force=true` | ✅ Aligned — archives by default; `?force=true` hard-deletes |
| Attachment CRUD, `batchDelete`, `motionMedia` field | ✅ Fully aligned |
| `POST /api/v1/users:batchGet` | ✅ Implemented |
| Identity provider CRUD | ✅ Fully aligned |
| GENERAL settings persistence (`additionalScript`, `additionalStyle`, `customProfile`, `weekStartDayOffset`) | ✅ Fixed |
| **Memo `name` field** | ✅ Uses `"memos/{uid}"` (UUID v4 from `memo.uid` column) — aligned with golang |
| **`PATCH /memos/{memo}` updateMask** | ✅ `updateMask` is now required in the request body; server applies only the paths listed |
| **`GET /memos` `showDeleted` param** | ✅ `showDeleted=true` (or `show_deleted=true`) sets state to ARCHIVED — aligned with golang |
| **`PATCH /users/{user}/settings/{setting}` updateMask** | ✅ Already enforced — rejects empty updateMask |
| **MCP endpoint** | ✅ Implemented at `POST/GET/DELETE /mcp` (Streamable HTTP transport) in `server/routes/mcp.ts` |

---

## 3) Frontend differences (`web/`)

### 3.1 Pages (`web/src/pages/`)

All 14 pages exist in both branches. The following pages have notable differences:

| Page | Nature of change in `master` vs `golang` |
| --- | --- |
| `SignIn.tsx` | `master` adds SSO sign-in form and extra UI (~87 lines); `golang` baseline is simpler |
| `MemoDetail.tsx` | `master` has sidebar/layout changes (~69 lines) |
| `Setting.tsx` | `golang` adds **AI** settings section and `LinkedIdentitySection`; `master` is missing these |
| `AuthCallback.tsx` | Minor differences (~13 lines) |
| `Inboxes.tsx` | Minor additions in `master` (~4 lines) |

### 3.2 Components present in `master` but NOT in `golang`

| Component | Notes |
| --- | --- |
| `MemoAttachment.tsx` | Single-attachment display (audio inline; other files show icon + filename) |
| `MemoResource.tsx` | Wraps `MemoAttachment` to flat-render a memo's attachment list |
| `SsoSignInForm.tsx` | SSO sign-in form component |
| `MemoActionMenu/MemoShareImageDialog.tsx` | Share-as-image dialog |
| `MemoActionMenu/MemoShareImagePreview.tsx` | Image preview for sharing |
| `MemoActionMenu/memoShareImage.ts` | Share image generation logic |
| `MemoContent/constants.ts` | Content rendering constants |
| `MemoEditor/hooks/useVoiceRecorder.ts` | Voice recorder hook (master equivalent of golang's `useAudioRecorder` + `useAudioWaveform`; all three now coexist) |
| `MemoEditor/services/` (6 files) | Service layer: cache, error, memo, upload, validation, index |
| `MemoEditor/state/` (5 files) | State management: actions, context, index, reducer, types |

### 3.3 Components present in `golang` but NOT in `master`

| Component | Notes |
| --- | --- |
| `Settings/AISection.tsx` | AI provider configuration panel (maps to `instance/settings/AI`); absent in `master` |
| `Settings/LinkedIdentitySection.tsx` | Lists and manages linked SSO identities per user; depends on `linkedIdentities` API (§2.1) |
| `Settings/InfoChip.tsx` | Reusable badge/chip used by `LinkedIdentitySection` and `SSOSection` |
| `router/guards.tsx` | Route guard components: `LandingRoute`, `RequireAuthRoute`, `RequireGuestRoute`; `golang` extracts them into a dedicated file and uses nested `<Outlet>` guards; `master` applies them inline in the router config |
| `helpers/sso-display.ts` | Utility functions for SSO provider display (`getIdentityProviderTypeLabel`, `getOAuth2SummaryItems`, etc.); used by the enhanced `SSOSection` |

### 3.4 Components that differ between branches

| Component | Difference |
| --- | --- |
| `Settings/SSOSection.tsx` | `golang` imports `InfoChip`, `sso-display` utilities, and uses structured row data (`IdentityProviderRow`) with error handling; `master` version is simpler |
| `Settings/MyAccountSection.tsx` | `golang` adds **delete-account** functionality and renders `LinkedIdentitySection`; `master` shows only PAT + password change |
| `router/index.tsx` | `golang` exports `routeConfig` array for testing, uses `RequireAuthRoute`/`RequireGuestRoute` guards, and eagerly imports `Home`; `master` uses lazy imports for all routes without explicit auth guards |
| `web/src/App.tsx` | `golang` adds `cleanupExpiredOAuthState()` on mount; `master` does not |

### 3.5 Realtime refresh (SSE)

The `/api/v1/sse` endpoint is mounted in `master` **Node.js only** (via `enableSSE: true`). CF Worker does not expose SSE. `golang` exposes it unconditionally.

---

## 4) Runtime / deployment differences

| Area | `master` | `golang` |
| --- | --- | --- |
| Frontend static hosting | Worker `ASSETS` binding / Node local static dir (`dist/public/`) | Built-in Echo fileserver |
| Primary DB | Node → SQLite; Worker → D1 (Cloudflare) | Single runtime (SQLite / PostgreSQL / MySQL via driver) |
| Object storage | `DATABASE / LOCAL / S3 / R2` | `DATABASE / LOCAL / S3` (no R2) |
| Realtime (SSE) | Node.js only; CF Worker excluded | Unconditionally available |
| MCP | ✅ Implemented at `/mcp` (Streamable HTTP, stateless per-request) | `server/router/mcp/*` (stateful sessions) |
| Frontend API transport | Custom REST client in `connect.ts` | Connect gRPC/protocol via `@connectrpc/connect-web` |

---

## 5) CI / Quality gates

| Item | Notes |
| --- | --- |
| GitHub Actions CI | `.github/workflows/ci.yml` runs type-check, tests, and uploads coverage to Codecov on every push/PR targeting `master` |
| Branch protection | Merging to `master` requires CI to pass |
