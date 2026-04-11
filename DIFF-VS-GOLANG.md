# Current Branch vs `golang` Branch: Gap List

> Baseline: current workspace (`master`) vs `golang@f403f8c03c1186d7d4b7a6f2e03d7bca6ffcec21` (2026-04-06).

---

## 1) Frontend gaps (`web/`)

| Area | Gap |
| --- | --- |
| Memo list / explore / archive / user pages | `filter` semantics are a subset implementation; complex expressions are not fully compatible with `golang` |
| Memo detail and attachment-related behavior | Attachment filter syntax is still a subset and does not fully cover CEL semantics |
| Realtime refresh (SSE) | Frontend expects realtime updates, but backend lacks `/api/v1/sse` |

### 1.1 Added components (parity with `golang`)

| Component | Notes |
| --- | --- |
| `web/src/components/MemoAttachment.tsx` | Single-attachment display component (audio inline, other files show icon + filename); matches `golang` component |
| `web/src/components/MemoResource.tsx` | Wraps `MemoAttachment` to render a flat list of attachments for a memo |

---

## 2) Backend gaps (`server/routes/v1` vs `golang`)

### 2.1 Missing route/service coverage

| Category | Gap |
| --- | --- |
| SSE | Missing `/api/v1/sse` equivalent |
| MCP | Missing `server/router/mcp/*` equivalent routes |

### 2.2 Semantic differences in existing routes

| Module | Gap |
| --- | --- |
| Memo query filtering | `server/lib/memo-filter.ts` is subset-based; complex CEL expressions are not fully compatible |
| Attachment behavior | Attachment `filter` does not fully cover CEL compilation semantics; EXIF stripping currently only covers JPEG |
| Instance storage settings | `GET /instance/settings/STORAGE` returns extra `supportedStorageTypes` and supports runtime-pruned options including `R2`; `golang` uses fixed enum (`DATABASE/LOCAL/S3`) and has no such dynamic field |

### 2.3 Resolved gaps

| Module | Fix |
| --- | --- |
| GENERAL settings | `additionalScript`, `additionalStyle`, `customProfile`, and `weekStartDayOffset` are now persisted and returned correctly by both `GET` and `PATCH /api/v1/instance/settings/GENERAL` |

---

## 3) Database design differences

### 3.1 Schema differences (`migrations/0001_initial.sql` vs `store/migration/sqlite/LATEST.sql`)

| Item | Gap |
| --- | --- |
| `schema_migrations` | Exists only in this branch (for incremental Node migrations); not present in `golang` baseline |

### 3.2 Migration mechanism differences (implementation)

| Item | Gap |
| --- | --- |
| SQLite evolution model | `golang` uses `store/migration/sqlite/*` + `LATEST.sql`; this branch uses incremental `migrations/NNNN_*.sql` |
| Migration version tracking | This branch writes explicit `schema_migrations` records (`0001` inserts version 1); `golang` does not rely on this table |

---

## 4) External/runtime dependency differences (runtime & deployment)

| Dependency area | Gap |
| --- | --- |
| Frontend static hosting | `golang` uses built-in fileserver; this branch uses Worker `ASSETS` / Node local static directory |
| Primary DB runtime model | `golang` has a single runtime model; this branch is dual-backend Node (SQLite) + Worker (D1) |
| Object storage chain | `golang` is primarily S3-oriented; this branch uses `DB/LOCAL/S3/R2`, and cross-backend behavior (especially filter and image-processing coverage) still needs more verification |
| Realtime channel | `golang` has SSE; this branch is missing SSE routes |
| MCP external API | `golang` has `mcp/*`; this branch has no equivalent interface |

---

## 5) CI / Quality gates

| Item | Notes |
| --- | --- |
| GitHub Actions CI | `.github/workflows/ci.yml` runs type-check, tests, and uploads coverage to Codecov on every push/PR targeting `master` |
| Branch protection | Merging to `master` requires CI to pass |
