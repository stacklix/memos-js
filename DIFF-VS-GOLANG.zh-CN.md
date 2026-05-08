# 当前分支（`master`）vs `golang` 分支：差异

> 更新时间：2026-05-06。对照基线：`master` vs `golang@9bf648ac`（v0.28.0）。
>
> **设计排除项**：
> - Instance `STORAGE` 后端 API + 动态 `supportedStorageTypes` 前端渲染
> - Cloudflare Worker 上的 SSE 接口（CF 流式传输与长连接 SSE 不兼容）

---

## 1) 数据库表结构

### `user_identity` 表

`golang@9bf648ac` 在 `store/migration/sqlite/LATEST.sql` 中有 `user_identity`。`master` 通过 `migrations/0002_user_identity.sql` 提供等价实现：

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

### 迁移机制

| | `master` | `golang` |
|---|---|---|
| 演进方式 | 递增 `migrations/NNNN_*.sql` 文件 | `store/migration/sqlite/*` 版本目录 + `LATEST.sql` |
| 版本追踪 | `schema_migrations` 表 | 无 |

### DDL 保护

`master` 使用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`。`golang` 使用原始 `CREATE TABLE` / `CREATE INDEX`。

---

## 2) 后端 API（`server/routes/v1`）

### API 传输策略

`master` 使用**自定义 REST** — `web/src/connect.ts`（约 1110 行）将 gRPC 风格服务调用转换为普通 JSON REST。

`golang` 使用 **Connect gRPC** via `@connectrpc/connect-web`（约 203 行）；原生 binary+JSON Connect 协议。

### `master` 中缺少的接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/sse` | 仅 Node.js（`enableSSE: true`）；CF Worker 不支持 |

### 路径差异

| 资源 | `master` 路径 | `golang` 路径 |
|---|---|---|
| 实例设置（读） | `GET /api/v1/instance/settings/{KEY}` | `GET /api/v1/{name=instance/settings/*}` |
| 实例设置（写） | `PATCH /api/v1/instance/settings/{KEY}` | `PATCH /api/v1/{setting.name=instance/settings/*}` |

### 语义差异

| 模块 | `master` | `golang` |
|---|---|---|
| **Instance `STORAGE`** | 动态 `supportedStorageTypes` 包含 `R2` | 固定枚举 `DATABASE/LOCAL/S3` — **设计排除** |
| **Memo `filter` / CEL** | `server/lib/memo-filter.ts` 子集实现 | 完整 CEL 编译语义 |

---

## 3) 前端（`web/`）

### 有差异的页面（`web/src/pages/`）

| 页面 | 差异 |
|---|---|
| `SignIn.tsx` | `master` 委托给 `SsoSignInForm` 组件；golang 原有内联 SSO 逻辑（约 84 行） |
| `MemoDetail.tsx` | `master` 移除 `MentionResolutionProvider`、`shareImageDialogOpen` 状态、`onShareImageOpen` 属性（约 69 行） |
| `Setting.tsx` | `master` 新增 `ai` 区块及 `AISection`；golang 原有更简单的设置结构 |
| `AuthCallback.tsx` | `ssoCredentials` 对象 vs golang 的 `credentials.case/value` 结构（约 13 行） |
| `Inboxes.tsx` | `master` 移除 `MemoMentionMessage`（约 4 行） |
| `SignUp.tsx` | `passwordCredentials` 对象 vs golang 的 `credentials.case/value`（约 5 行） |

### `master` 独有组件

| 组件 | 说明 |
|---|---|
| `MemoAttachment.tsx` | 单条附件展示 |
| `MemoResource.tsx` | 平铺渲染 Memo 附件列表 |
| `SsoSignInForm.tsx` | SSO 登录表单 |
| `MemoActionMenu/MemoShareImageDialog.tsx` | 分享为图片弹窗 |
| `MemoActionMenu/MemoShareImagePreview.tsx` | 图片预览 |
| `MemoActionMenu/memoShareImage.ts` | 分享图片生成逻辑 |
| `MemoContent/constants.ts` | 内容渲染常量 |
| `MemoEditor/hooks/useVoiceRecorder.ts` | 语音录制 Hook |
| `MemoEditor/services/`（6 个文件） | 服务层 |
| `MemoEditor/state/`（5 个文件） | 状态管理 |

---

## 4) 运行时 / 部署

| | `master` | `golang` |
|---|---|---|
| 前端静态托管 | Worker `ASSETS` / Node `dist/public/` | Echo 文件服务器 |
| 主数据库 | Node → SQLite；Worker → D1（CF） | SQLite / PostgreSQL / MySQL |
| 对象存储 | `DATABASE / LOCAL / S3 / R2` | `DATABASE / LOCAL / S3`（无 R2） |
| SSE | 仅 Node.js | 无条件可用 |
| MCP | `/mcp` 无状态模式 | 有状态会话模式 |

---

## 5) golang 基线后新提交（9bf648ac → 40fd700f）

`golang` 中尚未进入 `master` 的新变更：

- `fix(fileserver): render SVG attachment previews`
- `fix: remove duplicate Japanese locale keys`
- `i18n: refine and normalize Japanese locale strings`
- `chore(web): improve navigation accessibility`
- `fix(frontend): restore sitemap and robots routes`