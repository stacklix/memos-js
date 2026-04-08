import { describe, expect, it } from "vitest";
import { isValidMemosUsername } from "../../server/lib/user-username.js";

/** Cases from golang `internal/base/resource_name_test.go` (UIDMatcher), via toLowerCase like UpdateUser. */
describe("isValidMemosUsername (golang UIDMatcher parity)", () => {
  const cases: { input: string; expected: boolean }[] = [
    { input: "", expected: false },
    { input: "-abc123", expected: false },
    { input: "012345678901234567890123456789", expected: true },
    { input: "1abc-123", expected: true },
    { input: "A123B456C789", expected: true },
    { input: "a", expected: true },
    { input: "ab", expected: true },
    { input: "a*b&c", expected: false },
    { input: "a--b", expected: true },
    { input: "a-1b-2c", expected: true },
    { input: "a1234567890123456789012345678901", expected: true },
    { input: "abc123", expected: true },
    { input: "abc123-", expected: false },
  ];

  for (const { input, expected } of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(isValidMemosUsername(input)).toBe(expected);
    });
  }
});
