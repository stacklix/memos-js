# 当前分支（`master`）vs `golang` 分支：剩余差异

> 更新时间：2026-04-29。对照基线：`master` vs `golang@9bf648ac`（v0.28.0）。
> REST API 契约参考：[https://usememos.com/docs/api/0-28-0](https://usememos.com/docs/api/0-28-0) 及 `golang:proto/gen/openapi.yaml`。
>
> **设计排除项**（本 fork 不计划对齐）：
> - Instance `STORAGE` 设置后端 API + 动态 `supportedStorageTypes` 前端渲染
> - Cloudflare Worker 上的 SSE 接口（CF 流式传输与长连接 SSE 不兼容）

---

## 1) 数据库表结构差异

### 1.1 表级对比（`migrations/0001_initial.sql` vs `store/migration/sqlite/LATEST.sql`）

原有 9 张业务表**结构完全相同**（列名、类型、约束、默认值均一致）：

`system_setting`、`user`、`user_setting`、`memo`、`memo_relation`、`attachment`、`idp`、`inbox`、`reaction`、`memo_share`

### 1.2 仅 `golang` 存在的表（`master` 尚未添加）

| 表 | 用途 |
| --- | --- |
| `user_identity` | 存储每个用户的已关联 SSO / OAuth2 身份；支持新增的 `linkedIdentities` REST 接口 |

`golang` 中 `user_identity` 的表结构：
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

### 1.3 仅 `master` 存在的表

| 表 | 用途 |
| --- | --- |
| `schema_migrations(version INTEGER PK)` | Node 递增迁移版本记录，`golang` 无此表 |

### 1.4 DDL 层差异（非结构语义）

| 差异 | `master` | `golang` |
| --- | --- | --- |
| `CREATE TABLE` 保护 | `CREATE TABLE IF NOT EXISTS` | `CREATE TABLE` |
| 索引保护 | `CREATE INDEX IF NOT EXISTS` | `CREATE INDEX` |

### 1.5 迁移机制差异

| 项目 | `master` | `golang` |
| --- | --- | --- |
| 演进方式 | 递增 `migrations/NNNN_*.sql` 文件 | `store/migration/sqlite/*` 版本目录 + `LATEST.sql` |
| 版本追踪 | 显式写入 `schema_migrations` 记录 | 无等价表 |

---

## 2) 后端 API 差异（`server/routes/v1` 对照 `golang`）

> 参考：`golang:proto/gen/openapi.yaml`（由 proto 定义自动生成）。

### 2.1 `master` 中缺少的接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/v1/sse` | SSE 接口在 `master` 中**仅 Node.js** 可用（`enableSSE: true`）；CF Worker 不挂载（流式传输不兼容）。`golang` 无条件提供。 |

> **注：** `GET /api/v1/users/{user}:getStats` **已在 `master` 中实现**（通过通配路由 `GET /users/:username` 按后缀匹配分发），只是未作为独立命名路由注册。

### 2.2 路径差异（`master` 与 golang 契约不一致）

| 资源 | `master` 路径 | `golang` / OpenAPI 路径 | 影响 |
| --- | --- | --- | --- |
| 实例设置（读） | `GET /api/v1/instance/settings/{KEY}` | `GET /api/v1/{name=instance/settings/*}` | 两者实际解析路径相同，`master` 使用更简洁的参数提取方式 |
| 实例设置（写） | `PATCH /api/v1/instance/settings/{KEY}` | `PATCH /api/v1/{setting.name=instance/settings/*}` | 同上 |

### 2.3 已有接口的语义/字段差异

| 模块 | `master` 行为 | `golang` 行为 |
| --- | --- | --- |
| **Instance `STORAGE` 设置** | 额外返回 `supportedStorageTypes`（动态，含 `R2`） | 固定枚举 `DATABASE/LOCAL/S3`，无动态字段 — **设计排除** |
| **Instance `AI` 设置** | `instance/settings/AI` 键已持久化；完整 `AIService` + AI 提供商配置；`POST /api/v1/ai:transcribe` 已实现（已对齐） | 完整 `AIService` + AI 实例设置（`InstanceSetting_Key.AI`） |
| **Memo `filter` / CEL** | `server/lib/memo-filter.ts` 子集实现（覆盖 Web 客户端常用模式：creator、visibility、tag、pinned、时间范围、content.contains） | 完整 CEL 编译语义 |
| **API 传输层** | `web/src/connect.ts` 实现**自定义 REST 客户端**（约 1110 行），将 gRPC 风格的服务调用翻译为普通 JSON REST 请求 | `web/src/connect.ts` 通过 `@connectrpc/connect-web` 使用 **Connect gRPC/协议传输**（约 203 行）；原生 binary+JSON Connect 协议 |

### 2.4 已对齐项

| 模块 | 状态 |
| --- | --- |
| 认证接口（`/signin`、`/signout`、`/refresh`、`/me`） | ✅ 完全对齐 |
| 用户 CRUD、PAT、Webhook、通知、快捷方式接口 | ✅ 完全对齐 |
| Memo CRUD、评论、反应、关联、分享接口 | ✅ 完全对齐 |
| `DELETE /memos/{memo}` 软删除 / `?force=true` | ✅ 已对齐 — 默认归档；`?force=true` 硬删除 |
| Attachment CRUD、`batchDelete`、`motionMedia` 字段 | ✅ 完全对齐 |
| `POST /api/v1/users:batchGet` | ✅ 已实现 |
| 身份提供商 CRUD | ✅ 完全对齐 |
| GENERAL 设置持久化（`additionalScript`、`additionalStyle`、`customProfile`、`weekStartDayOffset`） | ✅ 已修复 |
| **Memo `name` 字段** | ✅ 已使用 `"memos/{uid}"`（UUID v4，来自 `memo.uid` 列）— 与 golang 对齐 |
| **`PATCH /memos/{memo}` updateMask** | ✅ 请求体现在必须包含 `updateMask`；服务端仅应用指定路径的字段 |
| **`GET /memos` `showDeleted` 参数** | ✅ `showDeleted=true`（或 `show_deleted=true`）将 state 设为 ARCHIVED — 与 golang 对齐 |
| **`PATCH /users/{user}/settings/{setting}` updateMask** | ✅ 已强制校验 — 空 updateMask 会返回错误 |
| **MCP 接口** | ✅ 已在 `server/routes/mcp.ts` 实现，挂载于 `POST/GET/DELETE /mcp`（Streamable HTTP 传输） |
| **`user_identity` 表** | ✅ 已通过 `migrations/0002_user_identity.sql` 添加 |
| **`POST /api/v1/ai:transcribe`** | ✅ 已在 `server/routes/v1/ai.ts` 实现；读取 `instance/settings/AI` 中的 AI 提供商配置 |
| **`GET/DELETE /api/v1/users/{user}/linkedIdentities[/{id}]`** | ✅ 已在 `server/routes/v1/users.ts` 实现 |
| **Instance `AI` 设置持久化** | ✅ `instance/settings/AI` 键已持久化并通过 `server/lib/instance-ai-setting.ts` 提供服务 |

---

## 3) 前端差异（`web/`）

### 3.1 页面（`web/src/pages/`）

两个分支均有全部 14 个页面。以下页面在两分支之间有显著差异：

| 页面 | `master` vs `golang` 差异性质 |
| --- | --- |
| `SignIn.tsx` | `master` 新增 SSO 登录表单及额外 UI（约 87 行）；`golang` 基线更简洁 |
| `MemoDetail.tsx` | `master` 有侧边栏/布局调整（约 69 行） |
| `Setting.tsx` | `golang` 新增 **AI** 设置区块和 `LinkedIdentitySection`；`master` 缺少这些 |
| `AuthCallback.tsx` | 小幅差异（约 13 行） |
| `Inboxes.tsx` | `master` 小幅新增（约 4 行） |

### 3.2 仅 `master` 存在的组件（master 独有扩展）

| 组件 | 说明 |
| --- | --- |
| `MemoAttachment.tsx` | 单条附件展示（音频内联播放；其他文件显示图标+文件名） |
| `MemoResource.tsx` | 组合 `MemoAttachment`，将 Memo 附件列表平铺渲染 |
| `SsoSignInForm.tsx` | SSO 登录表单组件 |
| `MemoActionMenu/MemoShareImageDialog.tsx` | 分享为图片弹窗 |
| `MemoActionMenu/MemoShareImagePreview.tsx` | 分享图片预览 |
| `MemoActionMenu/memoShareImage.ts` | 分享图片生成逻辑 |
| `MemoContent/constants.ts` | 内容渲染常量 |
| `MemoEditor/hooks/useVoiceRecorder.ts` | 语音录制 Hook（与 golang 的 `useAudioRecorder` + `useAudioWaveform` 并存） |
| `MemoEditor/services/`（6 个文件） | 服务层：cache、error、memo、upload、validation、index |
| `MemoEditor/state/`（5 个文件） | 状态管理：actions、context、index、reducer、types |

### 3.3 仅 `golang` 存在的组件（`master` 缺少）

所有 `golang` 独有组件均已添加至 `master`：

| 组件 | 状态 |
| --- | --- |
| `Settings/AISection.tsx` | ✅ 已添加 — AI 提供商配置面板（对应 `instance/settings/AI`） |
| `Settings/LinkedIdentitySection.tsx` | ✅ 已添加 — 列出并管理用户已关联的 SSO 身份 |
| `Settings/InfoChip.tsx` | ✅ 已添加 — 可复用 badge/chip 组件 |
| `router/guards.tsx` | ✅ 已添加 — `LandingRoute`、`RequireAuthRoute`、`RequireGuestRoute` 路由守卫组件 |
| `helpers/sso-display.ts` | ✅ 已添加 — SSO 提供商展示工具函数 |

### 3.4 两分支之间有差异的组件

所有此前存在差异的组件均已与 `golang` 对齐：

| 组件 | 状态 |
| --- | --- |
| `Settings/SSOSection.tsx` | ✅ 已对齐 — 引入 `InfoChip`、`sso-display` 工具函数，使用 `IdentityProviderRow` 并增加错误处理 |
| `Settings/MyAccountSection.tsx` | ✅ 已对齐 — 新增删除账号功能并渲染 `LinkedIdentitySection` |
| `router/index.tsx` | ✅ 已对齐 — 使用 `RequireAuthRoute`/`RequireGuestRoute` 守卫；导出 `routeConfig` |
| `web/src/App.tsx` | ✅ 已对齐 — 在挂载时调用 `cleanupExpiredOAuthState()` |

### 3.5 实时刷新（SSE）

`/api/v1/sse` 接口在 `master` 中**仅 Node.js** 可用（`enableSSE: true`）；CF Worker 不挂载。`golang` 无条件提供。

---

## 4) 运行时 / 部署差异

| 领域 | `master` | `golang` |
| --- | --- | --- |
| 前端静态资源托管 | Worker `ASSETS` 绑定 / Node 本地静态目录（`dist/public/`） | echo 内置文件服务器 |
| 主数据库 | Node → SQLite；Worker → D1（Cloudflare） | 单一运行时（SQLite / PostgreSQL / MySQL） |
| 对象存储 | `DATABASE / LOCAL / S3 / R2` | `DATABASE / LOCAL / S3`（无 R2） |
| 实时推送（SSE） | 仅 Node.js；CF Worker 排除 | 无条件可用 |
| MCP 接口 | ✅ 已实现，挂载于 `/mcp`（无状态逐请求模式） | `server/router/mcp/*`（有状态会话模式） |
| 前端 API 传输层 | `connect.ts` 自定义 REST 客户端 | 通过 `@connectrpc/connect-web` 的 Connect gRPC/协议传输 |

---

## 5) CI / 质量门禁

| 项目 | 说明 |
| --- | --- |
| GitHub Actions CI | `.github/workflows/ci.yml` 在每次推送及 PR 到 `master` 时执行类型检查、测试，并将覆盖率上报至 Codecov |
| 分支保护 | 合并到 `master` 须 CI 通过 |
