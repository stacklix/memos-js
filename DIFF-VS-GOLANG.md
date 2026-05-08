# Current Branch (`master`) vs `golang` Branch: Differences

> Updated: 2026-05-06. Baseline: `master` vs `golang@9bf648ac` (v0.28.0).
>
> **Excluded by design**:
> - Instance `STORAGE` backend API + dynamic `supportedStorageTypes` frontend rendering
> - SSE endpoint on Cloudflare Worker (CF streaming incompatible with long-lived SSE)

---

## 1) Database Schema

### `user_identity` table

`golang@9bf648ac` has `user_identity` in `store/migration/sqlite/LATEST.sql`. `master` has equivalent via `migrations/0002_user_identity.sql`:

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

### Migration mechanism

| | `master` | `golang` |
|---|---|---|
| Evolution | Incremental `migrations/NNNN_*.sql` | `store/migration/sqlite/*` dirs + `LATEST.sql` |
| Version tracking | `schema_migrations` table | None |

### DDL guards

`master` uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. `golang` uses plain `CREATE TABLE` / `CREATE INDEX`.

---

## 2) Backend API (`server/routes/v1`)

### API transport strategy

`master` uses **custom REST** — `web/src/connect.ts` (~1110 lines) translates gRPC-style service calls into plain JSON REST.

`golang` uses **Connect gRPC** via `@connectrpc/connect-web` (~203 lines); native binary+JSON Connect protocol.

### Missing endpoints in `master`

| Method | Path | Note |
|---|---|---|
| `GET` | `/api/v1/sse` | Node.js only (`enableSSE: true`); CF Worker excluded |

### Path differences

| Resource | `master` path | `golang` path |
|---|---|---|
| Instance settings (GET) | `GET /api/v1/instance/settings/{KEY}` | `GET /api/v1/{name=instance/settings/*}` |
| Instance settings (PATCH) | `PATCH /api/v1/instance/settings/{KEY}` | `PATCH /api/v1/{setting.name=instance/settings/*}` |

### Semantic differences

| Module | `master` | `golang` |
|---|---|---|
| **Instance `STORAGE`** | Dynamic `supportedStorageTypes` includes `R2` | Fixed enum `DATABASE/LOCAL/S3` — **excluded** |
| **Memo `filter` / CEL** | Subset in `server/lib/memo-filter.ts` | Full CEL compilation |

---

## 3) Frontend (`web/`)

### Pages with differences (`web/src/pages/`)

| Page | Difference |
|---|---|
| `SignIn.tsx` | `master` delegates to `SsoSignInForm` component; golang had inline SSO logic (~84 lines) |
| `MemoDetail.tsx` | `master` removes `MentionResolutionProvider`, `shareImageDialogOpen` state, `onShareImageOpen` prop (~69 lines) |
| `Setting.tsx` | `master` adds `ai` section with `AISection`; golang had simpler structure |
| `AuthCallback.tsx` | `ssoCredentials` object vs golang's `credentials.case/value` shape (~13 lines) |
| `Inboxes.tsx` | `master` removes `MemoMentionMessage` (~4 lines) |
| `SignUp.tsx` | `passwordCredentials` object vs golang's `credentials.case/value` (~5 lines) |

### `master`-only components

| Component | Note |
|---|---|
| `MemoAttachment.tsx` | Single attachment display |
| `MemoResource.tsx` | Flat-renders memo's attachment list |
| `SsoSignInForm.tsx` | SSO sign-in form |
| `MemoActionMenu/MemoShareImageDialog.tsx` | Share-as-image dialog |
| `MemoActionMenu/MemoShareImagePreview.tsx` | Image preview |
| `MemoActionMenu/memoShareImage.ts` | Share image generation |
| `MemoContent/constants.ts` | Content rendering constants |
| `MemoEditor/hooks/useVoiceRecorder.ts` | Voice recorder hook |
| `MemoEditor/services/` (6 files) | Service layer |
| `MemoEditor/state/` (5 files) | State management |

---

## 4) Runtime / Deployment

| | `master` | `golang` |
|---|---|---|
| Frontend hosting | Worker `ASSETS` / Node `dist/public/` | Echo fileserver |
| Primary DB | Node → SQLite; Worker → D1 (CF) | SQLite / PostgreSQL / MySQL |
| Object storage | `DATABASE / LOCAL / S3 / R2` | `DATABASE / LOCAL / S3` (no R2) |
| SSE | Node.js only | Unconditional |
| MCP | Stateless at `/mcp` | Stateful sessions |

---

## 5) golang forward commits (9bf648ac → 40fd700f)

New changes in `golang` not yet in `master`:

- `fix(fileserver): render SVG attachment previews`
- `fix: remove duplicate Japanese locale keys`
- `i18n: refine and normalize Japanese locale strings`
- `chore(web): improve navigation accessibility`
- `fix(frontend): restore sitemap and robots routes`