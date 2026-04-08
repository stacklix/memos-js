import { Hono } from "hono";
import type { ApiVariables } from "../../types/api-variables.js";
import type { AppDeps } from "../../types/deps.js";
import { createRepository } from "../../db/repository.js";
import { GrpcCode, jsonError } from "../../lib/grpc-status.js";
import { userToJson } from "../../lib/serializers.js";
import {
  parseInstanceStorageSetting,
  storageSettingToApiJson,
} from "../../lib/instance-storage-setting.js";
import {
  parseInstanceNotificationSetting,
} from "../../lib/instance-notification-setting.js";

function toNotificationApiResponse(setting: ReturnType<typeof parseInstanceNotificationSetting>) {
  return {
    email: {
      ...setting.email,
      // Keep parity with golang: smtpPassword is write-only.
      smtpPassword: "",
    },
  };
}

const DEFAULT_MEMO_RELATED = {
  displayWithUpdateTime: false,
  contentLengthLimit: 0,
  enableDoubleClickEdit: false,
  reactions: [] as string[],
};

function parseMemoRelatedFromRaw(raw: string | null): typeof DEFAULT_MEMO_RELATED {
  if (!raw) return { ...DEFAULT_MEMO_RELATED };
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const reactions = Array.isArray(j.reactions)
      ? j.reactions.filter((x): x is string => typeof x === "string")
      : [];
    return {
      displayWithUpdateTime: Boolean(j.displayWithUpdateTime),
      contentLengthLimit: typeof j.contentLengthLimit === "number" ? j.contentLengthLimit : 0,
      enableDoubleClickEdit: Boolean(j.enableDoubleClickEdit),
      reactions,
    };
  } catch {
    return { ...DEFAULT_MEMO_RELATED };
  }
}

function parseTagsFromRaw(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as { tags?: Record<string, unknown> };
    if (j.tags && typeof j.tags === "object" && !Array.isArray(j.tags)) return j.tags;
  } catch {
    /* ignore */
  }
  return {};
}

