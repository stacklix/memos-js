import type { DbAttachmentRow, DbMemoRow, DbUserRow } from "../db/repository.js";
import type { AuthPrincipal } from "../types/auth.js";
import { deriveMemoProperty } from "../services/memo-content-props.js";
import { extractTags } from "../services/markdown.js";
import { parseUserAvatarDataUri } from "./user-avatar-data-uri.js";

/** Proto JSON / picky clients (e.g. Swift OpenAPI date-time) often match this shape; see `auth/signin` accessTokenExpiresAt. */
export function protoJsonTimestamp(iso: string): string {
  return iso.replace(/\.\d{1,9}Z$/, "Z");
}

/** Viewer context for `userToJson` (matches golang `convertUserFromStore(user, viewer)`). */
export function authPrincipalFromUserRow(u: DbUserRow): AuthPrincipal {
  return {
    username: u.username,
    role: u.role === "ADMIN" ? "ADMIN" : "USER",
    via: "jwt",
  };
}

function canViewerSeeUserEmail(viewer: AuthPrincipal | null, target: DbUserRow): boolean {
  if (!viewer) return false;
  if (viewer.role === "ADMIN") return true;
  return viewer.username === target.username;
}

/**
 * JSON shape for `memos.api.v1.User`. Email is omitted from the payload for other users unless the viewer is ADMIN
 * (same as golang `canViewerAccessUserEmail`).
 */
export function userToJson(u: DbUserRow, viewer: AuthPrincipal | null) {
  const storedAvatarUrl = u.avatar_url ?? "";
  const avatarUrl =
    storedAvatarUrl && parseUserAvatarDataUri(storedAvatarUrl)
      ? `/file/users/${encodeURIComponent(u.username)}/avatar`
      : storedAvatarUrl;
  return {
    name: `users/${u.username}`,
    role: u.role === "ADMIN" ? "ADMIN" : "USER",
    username: u.username,
    email: canViewerSeeUserEmail(viewer, u) ? (u.email ?? "") : "",
    displayName: u.display_name ?? "",
    avatarUrl,
    description: u.description ?? "",
    state: u.state,
    createTime: protoJsonTimestamp(u.create_time),
    updateTime: protoJsonTimestamp(u.update_time),
  };
}

export function memoToJson(
  m: DbMemoRow,
  extras?: {
    tags?: string[];
    attachments?: ReturnType<typeof attachmentToJson>[];
    relations?: unknown[];
    reactions?: unknown[];
  },
) {
  const lat = m.location_latitude;
  const lng = m.location_longitude;
  const ph = m.location_placeholder;
  const hasLocation =
    ph != null &&
    lat != null &&
    lng != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng);
  return {
    name: `memos/${m.id}`,
    state: m.state,
    creator: `users/${m.creator_username}`,
    createTime: protoJsonTimestamp(m.create_time),
    updateTime: protoJsonTimestamp(m.update_time),
    displayTime: protoJsonTimestamp(m.display_time ?? m.create_time),
    content: m.content,
    visibility: m.visibility,
    tags:
      extras?.tags ??
      (m.payload_tags.length > 0 ? m.payload_tags : extractTags(m.content)),
    pinned: Boolean(m.pinned),
    attachments: extras?.attachments ?? [],
    relations: extras?.relations ?? [],
    reactions: extras?.reactions ?? [],
    property: m.payload_property ?? deriveMemoProperty(m.content),
    snippet: m.snippet ?? "",
    parent: m.parent_memo_id ? `memos/${m.parent_memo_id}` : undefined,
    ...(hasLocation
      ? {
          location: {
            placeholder: ph ?? "",
            latitude: lat,
            longitude: lng,
          },
        }
      : {}),
  };
}

export function attachmentToJson(a: DbAttachmentRow) {
  const isExternalLink = /^https?:\/\//i.test(a.reference);
  let motionMedia:
    | {
        family: string;
        role: string;
        groupId: string;
        presentationTimestampUs: string;
        hasEmbeddedVideo: boolean;
      }
    | undefined;
  try {
    const pl = JSON.parse(a.payload || "{}") as Record<string, unknown>;
    if (pl.motionMedia && typeof pl.motionMedia === "object") {
      const mm = pl.motionMedia as Record<string, unknown>;
      motionMedia = {
        family: typeof mm.family === "string" ? mm.family : "MOTION_MEDIA_FAMILY_UNSPECIFIED",
        role: typeof mm.role === "string" ? mm.role : "MOTION_MEDIA_ROLE_UNSPECIFIED",
        groupId: typeof mm.groupId === "string" ? mm.groupId : "",
        presentationTimestampUs:
          typeof mm.presentationTimestampUs === "string" ? mm.presentationTimestampUs : "0",
        hasEmbeddedVideo: Boolean(mm.hasEmbeddedVideo),
      };
    }
  } catch {
    // Ignore malformed payload — motionMedia will be omitted.
  }
  return {
    name: `attachments/${a.id}`,
    createTime: protoJsonTimestamp(a.create_time),
    filename: a.filename,
    // Only expose externalLink for true remote URLs.
    // Internal storage references (e.g. "attachments/ab/uid.png") must be served via `/file/*`.
    externalLink: isExternalLink ? a.reference : "",
    type: a.type,
    size: String(a.size),
    memo: a.memo_id ? `memos/${a.memo_id}` : undefined,
    ...(motionMedia !== undefined ? { motionMedia } : {}),
  };
}
