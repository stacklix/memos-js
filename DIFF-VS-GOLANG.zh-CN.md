# TypeScript 分支 vs `golang` 分支：当前差异

> 更新时间：2026-05-10。
>
> 对照基线：`chore/golang-v0.28.0-alignment@e8d0ff21` vs `golang@9bf648ac`（v0.28.0）。
>
> `golang` 分支是 API/proto 的权威参考。本文件只记录已知实现差异和 TypeScript/Worker 的设计差异，不代表可以继续引入新的 API 分叉。

## 设计差异

| 领域 | TypeScript 分支 | `golang` 分支 |
| --- | --- | --- |
| 后端运行时 | Hono REST API，Node.js + SQLite，Cloudflare Workers + D1 | Go 服务端，gRPC-Gateway REST + Connect |
| 前端托管 | Node 或 Worker Static Assets 提供 `dist/public/` | Go Echo 文件服务器 |
| Worker 静态资源 | Cloudflare `ASSETS.fetch`，`run_worker_first` | 不适用 |
| 对象存储 | `DATABASE / LOCAL / S3 / R2` | `DATABASE / LOCAL / S3` |
| SSE | 仅 Node；Worker SSE 设计排除 | Go 服务端 SSE |

## 数据库

| 领域 | TypeScript 分支 | `golang` 分支 |
| --- | --- | --- |
| 表结构来源 | 递增 `migrations/NNNN_*.sql` | `store/migration/sqlite/*` 加 `LATEST.sql` |
| 版本记录 | `schema_migrations` 表 | 无等价表 |
| 本地运行库 | SQLite 文件，默认 `data/memos.sqlite` | SQLite/PostgreSQL/MySQL |
| Worker 数据库 | Cloudflare D1，由 Wrangler 迁移 | 不适用 |
| DDL 风格 | 使用 `IF NOT EXISTS` 保护 | 原始 DDL |

## 后端 API

| 领域 | TypeScript 分支 | `golang` 分支 |
| --- | --- | --- |
| 传输实现 | 仅 REST：`/api/v1` 下的手写 Hono 路由 | `/api/v1` 下的 gRPC-Gateway REST，另有 Connect handlers |
| 存储设置响应 | 额外返回 `supportedStorageTypes`，可包含 `R2` | 固定 proto 枚举，无 R2 |
| Memo / 附件过滤 | 实现支持范围内的 CEL-like 子集 | Go/proto 完整行为 |
| SSE 路由 | 仅 Node 开启 SSE 时挂载 | Go 服务端可用 |

## 前端

当前前端差异主要来自适配层和运行时：

| 文件 / 领域 | 差异 |
| --- | --- |
| `web/src/connect.ts` | 大型自定义 REST 适配层，把前端 service 调用转换为 TypeScript 后端 JSON API。 |
| `web/src/lib/proto-adapters.ts` | 将 REST 响应转换为现有 hooks/components 使用的前端模型类型。 |
| 存储设置 | `InstanceContext.tsx` 和 `StorageSection.tsx` 支持动态存储类型与 R2。 |
| 用户菜单 | 移除了实时 SSE 连接状态提示，因为 Worker 不提供 SSE。 |

## 仍然设计排除

- R2 存储的后端/API 支持刻意不同于上游 Go。
- Cloudflare Worker SSE 仍然排除，因为长连接 SSE 不适合当前 Worker 部署路径。
