/**
 * REST `/api/v1` transport (replaces Connect binary). Keeps the same exported
 * service client names so hooks and components stay unchanged.
 */
import { create } from "@bufbuild/protobuf";
import type { FieldMask } from "@bufbuild/protobuf/wkt";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { getAccessToken, hasStoredToken, isTokenExpired, REQUEST_TOKEN_EXPIRY_BUFFER_MS, setAccessToken } from "./auth-state";
import { memoFromJson, userFromJson, userStatsFromJson } from "./lib/proto-adapters";
import type { Attachment } from "./types/proto/api/v1/attachment_service_pb";
import { AttachmentSchema } from "./types/proto/api/v1/attachment_service_pb";
import { State } from "./types/proto/api/v1/common_pb";
import type { IdentityProvider } from "./types/proto/api/v1/idp_service_pb";
import { IdentityProvider_Type, IdentityProviderSchema } from "./types/proto/api/v1/idp_service_pb";
import type {
  InstanceProfile,
  InstanceSetting,
  InstanceSetting_MemoRelatedSetting,
  InstanceSetting_NotificationSetting,
  InstanceSetting_TagsSetting,
} from "./types/proto/api/v1/instance_service_pb";
import {
  InstanceProfileSchema,
  InstanceSetting_AIProviderConfigSchema,
  InstanceSetting_AIProviderType,
  InstanceSetting_AISettingSchema,
  InstanceSetting_GeneralSettingSchema,
  InstanceSetting_MemoRelatedSettingSchema,
  InstanceSetting_NotificationSettingSchema,
  InstanceSetting_StorageSetting_StorageType,
  InstanceSetting_StorageSettingSchema,
  InstanceSetting_TagsSettingSchema,
  InstanceSettingSchema,
} from "./types/proto/api/v1/instance_service_pb";
import type { Memo, MemoRelation, MemoShare, Reaction } from "./types/proto/api/v1/memo_service_pb";
import { MemoRelationSchema, MemoShareSchema, ReactionSchema } from "./types/proto/api/v1/memo_service_pb";
import type { Shortcut } from "./types/proto/api/v1/shortcut_service_pb";
import { ShortcutSchema } from "./types/proto/api/v1/shortcut_service_pb";
import type {
  CreatePersonalAccessTokenResponse,
  LinkedIdentity,
  PersonalAccessToken,
  User,
  UserNotification,
  UserSetting,
  UserWebhook,
} from "./types/proto/api/v1/user_service_pb";
import {
  CreatePersonalAccessTokenResponseSchema,
  LinkedIdentitySchema,
  PersonalAccessTokenSchema,
  UserNotification_MemoCommentPayloadSchema,
  UserNotification_MemoMentionPayloadSchema,
  UserNotification_Status,
  UserNotification_Type,
  UserNotificationSchema,
  UserSetting_GeneralSettingSchema,
  UserSetting_WebhooksSettingSchema,
  UserSettingSchema,
  UserWebhookSchema,
} from "./types/proto/api/v1/user_service_pb";
import { redirectOnAuthFailure } from "./utils/auth-redirect";

const API = "/api/v1";
const RETRY_HEADER = "X-Retry";
const RETRY_HEADER_VALUE = "true";

type InstanceSettingWithStorageMeta = InstanceSetting & {
  __supportedStorageTypes?: InstanceSetting_StorageSetting_StorageType[];
};

function parseSupportedStorageTypes(raw: unknown): InstanceSetting_StorageSetting_StorageType[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: InstanceSetting_StorageSetting_StorageType[] = [];
  for (const item of raw) {
    if (item === "DATABASE") out.push(InstanceSetting_StorageSetting_StorageType.DATABASE);
    else if (item === "LOCAL") out.push(InstanceSetting_StorageSetting_StorageType.LOCAL);
    else if (item === "S3") out.push(InstanceSetting_StorageSetting_StorageType.S3);
    else if (item === "R2") out.push(4 as InstanceSetting_StorageSetting_StorageType);
  }
  return out.length > 0 ? out : undefined;
}

function grpcToCode(code: number | undefined, status: number): Code {
  if (code === 16 || status === 401) return Code.Unauthenticated;
  if (code === 7 || status === 403) return Code.PermissionDenied;
  if (code === 5 || status === 404) return Code.NotFound;
  if (code === 6 || status === 409) return Code.AlreadyExists;
  if (code === 9) return Code.FailedPrecondition;
  if (code === 12) return Code.Unimplemented;
  if (status >= 500) return Code.Internal;
  return Code.Unknown;
}

function userSeg(resourceName: string): string {
  return resourceName.replace(/^users\//, "");
}

function memoIdFromName(name: string): string {
  return name.replace(/^memos\//, "");
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function throwUnlessOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await readJson(res)) as { code?: number; message?: string };
  throw new ConnectError(body.message ?? res.statusText, grpcToCode(body.code, res.status));
}

const tokenRefreshManager = (() => {
  let isRefreshing = false;
  let refreshPromise: Promise<void> | null = null;
  return {
    async refresh(refreshFn: () => Promise<void>): Promise<void> {
      if (isRefreshing && refreshPromise) return refreshPromise;
      isRefreshing = true;
      refreshPromise = refreshFn().finally(() => {
        isRefreshing = false;
        refreshPromise = null;
      });
      return refreshPromise;
    },
  };
})();

const fetchWithCredentials: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, { ...init, credentials: "include" });

