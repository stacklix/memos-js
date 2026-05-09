import { Hono } from "hono";
import type { ApiVariables } from "../../types/api-variables.js";
import type { AppDeps } from "../../types/deps.js";
import { createRepository } from "../../db/repository.js";
import { GrpcCode, jsonError } from "../../lib/grpc-status.js";
import { parseAISettingFromRaw } from "../../lib/instance-ai-setting.js";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MiB

const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/aac",
  "audio/aiff",
  "audio/flac",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/mpga",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/x-flac",
  "audio/x-m4a",
  "audio/webm",
  "video/mp4",
  "video/mpeg",
  "video/webm",
]);

function isSupportedAudioType(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return SUPPORTED_AUDIO_TYPES.has(base);
}

function decodeBase64(content: string): Uint8Array<ArrayBufferLike> {
  const bin = atob(content);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function createAIActionRoutes(deps: AppDeps) {
  const r = new Hono<{ Variables: ApiVariables }>();
  const repo = createRepository(deps.sql);

  r.post("/ai:transcribe", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");

    type Body = {
      providerId?: string;
      config?: { prompt?: string; language?: string };
      audio?: { content?: string; filename?: string; contentType?: string };
    };
    let body: Body;
    try {
      body = (await c.req.json()) as Body;
    } catch {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "invalid json");
    }

    const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
    if (!providerId) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "providerId is required");
    }

    const audioContent = typeof body.audio?.content === "string" ? body.audio.content : "";
    if (!audioContent) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "audio.content is required");
    }

    let audioBytes: Uint8Array<ArrayBufferLike>;
    try {
      audioBytes = decodeBase64(audioContent);
    } catch {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "audio.content must be valid base64");
    }

    if (audioBytes.length > MAX_AUDIO_BYTES) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, "audio file is too large; maximum size is 25 MiB");
    }

    let contentType = typeof body.audio?.contentType === "string" ? body.audio.contentType.trim() : "";
    if (!contentType) {
      if (audioBytes[0] === 0x49 && audioBytes[1] === 0x44 && audioBytes[2] === 0x33) {
        contentType = "audio/mpeg";
      } else if (audioBytes[0] === 0x52 && audioBytes[1] === 0x49 && audioBytes[2] === 0x46 && audioBytes[3] === 0x46) {
        contentType = "audio/wav";
      } else if (audioBytes[0] === 0x4f && audioBytes[1] === 0x67 && audioBytes[2] === 0x67 && audioBytes[3] === 0x53) {
        contentType = "audio/ogg";
      } else {
        contentType = "audio/webm";
      }
    }

    if (!isSupportedAudioType(contentType)) {
      return jsonError(c, GrpcCode.INVALID_ARGUMENT, `audio content type "${contentType}" is not supported`);
    }

    const filename = typeof body.audio?.filename === "string" ? body.audio.filename.trim() : "audio.webm";
    const prompt = typeof body.config?.prompt === "string" ? body.config.prompt.trim() : "";
    const language = typeof body.config?.language === "string" ? body.config.language.trim() : "";

    const aiSetting = parseAISettingFromRaw(await repo.getInstanceSettingRaw("AI"));
    const provider = aiSetting.providers.find((p) => p.id === providerId);
    if (!provider) {
      return jsonError(c, GrpcCode.NOT_FOUND, "AI provider not found");
    }
    if (!provider.apiKey) {
      return jsonError(c, GrpcCode.FAILED_PRECONDITION, "AI provider has no API key configured");
    }

    const endpoint = provider.endpoint?.trim() || "https://api.openai.com/v1";
    const transcribeUrl = `${endpoint.replace(/\/$/, "")}/audio/transcriptions`;

    const formData = new FormData();
    const blob = new Blob([audioBytes], { type: contentType });
    formData.append("file", blob, filename);
    formData.append("model", "whisper-1");
    if (prompt) formData.append("prompt", prompt);
    if (language) formData.append("language", language);

    let fetchRes: Response;
    try {
      fetchRes = await fetch(transcribeUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: formData,
      });
    } catch (err) {
      console.error("[ai:transcribe] fetch error:", err);
      return jsonError(c, GrpcCode.UNAVAILABLE, "failed to reach AI provider");
    }

    if (!fetchRes.ok) {
      const errText = await fetchRes.text().catch(() => "");
      console.error(`[ai:transcribe] provider error ${fetchRes.status}: ${errText}`);
      return jsonError(c, GrpcCode.INTERNAL, `AI provider returned error: ${fetchRes.status}`);
    }

    const result = (await fetchRes.json()) as { text?: string };
    return c.json({ text: result.text ?? "" });
  });

  return r;
}
