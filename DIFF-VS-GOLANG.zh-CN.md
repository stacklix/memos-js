# 当前分支（`master`）vs `golang` 分支差异清单

> 对照基线：`master`（2026-04-12）vs `golang@40fd700f`（2026-04-12）。
> REST API 契约参考：[https://usememos.com/docs/api/latest](https://usememos.com/docs/api/latest) 及 `golang:proto/gen/openapi.yaml`。

---

## 1) 数据库表结构差异

### 1.1 表级对比（`migrations/0001_initial.sql` vs `store/migration/sqlite/LATEST.sql`）

两个分支的 9 张业务表**结构完全相同**（列名、类型、约束、默认值均一致）：

`system_setting`、`user`、`user_setting`、`memo`、`memo_relation`、`attachment`、`idp`、`inbox`、`reaction`、`memo_share`

### 1.2 仅 `master` 存在的表

| 表 | 用途 |
| --- | --- |
| `schema_migrations(version INTEGER PK)` | Node 递增迁移版本记录，`golang` 无此表 |

### 1.3 DDL 层差异（非结构语义）

| 差异 | `master` | `golang` |
| --- | --- | --- |
| `CREATE TABLE` 保护 | `CREATE TABLE IF NOT EXISTS` | `CREATE TABLE` |
| 索引保护 | `CREATE INDEX IF NOT EXISTS` | `CREATE INDEX` |

### 1.4 迁移机制差异

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
| `POST` | `/api/v1/users:batchGet` | 请求：`{ "usernames": ["users/alice"] }`；响应：`{ "users": [...] }`，最多 100 个活跃用户 |
| `POST` | `/api/v1/attachments:batchDelete` | 请求：`{ "names": ["attachments/uid1"] }`；响应：`{}`，批量删除附件 |
| `GET` | `/api/v1/sse` | 服务端推送（SSE）实时事件接口；在 golang 中以 echo 路由注册，不在 OpenAPI spec 内；前端依赖其获取实时更新 |

> **注：** `GET /api/v1/users/{user}:getStats` **已在 `master` 中实现**（通过通配路由 `GET /users/:username` 按后缀匹配分发），只是未作为独立命名路由注册。

### 2.2 路径差异（`master` 与 golang 契约不一致）

| 资源 | `master` 路径 | `golang` / OpenAPI 路径 | 影响 |
| --- | --- | --- | --- |
| 实例设置（读） | `GET /api/v1/instance/settings/{KEY}` | `GET /api/v1/instance/{instance}/*` | master 路径少一段，golang 客户端请求 master 会 404 |
| 实例设置（写） | `PATCH /api/v1/instance/settings/{KEY}` | `PATCH /api/v1/instance/{instance}/*` | 同上 |

### 2.3 已有接口的语义/字段差异

| 模块 | `master` 行为 | `golang` 行为 |
| --- | --- | --- |
| **Memo `name` 字段** | `"memos/{integer_id}"`（如 `memos/42`） | `"memos/{uid}"`（如 `memos/01HX...`），使用 `uid` 文本列 |
| **`PATCH /memos/{memo}`** | 应用请求体中所有字段，忽略 `updateMask` | 要求提供 `updateMask` 查询参数（FieldMask） |
| **`DELETE /memos/{memo}`** | 始终级联删除，无 `force` 参数 | 支持可选 `?force=true` 查询参数 |
| **`GET /memos` 列表参数** | `pageSize`、`pageToken`、`filter`、`orderBy` | 同上，另加 `state`（枚举）和 `showDeleted`（bool） |
| **`PATCH /users/{user}/settings/{setting}`** | 应用请求体所有字段 | 要求提供 `updateMask` 查询参数 |
| **Attachment `motionMedia` 字段** | `attachmentToJson()` 中未序列化 | golang schema 中存在（`MotionMedia` 对象，用于 Google Motion Photos） |
| **Instance `STORAGE` 设置** | 额外返回 `supportedStorageTypes`（动态，含 `R2`） | 固定枚举 `DATABASE/LOCAL/S3`，无动态字段 |
| **Memo `filter` / CEL** | `server/lib/memo-filter.ts` 为子集实现 | 完整 CEL 编译语义 |
| **MCP 路由** | 未实现 | golang 注册了 `server/router/mcp/*` |

### 2.4 已对齐项（已修复）

| 模块 | 状态 |
| --- | --- |
| 认证接口（`/signin`、`/signout`、`/refresh`、`/me`） | ✅ 完全对齐 |
| 用户 CRUD、PAT、Webhook、通知、快捷方式接口 | ✅ 完全对齐 |
| Memo CRUD、评论、反应、关联、分享接口 | ✅ 完全对齐 |
| Attachment CRUD | ✅ 已对齐（`batchDelete` 和 `motionMedia` 除外） |
| 身份提供商 CRUD | ✅ 完全对齐 |
| GENERAL 设置持久化（`additionalScript`、`additionalStyle`、`customProfile`、`weekStartDayOffset`） | ✅ 已在 `master` 修复 |

---

## 3) 前端差异（`web/`）

### 3.1 页面（`web/src/pages/`）

两个分支均有全部 14 个页面。以下页面在 `master` 中有显著变动：

| 页面 | master 中的变动性质 |
| --- | --- |
| `Attachments.tsx` | 附件库 UI 大幅重构（约 200 行变动） |
| `SignIn.tsx` | UI 显著新增（约 87 行） |
| `MemoDetail.tsx` | 侧边栏/布局调整（约 69 行） |
| `Setting.tsx` | 设置面板调整（约 29 行） |
| `AuthCallback.tsx` | 小幅改动（约 13 行） |
| `Inboxes.tsx` | 小幅增加（约 4 行） |

### 3.2 仅 `master` 存在的组件

| 组件 | 说明 |
| --- | --- |
| `MemoAttachment.tsx` | 单条附件展示（音频内联播放；其他文件显示图标+文件名） |
| `MemoResource.tsx` | 组合 `MemoAttachment`，将 Memo 附件列表平铺渲染 |
| `SsoSignInForm.tsx` | SSO 登录表单组件 |
| `MemoActionMenu/MemoShareImageDialog.tsx` | 分享为图片弹窗 |
| `MemoActionMenu/MemoShareImagePreview.tsx` | 分享图片预览 |
| `MemoActionMenu/memoShareImage.ts` | 分享图片生成逻辑 |
| `MemoContent/ConditionalComponent.tsx` | 条件渲染帮助组件 |
| `MemoContent/Mention.tsx` | @提及渲染 |
| `MemoContent/MentionResolutionContext.tsx` | 提及解析 Context |
| `MemoContent/TrustedIframe.ts` | 沙盒 iframe 支持 |
| `MemoContent/constants.ts` | 内容渲染常量 |
| `MemoEditor/hooks/useVoiceRecorder.ts` | 语音录制 Hook（取代 golang 中的 `useAudioRecorder` + `useAudioWaveform`） |
| `MemoEditor/services/`（6 个文件） | 服务层：cache、error、memo、upload、validation、index |
| `MemoEditor/state/`（5 个文件） | 状态管理：actions、context、index、reducer、types |

### 3.3 仅 `golang` 存在的组件

| 组件 | 说明 |
| --- | --- |
| `AttachmentLibrary/` | 附件管理库组件（含多个子文件） |
| `MotionPhotoPlayer.tsx` | Google Motion Photo 视频播放 |
| `MotionPhotoPreview.tsx` | Motion Photo 预览/缩略图 |
| `MemoEditor/hooks/useAudioRecorder.ts` | 音频录制 Hook（master 改用 `useVoiceRecorder.ts`） |
| `MemoEditor/hooks/useAudioWaveform.ts` | 波形可视化 Hook |

### 3.4 实时刷新（SSE）

两个分支的前端均可能有实时更新预期。后端 `/api/v1/sse` 接口在 `golang` 中存在，但在 `master` 中**缺失**。

---

## 4) 运行时 / 部署差异

| 领域 | `master` | `golang` |
| --- | --- | --- |
| 前端静态资源托管 | Worker `ASSETS` 绑定 / Node 本地静态目录（`dist/public/`） | echo 内置文件服务器 |
| 主数据库 | Node → SQLite；Worker → D1（Cloudflare） | 单一运行时（SQLite / PostgreSQL / MySQL） |
| 对象存储 | `DATABASE / LOCAL / S3 / R2` | `DATABASE / LOCAL / S3`（无 R2） |
| 实时推送 | SSE 缺失 | `GET /api/v1/sse` 已存在 |
| MCP 接口 | 未实现 | `server/router/mcp/*` |

---

## 5) CI / 质量门禁

| 项目 | 说明 |
| --- | --- |
| GitHub Actions CI | `.github/workflows/ci.yml` 在每次推送及 PR 到 `master` 时执行类型检查、测试，并将覆盖率上报至 Codecov |
| 分支保护 | 合并到 `master` 须 CI 通过 |
