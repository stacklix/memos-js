import { Hono } from "hono";
import type { ApiVariables } from "../../types/api-variables.js";
import type { AppDeps } from "../../types/deps.js";
import type { AuthPrincipal } from "../../types/auth.js";
import { createRepository, type DbMemoRow } from "../../db/repository.js";
import { GrpcCode, jsonError } from "../../lib/grpc-status.js";
import { attachmentToJson, memoToJson } from "../../lib/serializers.js";
import { b64urlToUtf8, utf8ToB64url } from "../../lib/b64url.js";
import { normalizeMemoStateFromClient, normalizeMemoVisibilityFromClient } from "../../lib/memo-enums.js";
import {
  parseMemoLocationForCreate,
  parseMemoLocationForPatch,
} from "../../lib/memo-location.js";
import {
  MEMO_FILTER_MAX_SCAN,
  creatorUsernameFromResource,
  memoListFilterNeedsMemory,
  memoRowMatchesFilter,
  parseMemoListFilter,
} from "../../lib/memo-filter.js";
import { parseAttachmentFilter } from "../../lib/attachment-filter.js";
import { parseInstanceNotificationSetting } from "../../lib/instance-notification-setting.js";
import { dispatchMemoCommentWebhooks } from "../../services/user-webhook-dispatch.js";
import { sseBus } from "../../lib/sse-bus.js";

function memoIdFromName(name: string): string | null {
  const p = name.startsWith("memos/") ? name.slice("memos/".length) : name;
  return p.length > 0 ? p : null;
}

function canViewMemo(
  m: DbMemoRow,
  auth: AuthPrincipal | null,
  shareMode = false,
): boolean {
  if (shareMode) return true;
  if (m.visibility === "PUBLIC") return true;
  if (!auth) return false;
  if (m.visibility === "PROTECTED") return true;
  return m.creator_username === auth.username;
}

