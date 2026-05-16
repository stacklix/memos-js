export type ParsedAttachmentFilter = {
  unlinkedOnly?: boolean;
  linkedOnly?: boolean;
  memoUid?: string;
  filenameContains?: string;
  mimeTypeEq?: string;
  mimeTypeNe?: string;
  mimeTypeIn?: string[];
};

function parseJsonValue<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function parseAttachmentFilter(rawFilter: string): ParsedAttachmentFilter {
  const filter = rawFilter.trim();
  if (!filter) return {};
  if (filter === "memo_id == null" || filter === "memo == null") {
    return { unlinkedOnly: true };
  }
  if (filter === "memo_id != null" || filter === "memo != null") {
    return { linkedOnly: true };
  }
  const byMemo = filter.match(/^memo(_id)?\s*==\s*"memos\/([^"]+)"$/);
  if (byMemo) {
    return { memoUid: byMemo[2] };
  }
  const filenameContains = filter.match(/^filename\.contains\(([\s\S]+)\)$/);
  if (filenameContains) {
    const value = parseJsonValue<string>(filenameContains[1]!.trim());
    if (typeof value === "string") return { filenameContains: value };
  }
  const mimeEq = filter.match(/^mime_type\s*==\s*("[\s\S]*")$/);
  if (mimeEq) {
    const value = parseJsonValue<string>(mimeEq[1]!.trim());
    if (typeof value === "string") return { mimeTypeEq: value };
  }
  const mimeNe = filter.match(/^mime_type\s*!=\s*("[\s\S]*")$/);
  if (mimeNe) {
    const value = parseJsonValue<string>(mimeNe[1]!.trim());
    if (typeof value === "string") return { mimeTypeNe: value };
  }
  const mimeIn = filter.match(/^mime_type\s+in\s+(\[[\s\S]*\])$/);
  if (mimeIn) {
    const value = parseJsonValue<string[]>(mimeIn[1]!.trim());
    if (Array.isArray(value) && value.every((x) => typeof x === "string")) {
      return { mimeTypeIn: value };
    }
  }
  throw new Error("unsupported filter expression");
}

export function attachmentMatchesParsedFilter(
  attachment: { filename: string; type: string },
  filter: ParsedAttachmentFilter,
): boolean {
  if (filter.filenameContains !== undefined && !attachment.filename.includes(filter.filenameContains)) {
    return false;
  }
  if (filter.mimeTypeEq !== undefined && attachment.type !== filter.mimeTypeEq) return false;
  if (filter.mimeTypeNe !== undefined && attachment.type === filter.mimeTypeNe) return false;
  if (filter.mimeTypeIn !== undefined && !filter.mimeTypeIn.includes(attachment.type)) return false;
  return true;
}
