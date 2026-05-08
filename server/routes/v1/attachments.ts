import { Hono } from "hono";
import type { ApiVariables } from "../../types/api-variables.js";
import type { AppDeps } from "../../types/deps.js";
import { createRepository } from "../../db/repository.js";
import { GrpcCode, jsonError } from "../../lib/grpc-status.js";
import { attachmentToJson } from "../../lib/serializers.js";
import { AttachmentStorageConfigError } from "../../services/attachment-storage.js";
import { parseInstanceStorageSetting } from "../../lib/instance-storage-setting.js";
import { resolveAttachmentStorage } from "../../services/attachment-storage-resolver.js";
import { stripJpegExifMetadata } from "../../lib/strip-jpeg-exif.js";
import { parseAttachmentFilter } from "../../lib/attachment-filter.js";

function attachmentIdFromName(name: string): string | null {
  const p = name.startsWith("attachments/") ? name.slice("attachments/".length) : name;
  return p.length > 0 ? p : null;
}

function decodeBase64(content: string): Uint8Array<ArrayBufferLike> {
  const bin = atob(content);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const JPEG_MIME_TYPES = new Set(["image/jpeg", "image/jpg"]);
const MIME_TYPE_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/;
const MAX_UPLOAD_BUFFER_BYTES = 32 << 20;

function validateFilename(filename: string): boolean {
  if (!filename || filename.includes("/") || filename.includes("\\")) return false;
  if (filename.startsWith(" ") || filename.endsWith(" ")) return false;
  if (filename.startsWith(".") || filename.endsWith(".")) return false;
  if (filename.includes("..")) return false;
  return true;
}

function isValidMimeType(mimeType: string): boolean {
  return mimeType.length > 0 && mimeType.length <= 255 && MIME_TYPE_PATTERN.test(mimeType);
}

function inferMimeTypeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "txt":
      return "text/plain";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    default:
      return "";
  }
}

function resolveUploadLimitBytes(uploadSizeLimitMb: number): number {
  if (!Number.isFinite(uploadSizeLimitMb) || uploadSizeLimitMb <= 0) {
    return MAX_UPLOAD_BUFFER_BYTES;
  }
  return Math.floor(uploadSizeLimitMb * 1024 * 1024);
}