export function createMemoRoutes(deps: AppDeps) {
  const r = new Hono<{ Variables: ApiVariables }>();
  const repo = createRepository(deps.sql);

  async function memoToJsonWithAttachments(m: DbMemoRow) {
    const attachments = await repo.listAttachments({
      memoUid: m.id,
      limit: 1000,
      offset: 0,
    });
    return memoToJson(m, { attachments: attachments.map((a) => attachmentToJson(a)) });
  }

  r.get("/", async (c) => {
    const auth = c.get("auth");
    const pageSize = Math.min(
      1000,
      Math.max(1, Number(c.req.query("pageSize") ?? 50)),
    );
    const token = c.req.query("pageToken");
    let offset = 0;
    if (token) {
      const n = Number(b64urlToUtf8(token));
      offset = Number.isFinite(n) ? n : 0;
    }
    const state = (c.req.query("state") as string | undefined) ?? "NORMAL";
    const filterStr = c.req.query("filter") ?? "";
    const parsed = parseMemoListFilter(filterStr);
    const hasFilter = filterStr.trim().length > 0;

    const creatorFromFilter = parsed.creatorResource
      ? creatorUsernameFromResource(parsed.creatorResource)
      : null;

    const needsMemory = memoListFilterNeedsMemory(parsed);

    type Base = Omit<Parameters<typeof repo.listMemosTopLevel>[0], "limit" | "offset">;
    function buildFilteredBase(): Base {
      const visRaw = parsed.visibilityIn?.length ? parsed.visibilityIn : undefined;
      let visibilityIn: string[] | undefined;
      let visibilitySingle: string | undefined;
      let viewerUsername: string | undefined;

      if (!auth) {
        if (visRaw?.length) {
          visibilityIn = visRaw.filter((v) => v === "PUBLIC");
        } else {
          visibilitySingle = "PUBLIC";
        }
      } else if (visRaw?.length) {
        visibilityIn = visRaw;
      } else {
        viewerUsername = auth.username;
      }

      const timeFieldSql =
        parsed.timeField === "updated"
          ? ("update_time" as const)
          : parsed.timeField === "created"
            ? ("create_time" as const)
            : undefined;

      return {
        state,
        ...(visibilityIn?.length
          ? { visibilityIn }
          : visibilitySingle
            ? { visibility: visibilitySingle }
            : {}),
        creator: creatorFromFilter ?? undefined,
        ...(viewerUsername ? { viewerUsername } : {}),
        ...(parsed.pinned ? { pinnedOnly: true } : {}),
        ...(timeFieldSql &&
        parsed.timeStartSec !== undefined &&
        parsed.timeEndSec !== undefined
          ? {
              timeField: timeFieldSql,
              timeStartSec: parsed.timeStartSec,
              timeEndSec: parsed.timeEndSec,
            }
          : {}),
      };
    }

    let rows: DbMemoRow[];
    let next: string;

    if (!hasFilter) {
      if (!auth) {
        rows = await repo.listMemosTopLevel({
          limit: pageSize,
          offset,
          state,
          visibility: "PUBLIC",
        });
      } else {
        rows = await repo.listMemosTopLevel({
          limit: pageSize,
          offset,
          state,
          viewerUsername: auth.username,
        });
      }
      next = rows.length === pageSize ? utf8ToB64url(String(offset + pageSize)) : "";
    } else {
      const base = buildFilteredBase();
      if (!auth && parsed.visibilityIn?.length && !(base as { visibilityIn?: string[] }).visibilityIn?.length) {
        return c.json({ memos: [], nextPageToken: "" });
      }
      if (needsMemory) {
        const all = await repo.listMemosTopLevel({
          ...base,
          limit: MEMO_FILTER_MAX_SCAN,
          offset: 0,
        });
        const filtered = all.filter((m) => memoRowMatchesFilter(m, parsed));
        rows = filtered.slice(offset, offset + pageSize);
        next =
          filtered.length > offset + pageSize ? utf8ToB64url(String(offset + pageSize)) : "";
      } else {
        rows = await repo.listMemosTopLevel({
          ...base,
          limit: pageSize,
          offset,
        });
        next = rows.length === pageSize ? utf8ToB64url(String(offset + pageSize)) : "";
      }
    }

    return c.json({
      memos: await Promise.all(rows.map((m) => memoToJsonWithAttachments(m))),
      nextPageToken: next,
    });
  });

  r.post("/", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    type MemoBody = {
      content?: string;
      visibility?: unknown;
      state?: unknown;
      pinned?: boolean;
      location?: unknown;
    };
    // Match golang v0.26.x contract: request body is Memo fields at top-level.
    const m = (await c.req.json()) as MemoBody;
    if (!m?.content) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "memo.content required");
    const locIn = parseMemoLocationForCreate(m.location);
    if (!locIn.ok) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, locIn.message);
    }
    const visibility = normalizeMemoVisibilityFromClient(m.visibility);
    const state = normalizeMemoStateFromClient(m.state);
    const id = crypto.randomUUID();
    const row = await repo.createMemo({
      id,
      creator: auth.username,
      content: m.content,
      visibility,
      state,
      pinned: Boolean(m.pinned),
      location: locIn.value,
    });
    sseBus.emit({ type: "memo.created", name: `memos/${row.id}` });
    return c.json(memoToJson(row));
  });

  r.get("/:id", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const row = await repo.getMemoById(id);
    if (!row || row.parent_memo_id) {
      return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    }
    if (row.state === "ARCHIVED") {
      if (
        !auth ||
        auth.username !== row.creator_username
      ) {
        return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
      }
    }
    if (row.visibility !== "PUBLIC" && !auth) {
      return jsonError(c, GrpcCode.UNAUTHENTICATED, "user not authenticated");
    }
    if (!canViewMemo(row, auth)) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    return c.json(await memoToJsonWithAttachments(row));
  });

  r.patch("/:id", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const id = c.req.param("id");
    const row = await repo.getMemoById(id);
    if (!row) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    if (row.creator_username !== auth.username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type MemoBody = {
      content?: string;
      visibility?: unknown;
      state?: unknown;
      pinned?: boolean;
      displayTime?: string;
      location?: unknown;
    };
    // Match golang v0.26.x contract: request body is Memo fields at top-level.
    const m = (await c.req.json()) as MemoBody;
    if (!m) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "memo required");
    const locPatch = parseMemoLocationForPatch(m.location);
    if (locPatch.kind === "error") {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, locPatch.message);
    }
    const locUpdate =
      locPatch.kind === "clear"
        ? { location: null }
        : locPatch.kind === "set"
          ? { location: locPatch.value }
          : {};
    await repo.updateMemo(id, {
      content: m.content,
      visibility: m.visibility !== undefined ? normalizeMemoVisibilityFromClient(m.visibility) : undefined,
      state: m.state !== undefined ? normalizeMemoStateFromClient(m.state) : undefined,
      pinned: m.pinned,
      display_time: m.displayTime ?? null,
      ...locUpdate,
    });
    sseBus.emit({ type: "memo.updated", name: `memos/${id}` });
    const next = await repo.getMemoById(id);
    if (!next) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    return c.json(await memoToJsonWithAttachments(next));
  });

  r.delete("/:id", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const id = c.req.param("id");
    const row = await repo.getMemoById(id);
    if (!row) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    if (row.creator_username !== auth.username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    if (c.req.query("force") === "true") {
      await repo.hardDeleteMemo(id);
    } else {
      await repo.archiveMemo(id);
    }
    sseBus.emit({ type: "memo.deleted", name: `memos/${id}` });
    return c.json({});
  });

  r.get("/:id/attachments", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const parent = await repo.getMemoById(id);
    if (!parent || parent.parent_memo_id) {
      return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    }
    if (!canViewMemo(parent, auth)) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const pageSize = Math.min(1000, Math.max(1, Number(c.req.query("pageSize") ?? 50)));
    const token = c.req.query("pageToken");
    const offset = token ? Number(token) : 0;
    if (token && !Number.isFinite(offset)) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid page token");
    }
    const filter = c.req.query("filter") ?? "";
    let parsedFilter: { unlinkedOnly?: boolean; linkedOnly?: boolean; memoUid?: string };
    try {
      parsedFilter = parseAttachmentFilter(filter);
    } catch {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid filter");
    }
    // Memo attachments endpoint is scoped by memo id; reject contradictory filter explicitly.
    if (parsedFilter.unlinkedOnly) {
      return c.json({ attachments: [], nextPageToken: "" });
    }
    if (parsedFilter.memoUid && parsedFilter.memoUid !== id) {
      return c.json({ attachments: [], nextPageToken: "" });
    }
    const rows = await repo.listAttachments({
      memoUid: id,
      limit: pageSize,
      offset: Number.isFinite(offset) ? offset : 0,
      ...(parsedFilter.linkedOnly ? { linkedOnly: true } : {}),
    });
    return c.json({
      attachments: rows.map((x) => attachmentToJson(x)),
      nextPageToken:
        rows.length === pageSize ? String((Number.isFinite(offset) ? offset : 0) + pageSize) : "",
    });
  });
  r.patch("/:id/attachments", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const id = c.req.param("id");
    const parent = await repo.getMemoById(id);
    if (!parent || parent.parent_memo_id) {
      return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    }
    if (parent.creator_username !== auth.username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = { attachments?: { name?: string }[] };
    const body = (await c.req.json()) as Body;
    const attachmentIds =
      body.attachments
        ?.map((a) => a.name?.replace(/^attachments\//, ""))
        .filter((x): x is string => Boolean(x)) ?? [];
    await repo.setMemoAttachments(id, attachmentIds);
    return c.json({});
  });

  r.get("/:id/comments", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const parent = await repo.getMemoById(id);
    if (!parent || parent.parent_memo_id) {
      return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    }
    if (!canViewMemo(parent, auth)) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const comments = await repo.listCommentsForMemo(id);
    return c.json({
      memos: await Promise.all(comments.map((m) => memoToJsonWithAttachments(m))),
      nextPageToken: "",
      totalSize: comments.length,
    });
  });

  r.post("/:id/comments", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const id = c.req.param("id");
    const parent = await repo.getMemoById(id);
    if (!parent || parent.parent_memo_id) {
      return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    }
    if (!canViewMemo(parent, auth)) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = {
      comment?: { content?: string; visibility?: unknown; state?: unknown; location?: unknown };
    };
    const body = (await c.req.json()) as Body;
    const content = body.comment?.content;
    if (!content) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "comment.content required");
    const locIn = parseMemoLocationForCreate(body.comment?.location);
    if (!locIn.ok) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, locIn.message);
    }
    const cid = crypto.randomUUID();
    const visRaw = body.comment?.visibility;
    const stateRaw = body.comment?.state;
    const row = await repo.createMemo({
      id: cid,
      creator: auth.username,
      content,
      visibility:
        visRaw !== undefined && visRaw !== null
          ? normalizeMemoVisibilityFromClient(visRaw)
          : parent.visibility,
      state: stateRaw !== undefined && stateRaw !== null ? normalizeMemoStateFromClient(stateRaw) : "NORMAL",
      pinned: false,
      parentId: id,
      location: locIn.value,
    });
    if (
      row.visibility !== "PRIVATE" &&
      auth.username !== parent.creator_username
    ) {
      // Best-effort external delivery; inbox notification remains source of truth.
      await dispatchMemoCommentWebhooks({
        repo,
        receiverUsername: parent.creator_username,
        senderUsername: auth.username,
        commentMemoUid: row.id,
        relatedMemoUid: parent.id,
      });
      const receiver = await repo.getUser(parent.creator_username);
      const receiverEmail = receiver?.email?.trim() ?? "";
      if (receiverEmail) {
        const notificationSetting = parseInstanceNotificationSetting(
          await repo.getInstanceSettingRaw("NOTIFICATION"),
        );
        const emailSetting = notificationSetting.email;
        if (
          deps.sendNotificationEmail &&
          emailSetting.enabled &&
          emailSetting.smtpHost.trim() &&
          emailSetting.smtpPort > 0 &&
          emailSetting.fromEmail.trim()
        ) {
          const senderLabel = auth.username;
          const subject = `[memos] New comment from ${senderLabel}`;
          const text =
            `${senderLabel} commented on your memo.\n\n` +
            `Comment: ${deps.instanceUrl}/m/${row.id}\n` +
            `Memo: ${deps.instanceUrl}/m/${parent.id}\n`;
          await Promise.allSettled([
            deps.sendNotificationEmail({
              smtpHost: emailSetting.smtpHost,
              smtpPort: emailSetting.smtpPort,
              smtpUsername: emailSetting.smtpUsername,
              smtpPassword: emailSetting.smtpPassword,
              useTls: emailSetting.useTls,
              useSsl: emailSetting.useSsl,
              fromEmail: emailSetting.fromEmail,
              fromName: emailSetting.fromName,
              replyTo: emailSetting.replyTo,
              to: receiverEmail,
              subject,
              text,
            }),
          ]);
        }
      }
    }
    sseBus.emit({ type: "memo.comment.created", name: `memos/${row.id}`, parent: `memos/${id}` });
    return c.json(await memoToJsonWithAttachments(row));
  });

  r.get("/:id/reactions", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const parent = await repo.getMemoById(id);
    if (!parent) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    if (!canViewMemo(parent, auth)) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const rx = await repo.listReactions(id);
    return c.json({
      reactions: rx.map((x) => ({
        name: `memos/${id}/reactions/${x.id}`,
        creator: `users/${x.creator_username}`,
        contentId: `memos/${id}`,
        reactionType: x.reaction_type,
        createTime: x.create_time,
      })),
      nextPageToken: "",
      totalSize: rx.length,
    });
  });

  r.post("/:id/reactions", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const id = c.req.param("id");
    const parent = await repo.getMemoById(id);
    if (!parent) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    if (!canViewMemo(parent, auth)) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = { reaction?: { reactionType?: string } };
    const body = (await c.req.json()) as Body;
    const rt = body.reaction?.reactionType;
    if (!rt) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "reactionType required");
    const rid = crypto.randomUUID();
    await repo.upsertReaction({
      id: rid,
      memoId: id,
      creator: auth.username,
      reactionType: rt,
    });
    sseBus.emit({ type: "reaction.upserted", name: `memos/${id}/reactions/${rid}`, parent: `memos/${id}` });
    const list = await repo.listReactions(id);
    const x = list.find((l) => l.creator_username === auth.username && l.reaction_type === rt);
    if (!x) return jsonError(c, GrpcCode.INTERNAL, "failed to read reaction");
    return c.json({
      name: `memos/${id}/reactions/${x.id}`,
      creator: `users/${auth.username}`,
      contentId: `memos/${id}`,
      reactionType: rt,
      createTime: x.create_time,
    });
  });

  r.delete("/:memoId/reactions/:rid", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const memoId = c.req.param("memoId");
    const parent = await repo.getMemoById(memoId);
    if (!parent) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    const rxRows = await repo.listReactions(memoId);
    const rx = rxRows.find((x) => x.id === c.req.param("rid"));
    if (!rx) return jsonError(c, GrpcCode.NOT_FOUND, "reaction not found");
    if (rx.creator_username !== auth.username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    await repo.deleteReaction(memoId, c.req.param("rid"));
    sseBus.emit({ type: "reaction.deleted", name: `memos/${memoId}/reactions/${c.req.param("rid")}`, parent: `memos/${memoId}` });
    return c.json({});
  });

  r.get("/:id/relations", async (c) => {
    const auth = c.get("auth");
    const id = c.req.param("id");
    const parent = await repo.getMemoById(id);
    if (!parent) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    if (!canViewMemo(parent, auth)) {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const rels = await repo.listMemoRelations(id);
    const out = [];
    for (const rel of rels) {
      const related = await repo.getMemoById(rel.related_memo_id);
      out.push({
        memo: { name: `memos/${id}`, snippet: parent.snippet ?? "" },
        relatedMemo: {
          name: `memos/${rel.related_memo_id}`,
          snippet: related?.snippet ?? "",
        },
        type: rel.relation_type,
      });
    }
    return c.json({ relations: out, nextPageToken: "", totalSize: out.length });
  });

  r.patch("/:id/relations", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const id = c.req.param("id");
    const parent = await repo.getMemoById(id);
    if (!parent) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    if (parent.creator_username !== auth.username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = {
      relations?: { relatedMemo?: { name?: string }; type?: string }[];
    };
    const body = (await c.req.json()) as Body;
    const pairs =
      body.relations?.map((rel) => {
        const rn = rel.relatedMemo?.name;
        const rid = rn ? memoIdFromName(rn) : null;
        return rid ? { relatedId: rid, type: rel.type ?? "REFERENCE" } : null;
      }) ?? [];
    await repo.setMemoRelations(
      id,
      pairs.filter((p): p is { relatedId: string; type: string } => Boolean(p)),
    );
    return c.json({});
  });

  r.get("/:id/shares", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const id = c.req.param("id");
    const parent = await repo.getMemoById(id);
    if (!parent) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    if (parent.creator_username !== auth.username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const rows = await repo.listShares(id);
    return c.json({
      shares: rows.map((s) => ({
        name: `memos/${id}/shares/${s.share_token}`,
        createTime: s.created_at,
        expireTime: s.expires_at ?? undefined,
      })),
    });
  });

  r.post("/:id/shares", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const id = c.req.param("id");
    const parent = await repo.getMemoById(id);
    if (!parent) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    if (parent.creator_username !== auth.username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = { memoShare?: { expireTime?: string } };
    const body = (await c.req.json()) as Body;
    const token = crypto.randomUUID().replace(/-/g, "");
    const shareId = crypto.randomUUID();
    await repo.createShare({
      id: shareId,
      memoId: id,
      token,
      expiresAt: body.memoShare?.expireTime ?? null,
    });
    return c.json({
      name: `memos/${id}/shares/${token}`,
      createTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      expireTime: body.memoShare?.expireTime,
    });
  });

  r.delete("/:memoId/shares/:shareSeg", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const memoId = c.req.param("memoId");
    const parent = await repo.getMemoById(memoId);
    if (!parent) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    if (parent.creator_username !== auth.username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const ok = await repo.deleteShareByName(memoId, c.req.param("shareSeg"));
    if (!ok) return jsonError(c, GrpcCode.NOT_FOUND, "share not found");
    return c.json({});
  });

  return r;
}

export function createShareByTokenRoute(deps: AppDeps) {
  const r = new Hono<{ Variables: ApiVariables }>();
  const repo = createRepository(deps.sql);
  async function memoToJsonWithAttachments(m: DbMemoRow) {
    const attachments = await repo.listAttachments({
      memoUid: m.id,
      limit: 1000,
      offset: 0,
    });
    return memoToJson(m, { attachments: attachments.map((a) => attachmentToJson(a)) });
  }
  r.get("/:shareId", async (c) => {
    const memoId = await repo.getMemoIdByShareToken(c.req.param("shareId"));
    if (!memoId) return jsonError(c, GrpcCode.NOT_FOUND, "share not found");
    const row = await repo.getMemoById(memoId);
    if (!row) return jsonError(c, GrpcCode.NOT_FOUND, "memo not found");
    return c.json(await memoToJsonWithAttachments(row));
  });
  return r;
}
