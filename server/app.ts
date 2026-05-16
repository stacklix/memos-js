import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { accessLog } from "./middleware/access-log.js";
import { logUncaughtApiError } from "./lib/error-logger.js";
import { GrpcCode, jsonError } from "./lib/grpc-status.js";
import type { AppDeps } from "./types/deps.js";
import { createV1App } from "./routes/v1/index.js";
import { createRepository } from "./db/repository.js";
import { verifyAccessToken } from "./services/jwt-access.js";
import { verifyRefreshToken } from "./services/jwt-refresh.js";
import { parseInstanceStorageSetting } from "./lib/instance-storage-setting.js";
import { resolveAttachmentStorage } from "./services/attachment-storage-resolver.js";
import { parseCookieHeader, REFRESH_COOKIE_NAME } from "./lib/cookies.js";
import { parseUserAvatarDataUri } from "./lib/user-avatar-data-uri.js";

/** Shared HTTP app. Mounts `GET /healthz` and `/api/v1` for Node and Worker. */
export function createApp(deps: AppDeps) {
  const app = new Hono();
  const repo = createRepository(deps.sql);
  async function resolveAuth(req: Request): Promise<{ username: string; role: "ADMIN" | "USER" } | null> {
    const header = req.headers.get("authorization");
    const bearer = header?.match(/^\s*Bearer\s+(.+)$/i)?.[1];
    const jwtSecret = deps.demo ? "usememos" : (await repo.getSecretKey());
    if (bearer) {
      const token = bearer.trim();
      if (jwtSecret) {
        const access = await verifyAccessToken(token, jwtSecret);
        if (access) {
          let username: string | null = null;
          if (access.userId != null) {
            const u = await repo.getUserByInternalId(access.userId);
            username = u?.username ?? null;
          }
          if (!username && access.username) {
            username = access.username;
          }
          if (username) {
            return { username, role: access.role };
          }
        }
      }
      if (token.startsWith("memos_pat_")) {
        const user = await repo.findUserByPat(token);
        if (user) {
          return { username: user.username, role: user.role === "ADMIN" ? "ADMIN" : "USER" };
        }
      }
    }

    // Align with golang fileserver auth priority:
    // Bearer access/PAT first, then refresh-token cookie as fallback for browser media requests.
    const refreshRaw = parseCookieHeader(req.headers.get("cookie") ?? undefined)[REFRESH_COOKIE_NAME];
    if (jwtSecret && refreshRaw) {
      const refresh = await verifyRefreshToken(refreshRaw, jwtSecret);
      if (refresh) {
        const rec = await repo.getRefreshTokenRecord(refresh.userId, refresh.tokenId);
        const notExpired = rec && new Date(rec.expires_at_iso).getTime() >= Date.now();
        if (rec && notExpired) {
          const user = await repo.getUser(rec.username);
          if (user) {
            return {
              username: user.username,
              role: user.role === "ADMIN" ? "ADMIN" : "USER",
            };
          }
        }
      }
    }
    return null;
  }
  app.onError((err, c) => {
    const u = new URL(c.req.url);
    logUncaughtApiError(err, { method: c.req.method, path: u.pathname });
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    return jsonError(c, GrpcCode.INTERNAL, "internal error");
  });
  app.use("*", accessLog());
  app.get("/healthz", (c) => c.text("Service ready."));
  app.get("/file/*", async (c) => {
    const u = new URL(c.req.url);
    const p = u.pathname.slice("/file/".length).split("/").filter(Boolean);
    let attachmentUid = "";
    if (p.length >= 2 && p[0] === "attachments") {
      attachmentUid = p[1] ?? "";
    } else if (p.length >= 3 && p[0] === "users" && p[2] === "avatar") {
      const username = decodeURIComponent(p[1] ?? "");
      const user = username ? await repo.getUser(username) : null;
      if (!user?.avatar_url) return c.notFound();
      const avatar = parseUserAvatarDataUri(user.avatar_url);
      if (!avatar) return c.notFound();
      const headers = new Headers();
      headers.set("Content-Type", avatar.imageType);
      headers.set("Cache-Control", "public, max-age=3600");
      return new Response(avatar.bytes, { status: 200, headers });
    } else if (p.length >= 1) {
      attachmentUid = p[0] ?? "";
    }
    if (!attachmentUid) return c.notFound();
    const row = await repo.getAttachmentByUid(attachmentUid);
    if (!row) return c.notFound();
    const auth = await resolveAuth(c.req.raw);
    if (!row.memo_id) {
      if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
      if (auth.username !== row.creator_username && auth.role !== "ADMIN") {
        return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
      }
    } else {
      const memo = await repo.getMemoById(row.memo_id);
      if (!memo) return c.notFound();
      if (memo.visibility !== "PUBLIC") {
        const shareToken = u.searchParams.get("share_token")?.trim() ?? "";
        let shareAllowed = false;
        if (shareToken) {
          const sharedMemoId = await repo.getMemoIdByShareToken(shareToken);
          shareAllowed = sharedMemoId === memo.id;
        }
        if (!shareAllowed) {
          if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
          if (
            memo.visibility === "PRIVATE" &&
            auth.username !== memo.creator_username &&
            auth.role !== "ADMIN"
          ) {
            return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
          }
        }
      }
    }
    const rawSetting = await repo.getInstanceSettingRaw("STORAGE");
    const setting = parseInstanceStorageSetting(rawSetting, deps.defaultAttachmentStorageType);
    const storage = await resolveAttachmentStorage(deps, setting);
    let content = row.blob;
    if (!content && row.reference) {
      let reference = row.reference;
      if (row.storage_type === "S3" || row.storage_type === "R2") {
        try {
          const payload = JSON.parse(row.payload || "{}") as {
            s3Object?: { key?: string };
            r2Object?: { key?: string };
          };
          const key = payload.s3Object?.key || payload.r2Object?.key;
          if (typeof key === "string" && key.trim() !== "") {
            reference = key;
          }
        } catch {
          // Keep compatibility with legacy rows.
        }
      }
      content = await storage.get(reference);
    }
    if (!content) return c.notFound();
    const headers = new Headers();
    headers.set("Content-Type", row.type || "application/octet-stream");
    headers.set(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(row.filename || "attachment")}"`,
    );
    return new Response(content, { status: 200, headers });
  });
  app.route("/api/v1", createV1App(deps));

  return app;
}
