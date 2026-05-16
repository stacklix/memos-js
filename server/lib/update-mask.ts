import type { Context } from "hono";

type MaskBody = {
  updateMask?: { paths?: string[] };
  update_mask?: { paths?: string[] };
};

/** Parse FieldMask paths from query (`updateMask` / `update_mask`, comma-separated) per grpc-gateway. */
export function fieldMaskPathsFromQuery(c: Context): string[] {
  const raw = c.req.query("updateMask") ?? c.req.query("update_mask");
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function fieldMaskPathsFromBody(body: MaskBody | null | undefined): string[] {
  return body?.updateMask?.paths ?? body?.update_mask?.paths ?? [];
}

/** Merge query + body mask paths (proto: `body: "memo"` leaves FieldMask on the query string). */
export function resolveFieldMaskPaths(c: Context, body: MaskBody | null | undefined): string[] {
  return [...new Set([...fieldMaskPathsFromQuery(c), ...fieldMaskPathsFromBody(body)])];
}