async function doRefreshAccessToken(): Promise<void> {
  const res = await fetchWithCredentials(`${window.location.origin}${API}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  await throwUnlessOk(res);
  const j = (await readJson(res)) as { accessToken?: string; expiresAt?: string };
  if (!j.accessToken) {
    throw new ConnectError("Refresh token response missing access token", Code.Internal);
  }
  setAccessToken(j.accessToken, j.expiresAt ? new Date(j.expiresAt) : undefined);
}

export async function refreshAccessToken(): Promise<void> {
  return tokenRefreshManager.refresh(doRefreshAccessToken);
}

async function refreshAndGetAccessToken(): Promise<string> {
  await refreshAccessToken();
  const token = getAccessToken();
  if (!token) {
    throw new ConnectError("Token refresh succeeded but no token available", Code.Internal);
  }
  return token;
}

async function getRequestToken(): Promise<string | null> {
  let token = getAccessToken();
  if (!token) {
    if (!hasStoredToken()) return null;
    try {
      token = await refreshAndGetAccessToken();
    } catch {
      return null;
    }
    return token;
  }
  if (isTokenExpired(REQUEST_TOKEN_EXPIRY_BUFFER_MS)) {
    try {
      token = await refreshAndGetAccessToken();
    } catch {
      /* reactive 401 path */
    }
  }
  return token;
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headersFor = async (isRetry: boolean) => {
    const headers = new Headers(init.headers);
    const token = await getRequestToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (isRetry) headers.set(RETRY_HEADER, RETRY_HEADER_VALUE);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return headers;
  };

  let res = await fetchWithCredentials(`${window.location.origin}${API}${path}`, {
    ...init,
    headers: await headersFor(false),
  });
  if (res.status === 401) {
    try {
      await refreshAndGetAccessToken();
      res = await fetchWithCredentials(`${window.location.origin}${API}${path}`, {
        ...init,
        headers: await headersFor(true),
      });
    } catch (e) {
      redirectOnAuthFailure();
      throw e;
    }
    if (res.status === 401) {
      redirectOnAuthFailure();
      await throwUnlessOk(res);
    }
  }
  return res;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  await throwUnlessOk(res);
  return (await readJson(res)) as T;
}

function tagsSettingToApiJson(v: InstanceSetting_TagsSetting): Record<string, unknown> {
  const tags: Record<string, unknown> = {};
  for (const [k, meta] of Object.entries(v.tags)) {
    const row: Record<string, unknown> = { blurContent: meta.blurContent };
    const bg = meta.backgroundColor;
    if (bg) {
      row.backgroundColor = {
        red: bg.red,
        green: bg.green,
        blue: bg.blue,
      };
    }
    tags[k] = row;
  }
  return { tags };
}

function memoRelatedToApiJson(v: InstanceSetting_MemoRelatedSetting): Record<string, unknown> {
  return {
    contentLengthLimit: v.contentLengthLimit,
    enableDoubleClickEdit: v.enableDoubleClickEdit,
    reactions: [...v.reactions],
  };
}

function notificationToApiJson(v: InstanceSetting_NotificationSetting): Record<string, unknown> {
  return {
    email: v.email
      ? {
          enabled: v.email.enabled,
          smtpHost: v.email.smtpHost,
          smtpPort: v.email.smtpPort,
          smtpUsername: v.email.smtpUsername,
          smtpPassword: v.email.smtpPassword,
          fromEmail: v.email.fromEmail,
          fromName: v.email.fromName,
          replyTo: v.email.replyTo,
          useTls: v.email.useTls,
          useSsl: v.email.useSsl,
        }
      : undefined,
  };
}

function instanceSettingFromResponse(j: Record<string, unknown>): InstanceSetting {
  const name = String(j.name ?? "");
  if (j.generalSetting) {
    return create(InstanceSettingSchema, {
      name,
      value: {
        case: "generalSetting",
        value: create(InstanceSetting_GeneralSettingSchema, j.generalSetting as Record<string, unknown>),
      },
    });
  }
  if (j.memoRelatedSetting) {
    return create(InstanceSettingSchema, {
      name,
      value: {
        case: "memoRelatedSetting",
        value: create(InstanceSetting_MemoRelatedSettingSchema, j.memoRelatedSetting as Record<string, unknown>),
      },
    });
  }
  if (j.storageSetting) {
    const setting = create(InstanceSettingSchema, {
      name,
      value: {
        case: "storageSetting",
        value: create(InstanceSetting_StorageSettingSchema, j.storageSetting as Record<string, unknown>),
      },
    });
    const supportedStorageTypes = parseSupportedStorageTypes((j as { supportedStorageTypes?: unknown }).supportedStorageTypes);
    if (supportedStorageTypes) {
      (setting as InstanceSettingWithStorageMeta).__supportedStorageTypes = supportedStorageTypes;
    }
    return setting;
  }
  if (j.tagsSetting) {
    return create(InstanceSettingSchema, {
      name,
      value: {
        case: "tagsSetting",
        value: create(InstanceSetting_TagsSettingSchema, j.tagsSetting as Record<string, unknown>),
      },
    });
  }
  if (j.notificationSetting) {
    return create(InstanceSettingSchema, {
      name,
      value: {
        case: "notificationSetting",
        value: create(InstanceSetting_NotificationSettingSchema, j.notificationSetting as Record<string, unknown>),
      },
    });
  }
  if (j.aiSetting) {
    const raw = j.aiSetting as { providers?: Array<Record<string, unknown>> };
    const providers = (raw.providers ?? []).map((p) =>
      create(InstanceSetting_AIProviderConfigSchema, {
        id: String(p.id ?? ""),
        title: String(p.title ?? ""),
        type: ((): InstanceSetting_AIProviderType => {
          const t = p.type;
          if (t === 1 || t === "OPENAI" || t === InstanceSetting_AIProviderType.OPENAI) return InstanceSetting_AIProviderType.OPENAI;
          if (t === 2 || t === "GEMINI" || t === InstanceSetting_AIProviderType.GEMINI) return InstanceSetting_AIProviderType.GEMINI;
          return InstanceSetting_AIProviderType.AI_PROVIDER_TYPE_UNSPECIFIED;
        })(),
        endpoint: String(p.endpoint ?? ""),
        apiKeySet: Boolean(p.apiKeySet),
        apiKeyHint: String(p.apiKeyHint ?? ""),
      }),
    );
    return create(InstanceSettingSchema, {
      name,
      value: {
        case: "aiSetting",
        value: create(InstanceSetting_AISettingSchema, { providers }),
      },
    });
  }
  return create(InstanceSettingSchema, { name, value: { case: undefined, value: undefined } });
}

function profileFromJson(j: Record<string, unknown>): InstanceProfile {
  return create(InstanceProfileSchema, {
    version: String(j.version ?? ""),
    demo: Boolean(j.demo),
    instanceUrl: String(j.instanceUrl ?? ""),
    admin: j.admin ? userFromJson(j.admin as Record<string, unknown>) : undefined,
  } as Record<string, unknown>);
}

function userSettingFromJson(j: Record<string, unknown>): UserSetting {
  if (j.generalSetting) {
    return create(UserSettingSchema, {
      name: String(j.name ?? ""),
      value: {
        case: "generalSetting",
        value: create(UserSetting_GeneralSettingSchema, j.generalSetting as Record<string, unknown>),
      },
    });
  }
  return create(UserSettingSchema, {
    name: String(j.name ?? ""),
    value: {
      case: "webhooksSetting",
      value: create(UserSetting_WebhooksSettingSchema, (j.webhooksSetting as Record<string, unknown>) ?? {}),
    },
  });
}

function shortcutFromJson(j: Record<string, unknown>): Shortcut {
  return create(ShortcutSchema, {
    name: String(j.name ?? ""),
    title: String(j.title ?? ""),
    filter: String(j.filter ?? ""),
  });
}

function memoShareFromJson(j: Record<string, unknown>): MemoShare {
  return create(MemoShareSchema, {
    name: String(j.name ?? ""),
    createTime: j.createTime ? timestampFromDate(new Date(String(j.createTime))) : undefined,
    expireTime: j.expireTime ? timestampFromDate(new Date(String(j.expireTime))) : undefined,
  } as Record<string, unknown>);
}

function attachmentFromJson(j: Record<string, unknown>): Attachment {
  return create(AttachmentSchema, {
    name: String(j.name ?? ""),
    createTime: j.createTime ? timestampFromDate(new Date(String(j.createTime))) : undefined,
    filename: String(j.filename ?? ""),
    externalLink: String(j.externalLink ?? ""),
    type: String(j.type ?? ""),
    size: BigInt(String(j.size ?? "0")),
    memo: j.memo ? String(j.memo) : undefined,
  });
}

function notificationStatusFromJson(raw: unknown): UserNotification_Status {
  if (raw === UserNotification_Status.UNREAD || raw === 1 || raw === "UNREAD") return UserNotification_Status.UNREAD;
  if (raw === UserNotification_Status.ARCHIVED || raw === 2 || raw === "ARCHIVED") return UserNotification_Status.ARCHIVED;
  return UserNotification_Status.STATUS_UNSPECIFIED;
}

function notificationTypeFromJson(raw: unknown): UserNotification_Type {
  if (raw === UserNotification_Type.MEMO_COMMENT || raw === 1 || raw === "MEMO_COMMENT") return UserNotification_Type.MEMO_COMMENT;
  if (raw === UserNotification_Type.MEMO_MENTION || raw === 2 || raw === "MEMO_MENTION") return UserNotification_Type.MEMO_MENTION;
  return UserNotification_Type.TYPE_UNSPECIFIED;
}

function notificationFromJson(j: Record<string, unknown>): UserNotification {
  const payload = j.payload && typeof j.payload === "object" ? (j.payload as Record<string, unknown>) : {};
  const memoComment = (payload.memoComment ?? j.memoComment) as Record<string, unknown> | undefined;
  const memoMention = (payload.memoMention ?? j.memoMention) as Record<string, unknown> | undefined;
  return create(UserNotificationSchema, {
    name: String(j.name ?? ""),
    sender: String(j.sender ?? ""),
    senderUser: j.senderUser && typeof j.senderUser === "object" ? userFromJson(j.senderUser as Record<string, unknown>) : undefined,
    status: notificationStatusFromJson(j.status),
    createTime: j.createTime ? timestampFromDate(new Date(String(j.createTime))) : undefined,
    type: notificationTypeFromJson(j.type),
    payload: memoComment
      ? {
          case: "memoComment",
          value: create(UserNotification_MemoCommentPayloadSchema, {
            memo: String(memoComment.memo ?? ""),
            relatedMemo: String(memoComment.relatedMemo ?? ""),
            memoSnippet: String(memoComment.memoSnippet ?? ""),
            relatedMemoSnippet: String(memoComment.relatedMemoSnippet ?? ""),
          }),
        }
      : memoMention
        ? {
            case: "memoMention",
            value: create(UserNotification_MemoMentionPayloadSchema, {
              memo: String(memoMention.memo ?? ""),
              relatedMemo: String(memoMention.relatedMemo ?? ""),
              memoSnippet: String(memoMention.memoSnippet ?? ""),
              relatedMemoSnippet: String(memoMention.relatedMemoSnippet ?? ""),
            }),
          }
        : undefined,
  });
}

function webhookFromJson(j: Record<string, unknown>): UserWebhook {
  return create(UserWebhookSchema, {
    name: String(j.name ?? ""),
    url: String(j.url ?? ""),
    displayName: String(j.displayName ?? ""),
    createTime: j.createTime ? timestampFromDate(new Date(String(j.createTime))) : undefined,
    updateTime: j.updateTime ? timestampFromDate(new Date(String(j.updateTime))) : undefined,
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

function listMemosQuery(req: Record<string, unknown>): string {
  const p = new URLSearchParams();
  if (req.pageSize != null) p.set("pageSize", String(req.pageSize));
  if (req.pageToken) p.set("pageToken", String(req.pageToken));
  let stateStr = "NORMAL";
  if (req.state != null && req.state !== "") {
    const st = req.state as number | string;
    stateStr = typeof st === "number" ? ((State[st] as string | undefined) ?? "NORMAL") : String(st);
  } else if (req.showDeleted) stateStr = "ARCHIVED";
  p.set("state", stateStr);
  if (req.filter != null && String(req.filter).length > 0) {
    p.set("filter", String(req.filter));
  }
  return `?${p.toString()}`;
}

export const instanceServiceClient = {
  async getInstanceProfile(_req: object): Promise<InstanceProfile> {
    const j = (await apiJson<Record<string, unknown>>("/instance/profile")) as Record<string, unknown>;
    return profileFromJson(j);
  },
  async getInstanceSetting(req: { name: string }): Promise<InstanceSetting> {
    const key = req.name.replace(/^instance\/settings\//, "");
    const j = (await apiJson<Record<string, unknown>>(`/instance/settings/${encodeURIComponent(key)}`)) as Record<string, unknown>;
    return instanceSettingFromResponse(j);
  },
  async updateInstanceSetting(req: { setting: InstanceSetting }): Promise<InstanceSetting> {
    const key = req.setting.name.replace(/^instance\/settings\//, "");
    const v = req.setting.value;
    const settingBody: Record<string, unknown> = {};
    if (v.case === "generalSetting") {
      settingBody.generalSetting = {
        disallowUserRegistration: v.value.disallowUserRegistration,
        disallowPasswordAuth: v.value.disallowPasswordAuth,
      };
    } else if (v.case === "tagsSetting") {
      settingBody.tagsSetting = tagsSettingToApiJson(v.value);
    } else if (v.case === "memoRelatedSetting") {
      settingBody.memoRelatedSetting = memoRelatedToApiJson(v.value);
    } else if (v.case === "storageSetting") {
      settingBody.storageSetting = {
        storageType: v.value.storageType,
        filepathTemplate: v.value.filepathTemplate,
        uploadSizeLimitMb: Number(v.value.uploadSizeLimitMb ?? 0n),
        ...(v.value.s3Config
          ? {
              s3Config: {
                accessKeyId: v.value.s3Config.accessKeyId,
                accessKeySecret: v.value.s3Config.accessKeySecret,
                endpoint: v.value.s3Config.endpoint,
                region: v.value.s3Config.region,
                bucket: v.value.s3Config.bucket,
                usePathStyle: v.value.s3Config.usePathStyle,
              },
            }
          : {}),
      };
    } else if (v.case === "notificationSetting") {
      settingBody.notificationSetting = notificationToApiJson(v.value);
    } else if (v.case === "aiSetting") {
      settingBody.aiSetting = {
        providers: v.value.providers.map((p) => ({
          id: p.id,
          title: p.title,
          type: p.type,
          endpoint: p.endpoint,
          apiKey: p.apiKey,
        })),
      };
    } else {
      throw new ConnectError("Unsupported instance setting update", Code.InvalidArgument);
    }
    const res = await apiFetch(`/instance/settings/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify({ setting: settingBody }),
    });
    await throwUnlessOk(res);
    const j = (await readJson(res)) as Record<string, unknown>;
    return instanceSettingFromResponse(j);
  },
};

