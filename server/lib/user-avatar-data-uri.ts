/**
 * Aligns with golang `user_service.extractImageInfo` + UpdateUser avatar_url validation.
 * Non-empty values must be `data:<image/*>;base64,...` with an allowed image type.
 */
const DATA_URI_RE = /^data:(.+);base64,(.+)$/;

const ALLOWED_AVATAR_TYPES: Record<string, boolean> = {
  "image/png": true,
  "image/jpeg": true,
  "image/jpg": true,
  "image/gif": true,
  "image/webp": true,
};

export function parseUserAvatarDataUri(
  avatarUrl: string,
): { imageType: string; bytes: Uint8Array<ArrayBufferLike> } | null {
  const m = DATA_URI_RE.exec(avatarUrl);
  if (!m) return null;
  const imageType = m[1] ?? "";
  if (!ALLOWED_AVATAR_TYPES[imageType]) return null;
  try {
    const bin = atob(m[2] ?? "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { imageType, bytes };
  } catch {
    return null;
  }
}

/**
 * @returns error message for INVALID_ARGUMENT, or null if valid (including empty string).
 */
export function validateUserAvatarUrl(avatarUrl: string): string | null {
  if (avatarUrl === "") return null;
  const m = DATA_URI_RE.exec(avatarUrl);
  if (!m) {
    return "invalid data URI format";
  }
  const imageType = m[1] ?? "";
  if (!ALLOWED_AVATAR_TYPES[imageType]) {
    return `invalid avatar image type: ${imageType}. Only PNG, JPEG, GIF, and WebP are allowed`;
  }
  return null;
}
