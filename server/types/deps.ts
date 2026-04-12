import type { SqlAdapter } from "../db/sql-adapter.js";
import type { AttachmentStorageMode } from "../services/attachment-storage.js";

export type NotificationEmailSendArgs = {
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  useTls: boolean;
  useSsl: boolean;
  fromEmail: string;
  fromName?: string;
  replyTo?: string;
  to: string;
  subject: string;
  text: string;
};

export type AppDeps = {
  sql: SqlAdapter;
  demo: boolean;
  instanceVersion: string;
  /** Base URL for instance profile, e.g. https://example.com */
  instanceUrl: string;
  /** When true, log request query/headers/body and response headers/body for `/api/v1/*` (`MEMOS_DEBUG_HTTP=1`). */
  debugHttp?: boolean;
  defaultAttachmentStorageType: AttachmentStorageMode;
  attachmentDataDir?: string;
  attachmentR2Bucket?: R2Bucket;
  sendNotificationEmail?: (args: NotificationEmailSendArgs) => Promise<void>;
  /** When true, mount the `/api/v1/sse` Server-Sent Events endpoint. Node.js only; CF Worker streaming is not supported. */
  enableSSE?: boolean;
};