export const authServiceClient = {
  async getCurrentUser(_req: object): Promise<{ user: User | undefined }> {
    const res = await apiFetch("/auth/me");
    await throwUnlessOk(res);
    const j = (await readJson(res)) as { user?: Record<string, unknown> };
    return { user: j.user ? userFromJson(j.user) : undefined };
  },
  async signIn(req: {
    passwordCredentials?: { username?: string; password?: string };
    ssoCredentials?: unknown;
  }): Promise<{ user?: User; accessToken?: string; accessTokenExpiresAt?: ReturnType<typeof timestampFromDate> }> {
    const res = await fetchWithCredentials(`${window.location.origin}${API}/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        passwordCredentials: req.passwordCredentials,
        ssoCredentials: req.ssoCredentials,
      }),
    });
    await throwUnlessOk(res);
    const j = (await readJson(res)) as {
      user?: Record<string, unknown>;
      accessToken?: string;
      accessTokenExpiresAt?: string;
    };
    if (j.accessToken && j.accessTokenExpiresAt) {
      setAccessToken(j.accessToken, new Date(j.accessTokenExpiresAt));
    }
    return {
      user: j.user ? userFromJson(j.user) : undefined,
      accessToken: j.accessToken,
      accessTokenExpiresAt: j.accessTokenExpiresAt ? timestampFromDate(new Date(j.accessTokenExpiresAt)) : undefined,
    };
  },
  async signOut(_req: object): Promise<object> {
    await apiJson("/auth/signout", { method: "POST", body: "{}" });
    return {};
  },
  async refreshToken(_req: object): Promise<{ accessToken?: string; expiresAt?: { seconds: bigint; nanos: number } }> {
    await doRefreshAccessToken();
    const t = getAccessToken();
    return { accessToken: t ?? undefined };
  },
};

export const userServiceClient = {
  async listUsers(req: { pageSize?: number; pageToken?: string }) {
    const q = new URLSearchParams();
    if (req.pageSize != null) q.set("pageSize", String(req.pageSize));
    if (req.pageToken) q.set("pageToken", req.pageToken);
    const qs = q.toString();
    const j = await apiJson<{ users: Record<string, unknown>[]; nextPageToken?: string; totalSize?: number }>(
      `/users${qs ? `?${qs}` : ""}`,
    );
    return { users: j.users.map((u) => userFromJson(u)), nextPageToken: j.nextPageToken ?? "", totalSize: j.totalSize ?? 0 };
  },
  async createUser(req: { user: Partial<User> & { username?: string; password?: string }; userId?: string; validateOnly?: boolean }) {
    const res = await apiFetch("/users", {
      method: "POST",
      body: JSON.stringify({
        user: {
          username: req.user.username,
          password: req.user.password,
          role: req.user.role,
          displayName: req.user.displayName,
          email: req.user.email,
          state: req.user.state,
        },
        userId: req.userId,
        validateOnly: req.validateOnly,
      }),
    });
    await throwUnlessOk(res);
    const j = (await readJson(res)) as Record<string, unknown>;
    return userFromJson(j);
  },
  async getUser(req: { name: string }): Promise<User> {
    const pathSeg = encodeURIComponent(req.name.replace(/^users\//, ""));
    const j = (await apiJson<Record<string, unknown>>(`/users/${pathSeg}`)) as Record<string, unknown>;
    return userFromJson(j);
  },
  async getUserStats(req: { name: string }) {
    const base = userSeg(req.name);
    const j = await apiJson<Record<string, unknown>>(`/users/${encodeURIComponent(`${base}:getStats`)}`);
    return userStatsFromJson(j);
  },
  async updateUser(req: { user: User; updateMask: FieldMask }): Promise<User> {
    const username = userSeg(req.user.name);
    const res = await apiFetch(`/users/${encodeURIComponent(username)}`, {
      method: "PATCH",
      body: JSON.stringify({
        user: {
          username: req.user.username,
          displayName: req.user.displayName,
          email: req.user.email,
          password: (req.user as { password?: string }).password,
          role: req.user.role,
          state: req.user.state,
          avatarUrl: req.user.avatarUrl,
          description: req.user.description,
        },
        updateMask: req.updateMask,
      }),
    });
    await throwUnlessOk(res);
    return userFromJson((await readJson(res)) as Record<string, unknown>);
  },
  async deleteUser(req: { name: string }): Promise<object> {
    const username = userSeg(req.name);
    await apiJson(`/users/${encodeURIComponent(username)}`, { method: "DELETE" });
    return {};
  },
  async listUserSettings(req: { parent: string; pageSize?: number; pageToken?: string; readMask?: string }) {
    const u = userSeg(req.parent);
    const q = new URLSearchParams();
    if (req.pageSize != null) q.set("pageSize", String(req.pageSize));
    if (req.pageToken) q.set("pageToken", req.pageToken);
    if (req.readMask) q.set("readMask", req.readMask);
    const qs = q.toString();
    const j = await apiJson<{ settings: Record<string, unknown>[]; nextPageToken?: string; totalSize?: number }>(
      `/users/${encodeURIComponent(u)}/settings${qs ? `?${qs}` : ""}`,
    );
    return {
      settings: j.settings.map((s) => userSettingFromJson(s)),
      nextPageToken: j.nextPageToken ?? "",
      totalSize: j.totalSize ?? j.settings.length,
    };
  },
  async updateUserSetting(req: { setting: UserSetting; updateMask: FieldMask }): Promise<UserSetting> {
    const m = req.setting.name.match(/^users\/([^/]+)\/settings\/(.+)$/);
    if (!m) throw new ConnectError("invalid setting name", Code.InvalidArgument);
    const [, user, key] = m;
    const body: Record<string, unknown> = { setting: {} };
    if (req.setting.value.case === "generalSetting") {
      (body.setting as Record<string, unknown>).generalSetting = req.setting.value.value;
    } else if (req.setting.value.case === "webhooksSetting") {
      (body.setting as Record<string, unknown>).webhooksSetting = req.setting.value.value;
    }
    const res = await apiFetch(`/users/${encodeURIComponent(user)}/settings/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...body,
        updateMask: req.updateMask,
      }),
    });
    await throwUnlessOk(res);
    return userSettingFromJson((await readJson(res)) as Record<string, unknown>);
  },
  async listPersonalAccessTokens(req: { parent: string }): Promise<{ personalAccessTokens: PersonalAccessToken[] }> {
    const u = userSeg(req.parent);
    const j = await apiJson<{
      personalAccessTokens: { name: string; description?: string; createdAt?: string; createTime?: string }[];
    }>(`/users/${encodeURIComponent(u)}/personalAccessTokens`);
    return {
      personalAccessTokens: j.personalAccessTokens.map((row) => {
        const iso = row.createdAt ?? row.createTime;
        return create(PersonalAccessTokenSchema, {
          name: row.name,
          description: row.description ?? "",
          createdAt: iso ? timestampFromDate(new Date(iso)) : undefined,
        });
      }),
    };
  },
  async createPersonalAccessToken(req: {
    parent?: string;
    personalAccessToken?: { description?: string };
    description?: string;
    expiresInDays?: number;
  }): Promise<CreatePersonalAccessTokenResponse> {
    const u = userSeg(req.parent ?? "");
    if (!u) {
      throw new ConnectError("invalid parent", Code.InvalidArgument);
    }
    const description = req.description ?? req.personalAccessToken?.description ?? "";
    const raw = await apiJson<{
      personalAccessToken?: { name: string; description?: string; createdAt?: string; createTime?: string };
      token?: string;
      accessToken?: string;
    }>(`/users/${encodeURIComponent(u)}/personalAccessTokens`, {
      method: "POST",
      body: JSON.stringify({
        description,
        expiresInDays: req.expiresInDays ?? 0,
      }),
    });
    const meta = raw.personalAccessToken;
    const iso = meta?.createdAt ?? meta?.createTime;
    return create(CreatePersonalAccessTokenResponseSchema, {
      personalAccessToken: meta
        ? create(PersonalAccessTokenSchema, {
            name: meta.name,
            description: meta.description ?? "",
            createdAt: iso ? timestampFromDate(new Date(iso)) : undefined,
          })
        : undefined,
      token: raw.token ?? raw.accessToken ?? "",
    });
  },
  async deletePersonalAccessToken(req: { name: string }): Promise<object> {
    const m = req.name.match(/^users\/([^/]+)\/personalAccessTokens\/(.+)$/);
    if (!m) throw new ConnectError("invalid token name", Code.InvalidArgument);
    await apiJson(`/users/${encodeURIComponent(m[1])}/personalAccessTokens/${encodeURIComponent(m[2])}`, { method: "DELETE" });
    return {};
  },
  async listUserWebhooks(req: { parent: string; pageSize?: number; pageToken?: string }) {
    const u = userSeg(req.parent);
    const q = new URLSearchParams();
    if (req.pageSize != null) q.set("pageSize", String(req.pageSize));
    if (req.pageToken) q.set("pageToken", req.pageToken);
    const qs = q.toString();
    const j = await apiJson<{ webhooks: Record<string, unknown>[] }>(`/users/${encodeURIComponent(u)}/webhooks${qs ? `?${qs}` : ""}`);
    return {
      webhooks: j.webhooks.map((w) => webhookFromJson(w)),
    };
  },
  async createUserWebhook(req: { parent: string; webhook?: { url?: string; displayName?: string } }) {
    const u = userSeg(req.parent);
    return apiJson<Record<string, unknown>>(`/users/${encodeURIComponent(u)}/webhooks`, {
      method: "POST",
      body: JSON.stringify({ webhook: { url: req.webhook?.url } }),
    });
  },
  async updateUserWebhook(req: { webhook: { name?: string; url?: string; displayName?: string }; updateMask: FieldMask }) {
    const wh = req.webhook;
    const name = wh.name ?? "";
    const m = name.match(/^users\/([^/]+)\/webhooks\/([^/]+)$/);
    if (!m) throw new ConnectError("invalid webhook name", Code.InvalidArgument);
    return apiJson<Record<string, unknown>>(`/users/${encodeURIComponent(m[1])}/webhooks/${encodeURIComponent(m[2])}`, {
      method: "PATCH",
      body: JSON.stringify({
        webhook: { url: wh.url, displayName: wh.displayName },
        updateMask: req.updateMask,
      }),
    });
  },
  async deleteUserWebhook(req: { name: string }): Promise<object> {
    const m = req.name.match(/^users\/([^/]+)\/webhooks\/([^/]+)$/);
    if (!m) throw new ConnectError("invalid webhook name", Code.InvalidArgument);
    await apiJson(`/users/${encodeURIComponent(m[1])}/webhooks/${encodeURIComponent(m[2])}`, { method: "DELETE" });
    return {};
  },
  async listUserNotifications(req: { parent: string }) {
    const u = userSeg(req.parent);
    const j = await apiJson<{ notifications: Record<string, unknown>[] }>(`/users/${encodeURIComponent(u)}/notifications`);
    return { notifications: j.notifications.map((n) => notificationFromJson(n)) };
  },
  async updateUserNotification(req: {
    notification: { name?: string; status?: UserNotification_Status; payload?: unknown };
    updateMask?: FieldMask;
  }) {
    const name = req.notification.name ?? "";
    const m = name.match(/^users\/([^/]+)\/notifications\/([^/]+)$/);
    if (!m) throw new ConnectError("invalid notification name", Code.InvalidArgument);
    const j = await apiJson<Record<string, unknown>>(`/users/${encodeURIComponent(m[1])}/notifications/${encodeURIComponent(m[2])}`, {
      method: "PATCH",
      body: JSON.stringify({ notification: { status: req.notification.status, payload: req.notification.payload } }),
    });
    return j;
  },
  async deleteUserNotification(req: { name: string }): Promise<object> {
    const m = req.name.match(/^users\/([^/]+)\/notifications\/([^/]+)$/);
    if (!m) throw new ConnectError("invalid notification name", Code.InvalidArgument);
    await apiJson(`/users/${encodeURIComponent(m[1])}/notifications/${encodeURIComponent(m[2])}`, { method: "DELETE" });
    return {};
  },
  async listAllUserStats(_req: object) {
    const j = await apiJson<{ stats: Record<string, unknown>[] }>("/users:stats");
    return { stats: j.stats.map((row) => userStatsFromJson(row)) };
  },
  async batchGetUsers(req: { usernames: string[] }): Promise<{ users: User[] }> {
    const j = await apiJson<{ users?: Record<string, unknown>[] }>("/users:batchGet", {
      method: "POST",
      body: JSON.stringify({ usernames: req.usernames }),
    });
    return { users: (j.users ?? []).map((u) => userFromJson(u)) };
  },
  async listLinkedIdentities(req: { parent: string }): Promise<{ linkedIdentities: LinkedIdentity[] }> {
    const u = userSeg(req.parent);
    const j = await apiJson<{ linkedIdentities?: Record<string, unknown>[] }>(`/users/${encodeURIComponent(u)}/linkedIdentities`);
    const identities = (j.linkedIdentities ?? []).map((li) =>
      create(LinkedIdentitySchema, {
        name: String(li.name ?? ""),
        idpName: String(li.idpName ?? ""),
        externUid: String(li.externUid ?? ""),
      }),
    );
    return { linkedIdentities: identities };
  },
  async createLinkedIdentity(req: {
    parent: string;
    idpName: string;
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<LinkedIdentity> {
    const u = userSeg(req.parent);
    const j = await apiJson<Record<string, unknown>>(`/users/${encodeURIComponent(u)}/linkedIdentities`, {
      method: "POST",
      body: JSON.stringify({
        idpName: req.idpName,
        code: req.code,
        redirectUri: req.redirectUri,
        codeVerifier: req.codeVerifier ?? "",
      }),
    });
    return create(LinkedIdentitySchema, {
      name: String(j.name ?? ""),
      idpName: String(j.idpName ?? ""),
      externUid: String(j.externUid ?? ""),
    });
  },
  async getLinkedIdentity(req: { name: string }): Promise<LinkedIdentity> {
    const m = req.name.match(/^users\/([^/]+)\/linkedIdentities\/(.+)$/);
    if (!m) throw new ConnectError("invalid linked identity name", Code.InvalidArgument);
    const j = await apiJson<Record<string, unknown>>(`/users/${encodeURIComponent(m[1])}/linkedIdentities/${encodeURIComponent(m[2])}`);
    return create(LinkedIdentitySchema, {
      name: String(j.name ?? ""),
      idpName: String(j.idpName ?? ""),
      externUid: String(j.externUid ?? ""),
    });
  },
  async deleteLinkedIdentity(req: { name: string }): Promise<object> {
    const m = req.name.match(/^users\/([^/]+)\/linkedIdentities\/(.+)$/);
    if (!m) throw new ConnectError("invalid linked identity name", Code.InvalidArgument);
    await apiJson(`/users/${encodeURIComponent(m[1])}/linkedIdentities/${encodeURIComponent(m[2])}`, { method: "DELETE" });
    return {};
  },
};

export const shortcutServiceClient = {
  async listShortcuts(req: { parent?: string; pageSize?: number; pageToken?: string }) {
    if (!req.parent) {
      return { shortcuts: [] as Shortcut[], nextPageToken: "", totalSize: 0 };
    }
    const u = userSeg(req.parent);
    const q = new URLSearchParams();
    if (req.pageSize != null) q.set("pageSize", String(req.pageSize));
    if (req.pageToken) q.set("pageToken", req.pageToken);
    const qs = q.toString();
    const j = await apiJson<{ shortcuts: Record<string, unknown>[]; nextPageToken?: string; totalSize?: number }>(
      `/users/${encodeURIComponent(u)}/shortcuts${qs ? `?${qs}` : ""}`,
    );
    return {
      shortcuts: j.shortcuts.map((s) => shortcutFromJson(s)),
      nextPageToken: j.nextPageToken ?? "",
      totalSize: j.totalSize ?? j.shortcuts.length,
    };
  },
  async createShortcut(req: { parent?: string; shortcut?: { name?: string; title?: string; filter?: string } }) {
    if (!req.parent) throw new ConnectError("parent required", Code.InvalidArgument);
    const u = userSeg(req.parent);
    const j = await apiJson<Record<string, unknown>>(`/users/${encodeURIComponent(u)}/shortcuts`, {
      method: "POST",
      body: JSON.stringify({ shortcut: { title: req.shortcut?.title, filter: req.shortcut?.filter } }),
    });
    return { shortcut: shortcutFromJson(j) };
  },
  async updateShortcut(req: { shortcut: Shortcut; updateMask: FieldMask }) {
    const m = req.shortcut.name.match(/^users\/([^/]+)\/shortcuts\/([^/]+)$/);
    if (!m) throw new ConnectError("invalid shortcut name", Code.InvalidArgument);
    const j = await apiJson<Record<string, unknown>>(`/users/${encodeURIComponent(m[1])}/shortcuts/${encodeURIComponent(m[2])}`, {
      method: "PATCH",
      body: JSON.stringify({
        shortcut: { title: req.shortcut.title, filter: req.shortcut.filter },
        updateMask: req.updateMask,
      }),
    });
    return { shortcut: shortcutFromJson(j) };
  },
  async deleteShortcut(req: { name: string }): Promise<object> {
    const m = req.name.match(/^users\/([^/]+)\/shortcuts\/([^/]+)$/);
    if (!m) throw new ConnectError("invalid shortcut name", Code.InvalidArgument);
    await apiJson(`/users/${encodeURIComponent(m[1])}/shortcuts/${encodeURIComponent(m[2])}`, { method: "DELETE" });
    return {};
  },
};

export const aiServiceClient = {
  async transcribe(req: {
    providerId: string;
    config?: { prompt?: string; language?: string };
    audio: { content: string; filename?: string; contentType?: string };
  }): Promise<{ text: string }> {
    const res = await apiFetch("/ai:transcribe", {
      method: "POST",
      body: JSON.stringify({
        providerId: req.providerId,
        config: req.config,
        audio: req.audio,
      }),
    });
    await throwUnlessOk(res);
    const j = (await readJson(res)) as { text?: string };
    return { text: j.text ?? "" };
  },
};

export const memoServiceClient = {
  async listMemos(req: Record<string, unknown>) {
    const j = await apiJson<{ memos: Record<string, unknown>[]; nextPageToken?: string }>(`/memos${listMemosQuery(req)}`);
    return { memos: j.memos.map((m) => memoFromJson(m)), nextPageToken: j.nextPageToken ?? "" };
  },
  async getMemo(req: { name: string }): Promise<Memo> {
    const id = memoIdFromName(req.name);
    const j = (await apiJson<Record<string, unknown>>(`/memos/${encodeURIComponent(id)}`)) as Record<string, unknown>;
    return memoFromJson(j);
  },
  async createMemo(req: { memo?: Memo }) {
    const m = req.memo;
    const loc = m?.location;
    const j = await apiJson<Record<string, unknown>>("/memos", {
      method: "POST",
      body: JSON.stringify({
        content: m?.content,
        visibility: m?.visibility,
        state: m?.state,
        pinned: m?.pinned,
        ...(loc
          ? {
              location: {
                placeholder: loc.placeholder,
                latitude: loc.latitude,
                longitude: loc.longitude,
              },
            }
          : {}),
      }),
    });
    return memoFromJson(j);
  },
  async listMemoAttachments(req: { name: string; pageSize?: number; pageToken?: string }) {
    const id = memoIdFromName(req.name);
    const q = new URLSearchParams();
    if (req.pageSize != null) q.set("pageSize", String(req.pageSize));
    if (req.pageToken) q.set("pageToken", req.pageToken);
    const qs = q.toString();
    const j = await apiJson<{ attachments: Record<string, unknown>[]; nextPageToken?: string }>(
      `/memos/${encodeURIComponent(id)}/attachments${qs ? `?${qs}` : ""}`,
    );
    return {
      attachments: (j.attachments ?? []).map((a) => attachmentFromJson(a)),
      nextPageToken: j.nextPageToken ?? "",
    };
  },
  async setMemoAttachments(req: { name: string; attachments: Attachment[] }) {
    const id = memoIdFromName(req.name);
    await apiJson(`/memos/${encodeURIComponent(id)}/attachments`, {
      method: "PATCH",
      body: JSON.stringify({
        attachments: req.attachments.map((a) => ({ name: a.name })),
      }),
    });
    return {};
  },
  async updateMemo(req: { memo: Memo; updateMask: FieldMask }) {
    const id = memoIdFromName(req.memo.name);
    const paths = req.updateMask.paths ?? [];
    const patch: Record<string, unknown> = {};
    for (const p of paths) {
      if (p === "content") patch.content = req.memo.content;
      if (p === "visibility") patch.visibility = req.memo.visibility;
      if (p === "state") patch.state = req.memo.state;
      if (p === "pinned") patch.pinned = req.memo.pinned;
      if (p === "display_time" || p === "displayTime") {
        patch.displayTime = req.memo.displayTime ? timestampDate(req.memo.displayTime).toISOString() : undefined;
      }
      if (p === "location") {
        const loc = req.memo.location;
        if (loc !== undefined && loc !== null) {
          patch.location = {
            placeholder: loc.placeholder ?? "",
            latitude: Number.isFinite(loc.latitude) ? loc.latitude : 0,
            longitude: Number.isFinite(loc.longitude) ? loc.longitude : 0,
          };
        } else {
          patch.location = null;
        }
      }
    }
    // Send updateMask alongside memo fields so the server can validate it.
    patch.updateMask = { paths };
    const j = await apiJson<Record<string, unknown>>(`/memos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return memoFromJson(j);
  },
  async deleteMemo(req: { name: string }): Promise<object> {
    const id = memoIdFromName(req.name);
    await apiJson(`/memos/${encodeURIComponent(id)}`, { method: "DELETE" });
    return {};
  },
  async listMemoComments(req: { name: string; pageSize?: number; pageToken?: string }) {
    const id = memoIdFromName(req.name);
    const q = new URLSearchParams();
    if (req.pageSize != null) q.set("pageSize", String(req.pageSize));
    if (req.pageToken) q.set("pageToken", req.pageToken);
    const qs = q.toString();
    const j = await apiJson<{ memos: Record<string, unknown>[]; nextPageToken?: string; totalSize?: number }>(
      `/memos/${encodeURIComponent(id)}/comments${qs ? `?${qs}` : ""}`,
    );
    return {
      memos: j.memos.map((m) => memoFromJson(m)),
      nextPageToken: j.nextPageToken ?? "",
      totalSize: j.totalSize ?? j.memos.length,
    };
  },
  async createMemoComment(req: { name: string; comment?: Memo }) {
    const id = memoIdFromName(req.name);
    const c = req.comment;
    const loc = c?.location;
    const j = await apiJson<Record<string, unknown>>(`/memos/${encodeURIComponent(id)}/comments`, {
      method: "POST",
      body: JSON.stringify({
        comment: {
          content: c?.content,
          visibility: c?.visibility,
          state: c?.state,
          ...(loc
            ? {
                location: {
                  placeholder: loc.placeholder ?? "",
                  latitude: loc.latitude ?? 0,
                  longitude: loc.longitude ?? 0,
                },
              }
            : {}),
        },
      }),
    });
    return memoFromJson(j);
  },
  async listMemoRelations(req: { name: string }) {
    const id = memoIdFromName(req.name);
    const j = await apiJson<{ relations: Record<string, unknown>[] }>(`/memos/${encodeURIComponent(id)}/relations`);
    const relations = (j.relations ?? []).map((r) =>
      create(MemoRelationSchema, {
        memo: r.memo,
        relatedMemo: r.relatedMemo,
        type: r.type,
      } as Record<string, unknown>),
    );
    return { relations, nextPageToken: "", totalSize: relations.length };
  },
  async setMemoRelations(req: { name: string; relations: MemoRelation[] }) {
    const id = memoIdFromName(req.name);
    await apiJson(`/memos/${encodeURIComponent(id)}/relations`, {
      method: "PATCH",
      body: JSON.stringify({
        relations: req.relations.map((rel) => ({
          relatedMemo: rel.relatedMemo,
          type: rel.type,
        })),
      }),
    });
    return {};
  },
  async listMemoReactions(req: { name: string }) {
    const id = memoIdFromName(req.name);
    const j = await apiJson<{ reactions: Record<string, unknown>[]; nextPageToken?: string; totalSize?: number }>(
      `/memos/${encodeURIComponent(id)}/reactions`,
    );
    return {
      reactions: j.reactions,
      nextPageToken: j.nextPageToken ?? "",
      totalSize: j.totalSize ?? j.reactions.length,
    };
  },
  async upsertMemoReaction(req: { name: string; reaction: { contentId?: string; reactionType?: string } }): Promise<Reaction> {
    const id = memoIdFromName(req.name);
    const j = await apiJson<Record<string, unknown>>(`/memos/${encodeURIComponent(id)}/reactions`, {
      method: "POST",
      body: JSON.stringify({ reaction: { reactionType: req.reaction.reactionType } }),
    });
    return create(ReactionSchema, {
      ...j,
      createTime: j.createTime ? timestampFromDate(new Date(String(j.createTime))) : undefined,
    } as Record<string, unknown>);
  },
  async deleteMemoReaction(req: { name: string }): Promise<object> {
    const m = req.name.match(/^memos\/([^/]+)\/reactions\/([^/]+)$/);
    if (!m) throw new ConnectError("invalid reaction name", Code.InvalidArgument);
    await apiJson(`/memos/${encodeURIComponent(m[1])}/reactions/${encodeURIComponent(m[2])}`, { method: "DELETE" });
    return {};
  },
  async listMemoShares(req: { parent: string }) {
    const id = memoIdFromName(req.parent);
    const j = await apiJson<{ shares: Record<string, unknown>[] }>(`/memos/${encodeURIComponent(id)}/shares`);
    return { memoShares: (j.shares ?? []).map((s) => memoShareFromJson(s)) };
  },
  async createMemoShare(req: { parent: string; memoShare?: MemoShare }) {
    const id = memoIdFromName(req.parent);
    const j = await apiJson<Record<string, unknown>>(`/memos/${encodeURIComponent(id)}/shares`, {
      method: "POST",
      body: JSON.stringify({
        memoShare: {
          expireTime: req.memoShare?.expireTime ? timestampDate(req.memoShare.expireTime).toISOString() : undefined,
        },
      }),
    });
    return { memoShare: memoShareFromJson(j) };
  },
  async deleteMemoShare(req: { name: string }): Promise<object> {
    const m = req.name.match(/^memos\/([^/]+)\/shares\/([^/]+)$/);
    if (!m) throw new ConnectError("invalid share name", Code.InvalidArgument);
    await apiJson(`/memos/${encodeURIComponent(m[1])}/shares/${encodeURIComponent(m[2])}`, { method: "DELETE" });
    return {};
  },
  async getMemoByShare(req: { shareId: string }): Promise<Memo> {
    const j = (await apiJson<Record<string, unknown>>(`/shares/${encodeURIComponent(req.shareId)}`)) as Record<string, unknown>;
    return memoFromJson(j);
  },
};

/** Removed server features: keep export so accidental imports fail at runtime clearly. */
export const attachmentServiceClient = {
  async listAttachments(req: { pageSize?: number; pageToken?: string; filter?: string }): Promise<{
    attachments: Attachment[];
    nextPageToken: string;
    totalSize: number;
  }> {
    const q = new URLSearchParams();
    if (req.pageSize != null) q.set("pageSize", String(req.pageSize));
    if (req.pageToken) q.set("pageToken", String(req.pageToken));
    if (req.filter) q.set("filter", req.filter);
    const qs = q.toString();
    const j = await apiJson<{
      attachments: Record<string, unknown>[];
      nextPageToken?: string;
      totalSize?: number;
    }>(`/attachments${qs ? `?${qs}` : ""}`);
    return {
      attachments: (j.attachments ?? []).map((a) => attachmentFromJson(a)),
      nextPageToken: j.nextPageToken ?? "",
      totalSize: j.totalSize ?? j.attachments.length,
    };
  },
  async createAttachment(req: { attachment?: Attachment; attachmentId?: string }): Promise<Attachment> {
    const a = req.attachment;
    const base64Content = a?.content && a.content.length > 0 ? bytesToBase64(a.content) : "";
    const j = await apiJson<Record<string, unknown>>("/attachments", {
      method: "POST",
      body: JSON.stringify({
        attachment: {
          filename: a?.filename ?? "",
          content: base64Content,
          type: a?.type ?? "",
          memo: a?.memo ?? "",
          externalLink: a?.externalLink ?? "",
        },
        attachmentId: req.attachmentId ?? "",
      }),
    });
    return attachmentFromJson(j);
  },
  async deleteAttachment(req: { name: string }): Promise<object> {
    const id = req.name.replace(/^attachments\//, "");
    await apiJson(`/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
    return {};
  },
  async batchDeleteAttachments(req: { names: string[] }): Promise<object> {
    await apiJson("/attachments:batchDelete", {
      method: "POST",
      body: JSON.stringify({ names: req.names }),
    });
    return {};
  },
};

export const identityProviderServiceClient = {
  async listIdentityProviders(_req?: object): Promise<{ identityProviders: IdentityProvider[] }> {
    const j = await apiJson<{ identityProviders?: Record<string, unknown>[] }>("/identity-providers");
    const identityProviders = (j.identityProviders ?? []).map((row) =>
      create(IdentityProviderSchema, {
        name: String(row.name ?? ""),
        title: String(row.title ?? ""),
        type:
          row.type === "OAUTH2" || Number(row.type) === IdentityProvider_Type.OAUTH2
            ? IdentityProvider_Type.OAUTH2
            : IdentityProvider_Type.TYPE_UNSPECIFIED,
        identifierFilter: String(row.identifierFilter ?? ""),
        config: {
          config: {
            case: "oauth2Config",
            value: (row.config as { oauth2Config?: Record<string, unknown> } | undefined)?.oauth2Config ?? {},
          },
        },
      } as Record<string, unknown>),
    );
    return { identityProviders };
  },
  async createIdentityProvider(req: { identityProvider?: IdentityProvider; identityProviderId?: string }): Promise<IdentityProvider> {
    const body = {
      identityProvider: req.identityProvider,
      identityProviderId: req.identityProviderId ?? "",
    };
    const j = await apiJson<Record<string, unknown>>("/identity-providers", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return create(IdentityProviderSchema, j);
  },
  async updateIdentityProvider(req: { identityProvider?: IdentityProvider; updateMask?: FieldMask }): Promise<IdentityProvider> {
    if (!req.identityProvider?.name) {
      throw new ConnectError("identityProvider.name is required", Code.InvalidArgument);
    }
    const uid = req.identityProvider.name.replace(/^identity-providers\//, "");
    const j = await apiJson<Record<string, unknown>>(`/identity-providers/${encodeURIComponent(uid)}`, {
      method: "PATCH",
      body: JSON.stringify({
        identityProvider: req.identityProvider,
        updateMask: req.updateMask,
      }),
    });
    return create(IdentityProviderSchema, j);
  },
  async deleteIdentityProvider(req: { name: string }): Promise<object> {
    const uid = req.name.replace(/^identity-providers\//, "");
    await apiJson(`/identity-providers/${encodeURIComponent(uid)}`, { method: "DELETE" });
    return {};
  },
};