export function createInstanceRoutes(deps: AppDeps) {
  const r = new Hono<{ Variables: ApiVariables }>();
  const repo = createRepository(deps.sql);
  const supportedStorageTypes = deps.attachmentDataDir
    ? ["DATABASE", "LOCAL", "S3"]
    : deps.attachmentR2Bucket
      ? ["DATABASE", "S3", "R2"]
      : ["DATABASE", "S3"];
  const orderSupportedStorageTypes = () => {
    const defaultApiType =
      deps.defaultAttachmentStorageType === "DB"
        ? "DATABASE"
        : deps.defaultAttachmentStorageType;
    return [
      defaultApiType,
      ...supportedStorageTypes.filter((t) => t !== defaultApiType),
    ];
  };

  r.get("/profile", async (c) => {
    if (!deps.demo) await repo.ensureSecretKey();
    const admin = await repo.findAdmin();
    const viewer = c.get("auth") ?? null;
    return c.json({
      version: deps.instanceVersion,
      demo: deps.demo,
      instanceUrl: deps.instanceUrl,
      admin: admin ? userToJson(admin, viewer) : null,
    });
  });

  r.get("/settings/*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const key = pathname.split("/instance/settings/")[1]?.split("/")[0];
    if (!key) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid setting name");
    const general = await repo.getGeneralSetting();
    if (key === "GENERAL") {
      return c.json({
        name: `instance/settings/${key}`,
        generalSetting: {
          disallowUserRegistration: general.disallowUserRegistration,
          disallowPasswordAuth: general.disallowPasswordAuth,
          additionalScript: "",
          additionalStyle: "",
          customProfile: { title: "", description: "", logoUrl: "" },
          weekStartDayOffset: 0,
          disallowChangeUsername: general.disallowChangeUsername,
          disallowChangeNickname: general.disallowChangeNickname,
        },
      });
    }
    if (key === "STORAGE") {
      const auth = c.get("auth");
      if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
      if (auth.role !== "ADMIN") {
        return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
      }
      const setting = parseInstanceStorageSetting(
        await repo.getInstanceSettingRaw("STORAGE"),
        deps.defaultAttachmentStorageType,
      );
      return c.json({
        name: `instance/settings/${key}`,
        storageSetting: storageSettingToApiJson(setting, false),
        supportedStorageTypes: orderSupportedStorageTypes(),
      });
    }
    if (key === "MEMO_RELATED") {
      const memoRelatedSetting = parseMemoRelatedFromRaw(await repo.getInstanceSettingRaw("MEMO_RELATED"));
      return c.json({
        name: `instance/settings/${key}`,
        memoRelatedSetting,
      });
    }
    if (key === "TAGS") {
      const tags = parseTagsFromRaw(await repo.getInstanceSettingRaw("TAGS"));
      return c.json({
        name: `instance/settings/${key}`,
        tagsSetting: { tags },
      });
    }
    if (key === "NOTIFICATION") {
      const auth = c.get("auth");
      if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
      if (auth.role !== "ADMIN") {
        return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
      }
      const notificationSetting = parseInstanceNotificationSetting(
        await repo.getInstanceSettingRaw("NOTIFICATION"),
      );
      return c.json({
        name: `instance/settings/${key}`,
        notificationSetting: toNotificationApiResponse(notificationSetting),
      });
    }
    return jsonError(c, GrpcCode.NOT_FOUND, "setting not found");
  });

  r.patch("/settings/*", async (c) => {
    const auth = c.get("auth");
    if (!auth || auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "admin only");
    }
    const pathname = new URL(c.req.url).pathname;
    const key = pathname.split("/instance/settings/")[1]?.split("/")[0];
    if (!key) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid setting name");
    if (!["GENERAL", "MEMO_RELATED", "TAGS", "STORAGE", "NOTIFICATION"].includes(key)) {
      return jsonError(c, GrpcCode.UNIMPLEMENTED, "this setting cannot be updated via API yet");
    }
    type Body = {
      setting?: {
        generalSetting?: {
          disallowUserRegistration?: boolean;
          disallowPasswordAuth?: boolean;
          disallowChangeUsername?: boolean;
          disallowChangeNickname?: boolean;
        };
        memoRelatedSetting?: {
          displayWithUpdateTime?: boolean;
          contentLengthLimit?: number;
          enableDoubleClickEdit?: boolean;
          reactions?: unknown;
        };
        tagsSetting?: { tags?: unknown };
        storageSetting?: {
          storageType?: unknown;
          filepathTemplate?: string;
          uploadSizeLimitMb?: number;
          s3Config?: {
            accessKeyId?: string;
            accessKeySecret?: string;
            endpoint?: string;
            region?: string;
            bucket?: string;
            usePathStyle?: boolean;
          };
        };
        notificationSetting?: {
          email?: {
            enabled?: boolean;
            smtpHost?: string;
            smtpPort?: number;
            smtpUsername?: string;
            smtpPassword?: string;
            fromEmail?: string;
            fromName?: string;
            replyTo?: string;
            useTls?: boolean;
            useSsl?: boolean;
          };
        };
      };
    };
    let body: Body;
    try {
      body = (await c.req.json()) as Body;
    } catch {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid json");
    }

    if (key === "GENERAL") {
      const gs = body.setting?.generalSetting;
      if (!gs) {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, "setting.generalSetting required");
      }
      await repo.upsertGeneralSetting({
        disallowUserRegistration: gs.disallowUserRegistration,
        disallowPasswordAuth: gs.disallowPasswordAuth,
        disallowChangeUsername: gs.disallowChangeUsername,
        disallowChangeNickname: gs.disallowChangeNickname,
      });
      const g = await repo.getGeneralSetting();
      return c.json({
        name: `instance/settings/GENERAL`,
        generalSetting: {
          disallowUserRegistration: g.disallowUserRegistration,
          disallowPasswordAuth: g.disallowPasswordAuth,
          additionalScript: "",
          additionalStyle: "",
          customProfile: { title: "", description: "", logoUrl: "" },
          weekStartDayOffset: 0,
          disallowChangeUsername: g.disallowChangeUsername,
          disallowChangeNickname: g.disallowChangeNickname,
        },
      });
    }

    if (key === "MEMO_RELATED") {
      const mr = body.setting?.memoRelatedSetting;
      if (!mr) {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, "setting.memoRelatedSetting required");
      }
      const reactions = Array.isArray(mr.reactions)
        ? mr.reactions.filter((x): x is string => typeof x === "string")
        : [];
      const next = {
        displayWithUpdateTime: Boolean(mr.displayWithUpdateTime),
        contentLengthLimit: typeof mr.contentLengthLimit === "number" ? mr.contentLengthLimit : 0,
        enableDoubleClickEdit: Boolean(mr.enableDoubleClickEdit),
        reactions,
      };
      await repo.upsertInstanceSettingRaw("MEMO_RELATED", JSON.stringify(next));
      return c.json({
        name: `instance/settings/MEMO_RELATED`,
        memoRelatedSetting: next,
      });
    }

    if (key === "TAGS") {
      const ts = body.setting?.tagsSetting;
      if (!ts || typeof ts !== "object") {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, "setting.tagsSetting required");
      }
      const tags = (ts as { tags?: unknown }).tags;
      if (!tags || typeof tags !== "object" || Array.isArray(tags)) {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, "tagsSetting.tags must be an object");
      }
      await repo.upsertInstanceSettingRaw("TAGS", JSON.stringify({ tags }));
      return c.json({
        name: `instance/settings/TAGS`,
        tagsSetting: { tags: tags as Record<string, unknown> },
      });
    }

    if (key === "STORAGE") {
      const ss = body.setting?.storageSetting;
      if (!ss) {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, "setting.storageSetting required");
      }
      const current = parseInstanceStorageSetting(
        await repo.getInstanceSettingRaw("STORAGE"),
        deps.defaultAttachmentStorageType,
      );
      const st = ss.storageType;
      const mappedType =
        st === "DATABASE" || st === 1
          ? "DB"
          : st === "LOCAL" || st === 2
            ? "LOCAL"
            : st === "S3" || st === 3
              ? "S3"
              : st === "R2" || st === 4
                ? "R2"
                : current.storageType;
      if (mappedType === "LOCAL" && !deps.attachmentDataDir) {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, "LOCAL storage is not supported in this runtime");
      }
      const next = {
        storageType: mappedType,
        filepathTemplate:
          typeof ss.filepathTemplate === "string" && ss.filepathTemplate.trim() !== ""
            ? ss.filepathTemplate
            : current.filepathTemplate,
        uploadSizeLimitMb:
          typeof ss.uploadSizeLimitMb === "number" && Number.isFinite(ss.uploadSizeLimitMb)
            ? ss.uploadSizeLimitMb
            : current.uploadSizeLimitMb,
        s3Config: ss.s3Config
          ? {
              accessKeyId:
                typeof ss.s3Config.accessKeyId === "string"
                  ? ss.s3Config.accessKeyId
                  : (current.s3Config?.accessKeyId ?? ""),
              accessKeySecret:
                typeof ss.s3Config.accessKeySecret === "string" &&
                ss.s3Config.accessKeySecret !== ""
                  ? ss.s3Config.accessKeySecret
                  : (current.s3Config?.accessKeySecret ?? ""),
              endpoint:
                typeof ss.s3Config.endpoint === "string"
                  ? ss.s3Config.endpoint
                  : (current.s3Config?.endpoint ?? ""),
              region:
                typeof ss.s3Config.region === "string"
                  ? ss.s3Config.region
                  : (current.s3Config?.region ?? ""),
              bucket:
                typeof ss.s3Config.bucket === "string"
                  ? ss.s3Config.bucket
                  : (current.s3Config?.bucket ?? ""),
              usePathStyle:
                typeof ss.s3Config.usePathStyle === "boolean"
                  ? ss.s3Config.usePathStyle
                  : (current.s3Config?.usePathStyle ?? true),
            }
          : current.s3Config,
      };
      await repo.upsertInstanceSettingRaw("STORAGE", JSON.stringify(next));
      return c.json({
        name: `instance/settings/STORAGE`,
        storageSetting: storageSettingToApiJson(next, false),
        supportedStorageTypes: orderSupportedStorageTypes(),
      });
    }

    if (key === "NOTIFICATION") {
      const ns = body.setting?.notificationSetting;
      if (!ns || typeof ns !== "object") {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, "setting.notificationSetting required");
      }
      const current = parseInstanceNotificationSetting(await repo.getInstanceSettingRaw("NOTIFICATION"));
      const e = ns.email ?? {};
      const next = {
        email: {
          enabled: typeof e.enabled === "boolean" ? e.enabled : current.email.enabled,
          smtpHost: typeof e.smtpHost === "string" ? e.smtpHost : current.email.smtpHost,
          smtpPort:
            typeof e.smtpPort === "number" && Number.isFinite(e.smtpPort)
              ? e.smtpPort
              : current.email.smtpPort,
          smtpUsername:
            typeof e.smtpUsername === "string" ? e.smtpUsername : current.email.smtpUsername,
          smtpPassword:
            typeof e.smtpPassword === "string"
              ? (e.smtpPassword === "" ? current.email.smtpPassword : e.smtpPassword)
              : current.email.smtpPassword,
          fromEmail: typeof e.fromEmail === "string" ? e.fromEmail : current.email.fromEmail,
          fromName: typeof e.fromName === "string" ? e.fromName : current.email.fromName,
          replyTo: typeof e.replyTo === "string" ? e.replyTo : current.email.replyTo,
          useTls: typeof e.useTls === "boolean" ? e.useTls : current.email.useTls,
          useSsl: typeof e.useSsl === "boolean" ? e.useSsl : current.email.useSsl,
        },
      };
      await repo.upsertInstanceSettingRaw("NOTIFICATION", JSON.stringify(next));
      return c.json({
        name: `instance/settings/NOTIFICATION`,
        notificationSetting: toNotificationApiResponse(next),
      });
    }

    return jsonError(c, GrpcCode.INTERNAL, "unreachable");
  });

  return r;
}