export function createAttachmentRoutes(deps: AppDeps) {
  const r = new Hono<{ Variables: ApiVariables }>();
  const repo = createRepository(deps.sql);

  async function getStorage() {
    const raw = await repo.getInstanceSettingRaw("STORAGE");
    const setting = parseInstanceStorageSetting(raw, deps.defaultAttachmentStorageType);
    return await resolveAttachmentStorage(deps, setting);
  }

  async function getStorageSetting() {
    return parseInstanceStorageSetting(
      await repo.getInstanceSettingRaw("STORAGE"),
      deps.defaultAttachmentStorageType,
    );
  }

  r.get("/", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
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
    const rows = await repo.listAttachments({
      creatorUsername: auth.username,
      limit: pageSize,
      offset: Number.isFinite(offset) ? offset : 0,
      ...(parsedFilter.unlinkedOnly ? { unlinkedOnly: true } : {}),
      ...(parsedFilter.linkedOnly ? { linkedOnly: true } : {}),
      ...(parsedFilter.memoUid ? { memoUid: parsedFilter.memoUid } : {}),
    });
    return c.json({
      attachments: rows.map((x) => attachmentToJson(x)),
      nextPageToken: rows.length === pageSize ? String((Number.isFinite(offset) ? offset : 0) + pageSize) : "",
      totalSize: rows.length,
    });
  });

  r.post("/", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    type Body = {
      attachment?: {
        filename?: string;
        content?: string;
        type?: string;
        memo?: string;
        externalLink?: string;
      };
      attachmentId?: string;
    };
    const body = (await c.req.json()) as Body;
    const a = body.attachment;
    if (!a) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "attachment is required");
    if (!a.filename) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "filename is required");
    if (!validateFilename(a.filename)) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "filename contains invalid characters or format");
    }
    let content: Uint8Array<ArrayBufferLike> = new Uint8Array();
    try {
      content = a.content ? decodeBase64(a.content) : new Uint8Array();
    } catch {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid attachment content");
    }
    const mimeType = (a.type && a.type.length > 0 ? a.type : inferMimeTypeFromFilename(a.filename)) || "application/octet-stream";
    if (!isValidMimeType(mimeType)) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid MIME type format");
    }
    const memoUid =
      a.memo && a.memo.startsWith("memos/") ? a.memo.slice("memos/".length) : undefined;
    const uid = body.attachmentId && body.attachmentId.length > 0 ? body.attachmentId : crypto.randomUUID();
    const storageSetting = await getStorageSetting();
    const uploadLimitBytes = resolveUploadLimitBytes(storageSetting.uploadSizeLimitMb);
    if (content.length > uploadLimitBytes) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "file size exceeds the limit");
    }
    // Align with golang: best-effort EXIF stripping for JPEG uploads.
    if (JPEG_MIME_TYPES.has(mimeType) && content.length > 0) {
      try {
        content = stripJpegExifMetadata(content);
      } catch {
        // Keep upload non-blocking if metadata stripping fails.
      }
    }
    let stored: {
      storageType: "LOCAL" | "DB" | "S3" | "R2";
      reference: string;
      blob: Uint8Array<ArrayBufferLike> | null;
      payload?: Record<string, unknown>;
    };
    try {
      if (a.externalLink && !a.content) {
        const storage = await getStorage();
        stored = {
          storageType: storage.mode,
          reference: a.externalLink,
          blob: null,
        };
      } else {
        const storage = await getStorage();
        stored = await storage.put({
          id: uid,
          filename: a.filename,
          content,
          mimeType,
        });
      }
    } catch (err) {
      if (err instanceof AttachmentStorageConfigError) {
        return jsonError(c, GrpcCode.INVALID_ARGUMENT, err.message);
      }
      throw err;
    }
    const row = await repo.createAttachment({
      id: uid,
      creator: auth.username,
      filename: a.filename,
      content: stored.blob,
      type: mimeType,
      size: content.length,
      ...(memoUid ? { memoUid } : {}),
      storageType: stored.storageType,
      reference: stored.reference,
      payload: JSON.stringify(stored.payload ?? {}),
    });
    return c.json(attachmentToJson(row));
  });

  r.get("/:attachment", async (c) => {
    const uid = attachmentIdFromName(c.req.param("attachment"));
    if (!uid) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid attachment id");
    const row = await repo.getAttachmentByUid(uid);
    if (!row) return jsonError(c, GrpcCode.NOT_FOUND, "attachment not found");
    return c.json(attachmentToJson(row));
  });

  r.patch("/:attachment", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const uid = attachmentIdFromName(c.req.param("attachment"));
    if (!uid) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid attachment id");
    const existing = await repo.getAttachmentByUid(uid);
    if (!existing) return jsonError(c, GrpcCode.NOT_FOUND, "attachment not found");
    if (existing.creator_username !== auth.username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    type Body = {
      attachment?: { filename?: string; memo?: string };
      updateMask?: { paths?: string[] };
    };
    const body = (await c.req.json()) as Body;
    const patch: { filename?: string; memoUid?: string | null } = {};
    for (const p of body.updateMask?.paths ?? []) {
      if (p === "filename" && body.attachment?.filename !== undefined) {
        patch.filename = body.attachment.filename;
      }
      if (p === "memo" && body.attachment?.memo !== undefined) {
        patch.memoUid = body.attachment.memo
          ? body.attachment.memo.replace(/^memos\//, "")
          : null;
      }
    }
    await repo.updateAttachment(uid, patch);
    const next = await repo.getAttachmentByUid(uid);
    if (!next) return jsonError(c, GrpcCode.NOT_FOUND, "attachment not found");
    return c.json(attachmentToJson(next));
  });

  r.delete("/:attachment", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");
    const uid = attachmentIdFromName(c.req.param("attachment"));
    if (!uid) return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid attachment id");
    const existing = await repo.getAttachmentByUid(uid);
    if (!existing) return jsonError(c, GrpcCode.NOT_FOUND, "attachment not found");
    if (existing.creator_username !== auth.username && auth.role !== "ADMIN") {
      return jsonError(c, GrpcCode.PERMISSION_DENIED, "permission denied");
    }
    const storage = await getStorage();
    await storage.delete(existing.reference);
    await repo.deleteAttachment(uid);
    return c.json({});
  });

  return r;
}
