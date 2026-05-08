import { Hono } from "hono";
import { z } from "zod";
import type { ApiVariables } from "../../types/api-variables.js";
import type { AppDeps } from "../../types/deps.js";
import { createRepository, type DbUserNotificationRow } from "../../db/repository.js";
import {
  parseWebhooksFromUserSettingValue,
  serializeWebhooksUserSetting,
  type StoredUserWebhook,
} from "../../lib/user-webhooks-setting.js";
import { GrpcCode, jsonError } from "../../lib/grpc-status.js";
import { b64urlToUtf8, utf8ToB64url } from "../../lib/b64url.js";
import { hashPassword } from "../../services/password.js";
import {
  exchangeOAuth2Token,
  fetchOAuth2UserInfo,
  parseOAuth2Config,
} from "../../services/oauth2-idp.js";
import { authPrincipalFromUserRow, userToJson } from "../../lib/serializers.js";
import { userStatsFieldsFromMemoRows } from "../../lib/user-stats-from-memos.js";
import { validateUserAvatarUrl } from "../../lib/user-avatar-data-uri.js";
import { isValidMemosUsername } from "../../lib/user-username.js";

function extractIdentityProviderUid(name: string): string | null {
  const prefix = "identity-providers/";
  if (!name.startsWith(prefix)) return null;
  const uid = name.slice(prefix.length).trim();
  if (!uid || !/^[a-z0-9][a-z0-9-]{0,31}$/i.test(uid)) return null;
  return uid;
}

/** Proto `User.Role`: ROLE_UNSPECIFIED=0, ADMIN=2, USER=3 — JSON often uses these numbers. */
const createUserRoleField = z
  .union([
    z.enum(["ADMIN", "USER", "ROLE_UNSPECIFIED"]),
    z.literal(0),
    z.literal(2),
    z.literal(3),
  ])
  .optional()
  .transform((v): "ADMIN" | "USER" | "ROLE_UNSPECIFIED" | undefined => {
    if (v === undefined) return undefined;
    if (v === "ADMIN" || v === 2) return "ADMIN";
    if (v === "USER" || v === 3) return "USER";
    return "ROLE_UNSPECIFIED";
  });

/** Proto `State` uses ints in JSON; server only validates shape (create ignores state). */
const createUserStateField = z.union([z.string(), z.number()]).optional();

const createUserBody = z.object({
  user: z.object({
    username: z.string(),
    password: z.string().optional(),
    role: createUserRoleField,
    displayName: z.string().optional(),
    email: z.string().optional(),
    state: createUserStateField,
  }),
  userId: z.string().optional(),
  validateOnly: z.boolean().optional(),
});

function parseUserRolePatchValue(v: unknown): "ADMIN" | "USER" | null {
  if (v === "ADMIN" || v === 2) return "ADMIN";
  if (v === "USER" || v === 3) return "USER";
  return null;
}

function parseUserStatePatchValue(v: unknown): "NORMAL" | "ARCHIVED" | null {
  if (v === "NORMAL" || v === 1) return "NORMAL";
  if (v === "ARCHIVED" || v === 2) return "ARCHIVED";
  return null;
}

function parsePageArgs(
  rawPageSize: string | undefined,
  rawToken: string | undefined,
): { limit: number; offset: number } | { error: string } {
  const limit = Math.min(1000, Math.max(1, Number(rawPageSize ?? 50)));
  let offset = 0;
  if (rawToken && rawToken.trim() !== "") {
    let decoded = "";
    try {
      decoded = b64urlToUtf8(rawToken);
    } catch {
      return { error: "invalid page token" };
    }
    const n = Number(decoded);
    if (!Number.isInteger(n) || n < 0) {
      return { error: "invalid page token" };
    }
    offset = n;
  }
  return { limit, offset };
}

function hasPath(paths: string[] | undefined, ...names: string[]): boolean {
  if (!paths || paths.length === 0) return false;
  return names.some((n) => paths.includes(n));
}

function validateUserWebhookUrl(url: string): string | null {
  const t = url.trim();
  if (!t) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return t;
}

