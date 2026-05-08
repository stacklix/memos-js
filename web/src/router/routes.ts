export const ROUTES = {
  // Entry-only route. Hosts the landing redirect, never a business page.
  ENTRY: "/",
  // The authenticated user's primary workspace page.
  HOME: "/home",
  // Backward compatibility alias for older code paths that meant "workspace root".
  ROOT: "/home",
  ATTACHMENTS: "/attachments",
  INBOX: "/inbox",
  ARCHIVED: "/archived",
  SETTING: "/setting",
  EXPLORE: "/explore",
  AUTH: "/auth",
  SHARED_MEMO: "/memos/shares",
} as const;

export type RouteKey = keyof typeof ROUTES;
export type RoutePath = (typeof ROUTES)[RouteKey];
