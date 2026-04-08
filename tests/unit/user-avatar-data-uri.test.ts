import { describe, expect, it } from "vitest";
import { validateUserAvatarUrl } from "../../server/lib/user-avatar-data-uri.js";

describe("validateUserAvatarUrl (golang user_service avatar parity)", () => {
  it("allows empty string", () => {
    expect(validateUserAvatarUrl("")).toBeNull();
  });

  it("allows minimal valid png data URI", () => {
    expect(validateUserAvatarUrl("data:image/png;base64,QQ==")).toBeNull();
  });

  it("rejects non-data URIs", () => {
    expect(validateUserAvatarUrl("https://example.com/x.png")).toBe("invalid data URI format");
  });

  it("rejects wrong image type", () => {
    expect(validateUserAvatarUrl("data:image/svg+xml;base64,PHN2Zy8+")).toContain("invalid avatar image type");
  });
});
