# Current Branch (`master`) vs `golang` Branch: Gap List

> Baseline: `master` (2026-04-12) vs `golang@40fd700f` (2026-04-12).
> REST API contract reference: [https://usememos.com/docs/api/latest](https://usememos.com/docs/api/latest) and `golang:proto/gen/openapi.yaml`.

---

## 1) Database schema differences

### 1.1 Table-level comparison (`migrations/0001_initial.sql` vs `store/migration/sqlite/LATEST.sql`)

All 9 business tables are **structurally identical** across both branches (column names, types, constraints, and defaults match):

`system_setting`, `user`, `user_setting`, `memo`, `memo_relation`, `attachment`, `idp`, `inbox`, `reaction`, `memo_share`

### 1.2 Tables exclusive to `master`

| Table | Purpose |
| --- | --- |
| `schema_migrations(version INTEGER PK)` | Node incremental migration bookkeeping; not present in `golang` |

### 1.3 DDL-level differences (non-semantic)

| Difference | `master` | `golang` |
| --- | --- | --- |
| `CREATE TABLE` guard | `CREATE TABLE IF NOT EXISTS` | `CREATE TABLE` |
| Index guard | `CREATE INDEX IF NOT EXISTS` | `CREATE INDEX` |

### 1.4 Migration mechanism

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
| `POST` | `/api/v1/users:batchGet` | Request: `{ "usernames": ["users/alice"] }`; Response: `{ "users": [...] }`. Returns up to 100 active users. |
| `POST` | `/api/v1/attachments:batchDelete` | Request: `{ "names": ["attachments/uid1"] }`; Response: `{}`. Deletes multiple attachments in one call. |
| `GET` | `/api/v1/sse` | Server-Sent Events endpoint for real-time push. Registered outside of Connect/gRPC; not in OpenAPI spec. Frontend may rely on it for live updates. |

> **Note:** `GET /api/v1/users/{user}:getStats` **is implemented** in `master` (handled inside the wildcard `GET /users/:username` handler via suffix matching), despite not being a named route.

### 2.2 Path differences (master deviates from golang contract)

| Resource | `master` path | `golang` / OpenAPI path | Impact |
| --- | --- | --- | --- |
| Instance settings (GET) | `GET /api/v1/instance/settings/{KEY}` | `GET /api/v1/instance/{instance}/*` | Master path is shorter by one segment. Golang clients would 404 against master; vice versa. |
| Instance settings (PATCH) | `PATCH /api/v1/instance/settings/{KEY}` | `PATCH /api/v1/instance/{instance}/*` | Same as above. |

### 2.3 Semantic / field differences in existing routes

| Module | `master` behavior | `golang` behavior |
| --- | --- | --- |
| **Memo `name` field** | `"memos/{integer_id}"` (e.g. `memos/42`) | `"memos/{uid}"` (e.g. `memos/01HX...`) — uses the `uid` text column |
| **`PATCH /memos/{memo}`** | Applies any fields present in body; ignores `updateMask` | Requires `updateMask` query param (FieldMask) |
| **`DELETE /memos/{memo}`** | Always cascades; no `force` param | Supports optional `?force=true` query param |
| **`GET /memos` list params** | `pageSize`, `pageToken`, `filter`, `orderBy` | Same, plus `state` (enum) and `showDeleted` (bool) |
| **`PATCH /users/{user}/settings/{setting}`** | Applies all fields in body | Requires `updateMask` query param |
| **Attachment `motionMedia` field** | Not serialized in `attachmentToJson()` | Present in golang schema (`MotionMedia` object for Google Motion Photos) |
| **Instance `STORAGE` setting** | Returns extra `supportedStorageTypes` (dynamic, includes `R2`) | Fixed enum `DATABASE/LOCAL/S3`; no dynamic field |
| **Memo `filter` / CEL** | Subset implementation in `server/lib/memo-filter.ts` | Full CEL compilation semantics |
| **MCP routes** | Not implemented | `server/router/mcp/*` registered on echo router |

### 2.4 Resolved gaps (already aligned)

| Module | Status |
| --- | --- |
| Auth endpoints (`/signin`, `/signout`, `/refresh`, `/me`) | ✅ Fully aligned |
| User CRUD, PAT, webhook, notification, shortcut endpoints | ✅ Fully aligned |
| Memo CRUD, comments, reactions, relations, shares | ✅ Fully aligned |
| Attachment CRUD | ✅ Fully aligned (except `batchDelete` and `motionMedia`) |
| Identity provider CRUD | ✅ Fully aligned |
| GENERAL settings persistence (`additionalScript`, `additionalStyle`, `customProfile`, `weekStartDayOffset`) | ✅ Fixed in `master` |

---

## 3) Frontend differences (`web/`)

### 3.1 Pages (`web/src/pages/`)

All 14 pages exist in both branches. The following pages have notable behavioral/UI changes:

| Page | Nature of change in `master` |
| --- | --- |
| `Attachments.tsx` | Major refactor of attachment library UI (~200 lines changed) |
| `SignIn.tsx` | Significant UI additions (~87 lines added) |
| `MemoDetail.tsx` | Sidebar/layout changes (~69 lines) |
| `Setting.tsx` | Settings panel changes (~29 lines) |
| `AuthCallback.tsx` | Minor changes (~13 lines) |
| `Inboxes.tsx` | Minor additions (~4 lines) |

### 3.2 Components present in `master` but NOT in `golang`

| Component | Notes |
| --- | --- |
| `MemoAttachment.tsx` | Single-attachment display (audio inline; other files show icon + filename) |
| `MemoResource.tsx` | Wraps `MemoAttachment` to flat-render a memo's attachment list |
| `SsoSignInForm.tsx` | SSO sign-in form component |
| `MemoActionMenu/MemoShareImageDialog.tsx` | Share-as-image dialog |
| `MemoActionMenu/MemoShareImagePreview.tsx` | Image preview for sharing |
| `MemoActionMenu/memoShareImage.ts` | Share image generation logic |
| `MemoContent/ConditionalComponent.tsx` | Conditional rendering helper |
| `MemoContent/Mention.tsx` | @mention rendering |
| `MemoContent/MentionResolutionContext.tsx` | Mention resolution context |
| `MemoContent/TrustedIframe.ts` | Sandboxed iframe support |
| `MemoContent/constants.ts` | Content rendering constants |
| `MemoEditor/hooks/useVoiceRecorder.ts` | Voice recorder hook (replaces `useAudioRecorder` + `useAudioWaveform` from golang) |
| `MemoEditor/services/` (6 files) | Service layer: cache, error, memo, upload, validation, index |
| `MemoEditor/state/` (5 files) | State management: actions, context, index, reducer, types |

### 3.3 Components present in `golang` but NOT in `master`

| Component | Notes |
| --- | --- |
| `AttachmentLibrary/` | Attachment management library component (folder with multiple files) |
| `MotionPhotoPlayer.tsx` | Google Motion Photo video playback |
| `MotionPhotoPreview.tsx` | Motion Photo preview/thumbnail |
| `MemoEditor/hooks/useAudioRecorder.ts` | Audio recorder hook (master uses `useVoiceRecorder.ts` instead) |
| `MemoEditor/hooks/useAudioWaveform.ts` | Waveform visualization hook |

### 3.4 Realtime refresh (SSE)

Frontend in both branches may expect realtime updates. The `/api/v1/sse` backend endpoint exists in `golang` but is **absent** in `master`.

---

## 4) Runtime / deployment differences

| Area | `master` | `golang` |
| --- | --- | --- |
| Frontend static hosting | Worker `ASSETS` binding / Node local static dir (`dist/public/`) | Built-in Echo fileserver |
| Primary DB | Node → SQLite; Worker → D1 (Cloudflare) | Single runtime (SQLite / PostgreSQL / MySQL via driver) |
| Object storage | `DATABASE / LOCAL / S3 / R2` | `DATABASE / LOCAL / S3` (no R2) |
| Realtime | SSE absent | `GET /api/v1/sse` present |
| MCP | Absent | `server/router/mcp/*` |

---

## 5) CI / Quality gates

| Item | Notes |
| --- | --- |
| GitHub Actions CI | `.github/workflows/ci.yml` runs type-check, tests, and uploads coverage to Codecov on every push/PR targeting `master` |
| Branch protection | Merging to `master` requires CI to pass |
