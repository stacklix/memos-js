# memos

本项目是开源备忘录应用 **[memos](https://github.com/usememos/memos)** 的 JavaScript/TypeScript 实现。

- 后端：基于 [Hono](https://hono.dev/) 的 REST API（`/api/v1`）
- 前端：React + Vite（`web/`）
- 部署目标：
  - **Node.js** + SQLite
  - **Cloudflare Workers** + D1 + Static Assets

[English](./README.md) | [简体中文](./README.zh-CN.md)

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `server/` | 后端源码：Hono 应用、数据库适配、Node/Worker 入口 |
| `web/` | 前端源码（React + Vite） |
| `dist/public/` | 前端构建产物，Node/Worker 静态资源目录 |
| `dist/server/` | Node 后端构建产物（入口 `dist/server/node.js`） |
| `migrations/` | SQL 迁移目录（`NNNN_description.sql`） |
| `wrangler.jsonc` | Worker、D1 与静态资源配置 |

## 环境要求

- 根目录/后端：建议 Node.js 18+
- 前端（`web/`）：满足 `web/package.json`（`engines.node >= 24`）
- Worker 部署：Cloudflare 账号 + D1 数据库

## 本地开发

安装依赖：

```bash
npm install
```

### 推荐方式（Node API + Vite）

```bash
npm run dev
```

会并行启动 API、前端和 URL 提示。

- 前端地址：[http://localhost:3001](http://localhost:3001)
- Vite 会将 `/api`、`/healthz` 代理到 [http://localhost:3000](http://localhost:3000)

### 分开启动

```bash
npm run dev:node
npm run dev:web
```

### 本地 Worker 模式

```bash
npm run dev:worker
```

`dev:worker` 会先确保 `dist/public` 最新，并先执行本地 D1 迁移。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 同时启动后端和前端 | `npm run dev` |
| 仅启动 Node 后端 | `npm run dev:node` |
| 仅启动 Vite 前端 | `npm run dev:web` |
| 启动本地 Worker | `npm run dev:worker` |
| 构建前端 | `npm run build:web` |
| 构建后端 | `npm run build:node` |
| 前后端一起构建 | `npm run build` |
| 运行已构建 Node 服务 | `npm run start:node` |
| 类型检查 | `npm run typecheck` |
| 测试（单次） | `npm test` |
| 测试（监听） | `npm run test:watch` |

### 数据库脚本

统一命名：`db:<action>:<target>`

- `action`：`migrate` / `empty` / `clear`
- `target`：`sqlite` / `d1:local` / `d1:remote`（`remote` 仅用于 migrate）

| 目的 | 命令 |
| --- | --- |
| 执行本地 SQLite 迁移 | `npm run db:migrate:sqlite` |
| 清空本地 SQLite 数据，保留表结构 | `npm run db:empty:sqlite` |
| 删除本地 SQLite 数据库文件 | `npm run db:clear:sqlite` |
| 执行本地 D1 迁移 | `npm run db:migrate:d1:local` |
| 执行远程 D1 迁移 | `npm run db:migrate:d1:remote` |
| 清空本地 D1 数据，保留表结构 | `npm run db:empty:d1:local` |
| 删除本地 Wrangler 状态 | `npm run db:clear:d1:local` |

执行 `empty` / `clear` 前请先停掉对应开发服务。SQLite 的 `empty` / `clear` 和本地 D1 的 `clear` 支持加 `-- --yes` 非交互执行。

## 迁移（Node 与 D1）

在 `migrations/` 下新增 SQL 文件：

- 命名：`NNNN_short_description.sql`（四位数字前缀）
- 版本号应与 `schema_migrations` 对齐
- 通常不需要改 TypeScript

Node 启动和 `npm run db:migrate:sqlite` 会按文件名顺序执行未应用迁移。  
D1 使用 Wrangler 在同一 `migrations/` 目录执行迁移。

## 部署

### 部署到 Node.js

```bash
npm run build
npm run start:node
```

至少需要携带：

- `dist/public/`
- `dist/server/`
- `migrations/`
- 生产依赖

Node 单进程同时提供静态页面和 `/api/*`。

### 部署到 Cloudflare Workers

1. 配置 `wrangler.jsonc`（`database_id`、Worker 名称、vars/secrets）
2. 构建前端：

```bash
npm run build:web
```

3. 执行远程 D1 迁移：

```bash
npm run db:migrate:d1:remote
```

4. 部署：

**一步全量**（等同于 upload + 100% promote）：

```bash
npm run deploy:worker:full
```

**分步**（先上传，再在 `promote` 时切流；全量选 100%，灰度选小于 100% 或传 `--percentage`，见 `wrangler versions deploy --help`）：

```bash
npm run deploy:worker
npm run deploy:worker:promote
```

## 环境变量（Node 常用）

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 `3000` |
| `MEMOS_STATIC_ROOT` | 覆盖静态目录 |
| `DATA_DIR` | SQLite 数据目录（默认 `data/`） |
| `MEMOS_MIGRATIONS_DIR` | 可选，迁移目录绝对路径 |
| `MEMOS_INSTANCE_URL` | 实例外网 URL |
| `MEMOS_VERSION` | 实例版本号 |
| `MEMOS_DEMO` | 设为 `1` 启用 demo JWT 密钥模式 |

## API 契约说明

API/proto 对齐时，以仓库 `golang` 分支为准，重点看：

- `proto/`
- Go 树下的 `server/` 与 `plugin/`

差异文档（根目录）：

- [英文差异清单](./DIFF-VS-GOLANG.md)
- [中文差异清单](./DIFF-VS-GOLANG.zh-CN.md)

注意：Go 的 `server/` 与当前分支 TypeScript 的 `server/` 不是同一套实现。  
协作规范见 `AGENTS.md`。
