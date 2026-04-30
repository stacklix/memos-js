import type { SqlAdapter, SqlPrimitive } from "./sql-adapter.js";
import type { UserRole } from "../types/auth.js";
import { randomTokenHex, sha256Hex } from "../services/crypto-util.js";
import { deriveMemoProperty } from "../services/memo-content-props.js";
import {
  memoReactionContentId,
  parseMemoPayloadGolang,
  rebuildMemoPayloadFromContent,
  stringifyMemoPayload,
  type MemoPayloadGolang,
} from "../lib/memo-payload.js";
import {
  newUserWebhookId,
  parseWebhooksFromUserSettingValue,
  serializeWebhooksUserSetting,
  type StoredUserWebhook,
} from "../lib/user-webhooks-setting.js";
import {
  parsePersonalAccessTokensUserSetting,
  parseRefreshTokensUserSetting,
  parseShortcutsUserSetting,
  serializePersonalAccessTokensUserSetting,
  serializeRefreshTokensUserSetting,
  serializeShortcutsUserSetting,
  USER_SETTING_KEY_PERSONAL_ACCESS_TOKENS,
  USER_SETTING_KEY_REFRESH_TOKENS,
  USER_SETTING_KEY_SHORTCUTS,
} from "../lib/user-setting-auth-shortcuts.js";

const DEFAULT_CUSTOM_PROFILE = {
  title: "",
  description: "",
  logoUrl: "",
};

const DEFAULT_GENERAL = {
  disallowUserRegistration: false,
  disallowPasswordAuth: false,
  additionalScript: "",
  additionalStyle: "",
  customProfile: { ...DEFAULT_CUSTOM_PROFILE },
  weekStartDayOffset: 0,
  disallowChangeUsername: false,
  disallowChangeNickname: false,
};

function parseStringField(raw: Record<string, unknown>, key: string, snakeKey: string): string {
  const v = raw[key] ?? raw[snakeKey];
  return typeof v === "string" ? v : "";
}

function parseCustomProfile(raw: Record<string, unknown>): typeof DEFAULT_CUSTOM_PROFILE {
  const cp = (raw.customProfile ?? raw.custom_profile) as Record<string, unknown> | undefined;
  return {
    title: parseStringField(cp ?? {}, "title", "title"),
    description: parseStringField(cp ?? {}, "description", "description"),
    logoUrl: parseStringField(cp ?? {}, "logoUrl", "logo_url"),
  };
}

