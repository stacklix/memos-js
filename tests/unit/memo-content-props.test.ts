import { describe, expect, it } from "vitest";
import { deriveMemoProperty, extractTitleHint } from "../../server/services/memo-content-props.js";

describe("extractTitleHint", () => {
  it("extracts plain text from first H1", () => {
    expect(extractTitleHint("# My Article Title\n\nBody text here.")).toBe(
      "My Article Title",
    );
  });

  it("does not extract from h2 as first block", () => {
    expect(extractTitleHint("## Sub Heading\n\nBody text.")).toBe("");
  });

  it("does not extract H1 when it is not the first block", () => {
    expect(extractTitleHint("Some text\n\n# Heading Later")).toBe("");
  });

  it("strips inline formatting from H1", () => {
    expect(extractTitleHint("# Title with **bold** and *italic*\n\nBody.")).toBe(
      "Title with bold and italic",
    );
  });

  it("returns empty for plain text without H1", () => {
    expect(extractTitleHint("Just plain text")).toBe("");
    expect(extractTitleHint("")).toBe("");
  });
});

describe("deriveMemoProperty", () => {
  it("includes title only for leading H1", () => {
    expect(deriveMemoProperty("# Title\n\n[Link](url)").title).toBe("Title");
    expect(deriveMemoProperty("Intro\n\n# Late Heading").title).toBe("");
  });
});