function userNotificationToJson(username: string, n: DbUserNotificationRow) {
  const status =
    n.status === "UNREAD"
      ? "UNREAD"
      : n.status === "ARCHIVED"
        ? "ARCHIVED"
        : "STATUS_UNSPECIFIED";
  const base: Record<string, unknown> = {
    name: `users/${username}/notifications/${n.inbox_id}`,
    sender: `users/${n.sender_username}`,
    status,
    createTime: n.create_time,
    type: "MEMO_COMMENT",
  };
  if (n.comment_memo_uid && n.related_memo_uid) {
    base.memoComment = {
      memo: `memos/${n.comment_memo_uid}`,
      relatedMemo: `memos/${n.related_memo_uid}`,
    };
  }
  return base;
}

function storedWebhooksToApi(username: string, list: StoredUserWebhook[]) {
  return list.map((w) => ({
    name: `users/${username}/webhooks/${w.id}`,
    url: w.url,
    displayName: w.title,
  }));
}

function webhooksFromApiSettingBody(webhooks: unknown[] | undefined): StoredUserWebhook[] {
  if (!Array.isArray(webhooks)) return [];
  const out: StoredUserWebhook[] = [];
  for (const x of webhooks) {
    if (typeof x !== "object" || !x) continue;
    const o = x as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url : "";
    const vUrl = validateUserWebhookUrl(url);
    if (!vUrl) continue;
    let id = "";
    if (typeof o.name === "string") {
      const parts = o.name.split("/");
      id = parts[parts.length - 1] ?? "";
    }
    if (!id && typeof o.id === "string") id = o.id;
    if (!id) continue;
    const title =
      typeof o.displayName === "string"
        ? o.displayName
        : typeof o.title === "string"
          ? o.title
          : "";
    out.push({ id, title, url: vUrl });
  }
  return out;
}

