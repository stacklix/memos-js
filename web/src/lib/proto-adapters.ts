import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { AttachmentSchema } from "@/types/proto/api/v1/attachment_service_pb";
import { State } from "@/types/proto/api/v1/common_pb";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";
import { LocationSchema, MemoSchema, Visibility } from "@/types/proto/api/v1/memo_service_pb";
import type { User, UserStats } from "@/types/proto/api/v1/user_service_pb";
import { User_Role, UserSchema, UserStatsSchema } from "@/types/proto/api/v1/user_service_pb";

/** REST JSON uses enum names as strings; protobuf-es expects numeric enums. */
function stateFromApiJson(s: unknown): State {
  if (s === State.NORMAL || s === 1) return State.NORMAL;
  if (s === State.ARCHIVED || s === 2) return State.ARCHIVED;
  if (s === State.STATE_UNSPECIFIED || s === 0) return State.STATE_UNSPECIFIED;
  if (typeof s === "string") {
    if (s === "NORMAL") return State.NORMAL;
    if (s === "ARCHIVED") return State.ARCHIVED;
    if (s === "STATE_UNSPECIFIED") return State.STATE_UNSPECIFIED;
  }
  return State.STATE_UNSPECIFIED;
}

function visibilityFromApiJson(v: unknown): Visibility {
  if (typeof v === "number" && v >= 0 && v <= Visibility.PUBLIC) return v as Visibility;
  if (typeof v === "string") {
    if (v === "PRIVATE") return Visibility.PRIVATE;
    if (v === "PROTECTED") return Visibility.PROTECTED;
    if (v === "PUBLIC") return Visibility.PUBLIC;
    if (v === "VISIBILITY_UNSPECIFIED") return Visibility.VISIBILITY_UNSPECIFIED;
  }
  return Visibility.VISIBILITY_UNSPECIFIED;
}

function ts(iso: string | undefined | null) {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return timestampFromDate(d);
}

function locationFromApiJson(raw: unknown): Memo["location"] {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const ph = o.placeholder;
  const lat = o.latitude;
  const lng = o.longitude;
  if (typeof ph !== "string" || typeof lat !== "number" || typeof lng !== "number") return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return create(LocationSchema, { placeholder: ph, latitude: lat, longitude: lng });
}

function attachmentFromApiJson(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return create(AttachmentSchema, {});
  }
  const o = raw as Record<string, unknown>;
  return create(AttachmentSchema, {
    name: String(o.name ?? ""),
    createTime: ts(o.createTime as string),
    filename: String(o.filename ?? ""),
    externalLink: String(o.externalLink ?? ""),
    type: String(o.type ?? ""),
    size: BigInt(String(o.size ?? "0")),
    memo: o.memo ? String(o.memo) : undefined,
  });
}

export function memoFromJson(j: Record<string, unknown>): Memo {
  return create(MemoSchema, {
    name: String(j.name ?? ""),
    state: stateFromApiJson(j.state),
    creator: String(j.creator ?? ""),
    createTime: ts(j.createTime as string),
    updateTime: ts(j.updateTime as string),
    displayTime: ts((j.displayTime as string) ?? (j.createTime as string)),
    content: String(j.content ?? ""),
    visibility: visibilityFromApiJson(j.visibility),
    tags: (j.tags as string[]) ?? [],
    pinned: Boolean(j.pinned),
    attachments: Array.isArray(j.attachments) ? j.attachments.map((a) => attachmentFromApiJson(a)) : [],
    relations: (j.relations as Memo["relations"]) ?? [],
    reactions: (j.reactions as Memo["reactions"]) ?? [],
    property: j.property as Memo["property"],
    snippet: String(j.snippet ?? ""),
    parent: j.parent as string | undefined,
    location: locationFromApiJson(j.location),
  } as Record<string, unknown>);
}

function roleFromApi(r: string | undefined): User_Role {
  if (r === "ADMIN") return User_Role.ADMIN;
  if (r === "USER") return User_Role.USER;
  return User_Role.ROLE_UNSPECIFIED;
}

export function userFromJson(j: Record<string, unknown>): User {
  return create(UserSchema, {
    name: String(j.name ?? ""),
    role: roleFromApi(j.role as string),
    username: String(j.username ?? ""),
    email: String(j.email ?? ""),
    displayName: String(j.displayName ?? ""),
    avatarUrl: String(j.avatarUrl ?? ""),
    description: String(j.description ?? ""),
    state: stateFromApiJson(j.state),
    createTime: ts(j.createTime as string),
    updateTime: ts(j.updateTime as string),
  } as Record<string, unknown>);
}

export function userStatsFromJson(j: Record<string, unknown>): UserStats {
  const rawMemoDisplayTimestamps = Array.isArray(j.memoDisplayTimestamps) ? j.memoDisplayTimestamps : [];
  const memoDisplayTimestamps = rawMemoDisplayTimestamps
    .map((rawTs) => (typeof rawTs === "string" ? ts(rawTs) : undefined))
    .filter((x): x is NonNullable<ReturnType<typeof ts>> => x !== undefined);

  const memoTypeStatsRaw = j.memoTypeStats;
  const memoTypeStats =
    memoTypeStatsRaw && typeof memoTypeStatsRaw === "object"
      ? {
          linkCount: Number((memoTypeStatsRaw as Record<string, unknown>).linkCount ?? 0),
          codeCount: Number((memoTypeStatsRaw as Record<string, unknown>).codeCount ?? 0),
          todoCount: Number((memoTypeStatsRaw as Record<string, unknown>).todoCount ?? 0),
          undoCount: Number((memoTypeStatsRaw as Record<string, unknown>).undoCount ?? 0),
        }
      : undefined;

  const tagCountRaw = j.tagCount;
  const tagCount: Record<string, number> = {};
  if (tagCountRaw && typeof tagCountRaw === "object") {
    for (const [k, v] of Object.entries(tagCountRaw as Record<string, unknown>)) {
      tagCount[k] = Number(v ?? 0);
    }
  }

  return create(UserStatsSchema, {
    name: String(j.name ?? ""),
    memoDisplayTimestamps,
    memoTypeStats,
    tagCount,
    pinnedMemos: Array.isArray(j.pinnedMemos) ? j.pinnedMemos.map((x) => String(x)) : [],
    totalMemoCount: Number(j.totalMemoCount ?? 0),
  } as Record<string, unknown>);
}
