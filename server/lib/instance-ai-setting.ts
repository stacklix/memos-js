export interface AIProviderConfig {
  id: string;
  title: string;
  type: string;
  endpoint: string;
  apiKey: string;
}

export interface AISetting {
  providers: AIProviderConfig[];
}

export function parseAISettingFromRaw(raw: string | null): AISetting {
  if (!raw) return { providers: [] };
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const providers = Array.isArray(j.providers)
      ? j.providers.filter(
          (p): p is AIProviderConfig =>
            p != null &&
            typeof p === "object" &&
            typeof (p as Record<string, unknown>).id === "string",
        )
      : [];
    return { providers };
  } catch {
    return { providers: [] };
  }
}

export function aiProviderTypeToNumber(type: unknown): number {
  if (type === "OPENAI" || type === 1) return 1;
  if (type === "GEMINI" || type === 2) return 2;
  return 0;
}

export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "*".repeat(key.length);
  return key.slice(0, 4) + "*".repeat(Math.min(key.length - 8, 8)) + key.slice(-4);
}