export function createUserRoutes(deps: AppDeps) {
  const r = new Hono<{ Variables: ApiVariables }>();
  const repo = createRepository(deps.sql);

  r.get("/", async (c) => {
    const auth = c.get("auth");
    if (!auth) {
      return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    }
    if (auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "admin only");
    }
    const page = parsePageArgs(c.req.query("pageSize"), c.req.query("pageToken"));
    if ("error" in page) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, page.error);
    }
    const users = await repo.listUsers({ limit: page.limit, offset: page.offset });
    const next =
      users.length === page.limit
        ? utf8ToB64url(String(page.offset + page.limit))
        : "";
    return c.json({
      users: users.map((u) => userToJson(u, auth)),
      nextPageToken: next,
      totalSize: await repo.userCount(),
    });
  });

  r.post("/", async (c) => {
    let body: z.infer<typeof createUserBody>;
    try {
      body = createUserBody.parse(await c.req.json());
    } catch {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid body");
    }
    const general = await repo.getGeneralSetting();
    const count = await repo.userCount();
    if (general.disallowUserRegistration && count > 0) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "registration disabled");
    }
    const username = body.userId?.trim() || body.user.username;
    if (!username || !isValidMemosUsername(username)) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, `invalid username: ${username}`);
    }
    if (await repo.getUser(username)) {
      return jsonError(c, GrpcCode.ALREADY_EXISTS, "user exists");
    }
    const role =
      count === 0 ? "ADMIN" : body.user.role === "ADMIN" ? "ADMIN" : "USER";
    if (role === "ADMIN" && count > 0 && c.get("auth")?.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "admin only");
    }
    const password = body.user.password ?? "";
    if (!password) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "password required");
    }
    if (general.disallowPasswordAuth) {
      return jsonError(c, GrpcCode.FAILED_PRECONDITION, "password not allowed");
    }
    if (body.validateOnly) {
      const row = {
        username,
        password_hash: "",
        role: role === "ADMIN" ? ("ADMIN" as const) : ("USER" as const),
        display_name: body.user.displayName ?? null,
        email: body.user.email ?? null,
        avatar_url: null,
        description: null,
        state: "NORMAL",
        create_time: new Date().toISOString(),
        update_time: new Date().toISOString(),
        deleted: 0,
      };
      return c.json(userToJson(row, authPrincipalFromUserRow(row)));
    }
    if (!deps.demo) await repo.ensureSecretKey();
    const hash = await hashPassword(password);
    const created = await repo.createUser({
      username,
      passwordHash: hash,
      role: role === "ADMIN" ? "ADMIN" : "USER",
      displayName: body.user.displayName,
      email: body.user.email,
    });
    return c.json(userToJson(created, authPrincipalFromUserRow(created)));
  });

  const forUser = new Hono<{ Variables: ApiVariables }>();

  forUser.use(async (c, next) => {
    if (!c.req.param("username")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user path");
    }
    await next();
  });

  forUser.get("/", async (c) => {
    const raw = c.req.param("username")!;
    if (raw.endsWith(":getStats")) {
      const username = raw.slice(0, -":getStats".length);
      const user = await repo.getUser(username);
      if (!user) return jsonError(c, GrpcCode.NOT_FOUND, "user not found");
      const auth = c.get("auth");
      const viewerUsername = auth?.username ?? null;
      const useUpdateTimeForHeatmap = await repo.getMemoRelatedDisplayWithUpdateTime();
      const rows = await repo.listTopLevelMemosForUserStats({
        creatorUsername: username,
        viewerUsername,
      });
      const {
        tagCount,
        memoDisplayTimestamps,
        totalMemoCount,
        memoTypeStats,
        pinnedMemos,
      } = userStatsFieldsFromMemoRows(rows, { useUpdateTimeForHeatmap });
      return c.json({
        name: `users/${username}/stats`,
        memoDisplayTimestamps,
        memoTypeStats,
        tagCount,
        pinnedMemos,
        totalMemoCount,
      });
    }
    const user = await repo.getUser(raw);
    if (!user) return jsonError(c, GrpcCode.NOT_FOUND, "user not found");
    return c.json(userToJson(user, c.get("auth") ?? null));
  });

  forUser.patch("/", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const general = await repo.getGeneralSetting();
    type Body = {
      user?: {
        username?: string;
        displayName?: string;
        email?: string;
        password?: string;
        role?: string | number;
        state?: string | number;
        avatarUrl?: string;
        description?: string;
      };
      updateMask?: { paths?: string[] };
    };
    let body: Body;
    try {
      body = (await c.req.json()) as Body;
    } catch {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid json");
    }
    const u = body.user;
    if (!u) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "user required");
    const paths = body.updateMask?.paths ?? [];
    if (paths.length === 0) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "update mask is empty");
    }
    let newUsername: string | null = null;
    if (hasPath(paths, "username")) {
      if (general.disallowChangeUsername) {
        return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
      }
      const next = typeof u.username === "string" ? u.username.trim() : "";
      if (!next) {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, "username required");
      }
      if (!isValidMemosUsername(next)) {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, `invalid username: ${next}`);
      }
      if (next !== username) {
        newUsername = next;
      }
    }

    const fields: Parameters<typeof repo.updateUser>[1] = {};
    if (hasPath(paths, "displayName", "display_name")) {
      if (general.disallowChangeNickname) {
        return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
      }
      if (u.displayName !== undefined) fields.display_name = u.displayName;
    }
    if (hasPath(paths, "email")) {
      if (u.email !== undefined) fields.email = u.email;
    }
    if (hasPath(paths, "avatar_url", "avatarUrl")) {
      if (u.avatarUrl !== undefined) {
        const avatarErr = validateUserAvatarUrl(u.avatarUrl);
        if (avatarErr) {
          const msg =
            avatarErr === "invalid data URI format"
              ? `invalid avatar format: ${avatarErr}`
              : avatarErr;
          return jsonError(c, GrpcCode.INVALID_ARGUMENT, msg);
        }
        fields.avatar_url = u.avatarUrl;
      }
    }
    if (hasPath(paths, "description")) {
      if (u.description !== undefined) fields.description = u.description;
    }
    if (u.password && hasPath(paths, "password")) {
      fields.password_hash = await hashPassword(u.password);
    }
    if (hasPath(paths, "role")) {
      if (auth.role !== "ADMIN") {
        return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
      }
      const parsedRole = parseUserRolePatchValue(u.role);
      if (!parsedRole) {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid role");
      }
      fields.role = parsedRole;
    }
    if (hasPath(paths, "state")) {
      const parsedState = parseUserStatePatchValue(u.state);
      if (!parsedState) {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid state");
      }
      fields.state = parsedState;
    }
    await repo.updateUser(username, fields);
    let resolvedUsername = username;
    if (newUsername) {
      try {
        await repo.renameUser(username, newUsername);
        resolvedUsername = newUsername;
      } catch (e) {
        if (e instanceof Error && e.message === "username already exists") {
          return jsonError(c, GrpcCode.ALREADY_EXISTS, "username already exists");
        }
        throw e;
      }
    }
    const next = await repo.getUserAnyState(resolvedUsername);
    if (!next) return jsonError(c, GrpcCode.NOT_FOUND, "user not found");
    return c.json(userToJson(next, auth));
  });

  forUser.delete("/", async (c) => {
    const auth = c.get("auth");
    if (!auth || auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "admin only");
    }
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    await repo.softDeleteUser(username);
    return c.json({});
  });

  forUser.get("/settings", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const rows = await repo.listUserSettings(username);
    const readMaskRaw = c.req.query("readMask");
    const readMask = new Set(
      (readMaskRaw ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    );
    const page = parsePageArgs(c.req.query("pageSize"), c.req.query("pageToken"));
    if ("error" in page) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, page.error);
    }
    const settings = rows.map((row) => {
      const key = row.setting_key;
      if (key === "GENERAL") {
        const parsed = JSON.parse(row.json_value) as { payload?: unknown };
        const value = parsed.payload ?? { locale: "", memoVisibility: "", theme: "" };
        return {
          name: `users/${username}/settings/GENERAL`,
          ...(readMask.size === 0 || readMask.has("general_setting") || readMask.has("generalSetting")
            ? { generalSetting: value }
            : {}),
        };
      }
      if (key === "WEBHOOKS") {
        const stored = parseWebhooksFromUserSettingValue(row.json_value);
        const value = { webhooks: storedWebhooksToApi(username, stored) };
        return {
          name: `users/${username}/settings/WEBHOOKS`,
          ...(readMask.size === 0 || readMask.has("webhooks_setting") || readMask.has("webhooksSetting")
            ? { webhooksSetting: value }
            : {}),
        };
      }
      return {
        name: `users/${username}/settings/${key}`,
        ...(readMask.size === 0 || readMask.has("webhooks_setting") || readMask.has("webhooksSetting")
          ? { webhooksSetting: { webhooks: [] } }
          : {}),
      };
    });
    if (!settings.some((x) => x.name === `users/${username}/settings/GENERAL`)) {
      settings.unshift({
        name: `users/${username}/settings/GENERAL`,
        ...(readMask.size === 0 || readMask.has("general_setting") || readMask.has("generalSetting")
          ? { generalSetting: { locale: "", memoVisibility: "", theme: "" } }
          : {}),
      });
    }
    const paged = settings.slice(page.offset, page.offset + page.limit);
    const nextPageToken =
      page.offset + page.limit < settings.length
        ? utf8ToB64url(String(page.offset + page.limit))
        : "";
    return c.json({ settings: paged, nextPageToken, totalSize: settings.length });
  });

  forUser.get("/settings/:key", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    const key = c.req.param("key");
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const raw = await repo.getUserSetting(username, key);
    if (!raw) {
      if (key === "GENERAL") {
        return c.json({
          name: `users/${username}/settings/GENERAL`,
          generalSetting: { locale: "", memoVisibility: "", theme: "" },
        });
      }
      if (key === "WEBHOOKS") {
        return c.json({
          name: `users/${username}/settings/WEBHOOKS`,
          webhooksSetting: { webhooks: [] },
        });
      }
      return jsonError(c, GrpcCode.NOT_FOUND, "not found");
    }
    const parsed = JSON.parse(raw) as { payload?: unknown };
    if (key === "GENERAL") {
      return c.json({
        name: `users/${username}/settings/GENERAL`,
        generalSetting: parsed.payload ?? {},
      });
    }
    if (key === "WEBHOOKS") {
      const stored = parseWebhooksFromUserSettingValue(raw);
      return c.json({
        name: `users/${username}/settings/WEBHOOKS`,
        webhooksSetting: { webhooks: storedWebhooksToApi(username, stored) },
      });
    }
    return c.json({
      name: `users/${username}/settings/${key}`,
      webhooksSetting: parsed.payload ?? { webhooks: [] },
    });
  });

  forUser.patch("/settings/:key", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    const key = c.req.param("key");
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = { setting?: { generalSetting?: unknown; webhooksSetting?: unknown }; updateMask?: { paths?: string[] } };
    const body = (await c.req.json()) as Body;
    const paths = body.updateMask?.paths ?? [];
    if (paths.length === 0) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "update mask is empty");
    }
    if (key === "WEBHOOKS") {
      const ws = body.setting?.webhooksSetting as { webhooks?: unknown[] } | undefined;
      const stored = webhooksFromApiSettingBody(ws?.webhooks);
      await repo.upsertUserSetting(username, key, serializeWebhooksUserSetting(stored));
      return c.json({
        name: `users/${username}/settings/WEBHOOKS`,
        webhooksSetting: { webhooks: storedWebhooksToApi(username, stored) },
      });
    }
    if (key === "GENERAL") {
      const currentRaw = await repo.getUserSetting(username, "GENERAL");
      const currentParsed = currentRaw
        ? ((JSON.parse(currentRaw) as { payload?: Record<string, unknown> }).payload ?? {})
        : {};
      const incoming = (body.setting?.generalSetting as Record<string, unknown> | undefined) ?? {};
      const next = { ...currentParsed };
      if (hasPath(paths, "generalSetting", "general_setting")) {
        await repo.upsertUserSetting(
          username,
          key,
          JSON.stringify({ kind: "GENERAL", payload: incoming }),
        );
      } else {
        if (hasPath(paths, "locale") && incoming.locale !== undefined) next.locale = incoming.locale;
        if (hasPath(paths, "theme") && incoming.theme !== undefined) next.theme = incoming.theme;
        if (hasPath(paths, "memoVisibility", "memo_visibility") && incoming.memoVisibility !== undefined) {
          next.memoVisibility = incoming.memoVisibility;
        }
        await repo.upsertUserSetting(
          username,
          key,
          JSON.stringify({ kind: "GENERAL", payload: next }),
        );
      }
      const raw = await repo.getUserSetting(username, key);
      if (!raw) {
        return jsonError(c, GrpcCode.INTERNAL, "failed to read setting");
      }
      const parsed = JSON.parse(raw) as { payload?: unknown };
      return c.json({
        name: `users/${username}/settings/GENERAL`,
        generalSetting: parsed.payload ?? {},
      });
    }
    const payload =
      { kind: key, payload: body.setting?.webhooksSetting ?? {} };
    await repo.upsertUserSetting(username, key, JSON.stringify(payload));
    const raw = await repo.getUserSetting(username, key);
    if (!raw) {
      return jsonError(c, GrpcCode.INTERNAL, "failed to read setting");
    }
    const parsed = JSON.parse(raw) as { payload?: unknown };
    if (key === "GENERAL") {
      return c.json({
        name: `users/${username}/settings/GENERAL`,
        generalSetting: parsed.payload ?? {},
      });
    }
    return c.json({
      name: `users/${username}/settings/${key}`,
      webhooksSetting: parsed.payload ?? { webhooks: [] },
    });
  });

  forUser.get("/personalAccessTokens", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const rows = await repo.listPats(username);
    return c.json({
      personalAccessTokens: rows.map((t) => ({
        name: `users/${username}/personalAccessTokens/${t.id}`,
        description: t.description ?? "",
        // Proto field created_at → JSON name createdAt (google.protobuf.Timestamp as RFC 3339).
        createdAt: t.created_at,
      })),
      nextPageToken: "",
    });
  });

  forUser.post("/personalAccessTokens", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    // CreatePersonalAccessTokenRequest (proto): parent + optional description + expires_in_days; HTTP body: "*".
    type Body = {
      parent?: string;
      description?: string;
      expiresInDays?: number;
      personalAccessToken?: { description?: string };
    };
    const body = (await c.req.json()) as Body;
    const description =
      typeof body.description === "string"
        ? body.description
        : (body.personalAccessToken?.description ?? null);
    const { id, raw } = await repo.createPat(username, description?.trim() ? description.trim() : null);
    return c.json({
      personalAccessToken: {
        name: `users/${username}/personalAccessTokens/${id}`,
        description: description?.trim() ?? "",
        createdAt: new Date().toISOString(),
      },
      // Proto field name is `token` (only returned on create).
      token: raw,
    });
  });

  forUser.delete("/personalAccessTokens/:patId", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const ok = await repo.deletePat(username, c.req.param("patId"));
    if (!ok) return jsonError(c, GrpcCode.NOT_FOUND, "not found");
    return c.json({});
  });

  forUser.get("/webhooks", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const rows = await repo.listWebhooks(username);
    const page = parsePageArgs(c.req.query("pageSize"), c.req.query("pageToken"));
    if ("error" in page) return jsonError(c, GrpcCode.INVALID_ARGUMENT, page.error);
    const all = storedWebhooksToApi(username, rows);
    const webhooks = all.slice(page.offset, page.offset + page.limit);
    const nextPageToken =
      page.offset + page.limit < all.length
        ? utf8ToB64url(String(page.offset + page.limit))
        : "";
    return c.json({
      webhooks,
      nextPageToken,
      totalSize: all.length,
    });
  });

  forUser.post("/webhooks", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = { webhook?: { url?: string; displayName?: string } };
    const body = (await c.req.json()) as Body;
    const url = validateUserWebhookUrl(body.webhook?.url ?? "");
    if (!url) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "url required");
    const id = await repo.createWebhook(username, url, body.webhook?.displayName);
    const title = body.webhook?.displayName?.trim() ?? "";
    return c.json({
      name: `users/${username}/webhooks/${id}`,
      url,
      displayName: title,
    });
  });

  forUser.patch("/webhooks/:whId", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = {
      webhook?: { url?: string; displayName?: string };
      updateMask?: { paths?: string[] };
    };
    const body = (await c.req.json()) as Body;
    const paths = new Set(body.updateMask?.paths ?? []);
    let url = body.webhook?.url;
    if (url !== undefined && (paths.size === 0 || paths.has("url"))) {
      const v = validateUserWebhookUrl(url);
      if (!v) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid url");
      url = v;
    }
    const whId = c.req.param("whId");
    const ok = await repo.updateWebhook(
      username,
      whId,
      { url, displayName: body.webhook?.displayName },
      paths,
    );
    if (!ok) return jsonError(c, GrpcCode.NOT_FOUND, "not found");
    const list = await repo.listWebhooks(username);
    const w = list.find((x) => x.id === whId);
    if (!w) return jsonError(c, GrpcCode.NOT_FOUND, "not found");
    return c.json({
      name: `users/${username}/webhooks/${w.id}`,
      url: w.url,
      displayName: w.title,
    });
  });

  forUser.delete("/webhooks/:whId", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const ok = await repo.deleteWebhook(username, c.req.param("whId"));
    if (!ok) return jsonError(c, GrpcCode.NOT_FOUND, "not found");
    return c.json({});
  });

  forUser.get("/notifications", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const rows = await repo.listNotifications(username);
    return c.json({
      notifications: rows.map((n) => userNotificationToJson(username, n)),
    });
  });

  forUser.patch("/notifications/:nid", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const inboxId = Number(c.req.param("nid"));
    if (!Number.isInteger(inboxId) || inboxId < 1) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid notification id");
    }
    type Body = { notification?: { status?: string }; updateMask?: { paths?: string[] } };
    const body = (await c.req.json()) as Body;
    const paths = body.updateMask?.paths ?? [];
    if (!paths.includes("status")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "updateMask must include status");
    }
    const rawStatus = body.notification?.status;
    let status: "UNREAD" | "ARCHIVED" | null = null;
    if (rawStatus === "UNREAD") status = "UNREAD";
    else if (rawStatus === "ARCHIVED") status = "ARCHIVED";
    if (!status) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid status");
    }
    const updated = await repo.updateNotificationStatus({ username, inboxId, status });
    if (!updated) return jsonError(c, GrpcCode.NOT_FOUND, "not found");
    return c.json(userNotificationToJson(username, updated));
  });

  forUser.delete("/notifications/:nid", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const inboxId = Number(c.req.param("nid"));
    if (!Number.isInteger(inboxId) || inboxId < 1) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid notification id");
    }
    const ok = await repo.deleteNotification(username, inboxId);
    if (!ok) return jsonError(c, GrpcCode.NOT_FOUND, "not found");
    return c.json({});
  });

  forUser.get("/shortcuts", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const rows = await repo.listShortcuts(username);
    const page = parsePageArgs(c.req.query("pageSize"), c.req.query("pageToken"));
    if ("error" in page) return jsonError(c, GrpcCode.INVALID_ARGUMENT, page.error);
    const all = rows.map((s) => ({
      name: `users/${username}/shortcuts/${s.shortcut_id}`,
      title: s.title,
      filter: s.filter_expr ?? "",
    }));
    const shortcuts = all.slice(page.offset, page.offset + page.limit);
    const nextPageToken =
      page.offset + page.limit < all.length
        ? utf8ToB64url(String(page.offset + page.limit))
        : "";
    return c.json({
      shortcuts,
      nextPageToken,
      totalSize: all.length,
    });
  });

  forUser.get("/shortcuts/:sid", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const sid = c.req.param("sid");
    const rows = await repo.listShortcuts(username);
    const s = rows.find((x) => x.shortcut_id === sid);
    if (!s) return jsonError(c, GrpcCode.NOT_FOUND, "not found");
    return c.json({
      name: `users/${username}/shortcuts/${sid}`,
      title: s.title,
      filter: s.filter_expr ?? "",
    });
  });

  forUser.post("/shortcuts", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = { shortcut?: { title?: string; filter?: string }; updateMask?: { paths?: string[] } };
    const body = (await c.req.json()) as Body;
    const title = body.shortcut?.title;
    if (!title) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "title required");
    const shortcutId = crypto.randomUUID();
    await repo.createShortcut({
      username,
      shortcutId,
      title,
      filter: body.shortcut?.filter ?? null,
    });
    return c.json({
      name: `users/${username}/shortcuts/${shortcutId}`,
      title,
      filter: body.shortcut?.filter ?? "",
    });
  });

  forUser.patch("/shortcuts/:sid", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = { shortcut?: { title?: string; filter?: string }; updateMask?: { paths?: string[] } };
    const body = (await c.req.json()) as Body;
    const paths = body.updateMask?.paths ?? [];
    if (paths.length === 0) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "update mask is empty");
    }
    await repo.updateShortcut(username, c.req.param("sid"), {
      title: hasPath(paths, "title") ? body.shortcut?.title : undefined,
      filter: hasPath(paths, "filter") ? body.shortcut?.filter : undefined,
    });
    const rows = await repo.listShortcuts(username);
    const s = rows.find((x) => x.shortcut_id === c.req.param("sid"));
    if (!s) return jsonError(c, GrpcCode.NOT_FOUND, "not found");
    return c.json({
      name: `users/${username}/shortcuts/${c.req.param("sid")}`,
      title: s.title,
      filter: s.filter_expr ?? "",
    });
  });

  forUser.delete("/shortcuts/:sid", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    }
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const ok = await repo.deleteShortcut(username, c.req.param("sid"));
    if (!ok) return jsonError(c, GrpcCode.NOT_FOUND, "not found");
    return c.json({});
  });

  // Linked identities (SSO) endpoints
  forUser.get("/linkedIdentities", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const userId = await repo.getUserInternalId(username);
    if (userId === null) return jsonError(c, GrpcCode.NOT_FOUND, "user not found");
    const rows = await repo.listUserIdentities(userId);
    return c.json({
      linkedIdentities: rows.map((row) => ({
        name: `users/${username}/linkedIdentities/${encodeURIComponent(row.provider)}`,
        idpName: `identity-providers/${encodeURIComponent(row.provider)}`,
        externUid: row.extern_uid,
      })),
    });
  });

  forUser.post("/linkedIdentities", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    if (auth.username !== username) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = {
      idpName?: string;
      code?: string;
      redirectUri?: string;
      codeVerifier?: string;
    };
    const body = (await c.req.json()) as Body;
    const providerUid = extractIdentityProviderUid(body.idpName ?? "");
    if (!providerUid) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid identity provider name");
    if (!body.code) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "code required");
    if (!body.redirectUri) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "redirect uri required");

    const userId = await repo.getUserInternalId(username);
    if (userId === null) return jsonError(c, GrpcCode.NOT_FOUND, "user not found");
    const provider = await repo.getIdentityProviderByUid(providerUid);
    if (!provider) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "identity provider not found");
    if (provider.type !== "OAUTH2") return jsonError(c, GrpcCode.INVALID_ARGUMENT, "unsupported identity provider type");

    let providerConfig: unknown = {};
    try {
      providerConfig = JSON.parse(provider.config);
    } catch {
      return jsonError(c, GrpcCode.INTERNAL, "invalid identity provider config");
    }
    const oauth2Config = parseOAuth2Config(providerConfig);
    if (!oauth2Config) return jsonError(c, GrpcCode.INTERNAL, "invalid identity provider config");

    let oauthAccessToken = "";
    try {
      oauthAccessToken = await exchangeOAuth2Token({
        config: oauth2Config,
        redirectUri: body.redirectUri,
        code: body.code,
        codeVerifier: body.codeVerifier,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to exchange token";
      return jsonError(c, GrpcCode.INTERNAL, message);
    }

    let userInfo: { identifier: string };
    try {
      userInfo = await fetchOAuth2UserInfo({
        config: oauth2Config,
        accessToken: oauthAccessToken,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to get user info";
      return jsonError(c, GrpcCode.INTERNAL, message);
    }

    if (provider.identifier_filter) {
      let regex: RegExp;
      try {
        regex = new RegExp(provider.identifier_filter);
      } catch {
        return jsonError(c, GrpcCode.INTERNAL, "invalid identity provider identifier filter");
      }
      if (!regex.test(userInfo.identifier)) {
        return jsonError(c, GrpcCode.PERMISSION_DENIED, "identifier is not allowed");
      }
    }

    const existingForUser = await repo.getUserIdentity(userId, providerUid);
    if (existingForUser) {
      return jsonError(c, GrpcCode.ALREADY_EXISTS, "identity provider already linked");
    }
    const existingForIdentity = await repo.getUserIdentityByProviderExternUid(providerUid, userInfo.identifier);
    if (existingForIdentity && existingForIdentity.user_id !== userId) {
      return jsonError(c, GrpcCode.ALREADY_EXISTS, "identity already linked to another user");
    }

    const row = await repo.upsertUserIdentity(userId, providerUid, userInfo.identifier);
    return c.json({
      name: `users/${username}/linkedIdentities/${encodeURIComponent(row.provider)}`,
      idpName: `identity-providers/${encodeURIComponent(row.provider)}`,
      externUid: row.extern_uid,
    });
  });

  forUser.get("/linkedIdentities/:provider", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const provider = decodeURIComponent(c.req.param("provider")!);
    const userId = await repo.getUserInternalId(username);
    if (userId === null) return jsonError(c, GrpcCode.NOT_FOUND, "user not found");
    const row = await repo.getUserIdentity(userId, provider);
    if (!row) return jsonError(c, GrpcCode.NOT_FOUND, "linked identity not found");
    return c.json({
      name: `users/${username}/linkedIdentities/${encodeURIComponent(row.provider)}`,
      idpName: `identity-providers/${encodeURIComponent(row.provider)}`,
      externUid: row.extern_uid,
    });
  });

  forUser.delete("/linkedIdentities/:provider", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const username = c.req.param("username")!;
    if (username.includes(":")) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid user resource");
    if (auth.username !== username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const provider = decodeURIComponent(c.req.param("provider")!);
    const userId = await repo.getUserInternalId(username);
    if (userId === null) return jsonError(c, GrpcCode.NOT_FOUND, "user not found");
    const ok = await repo.deleteUserIdentity(userId, provider);
    if (!ok) return jsonError(c, GrpcCode.NOT_FOUND, "linked identity not found");
    return c.json({});
  });

  r.route("/:username", forUser);

  return r;
}
