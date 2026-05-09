import { describe, expect, it } from "vitest";
import { apiJson } from "../helpers/http.js";
import { createTestApp } from "../helpers/test-app.js";
import { postFirstUser, signIn } from "../helpers/seed.js";

describe("integration: attachments", () => {
  it("GET /attachments supports golang filename and mime_type filters", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "attfilter", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "attfilter", "secret123");

    for (const attachment of [
      { filename: "report.pdf", type: "application/pdf" },
      { filename: "photo.png", type: "image/png" },
      { filename: "notes.txt", type: "text/plain" },
    ]) {
      const created = await apiJson(app, "/api/v1/attachments", {
        method: "POST",
        bearer: accessToken,
        json: { attachment: { ...attachment, content: "ZGF0YQ==" } },
      });
      expect(created.status).toBe(200);
    }

    const byFilename = await apiJson<{ attachments: { filename: string }[] }>(
      app,
      `/api/v1/attachments?filter=${encodeURIComponent('filename.contains("report")')}`,
      { bearer: accessToken },
    );
    expect(byFilename.status).toBe(200);
    expect(byFilename.body.attachments.map((a) => a.filename)).toEqual(["report.pdf"]);

    const byMime = await apiJson<{ attachments: { filename: string }[] }>(
      app,
      `/api/v1/attachments?filter=${encodeURIComponent('mime_type in ["image/png", "text/plain"]')}`,
      { bearer: accessToken },
    );
    expect(byMime.status).toBe(200);
    expect(byMime.body.attachments.map((a) => a.filename).sort()).toEqual(["notes.txt", "photo.png"]);
  });
});
