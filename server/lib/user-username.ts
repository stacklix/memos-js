/**
 * Matches golang `internal/base/resource_name.go` UIDMatcher:
 * `^[a-zA-Z0-9]([a-zA-Z0-9-]{0,30}[a-zA-Z0-9])?$`
 * golang applies `strings.ToLower` before matching (see user_service UpdateUser / CreateUser).
 */
const USERNAME_UID_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

export function isValidMemosUsername(username: string): boolean {
  return USERNAME_UID_RE.test(username.toLowerCase());
}
