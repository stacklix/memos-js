import { clearAccessToken } from "@/auth-state";
import { ROUTES } from "@/router/routes";
import { buildAuthRoute, isPublicRoute } from "./redirect-safety";

// Re-export the pure helpers so existing call sites (`@/utils/auth-redirect`)
// keep working without every caller switching to the new module. The side-effectful
// `redirectOnAuthFailure` lives here; pure logic lives in `./redirect-safety`.
export {
  AUTH_REASON_PARAM,
  AUTH_REASON_PROTECTED_MEMO,
  AUTH_REDIRECT_PARAM,
  buildAuthRoute,
  getSafeRedirectPath,
  isPublicRoute,
} from "./redirect-safety";

export function redirectOnAuthFailure(
  forceRedirect = false,
  options?: {
    redirect?: string | null;
    reason?: string | null;
  },
): void {
  const currentPath = window.location.pathname;
  const currentRedirectPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  // Already on auth page, nothing to do.
  if (currentPath.startsWith(ROUTES.AUTH)) {
    return;
  }

  // Don't redirect if it's a public route (unless forced, e.g. public visibility is disallowed).
  if (!forceRedirect && isPublicRoute(currentPath)) {
    return;
  }

  clearAccessToken();
  window.location.replace(
    buildAuthRoute({
      ...options,
      redirect: options?.redirect ?? currentRedirectPath,
    }),
  );
}
