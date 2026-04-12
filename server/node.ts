import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { readRootPackageJsonVersion } from "./lib/root-package-version.js";
import { createBetterSqliteAdapter } from "./db/better-sqlite-adapter.js";
import { migrateBetterSqliteFromDir } from "./db/migrate.js";
import { assertMigrationsDirReadable, resolveMigrationsDirectory } from "./lib/initial-migration-sql.js";
import { sendNotificationEmailViaSmtp } from "./services/notification-email-node.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `dist/server/node.js` vs `server/node.ts` (tsx) */
function isDistServerModuleDir(dir: string): boolean {
  return /[/\\]dist[/\\]server$/i.test(dir.replace(/\\/g, "/"));
}

function resolvePublicDir(): string {
  if (process.env.MEMOS_STATIC_ROOT) {
    return resolve(process.env.MEMOS_STATIC_ROOT);
  }
  if (isDistServerModuleDir(__dirname)) {
    return resolve(join(__dirname, "../public"));
  }
  // tsx runs from `server/`; Vite output is repo `dist/public/` (one level up from `server/`)
  return resolve(join(__dirname, "../dist/public"));
}

function resolveDefaultDataDir(): string {
  if (isDistServerModuleDir(__dirname)) {
    return resolve(join(__dirname, "../../data"));
  }
  return resolve(join(__dirname, "../data"));
}

const publicDir = resolvePublicDir();
const indexHtmlPath = join(publicDir, "index.html");
if (!existsSync(indexHtmlPath)) {
  console.error(
    `[memos] No SPA at ${indexHtmlPath}. Run \`npm run build:web\` (or \`npm run dev:web\` on port 3001 for HMR).`,
  );
}
const dataDir = process.env.DATA_DIR ?? resolveDefaultDataDir();
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "memos.sqlite");
const sqlite = new Database(dbPath);
try {
  const migrationsDir = resolveMigrationsDirectory(__dirname);
  assertMigrationsDirReadable(migrationsDir);
  migrateBetterSqliteFromDir(sqlite, migrationsDir);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const sql = createBetterSqliteAdapter(sqlite);

const demo = process.env.MEMOS_DEMO === "1";
const port = Number(process.env.PORT) || 3000;
const instanceUrl =
  process.env.MEMOS_INSTANCE_URL ?? `http://localhost:${port}`;

/** Local `tsx server/node.ts`: set MEMOS_DEBUG_HTTP=1 unless MEMOS_DEBUG_HTTP=0. `dist/server`: off unless MEMOS_DEBUG_HTTP=1. */
if (!isDistServerModuleDir(__dirname) && process.env.MEMOS_DEBUG_HTTP !== "0") {
  process.env.MEMOS_DEBUG_HTTP ??= "1";
}
const debugHttp = process.env.MEMOS_DEBUG_HTTP === "1";
const inner = createApp({
  sql,
  demo,
  instanceVersion: process.env.MEMOS_VERSION ?? readRootPackageJsonVersion(__dirname),
  instanceUrl,
  debugHttp,
  defaultAttachmentStorageType: "LOCAL",
  attachmentDataDir: dataDir,
  sendNotificationEmail: sendNotificationEmailViaSmtp,
  enableSSE: true,
});
if (debugHttp) {
  console.log(
    "[memos] MEMOS_DEBUG_HTTP=1 — [debug:http] for /api/v1. Quiet: MEMOS_DEBUG_HTTP=0. Worker local: .dev.vars (see dev:worker).",
  );
}

const app = new Hono();

app.all("*", async (c) => {
  const pathname = new URL(c.req.url).pathname;
  if (pathname === "/healthz" || pathname.startsWith("/api/") || pathname.startsWith("/file/")) {
    return inner.fetch(c.req.raw);
  }

  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.notFound();
  }

  const rel = pathname === "/" || pathname === "" ? "index.html" : pathname.slice(1);
  const candidate = resolve(publicDir, rel);
  if (!candidate.startsWith(publicDir)) {
    return c.notFound();
  }
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    const body = readFileSync(candidate);
    const headers = new Headers();
    const ext = extname(candidate);
    const mime =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".css"
            ? "text/css; charset=utf-8"
            : ext === ".json"
              ? "application/json"
              : ext === ".webp"
                ? "image/webp"
                : ext === ".png"
                  ? "image/png"
                  : ext === ".svg"
                    ? "image/svg+xml"
                    : "application/octet-stream";
    headers.set("Content-Type", mime);
    if (pathname === "/" || pathname === "/index.html") {
      headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      headers.set("Pragma", "no-cache");
      headers.set("Expires", "0");
    } else if (/-[A-Za-z0-9_-]{6,}\.(js|css|woff2?)$/i.test(pathname)) {
      headers.set("Cache-Control", "public, max-age=3600, immutable");
    }
    return new Response(body, { status: 200, headers });
  }

  const html = readFileSync(join(publicDir, "index.html"), "utf-8");
  return c.html(html, 200, {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
});

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Listening on http://localhost:${info.port}`);
  },
);
