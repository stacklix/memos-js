/** golang `user_setting` key `WEBHOOKS`: protojson of `WebhooksUserSetting` (`{ "webhooks": [{ "id", "title", "url" }] }`). */

export type StoredUserWebhook = { id: string; title: string; url: string; signingSecret?: string };

export function newUserWebhookId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function isWebhookRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function normalizeWebhook(x: unknown): StoredUserWebhook | null {
  if (!isWebhookRecord(x)) return null;
  const id = typeof x.id === "string" ? x.id : "";
  const url = typeof x.url === "string" ? x.url : "";
  if (!id || !url) return null;
  const title =
    typeof x.title === "string"
      ? x.title
      : typeof (x as { displayName?: unknown }).displayName === "string"
        ? String((x as { displayName: string }).displayName)
        : "";
  const signingSecret = typeof x.signingSecret === "string" ? x.signingSecret : "";
  return { id, title, url, ...(signingSecret ? { signingSecret } : {}) };
}

/**
 * Accepts golang protojson or legacy TS `{ kind, payload: { webhooks } }` rows.
 */
export function parseWebhooksFromUserSettingValue(raw: string | null): StoredUserWebhook[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const direct = j.webhooks;
    if (Array.isArray(direct)) {
      return direct.map(normalizeWebhook).filter((w): w is StoredUserWebhook => w !== null);
    }
    const payload = j.payload;
    if (isWebhookRecord(payload) && Array.isArray(payload.webhooks)) {
      return payload.webhooks.map(normalizeWebhook).filter((w): w is StoredUserWebhook => w !== null);
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function serializeWebhooksUserSetting(webhooks: StoredUserWebhook[]): string {
  return JSON.stringify({ webhooks });
}
