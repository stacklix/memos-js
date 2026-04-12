export type SseEventType =
  | "memo.created"
  | "memo.updated"
  | "memo.deleted"
  | "memo.comment.created"
  | "reaction.upserted"
  | "reaction.deleted";

export interface SseEvent {
  type: SseEventType;
  name: string;
  parent?: string;
}

type SseHandler = (event: SseEvent) => void;

// Singleton in-process pub/sub bus. Keyed by subscriber id.
const _subscribers = new Map<string, SseHandler>();

export const sseBus = {
  emit(event: SseEvent): void {
    for (const handler of _subscribers.values()) {
      try {
        handler(event);
      } catch {
        // Never crash the emitter due to a subscriber error.
      }
    }
  },

  subscribe(id: string, handler: SseHandler): void {
    _subscribers.set(id, handler);
  },

  unsubscribe(id: string): void {
    _subscribers.delete(id);
  },
};
