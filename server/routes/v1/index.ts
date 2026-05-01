import { Hono } from "hono";
import type { AppDeps } from "../../types/deps.js";
import type { ApiVariables } from "../../types/api-variables.js";
import { createRepository } from "../../db/repository.js";
import { isPublicApiRoute } from "../../lib/public-routes.js";
import { GrpcCode, jsonError } from "../../lib/grpc-status.js";
import { verifyAccessToken } from "../../services/jwt-access.js";
import { apiCors } from "../../middleware/cors.js";
import { debugHttpLog } from "../../middleware/debug-http.js";
import { createAuthRoutes } from "./auth.js";
import { createInstanceRoutes } from "./instance.js";
import { createUserRoutes } from "./users.js";
import { createMemoRoutes, createShareByTokenRoute } from "./memos.js";
import { createAttachmentRoutes } from "./attachments.js";
import { createIdentityProviderRoutes } from "./idp.js";
import { createSseRoutes } from "./sse.js";
import { createAIRoutes } from "./ai.js";
import { userStatsFieldsFromMemoRows } from "../../lib/user-stats-from-memos.js";

export function createV1App(deps: AppDeps) {
  const v1 = new Hono<{ Variables: ApiVariables }>();
  const repo = createRepository(deps.sql);

  v1.use("*", apiCors);
  v1.use("*", debugHttpLog(Boolean(deps.debugHttp)));

  v1.use("*", async (c, next) => {
    c.set("auth", null);
    const header = c.req.header("authorization");
    const bearer = header?.match(/^\s*Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      const token = bearer.trim();
      const jwtSecret = deps.demo ? "usememos" : (await repo.getSecretKey());
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
          if (!username) {
            await next();
            return;
          }
          c.set("auth", {
            username,
            role: access.role,
            via: "jwt",
          });
          await next();
          return;
        }
      }
      if (token.startsWith("memos_pat_")) {
        const user = await repo.findUserByPat(token);
        if (user) {
          c.set("auth", {
            username: user.username,
            role: user.role === "ADMIN" ? "ADMIN" : "USER",
            via: "pat",
          });
        }
      }
    }
    await next();
  });

  v1.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (isPublicApiRoute(c.req.method, url.pathname)) return next();
    if (c.get("auth")) return next();
    return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
  });

  v1.get("/users:stats", async (c) => {
    const users = await repo.listUsers({ limit: 1000, offset: 0 });
    const auth = c.get("auth");
    const viewerUsername = auth?.username ?? null;
    const useUpdateTimeForHeatmap = await repo.getMemoRelatedDisplayWithUpdateTime();
    const stats = [];
    for (const u of users) {
      const rows = await repo.listTopLevelMemosForUserStats({
        creatorUsername: u.username,
        viewerUsername,
      });
      const {
        tagCount,
        memoDisplayTimestamps,
        totalMemoCount,
        memoTypeStats,
        pinnedMemos,
      } = userStatsFieldsFromMemoRows(rows, { useUpdateTimeForHeatmap });
      stats.push({
        name: `users/${u.username}/stats`,
        memoDisplayTimestamps,
        memoTypeStats,
        tagCount,
        pinnedMemos,
        totalMemoCount,
      });
    }
    return c.json({ stats });
  });

  v1.route("/auth", createAuthRoutes(deps));
  v1.route("/instance", createInstanceRoutes(deps));
  v1.route("/users", createUserRoutes(deps));
  v1.route("/memos", createMemoRoutes(deps));
  v1.route("/attachments", createAttachmentRoutes(deps));
  v1.route("/identity-providers", createIdentityProviderRoutes(deps));
  v1.route("/shares", createShareByTokenRoute(deps));
  v1.route("/ai", createAIRoutes(deps));
  // Node.js only — CF Worker streaming is not supported for long-lived SSE connections.
  if (deps.enableSSE) {
    v1.route("/sse", createSseRoutes());
  }

  return v1;
}
