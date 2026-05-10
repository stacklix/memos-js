import { aiServiceClient } from "@/connect";
import type { InstanceSetting_AIProviderConfig } from "@/types/proto/api/v1/instance_service_pb";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin);
}

export const transcriptionService = {
  async transcribeFile(file: File, provider: InstanceSetting_AIProviderConfig): Promise<string> {
    const content = new Uint8Array(await file.arrayBuffer());
    const response = await aiServiceClient.transcribe({
      providerId: provider.id,
      config: {},
      audio: {
        content: bytesToBase64(content),
        filename: file.name,
        contentType: file.type,
      },
    });

    return response.text;
  },
};
