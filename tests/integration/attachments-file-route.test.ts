import { describe, expect, it } from "vitest";
import { apiJson, apiRequest } from "../helpers/http.js";
import { createTestApp } from "../helpers/test-app.js";
import { postFirstUser, signIn } from "../helpers/seed.js";

describe("integration: attachments file route", () => {
  it("serves uploaded attachment bytes via /file path", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "a1", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "a1", "secret123");
    const content = "hello-from-attachment";
    const created = await apiJson<{ name: string }>(app, "/api/v1/attachments", {
      method: "POST",
      bearer: accessToken,
      json: {
        attachment: {
          filename: "hello.txt",
          type: "text/plain",
          content: Buffer.from(content, "utf-8").toString("base64"),
        },
      },
    });
    expect(created.status).toBe(200);
    const name = created.body.name;
    const res = await apiRequest(app, `/file/${name}/hello.txt`, {
      bearer: accessToken,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toBe(content);
  });

  it("serves user data URI avatar via golang /file/users/:identifier/avatar path", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "avataru", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "avataru", "secret123");
    const avatarBytes = Buffer.from("avatar-bytes", "utf-8");
    const avatarUrl = `data:image/png;base64,${avatarBytes.toString("base64")}`;

    const patch = await apiJson<{ avatarUrl: string }>(app, "/api/v1/users/avataru", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        user: { avatarUrl },
        updateMask: { paths: ["avatarUrl"] },
      },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.avatarUrl).toBe("/file/users/avataru/avatar");

    const res = await apiRequest(app, "/file/users/avataru/avatar");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(avatarBytes);
  });
});