function isoToUnixSec(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** Same string as golang `store.MemoRelationComment`. */
const MEMO_RELATION_COMMENT = "COMMENT";

function unixSecToIso(sec: number | bigint): string {
  const n = typeof sec === "bigint" ? Number(sec) : sec;
  return new Date(n * 1000).toISOString();
}

function parseMemoCommentFromInboxMessage(
  message: string,
): { memoId: number; relatedMemoId: number } | null {
  try {
    const j = JSON.parse(message) as Record<string, unknown>;
    if (j.type !== "MEMO_COMMENT") return null;
    const mc = (j.memoComment ?? j.memo_comment) as Record<string, unknown> | undefined;
    if (!mc || typeof mc !== "object") return null;
    const memoId = Number(mc.memoId ?? mc.memo_id);
    const relatedMemoId = Number(mc.relatedMemoId ?? mc.related_memo_id);
    if (!Number.isFinite(memoId) || !Number.isFinite(relatedMemoId)) return null;
    return { memoId, relatedMemoId };
  } catch {
    return null;
  }
}

/** Row shape used by routes / serializers (unchanged API surface). */
export type DbUserRow = {
  username: string;
  password_hash: string;
  role: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  description: string | null;
  state: string;
  create_time: string;
  update_time: string;
  deleted: number;
};

/** Inbox-backed notification row for API mapping (MEMO_COMMENT only). */
export type DbUserNotificationRow = {
  inbox_id: number;
  sender_username: string;
  create_time: string;
  status: string;
  comment_memo_uid: string | null;
  related_memo_uid: string | null;
};

export type DbMemoRow = {
  id: string;
  creator_username: string;
  content: string;
  visibility: string;
  state: string;
  pinned: number;
  create_time: string;
  update_time: string;
  display_time: string | null;
  snippet: string | null;
  parent_memo_id: string | null;
  deleted: number;
  location_placeholder: string | null;
  location_latitude: number | null;
  location_longitude: number | null;
  /** From `memo.payload.tags` (golang `MemoPayload.tags`). */
  payload_tags: string[];
  /** From `memo.payload.property` when present. */
  payload_property: ReturnType<typeof deriveMemoProperty> | null;
};

export type DbAttachmentRow = {
  id: string;
  creator_username: string;
  create_time: string;
  update_time: string;
  filename: string;
  blob: Uint8Array<ArrayBufferLike> | null;
  type: string;
  size: number;
  memo_id: string | null;
  storage_type: string;
  reference: string;
  payload: string;
};

export type DbIdentityProviderRow = {
  uid: string;
  name: string;
  type: string;
  identifier_filter: string;
  config: string;
};

export type DbUserIdentityRow = {
  id: number;
  user_id: number;
  provider: string;
  extern_uid: string;
  created_ts: number;
  updated_ts: number;
};

type SqlUserRow = {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  email: string;
  nickname: string;
  avatar_url: string;
  description: string;
  row_status: string;
  created_ts: number | bigint;
  updated_ts: number | bigint;
};

function mapUserRow(r: SqlUserRow): DbUserRow {
  return {
    username: r.username,
    password_hash: r.password_hash,
    role: r.role,
    display_name: r.nickname || null,
    email: r.email || null,
    avatar_url: r.avatar_url || null,
    description: r.description || null,
    state: r.row_status,
    create_time: unixSecToIso(r.created_ts),
    update_time: unixSecToIso(r.updated_ts),
    deleted: r.row_status === "ARCHIVED" ? 1 : 0,
  };
}

type SqlMemoRow = {
  uid: string;
  content: string;
  visibility: string;
  row_status: string;
  pinned: number;
  created_ts: number | bigint;
  updated_ts: number | bigint;
  payload: string;
  creator_username: string;
  parent_uid?: string | null;
};

type SqlAttachmentRow = {
  uid: string;
  creator_username: string;
  created_ts: number | bigint;
  updated_ts: number | bigint;
  filename: string;
  blob: Uint8Array<ArrayBufferLike> | null;
  type: string;
  size: number;
  memo_uid: string | null;
  storage_type: string;
  reference: string;
  payload: string;
};

/**
 * golang: `memo.payload` is `memos.store.MemoPayload` JSON; display time in API comes from
 * `created_ts` / `updated_ts` per instance MEMO_RELATED (see `memo_service_converter.go`).
 */
function mapMemoRow(r: SqlMemoRow, displayWithUpdateTime: boolean): DbMemoRow {
  const pl = parseMemoPayloadGolang(r.payload);
  const loc = pl.location;
  const displayTs = displayWithUpdateTime ? r.updated_ts : r.created_ts;
  const snippet = r.content.slice(0, 200);
  const apiState = r.row_status === "ARCHIVED" ? "ARCHIVED" : "NORMAL";
  const pp = pl.property;
  const payloadProperty =
    pp &&
    typeof pp.hasLink === "boolean" &&
    typeof pp.hasTaskList === "boolean" &&
    typeof pp.hasCode === "boolean" &&
    typeof pp.hasIncompleteTasks === "boolean"
      ? {
          hasLink: pp.hasLink,
          hasTaskList: pp.hasTaskList,
          hasCode: pp.hasCode,
          hasIncompleteTasks: pp.hasIncompleteTasks,
          title: pp.title ?? "",
        }
      : null;
  return {
    id: r.uid,
    creator_username: r.creator_username,
    content: r.content,
    visibility: r.visibility,
    state: apiState,
    pinned: r.pinned,
    create_time: unixSecToIso(r.created_ts),
    update_time: unixSecToIso(r.updated_ts),
    display_time: unixSecToIso(displayTs),
    snippet,
    parent_memo_id: r.parent_uid ?? null,
    deleted: r.row_status === "ARCHIVED" ? 1 : 0,
    location_placeholder: loc?.placeholder ?? null,
    location_latitude: loc?.latitude ?? null,
    location_longitude: loc?.longitude ?? null,
    payload_tags: pl.tags ?? [],
    payload_property: payloadProperty,
  };
}

function mapAttachmentRow(r: SqlAttachmentRow): DbAttachmentRow {
  return {
    id: r.uid,
    creator_username: r.creator_username,
    create_time: unixSecToIso(r.created_ts),
    update_time: unixSecToIso(r.updated_ts),
    filename: r.filename,
    blob: r.blob ?? null,
    type: r.type,
    size: Number(r.size ?? 0),
    memo_id: r.memo_uid ?? null,
    storage_type: r.storage_type ?? "",
    reference: r.reference ?? "",
    payload: r.payload ?? "{}",
  };
}

export function createRepository(sql: SqlAdapter) {
  async function memoDisplayWithUpdateTime(): Promise<boolean> {
    const row = await sql.queryOne<{ value: string }>(
      "SELECT value FROM system_setting WHERE name = 'MEMO_RELATED'",
    );
    if (!row?.value) return false;
    try {
      const j = JSON.parse(row.value) as { displayWithUpdateTime?: boolean };
      return Boolean(j.displayWithUpdateTime);
    } catch {
      return false;
    }
  }

  async function resolveMemoInternalId(uid: string): Promise<number | null> {
    const r = await sql.queryOne<{ id: number }>("SELECT id FROM memo WHERE uid = ?", [
      uid,
    ]);
    return r?.id ?? null;
  }

  async function lookupMemoUidsForInternalIds(ids: number[]): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    const uniq = [...new Set(ids)].filter((x) => Number.isFinite(x) && x > 0);
    if (uniq.length === 0) return map;
    const placeholders = uniq.map(() => "?").join(",");
    const rows = await sql.queryAll<{ id: number; uid: string }>(
      `SELECT id, uid FROM memo WHERE id IN (${placeholders}) AND row_status != 'ARCHIVED'`,
      uniq,
    );
    for (const r of rows) map.set(r.id, r.uid);
    return map;
  }

  async function fetchMemoCommentNotificationForUser(
    username: string,
    inboxId: number,
  ): Promise<DbUserNotificationRow | null> {
    const row = await sql.queryOne<{
      id: number;
      created_ts: number | bigint;
      status: string;
      message: string;
      sender_username: string;
    }>(
      `SELECT i.id, i.created_ts, i.status, i.message, su.username AS sender_username
       FROM inbox i
       INNER JOIN user ru ON ru.id = i.receiver_id AND ru.row_status = 'NORMAL'
       INNER JOIN user su ON su.id = i.sender_id AND su.row_status = 'NORMAL'
       WHERE ru.username = ? AND i.id = ?
         AND json_extract(i.message, '$.type') = 'MEMO_COMMENT'`,
      [username, inboxId],
    );
    if (!row) return null;
    const p = parseMemoCommentFromInboxMessage(row.message);
    if (!p) return null;
    const uidMap = await lookupMemoUidsForInternalIds([p.memoId, p.relatedMemoId]);
    return {
      inbox_id: row.id,
      sender_username: row.sender_username,
      create_time: unixSecToIso(row.created_ts),
      status: row.status,
      comment_memo_uid: uidMap.get(p.memoId) ?? null,
      related_memo_uid: uidMap.get(p.relatedMemoId) ?? null,
    };
  }

  const memoSelectFields = `
    m.uid, m.content, m.visibility, m.row_status, m.pinned, m.created_ts, m.updated_ts, m.payload,
    u.username AS creator_username,
    parent.uid AS parent_uid`;

  const memoJoins = `
    FROM memo m
    INNER JOIN user u ON u.id = m.creator_id
    LEFT JOIN memo_relation com ON com.memo_id = m.id AND com.type = '${MEMO_RELATION_COMMENT}'
    LEFT JOIN memo parent ON parent.id = com.related_memo_id`;

  return {
    sql,

    async getSecretKey(): Promise<string | null> {
      const row = await sql.queryOne<{ value: string }>(
        "SELECT value FROM system_setting WHERE name = 'secret_key'",
      );
      return row?.value ?? null;
    },

    async setSecretKey(value: string): Promise<void> {
      await sql.execute(
        `INSERT INTO system_setting (name, value, description) VALUES ('secret_key', ?, '')
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
        [value],
      );
    },

    async ensureSecretKey(): Promise<string> {
      const existing = await this.getSecretKey();
      if (existing) return existing;
      const v = crypto.randomUUID();
      await this.setSecretKey(v);
      return v;
    },

    async getGeneralSetting(): Promise<typeof DEFAULT_GENERAL> {
      const row = await sql.queryOne<{ value: string }>(
        "SELECT value FROM system_setting WHERE name = 'GENERAL'",
      );
      if (!row) return { ...DEFAULT_GENERAL, customProfile: { ...DEFAULT_CUSTOM_PROFILE } };
      try {
        const parsed = JSON.parse(row.value) as Record<string, unknown>;
        const weekOffset = parsed.weekStartDayOffset ?? parsed.week_start_day_offset;
        return {
          disallowUserRegistration: Boolean(
            parsed.disallowUserRegistration ?? parsed.disallow_user_registration,
          ),
          disallowPasswordAuth: Boolean(
            parsed.disallowPasswordAuth ?? parsed.disallow_password_auth,
          ),
          additionalScript: parseStringField(parsed, "additionalScript", "additional_script"),
          additionalStyle: parseStringField(parsed, "additionalStyle", "additional_style"),
          customProfile: parseCustomProfile(parsed),
          weekStartDayOffset: typeof weekOffset === "number" ? weekOffset : 0,
          disallowChangeUsername: Boolean(
            parsed.disallowChangeUsername ?? parsed.disallow_change_username,
          ),
          disallowChangeNickname: Boolean(
            parsed.disallowChangeNickname ?? parsed.disallow_change_nickname,
          ),
        };
      } catch {
        return { ...DEFAULT_GENERAL, customProfile: { ...DEFAULT_CUSTOM_PROFILE } };
      }
    },

    async upsertGeneralSetting(patch: Partial<typeof DEFAULT_GENERAL>): Promise<void> {
      const cur = await this.getGeneralSetting();
      const next = { ...cur };
      if (patch.disallowUserRegistration !== undefined) {
        next.disallowUserRegistration = patch.disallowUserRegistration;
      }
      if (patch.disallowPasswordAuth !== undefined) {
        next.disallowPasswordAuth = patch.disallowPasswordAuth;
      }
      if (patch.additionalScript !== undefined) {
        next.additionalScript = patch.additionalScript;
      }
      if (patch.additionalStyle !== undefined) {
        next.additionalStyle = patch.additionalStyle;
      }
      if (patch.customProfile !== undefined) {
        next.customProfile = {
          title: typeof patch.customProfile.title === "string" ? patch.customProfile.title : cur.customProfile.title,
          description: typeof patch.customProfile.description === "string" ? patch.customProfile.description : cur.customProfile.description,
          logoUrl: typeof patch.customProfile.logoUrl === "string" ? patch.customProfile.logoUrl : cur.customProfile.logoUrl,
        };
      }
      if (typeof patch.weekStartDayOffset === "number") {
        next.weekStartDayOffset = patch.weekStartDayOffset;
      }
      if (patch.disallowChangeUsername !== undefined) {
        next.disallowChangeUsername = patch.disallowChangeUsername;
      }
      if (patch.disallowChangeNickname !== undefined) {
        next.disallowChangeNickname = patch.disallowChangeNickname;
      }
      await sql.execute(
        `INSERT INTO system_setting (name, value, description) VALUES ('GENERAL', ?, '')
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
        [JSON.stringify(next)],
      );
    },

    async getInstanceSettingRaw(key: string): Promise<string | null> {
      const row = await sql.queryOne<{ value: string }>(
        "SELECT value FROM system_setting WHERE name = ?",
        [key],
      );
      return row?.value ?? null;
    },

    async upsertInstanceSettingRaw(key: string, jsonValue: string): Promise<void> {
      await sql.execute(
        `INSERT INTO system_setting (name, value, description) VALUES (?, ?, '')
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
        [key, jsonValue],
      );
    },

    async getMemoRelatedDisplayWithUpdateTime(): Promise<boolean> {
      const raw = await this.getInstanceSettingRaw("MEMO_RELATED");
      if (!raw) return false;
      try {
        const j = JSON.parse(raw) as { displayWithUpdateTime?: boolean };
        return Boolean(j.displayWithUpdateTime);
      } catch {
        return false;
      }
    },

    async userCount(): Promise<number> {
      const row = await sql.queryOne<{ c: number }>(
        "SELECT COUNT(*) as c FROM user WHERE row_status = 'NORMAL'",
      );
      return row?.c ?? 0;
    },

    async findAdmin(): Promise<DbUserRow | null> {
      const r = await sql.queryOne<SqlUserRow>(
        "SELECT * FROM user WHERE row_status = 'NORMAL' AND role = 'ADMIN' ORDER BY created_ts ASC LIMIT 1",
      );
      return r ? mapUserRow(r) : null;
    },

    async getUser(username: string): Promise<DbUserRow | null> {
      const r = await sql.queryOne<SqlUserRow>(
        "SELECT * FROM user WHERE username = ? AND row_status = 'NORMAL'",
        [username],
      );
      return r ? mapUserRow(r) : null;
    },

    async getUserAnyState(username: string): Promise<DbUserRow | null> {
      const r = await sql.queryOne<SqlUserRow>(
        "SELECT * FROM user WHERE username = ?",
        [username],
      );
      return r ? mapUserRow(r) : null;
    },

    async getUserInternalId(username: string): Promise<number | null> {
      const r = await sql.queryOne<{ id: number }>(
        "SELECT id FROM user WHERE username = ? AND row_status = 'NORMAL'",
        [username],
      );
      return r?.id ?? null;
    },

    async getUserByInternalId(id: number): Promise<DbUserRow | null> {
      const r = await sql.queryOne<SqlUserRow>(
        "SELECT * FROM user WHERE id = ? AND row_status = 'NORMAL'",
        [id],
      );
      return r ? mapUserRow(r) : null;
    },

    async createUser(args: {
      username: string;
      passwordHash: string;
      role: UserRole;
      displayName?: string;
      email?: string;
    }): Promise<DbUserRow> {
      await sql.execute(
        `INSERT INTO user (username, password_hash, role, nickname, email, row_status)
         VALUES (?, ?, ?, ?, ?, 'NORMAL')`,
        [
          args.username,
          args.passwordHash,
          args.role,
          args.displayName ?? "",
          args.email ?? "",
        ],
      );
      const u = await this.getUser(args.username);
      if (!u) throw new Error("user missing after insert");
      return u;
    },

    async listUsers(args: { limit: number; offset: number }): Promise<DbUserRow[]> {
      const rows = await sql.queryAll<SqlUserRow>(
        "SELECT * FROM user WHERE row_status = 'NORMAL' ORDER BY created_ts ASC LIMIT ? OFFSET ?",
        [args.limit, args.offset],
      );
      return rows.map(mapUserRow);
    },

    async updateUser(
      username: string,
      fields: {
        display_name?: string | null;
        email?: string | null;
        avatar_url?: string | null;
        description?: string | null;
        password_hash?: string;
        role?: UserRole;
        state?: string;
      },
    ): Promise<void> {
      const sets: string[] = [];
      const vals: SqlPrimitive[] = [];
      if (fields.display_name !== undefined) {
        sets.push("nickname = ?");
        vals.push(fields.display_name ?? "");
      }
      if (fields.email !== undefined) {
        sets.push("email = ?");
        vals.push(fields.email ?? "");
      }
      if (fields.avatar_url !== undefined) {
        sets.push("avatar_url = ?");
        vals.push(fields.avatar_url ?? "");
      }
      if (fields.description !== undefined) {
        sets.push("description = ?");
        vals.push(fields.description ?? "");
      }
      if (fields.password_hash !== undefined) {
        sets.push("password_hash = ?");
        vals.push(fields.password_hash);
      }
      if (fields.role !== undefined) {
        sets.push("role = ?");
        vals.push(fields.role);
      }
      if (fields.state !== undefined) {
        sets.push("row_status = ?");
        vals.push(fields.state);
      }
      sets.push("updated_ts = strftime('%s', 'now')");
      vals.push(username);
      if (sets.length === 1) return;
      await sql.execute(
        `UPDATE user SET ${sets.join(", ")} WHERE username = ?`,
        vals,
      );
    },

    /** Rename login username (unique). Caller validates format and permissions. */
    async renameUser(fromUsername: string, toUsername: string): Promise<void> {
      const clash = await sql.queryOne<{ id: number }>(
        "SELECT id FROM user WHERE username = ?",
        [toUsername],
      );
      if (clash) {
        throw new Error("username already exists");
      }
      await sql.execute(
        "UPDATE user SET username = ?, updated_ts = strftime('%s', 'now') WHERE username = ?",
        [toUsername, fromUsername],
      );
    },

    async softDeleteUser(username: string): Promise<void> {
      await sql.execute(
        "UPDATE user SET row_status = 'ARCHIVED', updated_ts = strftime('%s', 'now') WHERE username = ?",
        [username],
      );
    },

    async addRefreshSession(args: {
      username: string;
      tokenId: string;
      expiresAt: Date;
      createdAt: Date;
    }): Promise<void> {
      const raw = await this.getUserSetting(args.username, USER_SETTING_KEY_REFRESH_TOKENS);
      const doc = parseRefreshTokensUserSetting(raw);
      doc.refreshTokens.push({
        tokenId: args.tokenId,
        expiresAt: args.expiresAt.toISOString(),
        createdAt: args.createdAt.toISOString(),
      });
      await this.upsertUserSetting(
        args.username,
        USER_SETTING_KEY_REFRESH_TOKENS,
        serializeRefreshTokensUserSetting(doc),
      );
    },

    async getRefreshTokenRecord(
      userId: number,
      tokenId: string,
    ): Promise<{ username: string; expires_at_iso: string } | null> {
      const r = await sql.queryOne<{ username: string; value: string }>(
        `SELECT u.username, s.value FROM user_setting s
         INNER JOIN user u ON u.id = s.user_id AND u.row_status = 'NORMAL'
         WHERE u.id = ? AND s.key = ?`,
        [userId, USER_SETTING_KEY_REFRESH_TOKENS],
      );
      if (!r) return null;
      const doc = parseRefreshTokensUserSetting(r.value);
      const t = doc.refreshTokens.find((x) => x.tokenId === tokenId);
      if (!t) return null;
      return { username: r.username, expires_at_iso: t.expiresAt };
    },

    async deleteRefreshToken(username: string, tokenId: string): Promise<void> {
      const raw = await this.getUserSetting(username, USER_SETTING_KEY_REFRESH_TOKENS);
      const doc = parseRefreshTokensUserSetting(raw);
      doc.refreshTokens = doc.refreshTokens.filter((x) => x.tokenId !== tokenId);
      await this.upsertUserSetting(
        username,
        USER_SETTING_KEY_REFRESH_TOKENS,
        serializeRefreshTokensUserSetting(doc),
      );
    },

    async deleteRefreshSessionsForUser(username: string): Promise<void> {
      await this.upsertUserSetting(
        username,
        USER_SETTING_KEY_REFRESH_TOKENS,
        serializeRefreshTokensUserSetting({ refreshTokens: [] }),
      );
    },

    async listPats(username: string) {
      const raw = await this.getUserSetting(username, USER_SETTING_KEY_PERSONAL_ACCESS_TOKENS);
      const doc = parsePersonalAccessTokensUserSetting(raw);
      return [...doc.tokens]
        .sort((a, b) => {
          const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return tb - ta;
        })
        .map((t) => ({
          id: t.tokenId,
          description: t.description ?? null,
          created_at: t.createdAt ?? "",
        }));
    },

    async createPat(username: string, description: string | null) {
      const id = crypto.randomUUID();
      const raw = `memos_pat_${randomTokenHex(24)}`;
      const tokenHash = await sha256Hex(raw);
      const rawSetting = await this.getUserSetting(username, USER_SETTING_KEY_PERSONAL_ACCESS_TOKENS);
      const doc = parsePersonalAccessTokensUserSetting(rawSetting);
      doc.tokens.push({
        tokenId: id,
        tokenHash,
        description: description ?? "",
        createdAt: new Date().toISOString(),
      });
      await this.upsertUserSetting(
        username,
        USER_SETTING_KEY_PERSONAL_ACCESS_TOKENS,
        serializePersonalAccessTokensUserSetting(doc),
      );
      return { id, raw };
    },

    async deletePat(username: string, patId: string): Promise<boolean> {
      const rawSetting = await this.getUserSetting(username, USER_SETTING_KEY_PERSONAL_ACCESS_TOKENS);
      const doc = parsePersonalAccessTokensUserSetting(rawSetting);
      const before = doc.tokens.length;
      doc.tokens = doc.tokens.filter((t) => t.tokenId !== patId);
      if (doc.tokens.length === before) return false;
      await this.upsertUserSetting(
        username,
        USER_SETTING_KEY_PERSONAL_ACCESS_TOKENS,
        serializePersonalAccessTokensUserSetting(doc),
      );
      return true;
    },

    async findUserByPat(rawToken: string): Promise<DbUserRow | null> {
      const tokenHash = await sha256Hex(rawToken);
      const r = await sql.queryOne<SqlUserRow>(
        `SELECT u.* FROM user_setting s
         INNER JOIN user u ON u.id = s.user_id AND u.row_status = 'NORMAL'
         WHERE s.key = ?
           AND EXISTS (
             SELECT 1 FROM json_each(COALESCE(json_extract(s.value, '$.tokens'), json('[]'))) AS je
             WHERE json_extract(je.value, '$.tokenHash') = ?
                OR json_extract(je.value, '$.token_hash') = ?
           )
         LIMIT 1`,
        [USER_SETTING_KEY_PERSONAL_ACCESS_TOKENS, tokenHash, tokenHash],
      );
      return r ? mapUserRow(r) : null;
    },

    async listIdentityProviders(): Promise<DbIdentityProviderRow[]> {
      return sql.queryAll<DbIdentityProviderRow>(
        "SELECT uid, name, type, identifier_filter, config FROM idp ORDER BY id ASC",
      );
    },

    async getIdentityProviderByUid(uid: string): Promise<DbIdentityProviderRow | null> {
      const row = await sql.queryOne<DbIdentityProviderRow>(
        "SELECT uid, name, type, identifier_filter, config FROM idp WHERE uid = ?",
        [uid],
      );
      return row ?? null;
    },

    async createIdentityProvider(args: {
      uid: string;
      name: string;
      type: string;
      identifierFilter: string;
      configJson: string;
    }): Promise<void> {
      await sql.execute(
        `INSERT INTO idp (uid, name, type, identifier_filter, config)
         VALUES (?, ?, ?, ?, ?)`,
        [args.uid, args.name, args.type, args.identifierFilter, args.configJson],
      );
    },

    async updateIdentityProvider(args: {
      uid: string;
      name: string;
      type: string;
      identifierFilter: string;
      configJson: string;
    }): Promise<boolean> {
      const result = await sql.execute(
        `UPDATE idp
         SET name = ?, type = ?, identifier_filter = ?, config = ?
         WHERE uid = ?`,
        [args.name, args.type, args.identifierFilter, args.configJson, args.uid],
      );
      return result.changes > 0;
    },

    async deleteIdentityProvider(uid: string): Promise<boolean> {
      const result = await sql.execute("DELETE FROM idp WHERE uid = ?", [uid]);
      return result.changes > 0;
    },

    async createMemo(args: {
      id: string;
      creator: string;
      content: string;
      visibility: string;
      state: string;
      pinned: boolean;
      parentId?: string | null;
      location?: {
        location_placeholder: string;
        location_latitude: number;
        location_longitude: number;
      } | null;
    }): Promise<DbMemoRow> {
      const creator = await sql.queryOne<{ id: number }>(
        "SELECT id FROM user WHERE username = ? AND row_status = 'NORMAL'",
        [args.creator],
      );
      if (!creator) throw new Error("creator not found");

      const rowStatus = args.state === "ARCHIVED" ? "ARCHIVED" : "NORMAL";
      const nowSec = Math.floor(Date.now() / 1000);
      let createdTs = nowSec;
      let updatedTs = nowSec;

      const rebuilt = rebuildMemoPayloadFromContent(args.content);
      const pl: MemoPayloadGolang = { ...rebuilt };
      if (args.location) {
        pl.location = {
          placeholder: args.location.location_placeholder,
          latitude: args.location.location_latitude,
          longitude: args.location.location_longitude,
        };
      }

      await sql.execute(
        `INSERT INTO memo (uid, creator_id, content, visibility, row_status, pinned, payload, created_ts, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          args.id,
          creator.id,
          args.content,
          args.visibility,
          rowStatus,
          args.pinned ? 1 : 0,
          stringifyMemoPayload(pl),
          createdTs,
          updatedTs,
        ],
      );

      const newId = await resolveMemoInternalId(args.id);
      if (newId == null) throw new Error("memo missing after insert");

      let parentInternalId: number | null = null;
      if (args.parentId) {
        parentInternalId = await resolveMemoInternalId(args.parentId);
        if (parentInternalId != null) {
          await sql.execute(
            `INSERT INTO memo_relation (memo_id, related_memo_id, type) VALUES (?, ?, ?)`,
            [newId, parentInternalId, MEMO_RELATION_COMMENT],
          );
        }
        const parentRow = await sql.queryOne<{ creator_id: number }>(
          "SELECT creator_id FROM memo WHERE uid = ?",
          [args.parentId],
        );
        const parentCreator = parentRow
          ? await sql.queryOne<{ username: string }>(
              "SELECT username FROM user WHERE id = ? AND row_status = 'NORMAL'",
              [parentRow.creator_id],
            )
          : null;
        if (
          parentInternalId != null &&
          parentCreator &&
          args.creator !== parentCreator.username &&
          args.visibility !== "PRIVATE"
        ) {
          const message = JSON.stringify({
            type: "MEMO_COMMENT",
            memoComment: { memoId: newId, relatedMemoId: parentInternalId },
          });
          const sender = await sql.queryOne<{ id: number }>(
            "SELECT id FROM user WHERE username = ? AND row_status = 'NORMAL'",
            [args.creator],
          );
          const receiver = await sql.queryOne<{ id: number }>(
            "SELECT id FROM user WHERE username = ? AND row_status = 'NORMAL'",
            [parentCreator.username],
          );
          if (sender && receiver) {
            await sql.execute(
              `INSERT INTO inbox (sender_id, receiver_id, status, message) VALUES (?, ?, 'UNREAD', ?)`,
              [sender.id, receiver.id, message],
            );
          }
        }
      }

      const dw = await memoDisplayWithUpdateTime();
      const r = await sql.queryOne<SqlMemoRow>(
        `SELECT ${memoSelectFields} ${memoJoins} WHERE m.uid = ?`,
        [args.id],
      );
      if (!r) throw new Error("memo missing");
      return mapMemoRow(r, dw);
    },

    async getMemoById(uid: string): Promise<DbMemoRow | null> {
      const dw = await memoDisplayWithUpdateTime();
      const r = await sql.queryOne<SqlMemoRow>(
        `SELECT ${memoSelectFields} ${memoJoins} WHERE m.uid = ?`,
        [uid],
      );
      return r ? mapMemoRow(r, dw) : null;
    },

    async updateMemo(
      uid: string,
      patch: Partial<{
        content: string;
        visibility: string;
        state: string;
        pinned: boolean;
        display_time: string | null;
        location:
          | {
              location_placeholder: string;
              location_latitude: number;
              location_longitude: number;
            }
          | null;
      }>,
    ): Promise<void> {
      const cur = await sql.queryOne<{
        payload: string;
        id: number;
      }>("SELECT id, payload FROM memo WHERE uid = ?", [uid]);
      if (!cur) return;
      let pl = parseMemoPayloadGolang(cur.payload);
      const sets: string[] = [];
      const vals: SqlPrimitive[] = [];
      if (patch.content !== undefined) {
        sets.push("content = ?");
        vals.push(patch.content);
        const rebuilt = rebuildMemoPayloadFromContent(patch.content);
        pl = { ...rebuilt, location: pl.location };
      }
      if (patch.visibility !== undefined) {
        sets.push("visibility = ?");
        vals.push(patch.visibility);
      }
      if (patch.pinned !== undefined) {
        sets.push("pinned = ?");
        vals.push(patch.pinned ? 1 : 0);
      }
      if (patch.state !== undefined) {
        sets.push("row_status = ?");
        vals.push(patch.state === "ARCHIVED" ? "ARCHIVED" : "NORMAL");
      }
      let displayWroteUpdatedTs = false;
      if (patch.display_time !== undefined) {
        const useUpd = await memoDisplayWithUpdateTime();
        const sec =
          patch.display_time != null && patch.display_time !== ""
            ? isoToUnixSec(patch.display_time)
            : null;
        if (sec != null) {
          if (useUpd) {
            sets.push("updated_ts = ?");
            vals.push(sec);
            displayWroteUpdatedTs = true;
          } else {
            sets.push("created_ts = ?");
            vals.push(sec);
          }
        }
      }
      if (patch.location !== undefined) {
        if (patch.location === null) {
          const { location: _l, ...rest } = pl;
          pl = rest;
        } else {
          pl = {
            ...pl,
            location: {
              placeholder: patch.location.location_placeholder,
              latitude: patch.location.location_latitude,
              longitude: patch.location.location_longitude,
            },
          };
        }
      }
      if (
        patch.content !== undefined ||
        patch.location !== undefined
      ) {
        sets.push("payload = ?");
        vals.push(stringifyMemoPayload(pl));
      }
      if (!displayWroteUpdatedTs) {
        sets.push("updated_ts = strftime('%s', 'now')");
      }
      vals.push(uid);
      if (sets.length === 0) return;
      await sql.execute(`UPDATE memo SET ${sets.join(", ")} WHERE uid = ?`, vals);
    },

    /** Hard delete (removes the memo row entirely). */
    async hardDeleteMemo(uid: string): Promise<void> {
      const idRow = await sql.queryOne<{ id: number }>("SELECT id FROM memo WHERE uid = ?", [
        uid,
      ]);
      if (!idRow) return;
      const mid = idRow.id;
      const cid = memoReactionContentId(uid);
      await sql.execute("DELETE FROM reaction WHERE content_id = ? OR content_id = ?", [
        cid,
        uid,
      ]);
      await sql.execute(
        "DELETE FROM memo_relation WHERE memo_id = ? OR related_memo_id = ?",
        [mid, mid],
      );
      await sql.execute("DELETE FROM memo WHERE id = ?", [mid]);
    },

    /** Soft delete: set row_status to ARCHIVED (aligns with golang `DeleteMemo` default behaviour). */
    async archiveMemo(uid: string): Promise<void> {
      await sql.execute("UPDATE memo SET row_status = 'ARCHIVED', updated_ts = ? WHERE uid = ?", [
        Math.floor(Date.now() / 1000),
        uid,
      ]);
    },

    async listTopLevelMemosForUserStats(args: {
      creatorUsername: string;
      viewerUsername: string | null;
    }): Promise<
      Array<{
        id: string;
        content: string;
        display_time: string | null;
        create_time: string;
        update_time: string;
        pinned: number;
      }>
    > {
      const where: string[] = [
        "m.row_status = 'NORMAL'",
        `NOT EXISTS (SELECT 1 FROM memo_relation c WHERE c.memo_id = m.id AND c.type = '${MEMO_RELATION_COMMENT}')`,
        "u.username = ?",
      ];
      const vals: SqlPrimitive[] = [args.creatorUsername];
      const v = args.viewerUsername;
      if (v === null) {
        where.push("m.visibility = 'PUBLIC'");
      } else if (v !== args.creatorUsername) {
        where.push("(m.visibility = 'PUBLIC' OR m.visibility = 'PROTECTED')");
      }
      const dw = await memoDisplayWithUpdateTime();
      const rows = await sql.queryAll<{
        uid: string;
        content: string;
        created_ts: number | bigint;
        updated_ts: number | bigint;
        pinned: number;
      }>(
        `SELECT m.uid, m.content, m.created_ts, m.updated_ts, m.pinned
         FROM memo m
         INNER JOIN user u ON u.id = m.creator_id
         WHERE ${where.join(" AND ")}`,
        vals,
      );
      return rows.map((m) => ({
        id: m.uid,
        content: m.content,
        display_time: unixSecToIso(dw ? m.updated_ts : m.created_ts),
        create_time: unixSecToIso(m.created_ts),
        update_time: unixSecToIso(m.updated_ts),
        pinned: m.pinned,
      }));
    },

    async listMemosTopLevel(args: {
      limit: number;
      offset: number;
      state: string;
      visibility?: string | null;
      creator?: string | null;
      viewerUsername?: string | null;
      visibilityIn?: string[] | null;
      pinnedOnly?: boolean;
      timeField?: "create_time" | "update_time";
      timeStartSec?: number;
      timeEndSec?: number;
    }): Promise<DbMemoRow[]> {
      const rowStatus = args.state === "ARCHIVED" ? "ARCHIVED" : "NORMAL";
      const where: string[] = [
        "m.row_status = ?",
        `NOT EXISTS (SELECT 1 FROM memo_relation c WHERE c.memo_id = m.id AND c.type = '${MEMO_RELATION_COMMENT}')`,
      ];
      const vals: SqlPrimitive[] = [rowStatus];
      if (args.visibility) {
        where.push("m.visibility = ?");
        vals.push(args.visibility);
      }
      if (args.creator) {
        where.push("u.username = ?");
        vals.push(args.creator);
      }
      if (args.viewerUsername) {
        where.push(
          "(m.visibility = 'PUBLIC' OR m.visibility = 'PROTECTED' OR (m.visibility = 'PRIVATE' AND u.username = ?))",
        );
        vals.push(args.viewerUsername);
      }
      if (args.visibilityIn && args.visibilityIn.length > 0) {
        const ph = args.visibilityIn.map(() => "?").join(", ");
        where.push(`m.visibility IN (${ph})`);
        for (const v of args.visibilityIn) vals.push(v);
      }
      if (args.pinnedOnly) {
        where.push("m.pinned = 1");
      }
      if (
        args.timeField &&
        args.timeStartSec !== undefined &&
        args.timeEndSec !== undefined
      ) {
        const col = args.timeField === "update_time" ? "m.updated_ts" : "m.created_ts";
        where.push(`(${col} + 0) >= ? AND (${col} + 0) < ?`);
        vals.push(args.timeStartSec, args.timeEndSec);
      }
      vals.push(args.limit, args.offset);
      const dw = await memoDisplayWithUpdateTime();
      const orderTs = dw ? "m.updated_ts" : "m.created_ts";
      const rows = await sql.queryAll<SqlMemoRow>(
        `SELECT ${memoSelectFields} ${memoJoins}
         WHERE ${where.join(" AND ")}
         ORDER BY m.pinned DESC, ${orderTs} DESC, m.id DESC
         LIMIT ? OFFSET ?`,
        vals,
      );
      return rows.map((r) => mapMemoRow(r, dw));
    },

    async listCommentsForMemo(parentUid: string): Promise<DbMemoRow[]> {
      const dw = await memoDisplayWithUpdateTime();
      const rows = await sql.queryAll<SqlMemoRow>(
        `SELECT ${memoSelectFields} ${memoJoins}
         WHERE m.row_status = 'NORMAL'
         AND EXISTS (
           SELECT 1 FROM memo_relation r
           WHERE r.memo_id = m.id AND r.type = '${MEMO_RELATION_COMMENT}'
           AND r.related_memo_id = (SELECT id FROM memo WHERE uid = ?)
         )
         ORDER BY m.created_ts ASC`,
        [parentUid],
      );
      return rows.map((r) => mapMemoRow(r, dw));
    },

    async setMemoRelations(memoUid: string, pairs: { relatedId: string; type: string }[]) {
      const mid = await resolveMemoInternalId(memoUid);
      if (mid == null) return;
      await sql.execute(
        `DELETE FROM memo_relation WHERE memo_id = ? AND type != '${MEMO_RELATION_COMMENT}'`,
        [mid],
      );
      for (const p of pairs) {
        const rid = await resolveMemoInternalId(p.relatedId);
        if (rid == null) continue;
        await sql.execute(
          `INSERT INTO memo_relation (memo_id, related_memo_id, type) VALUES (?, ?, ?)`,
          [mid, rid, p.type],
        );
      }
    },

    async listMemoRelations(memoUid: string) {
      const mid = await resolveMemoInternalId(memoUid);
      if (mid == null) return [];
      const rows = await sql.queryAll<{ related_uid: string; relation_type: string }>(
        `SELECT r2.uid AS related_uid, mr.type AS relation_type
         FROM memo_relation mr
         INNER JOIN memo r2 ON r2.id = mr.related_memo_id AND r2.row_status = 'NORMAL'
         WHERE mr.memo_id = ? AND mr.type != '${MEMO_RELATION_COMMENT}'`,
        [mid],
      );
      return rows.map((x) => ({
        related_memo_id: x.related_uid,
        relation_type: x.relation_type,
      }));
    },

    async upsertReaction(args: {
      id: string;
      memoId: string;
      creator: string;
      reactionType: string;
    }) {
      const creator = await sql.queryOne<{ id: number }>(
        "SELECT id FROM user WHERE username = ? AND row_status = 'NORMAL'",
        [args.creator],
      );
      if (!creator) throw new Error("user not found");
      const contentId = memoReactionContentId(args.memoId);
      await sql.execute(
        "DELETE FROM reaction WHERE content_id IN (?, ?) AND creator_id = ? AND reaction_type = ?",
        [contentId, args.memoId, creator.id, args.reactionType],
      );
      await sql.execute(
        `INSERT INTO reaction (created_ts, creator_id, content_id, reaction_type)
         VALUES (strftime('%s', 'now'), ?, ?, ?)`,
        [creator.id, contentId, args.reactionType],
      );
    },

    async listReactions(memoUid: string) {
      const contentId = memoReactionContentId(memoUid);
      const rows = await sql.queryAll<{
        id: number;
        creator_username: string;
        reaction_type: string;
        created_ts: number | bigint;
      }>(
        `SELECT r.id, u.username AS creator_username, r.reaction_type, r.created_ts
         FROM reaction r
         INNER JOIN user u ON u.id = r.creator_id
         WHERE r.content_id IN (?, ?)
         ORDER BY r.created_ts ASC`,
        [contentId, memoUid],
      );
      return rows.map((r) => ({
        id: String(r.id),
        creator_username: r.creator_username,
        reaction_type: r.reaction_type,
        create_time: unixSecToIso(r.created_ts),
      }));
    },

    async deleteReaction(memoUid: string, reactionId: string): Promise<boolean> {
      const contentId = memoReactionContentId(memoUid);
      const r = await sql.execute(
        "DELETE FROM reaction WHERE id = ? AND content_id IN (?, ?)",
        [reactionId, contentId, memoUid],
      );
      return r.changes > 0;
    },

    async createShare(args: {
      id: string;
      memoId: string;
      token: string;
      expiresAt: string | null;
    }) {
      const memo = await sql.queryOne<{ id: number }>(
        "SELECT id FROM memo WHERE uid = ? AND row_status = 'NORMAL'",
        [args.memoId],
      );
      if (!memo) throw new Error("memo not found");
      const mrow = await sql.queryOne<{ creator_id: number }>(
        "SELECT creator_id FROM memo WHERE id = ?",
        [memo.id],
      );
      const expiresTs =
        args.expiresAt && args.expiresAt.length > 0
          ? isoToUnixSec(args.expiresAt)
          : null;
      await sql.execute(
        `INSERT INTO memo_share (uid, memo_id, creator_id, created_ts, expires_ts)
         VALUES (?, ?, ?, strftime('%s', 'now'), ?)`,
        [args.token, memo.id, mrow!.creator_id, expiresTs],
      );
    },

    async listShares(memoUid: string) {
      const mid = await resolveMemoInternalId(memoUid);
      if (mid == null) return [];
      const rows = await sql.queryAll<{
        share_token: string;
        expires_ts: number | null;
        created_ts: number | bigint;
      }>(
        `SELECT uid AS share_token, expires_ts, created_ts
         FROM memo_share WHERE memo_id = ? ORDER BY created_ts DESC`,
        [mid],
      );
      return rows.map((s) => ({
        id: s.share_token,
        share_token: s.share_token,
        expires_at:
          s.expires_ts != null ? unixSecToIso(s.expires_ts) : null,
        created_at: unixSecToIso(s.created_ts),
      }));
    },

    async deleteShareByName(memoUid: string, shareSegment: string): Promise<boolean> {
      const mid = await resolveMemoInternalId(memoUid);
      if (mid == null) return false;
      const r = await sql.execute(
        `DELETE FROM memo_share WHERE memo_id = ? AND (uid = ? OR CAST(id AS TEXT) = ?)`,
        [mid, shareSegment, shareSegment],
      );
      return r.changes > 0;
    },

    async getMemoIdByShareToken(token: string): Promise<string | null> {
      const row = await sql.queryOne<{
        memo_uid: string;
        expires_ts: number | null;
      }>(
        `SELECT m.uid AS memo_uid, s.expires_ts
         FROM memo_share s
         INNER JOIN memo m ON m.id = s.memo_id AND m.row_status = 'NORMAL'
         WHERE s.uid = ?`,
        [token],
      );
      if (!row) return null;
      if (row.expires_ts != null) {
        const ex = row.expires_ts * 1000;
        if (ex < Date.now()) return null;
      }
      return row.memo_uid;
    },

    async createAttachment(args: {
      id: string;
      creator: string;
      filename: string;
      content: Uint8Array<ArrayBufferLike> | null;
      type: string;
      size: number;
      memoUid?: string | null;
      storageType?: string;
      reference?: string;
      payload?: string;
    }): Promise<DbAttachmentRow> {
      const creator = await sql.queryOne<{ id: number }>(
        "SELECT id FROM user WHERE username = ? AND row_status = 'NORMAL'",
        [args.creator],
      );
      if (!creator) throw new Error("creator not found");
      let memoId: number | null = null;
      if (args.memoUid) {
        memoId = await resolveMemoInternalId(args.memoUid);
      }
      await sql.execute(
        `INSERT INTO attachment (uid, creator_id, filename, blob, type, size, memo_id, storage_type, reference, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          args.id,
          creator.id,
          args.filename,
          args.content,
          args.type,
          args.size,
          memoId,
          args.storageType ?? "DB",
          args.reference ?? "",
          args.payload ?? "{}",
        ],
      );
      const row = await sql.queryOne<SqlAttachmentRow>(
        `SELECT a.uid, u.username AS creator_username, a.created_ts, a.updated_ts, a.filename, a.blob, a.type, a.size,
                m.uid AS memo_uid, a.storage_type, a.reference, a.payload
         FROM attachment a
         INNER JOIN user u ON u.id = a.creator_id
         LEFT JOIN memo m ON m.id = a.memo_id
         WHERE a.uid = ?`,
        [args.id],
      );
      if (!row) throw new Error("attachment missing after insert");
      return mapAttachmentRow(row);
    },

    async listAttachments(args: {
      creatorUsername?: string;
      memoUid?: string | null;
      unlinkedOnly?: boolean;
      linkedOnly?: boolean;
      limit: number;
      offset: number;
    }): Promise<DbAttachmentRow[]> {
      const where: string[] = [];
      const vals: SqlPrimitive[] = [];
      if (args.creatorUsername) {
        where.push("u.username = ?");
        vals.push(args.creatorUsername);
      }
      if (args.memoUid !== undefined && args.memoUid !== null) {
        where.push("m.uid = ?");
        vals.push(args.memoUid);
      }
      if (args.unlinkedOnly) {
        where.push("a.memo_id IS NULL");
      }
      if (args.linkedOnly) {
        where.push("a.memo_id IS NOT NULL");
      }
      vals.push(args.limit, args.offset);
      const rows = await sql.queryAll<SqlAttachmentRow>(
        `SELECT a.uid, u.username AS creator_username, a.created_ts, a.updated_ts, a.filename, a.blob, a.type, a.size,
                m.uid AS memo_uid, a.storage_type, a.reference, a.payload
         FROM attachment a
         INNER JOIN user u ON u.id = a.creator_id
         LEFT JOIN memo m ON m.id = a.memo_id
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY a.created_ts DESC, a.id DESC
         LIMIT ? OFFSET ?`,
        vals,
      );
      return rows.map(mapAttachmentRow);
    },

    async getAttachmentByUid(uid: string): Promise<DbAttachmentRow | null> {
      const row = await sql.queryOne<SqlAttachmentRow>(
        `SELECT a.uid, u.username AS creator_username, a.created_ts, a.updated_ts, a.filename, a.blob, a.type, a.size,
                m.uid AS memo_uid, a.storage_type, a.reference, a.payload
         FROM attachment a
         INNER JOIN user u ON u.id = a.creator_id
         LEFT JOIN memo m ON m.id = a.memo_id
         WHERE a.uid = ?`,
        [uid],
      );
      return row ? mapAttachmentRow(row) : null;
    },

    async updateAttachment(
      uid: string,
      patch: Partial<{
        filename: string;
        memoUid: string | null;
      }>,
    ): Promise<void> {
      const sets: string[] = [];
      const vals: SqlPrimitive[] = [];
      if (patch.filename !== undefined) {
        sets.push("filename = ?");
        vals.push(patch.filename);
      }
      if (patch.memoUid !== undefined) {
        const mid = patch.memoUid ? await resolveMemoInternalId(patch.memoUid) : null;
        sets.push("memo_id = ?");
        vals.push(mid);
      }
      if (sets.length === 0) return;
      sets.push("updated_ts = strftime('%s', 'now')");
      vals.push(uid);
      await sql.execute(`UPDATE attachment SET ${sets.join(", ")} WHERE uid = ?`, vals);
    },

    async deleteAttachment(uid: string): Promise<boolean> {
      const r = await sql.execute("DELETE FROM attachment WHERE uid = ?", [uid]);
      return r.changes > 0;
    },

    async setMemoAttachments(memoUid: string, attachmentUids: string[]): Promise<void> {
      const mid = await resolveMemoInternalId(memoUid);
      if (mid == null) return;
      await sql.execute("UPDATE attachment SET memo_id = NULL WHERE memo_id = ?", [mid]);
      for (const uid of attachmentUids) {
        await sql.execute("UPDATE attachment SET memo_id = ?, updated_ts = strftime('%s', 'now') WHERE uid = ?", [
          mid,
          uid,
        ]);
      }
    },

    async listShortcuts(username: string) {
      const raw = await this.getUserSetting(username, USER_SETTING_KEY_SHORTCUTS);
      const doc = parseShortcutsUserSetting(raw);
      const t0 = Date.now();
      const list = [...doc.shortcuts].reverse();
      return list.map((s, i) => {
        const iso = new Date(t0 - i * 1000).toISOString();
        return {
          shortcut_id: s.id,
          title: s.title,
          filter_expr: s.filter || null,
          create_time: iso,
          update_time: iso,
        };
      });
    },

    async createShortcut(args: {
      username: string;
      shortcutId: string;
      title: string;
      filter: string | null;
    }) {
      const raw = await this.getUserSetting(args.username, USER_SETTING_KEY_SHORTCUTS);
      const doc = parseShortcutsUserSetting(raw);
      doc.shortcuts.push({
        id: args.shortcutId,
        title: args.title,
        filter: args.filter ?? "",
      });
      await this.upsertUserSetting(
        args.username,
        USER_SETTING_KEY_SHORTCUTS,
        serializeShortcutsUserSetting(doc),
      );
    },

    async updateShortcut(
      username: string,
      shortcutId: string,
      patch: { title?: string; filter?: string | null },
    ) {
      if (patch.title === undefined && patch.filter === undefined) return;
      const raw = await this.getUserSetting(username, USER_SETTING_KEY_SHORTCUTS);
      const doc = parseShortcutsUserSetting(raw);
      const s = doc.shortcuts.find((x) => x.id === shortcutId);
      if (!s) return;
      if (patch.title !== undefined) s.title = patch.title;
      if (patch.filter !== undefined) s.filter = patch.filter ?? "";
      await this.upsertUserSetting(
        username,
        USER_SETTING_KEY_SHORTCUTS,
        serializeShortcutsUserSetting(doc),
      );
    },

    async deleteShortcut(username: string, shortcutId: string): Promise<boolean> {
      const raw = await this.getUserSetting(username, USER_SETTING_KEY_SHORTCUTS);
      const doc = parseShortcutsUserSetting(raw);
      const before = doc.shortcuts.length;
      doc.shortcuts = doc.shortcuts.filter((x) => x.id !== shortcutId);
      if (doc.shortcuts.length === before) return false;
      await this.upsertUserSetting(
        username,
        USER_SETTING_KEY_SHORTCUTS,
        serializeShortcutsUserSetting(doc),
      );
      return true;
    },

    async getUserSetting(username: string, key: string): Promise<string | null> {
      const row = await sql.queryOne<{ value: string }>(
        `SELECT s.value FROM user_setting s
         INNER JOIN user u ON u.id = s.user_id AND u.row_status = 'NORMAL'
         WHERE u.username = ? AND s.key = ?`,
        [username, key],
      );
      return row?.value ?? null;
    },

    async upsertUserSetting(username: string, key: string, json: string): Promise<void> {
      await sql.execute(
        `INSERT INTO user_setting (user_id, key, value)
         SELECT id, ?, ? FROM user WHERE username = ? AND row_status = 'NORMAL'
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
        [key, json, username],
      );
    },

    async listUserSettings(username: string) {
      return sql.queryAll<{ setting_key: string; json_value: string }>(
        `SELECT s.key AS setting_key, s.value AS json_value FROM user_setting s
         INNER JOIN user u ON u.id = s.user_id AND u.row_status = 'NORMAL'
         WHERE u.username = ?`,
        [username],
      );
    },

    async listWebhooks(username: string): Promise<StoredUserWebhook[]> {
      const raw = await this.getUserSetting(username, "WEBHOOKS");
      return parseWebhooksFromUserSettingValue(raw);
    },

    async createWebhook(username: string, url: string, displayName?: string): Promise<string> {
      const id = newUserWebhookId();
      const items = parseWebhooksFromUserSettingValue(await this.getUserSetting(username, "WEBHOOKS"));
      items.push({ id, title: displayName?.trim() ?? "", url });
      await this.upsertUserSetting(username, "WEBHOOKS", serializeWebhooksUserSetting(items));
      return id;
    },

    async updateWebhook(
      username: string,
      webhookId: string,
      patch: { url?: string; displayName?: string },
      paths: Set<string>,
    ): Promise<boolean> {
      const items = parseWebhooksFromUserSettingValue(await this.getUserSetting(username, "WEBHOOKS"));
      const idx = items.findIndex((w) => w.id === webhookId);
      if (idx < 0) return false;
      const cur = items[idx]!;
      let next = { ...cur };
      if (paths.size === 0) {
        if (patch.url !== undefined && patch.url.trim() !== "") {
          next.url = patch.url.trim();
        }
        if (patch.displayName !== undefined) {
          next.title = patch.displayName;
        }
      } else {
        for (const p of paths) {
          if (p === "url" && patch.url !== undefined && patch.url.trim() !== "") {
            next.url = patch.url.trim();
          }
          if (
            (p === "display_name" || p === "displayName") &&
            patch.displayName !== undefined
          ) {
            next.title = patch.displayName;
          }
        }
      }
      items[idx] = next;
      await this.upsertUserSetting(username, "WEBHOOKS", serializeWebhooksUserSetting(items));
      return true;
    },

    async deleteWebhook(username: string, id: string): Promise<boolean> {
      const items = parseWebhooksFromUserSettingValue(await this.getUserSetting(username, "WEBHOOKS"));
      const next = items.filter((w) => w.id !== id);
      if (next.length === items.length) return false;
      await this.upsertUserSetting(username, "WEBHOOKS", serializeWebhooksUserSetting(next));
      return true;
    },

    async listNotifications(username: string): Promise<DbUserNotificationRow[]> {
      const rows = await sql.queryAll<{
        id: number;
        created_ts: number | bigint;
        status: string;
        message: string;
        sender_username: string;
      }>(
        `SELECT i.id, i.created_ts, i.status, i.message, su.username AS sender_username
         FROM inbox i
         INNER JOIN user ru ON ru.id = i.receiver_id AND ru.row_status = 'NORMAL'
         INNER JOIN user su ON su.id = i.sender_id AND su.row_status = 'NORMAL'
         WHERE ru.username = ?
           AND json_extract(i.message, '$.type') = 'MEMO_COMMENT'
         ORDER BY i.created_ts DESC`,
        [username],
      );
      const parsed: Array<{
        row: (typeof rows)[0];
        memoId: number;
        relatedMemoId: number;
      }> = [];
      const idSet = new Set<number>();
      for (const row of rows) {
        const p = parseMemoCommentFromInboxMessage(row.message);
        if (!p) continue;
        parsed.push({ row, memoId: p.memoId, relatedMemoId: p.relatedMemoId });
        idSet.add(p.memoId);
        idSet.add(p.relatedMemoId);
      }
      const uidMap = await lookupMemoUidsForInternalIds([...idSet]);
      return parsed.map(({ row, memoId, relatedMemoId }) => ({
        inbox_id: row.id,
        sender_username: row.sender_username,
        create_time: unixSecToIso(row.created_ts),
        status: row.status,
        comment_memo_uid: uidMap.get(memoId) ?? null,
        related_memo_uid: uidMap.get(relatedMemoId) ?? null,
      }));
    },

    async updateNotificationStatus(args: {
      username: string;
      inboxId: number;
      status: "UNREAD" | "ARCHIVED";
    }): Promise<DbUserNotificationRow | null> {
      const r = await sql.execute(
        `UPDATE inbox SET status = ?
         WHERE id = ? AND receiver_id = (SELECT id FROM user WHERE username = ? AND row_status = 'NORMAL')
           AND json_extract(message, '$.type') = 'MEMO_COMMENT'`,
        [args.status, args.inboxId, args.username],
      );
      if (r.changes === 0) return null;
      return fetchMemoCommentNotificationForUser(args.username, args.inboxId);
    },

    async deleteNotification(username: string, inboxId: number): Promise<boolean> {
      const r = await sql.execute(
        `DELETE FROM inbox WHERE id = ? AND receiver_id =
         (SELECT id FROM user WHERE username = ? AND row_status = 'NORMAL')`,
        [inboxId, username],
      );
      return r.changes > 0;
    },

    async listUserIdentities(userId: number): Promise<DbUserIdentityRow[]> {
      return sql.queryAll<DbUserIdentityRow>(
        "SELECT id, user_id, provider, extern_uid, created_ts, updated_ts FROM user_identity WHERE user_id = ?",
        [userId],
      );
    },

    async getUserIdentity(userId: number, provider: string): Promise<DbUserIdentityRow | null> {
      const rows = await sql.queryAll<DbUserIdentityRow>(
        "SELECT id, user_id, provider, extern_uid, created_ts, updated_ts FROM user_identity WHERE user_id = ? AND provider = ?",
        [userId, provider],
      );
      return rows[0] ?? null;
    },

    async upsertUserIdentity(userId: number, provider: string, externUid: string): Promise<DbUserIdentityRow> {
      await sql.execute(
        `INSERT INTO user_identity (user_id, provider, extern_uid)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET extern_uid = excluded.extern_uid, updated_ts = strftime('%s', 'now')`,
        [userId, provider, externUid],
      );
      const row = await sql.queryAll<DbUserIdentityRow>(
        "SELECT id, user_id, provider, extern_uid, created_ts, updated_ts FROM user_identity WHERE user_id = ? AND provider = ?",
        [userId, provider],
      );
      return row[0]!;
    },

    async deleteUserIdentity(userId: number, provider: string): Promise<boolean> {
      const r = await sql.execute(
        "DELETE FROM user_identity WHERE user_id = ? AND provider = ?",
        [userId, provider],
      );
      return r.changes > 0;
    },
  };
}

export type Repository = ReturnType<typeof createRepository>;
