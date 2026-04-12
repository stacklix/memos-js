import { Hono } from "hono";
import type { ApiVariables } from "../../types/api-variables.js";
import { GrpcCode, jsonError } from "../../lib/grpc-status.js";
import { sseBus, type SseEvent } from "../../lib/sse-bus.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export function createSseRoutes() {
  const r = new Hono<{ Variables: ApiVariables }>();

  r.get("/", async (c) => {
    const auth = c.get("auth");
    if (!auth) return jsonError(c, GrpcCode.UNAUTHENTICATED, "permission denied");

    const subscriberId = crypto.randomUUID();

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      sseBus.unsubscribe(subscriberId);
      clearInterval(heartbeatTimer);
      writer.close().catch(() => {});
    };

    const send = (chunk: string): void => {
      writer.write(encoder.encode(chunk)).catch(() => cleanup());
    };

    sseBus.subscribe(subscriberId, (event: SseEvent) => {
      send(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeatTimer = setInterval(() => {
      send(`: heartbeat\n\n`);
    }, HEARTBEAT_INTERVAL_MS);

    // Detect client disconnect via the readable stream being cancelled.
    // `abort` fires when the consumer (the HTTP response) cancels / closes the stream.
    readable.pipeTo(new WritableStream({ abort: cleanup })).catch(() => cleanup());

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return r;
}
