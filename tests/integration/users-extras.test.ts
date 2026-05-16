import { afterEach, describe, expect, it, vi } from "vitest";
import { apiJson } from "../helpers/http.js";
import { createTestApp } from "../helpers/test-app.js";
import { postFirstUser, postMemo, signIn } from "../helpers/seed.js";
import { GrpcCode } from "../../server/lib/grpc-status.js";

describe("integration: users extras (shortcuts, PAT, webhooks, notifications)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shortcuts CRUD round-trip", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "sc", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "sc", "secret123");
    const base = "/api/v1/users/sc";

    const created = await apiJson(app, `${base}/shortcuts`, {
      method: "POST",
      bearer: accessToken,
      json: { shortcut: { title: "Inbox", filter: 'tag in ["inbox"]' } },
    });
    expect(created.status).toBe(200);
    const sid = (created.body as { name: string }).name.split("/").pop()!;

    const list = await apiJson<{ shortcuts: { title: string }[] }>(app, `${base}/shortcuts`, {
      bearer: accessToken,
    });
    expect(list.status).toBe(200);
    expect(list.body.shortcuts.some((s) => s.title === "Inbox")).toBe(true);

    const one = await apiJson(app, `${base}/shortcuts/${encodeURIComponent(sid)}`, {
      bearer: accessToken,
    });
    expect(one.status).toBe(200);
    expect((one.body as { title: string }).title).toBe("Inbox");

    const patched = await apiJson(app, `${base}/shortcuts/${encodeURIComponent(sid)}`, {
      method: "PATCH",
      bearer: accessToken,
      json: { shortcut: { title: "Inbox2" }, updateMask: { paths: ["title"] } },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { title: string }).title).toBe("Inbox2");

    const del = await apiJson(app, `${base}/shortcuts/${encodeURIComponent(sid)}`, {
      method: "DELETE",
      bearer: accessToken,
    });
    expect(del.status).toBe(200);

    const list2 = await apiJson<{ shortcuts: unknown[] }>(app, `${base}/shortcuts`, {
      bearer: accessToken,
    });
    expect(list2.body.shortcuts.length).toBe(0);
  });

  it("PAT create then Bearer memos_pat_* can list memos", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "patu", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "patu", "secret123");
    const base = "/api/v1/users/patu";

    const tok = await apiJson<{ token?: string }>(app, `${base}/personalAccessTokens`, {
      method: "POST",
      bearer: accessToken,
      json: { description: "ci" },
    });
    expect(tok.status).toBe(200);
    const raw = tok.body.token as string;
    expect(raw.startsWith("memos_pat_")).toBe(true);

    const list = await apiJson<{ memos: unknown[] }>(app, "/api/v1/memos?pageSize=5", {
      bearer: raw,
    });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.memos)).toBe(true);
  });

  it("webhooks POST then GET then DELETE", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "wh", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "wh", "secret123");
    const base = "/api/v1/users/wh";

    const post = await apiJson(app, `${base}/webhooks`, {
      method: "POST",
      bearer: accessToken,
      json: { webhook: { url: "https://example.com/hook" } },
    });
    expect(post.status).toBe(200);
    const wid = (post.body as { name: string }).name.split("/").pop()!;

    const list = await apiJson<{ webhooks: { url: string }[] }>(app, `${base}/webhooks`, {
      bearer: accessToken,
    });
    expect(list.status).toBe(200);
    expect(list.body.webhooks.some((w) => w.url === "https://example.com/hook")).toBe(true);

    const del = await apiJson(app, `${base}/webhooks/${encodeURIComponent(wid)}`, {
      method: "DELETE",
      bearer: accessToken,
    });
    expect(del.status).toBe(200);
  });

  it("GET notifications returns 200", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "ntf", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "ntf", "secret123");
    const res = await apiJson(app, "/api/v1/users/ntf/notifications", { bearer: accessToken });
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { notifications: unknown[] }).notifications)).toBe(true);
  });

  it("links an OAuth identity to the current user", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "idpadmin", password: "secret123", role: "ADMIN" });
    const { accessToken } = await signIn(app, "idpadmin", "secret123");

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://idp.example/token") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ access_token: "oauth-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://idp.example/userinfo") {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer oauth-token");
        return new Response(JSON.stringify({ sub: "extern-1", name: "Extern User", email: "extern@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const createProvider = await apiJson(app, "/api/v1/identity-providers", {
      method: "POST",
      bearer: accessToken,
      json: {
        identityProviderId: "oauth-test",
        identityProvider: {
          title: "OAuth Test",
          type: "OAUTH2",
          config: {
            oauth2Config: {
              clientId: "client-id",
              clientSecret: "client-secret",
              authUrl: "https://idp.example/auth",
              tokenUrl: "https://idp.example/token",
              userInfoUrl: "https://idp.example/userinfo",
              scopes: ["openid"],
              fieldMapping: {
                identifier: "sub",
                displayName: "name",
                email: "email",
                avatarUrl: "",
              },
            },
          },
        },
      },
    });
    expect(createProvider.status).toBe(200);

    const linked = await apiJson<{ name: string; idpName: string; externUid: string }>(app, "/api/v1/users/idpadmin/linkedIdentities", {
      method: "POST",
      bearer: accessToken,
      json: {
        idpName: "identity-providers/oauth-test",
        code: "oauth-code",
        redirectUri: "http://localhost/auth/callback",
        codeVerifier: "verifier",
      },
    });

    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({
      name: "users/idpadmin/linkedIdentities/oauth-test",
      idpName: "identity-providers/oauth-test",
      externUid: "extern-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns INVALID_ARGUMENT for malformed pageToken on user settings/webhooks/shortcuts", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "pg", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "pg", "secret123");
    const base = "/api/v1/users/pg";

    for (const path of ["settings", "webhooks", "shortcuts"]) {
      const res = await apiJson<{ code: number; message: string }>(
        app,
        `${base}/${path}?pageToken=bad-token`,
        { bearer: accessToken },
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(GrpcCode.INVALID_ARGUMENT);
    }
  });

  it("applies readMask for list user settings", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "rm", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "rm", "secret123");
    const base = "/api/v1/users/rm";

    // Ensure both GENERAL and WEBHOOKS exist so mask result is visible.
    const createWebhook = await apiJson(app, `${base}/webhooks`, {
      method: "POST",
      bearer: accessToken,
      json: { webhook: { url: "https://example.com/hook" } },
    });
    expect(createWebhook.status).toBe(200);
    const patchGeneral = await apiJson(app, `${base}/settings/GENERAL`, {
      method: "PATCH",
      bearer: accessToken,
      json: {
        setting: { generalSetting: { locale: "en", theme: "system", memoVisibility: "PRIVATE" } },
        updateMask: { paths: ["generalSetting"] },
      },
    });
    expect(patchGeneral.status).toBe(200);

    const res = await apiJson<{ settings: Array<Record<string, unknown>> }>(
      app,
      `${base}/settings?readMask=general_setting`,
      { bearer: accessToken },
    );
    expect(res.status).toBe(200);
    expect(res.body.settings.length).toBeGreaterThan(0);
    let hasGeneralSetting = false;
    for (const setting of res.body.settings) {
      expect(Object.hasOwn(setting, "webhooksSetting")).toBe(false);
      if (Object.hasOwn(setting, "generalSetting")) hasGeneralSetting = true;
    }
    expect(hasGeneralSetting).toBe(true);
  });

  it("rejects invalid user updateMask paths; ignores unknown webhook mask paths (golang)", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "um", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "um", "secret123");
    const base = "/api/v1/users/um";

    const userPatch = await apiJson<{ code: number; message?: string }>(app, `${base}`, {
      method: "PATCH",
      bearer: accessToken,
      json: {
        user: { displayName: "X" },
        updateMask: { paths: ["nickname"] },
      },
    });
    expect(userPatch.status).toBe(400);
    expect(userPatch.body.code).toBe(GrpcCode.INVALID_ARGUMENT);
    expect(userPatch.body.message).toMatch(/invalid update path/i);

    const webhookCreate = await apiJson<{ name: string }>(app, `${base}/webhooks`, {
      method: "POST",
      bearer: accessToken,
      json: { webhook: { url: "https://example.com/hook" } },
    });
    expect(webhookCreate.status).toBe(200);
    const wid = webhookCreate.body.name.split("/").pop()!;

    const webhookPatch = await apiJson<{ url: string }>(app, `${base}/webhooks/${encodeURIComponent(wid)}`, {
      method: "PATCH",
      bearer: accessToken,
      json: {
        webhook: { url: "https://example.com/new" },
        updateMask: { paths: ["unknown_field"] },
      },
    });
    expect(webhookPatch.status).toBe(200);
    expect(webhookPatch.body.url).toBe("https://example.com/hook");
  });

  it("returns INVALID_ARGUMENT for empty updateMask on user/settings/shortcut updates", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "emptym", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "emptym", "secret123");
    const base = "/api/v1/users/emptym";

    const userPatch = await apiJson<{ code: number }>(app, `${base}`, {
      method: "PATCH",
      bearer: accessToken,
      json: {
        user: { displayName: "X" },
        updateMask: { paths: [] },
      },
    });
    expect(userPatch.status).toBe(400);
    expect(userPatch.body.code).toBe(GrpcCode.INVALID_ARGUMENT);

    const settingsPatch = await apiJson<{ code: number }>(app, `${base}/settings/GENERAL`, {
      method: "PATCH",
      bearer: accessToken,
      json: {
        setting: { generalSetting: { locale: "en" } },
        updateMask: { paths: [] },
      },
    });
    expect(settingsPatch.status).toBe(400);
    expect(settingsPatch.body.code).toBe(GrpcCode.INVALID_ARGUMENT);

    const created = await apiJson<{ name: string }>(app, `${base}/shortcuts`, {
      method: "POST",
      bearer: accessToken,
      json: { shortcut: { title: "Inbox", filter: 'tag in ["x"]' } },
    });
    expect(created.status).toBe(200);
    const sid = created.body.name.split("/").pop()!;

    const shortcutPatch = await apiJson<{ code: number }>(app, `${base}/shortcuts/${encodeURIComponent(sid)}`, {
      method: "PATCH",
      bearer: accessToken,
      json: {
        shortcut: { title: "New" },
        updateMask: { paths: [] },
      },
    });
    expect(shortcutPatch.status).toBe(400);
    expect(shortcutPatch.body.code).toBe(GrpcCode.INVALID_ARGUMENT);
  });

  it("dispatches user webhooks for memo comment notifications", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "owner", password: "secret123", role: "USER" });
    const { accessToken: ownerToken } = await signIn(app, "owner", "secret123");
    await apiJson(app, "/api/v1/users/owner/webhooks", {
      method: "POST",
      bearer: ownerToken,
      json: { webhook: { url: "https://hooks.example.local/comment" } },
    });

    // Create commenter as admin-created second user.
    await apiJson(app, "/api/v1/users", {
      method: "POST",
      bearer: ownerToken,
      json: {
        user: { username: "commenter", password: "secret123", role: "USER" },
      },
    });
    const { accessToken: commenterToken } = await signIn(app, "commenter", "secret123");

    const parent = await postMemo(app, ownerToken, {
      content: "owner memo",
      visibility: "PUBLIC",
      state: "NORMAL",
    });
    expect(parent.status).toBe(200);
    const parentName = (parent.body as { name: string }).name;

    const calls: Array<{ url: string; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const comment = await apiJson(app, `/api/v1/memos/${encodeURIComponent(parentName.replace(/^memos\//, ""))}/comments`, {
        method: "POST",
        bearer: commenterToken,
        json: {
          comment: {
            content: "reply",
            visibility: "PUBLIC",
            state: "NORMAL",
          },
        },
      });
      expect(comment.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.url).toBe("https://hooks.example.local/comment");
    const payload = JSON.parse(calls[0]!.body) as {
      type: string;
      sender: string;
      receiver: string;
      memoComment: { memo: string; relatedMemo: string };
    };
    expect(payload.type).toBe("MEMO_COMMENT");
    expect(payload.sender).toBe("users/commenter");
    expect(payload.receiver).toBe("users/owner");
    expect(payload.memoComment.relatedMemo).toBe(parentName);
  });

  it("dispatches smtp notification email for memo comments when NOTIFICATION is enabled", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const app = createTestApp({
      sendNotificationEmail: async (args) => {
        sent.push(args as unknown as Record<string, unknown>);
      },
    });
    await postFirstUser(app, {
      username: "owner2",
      password: "secret123",
      role: "USER",
      email: "owner2@example.com",
    });
    const { accessToken: ownerToken } = await signIn(app, "owner2", "secret123");
    await apiJson(app, "/api/v1/instance/settings/NOTIFICATION", {
      method: "PATCH",
      bearer: ownerToken,
      json: {
        notificationSetting: {
          email: {
            enabled: true,
            smtpHost: "smtp.example.com",
            smtpPort: 587,
            smtpUsername: "bot@example.com",
            smtpPassword: "secret",
            fromEmail: "bot@example.com",
            fromName: "memos bot",
            replyTo: "noreply@example.com",
            useTls: true,
            useSsl: false,
          },
        },
      },
    });
    await apiJson(app, "/api/v1/users", {
      method: "POST",
      bearer: ownerToken,
      json: {
        user: { username: "commenter2", password: "secret123", role: "USER" },
      },
    });
    const { accessToken: commenterToken } = await signIn(app, "commenter2", "secret123");

    const parent = await postMemo(app, ownerToken, {
      content: "owner memo",
      visibility: "PUBLIC",
      state: "NORMAL",
    });
    expect(parent.status).toBe(200);
    const parentId = (parent.body as { name: string }).name.replace(/^memos\//, "");

    const comment = await apiJson(app, `/api/v1/memos/${encodeURIComponent(parentId)}/comments`, {
      method: "POST",
      bearer: commenterToken,
      json: {
        comment: {
          content: "reply",
          visibility: "PUBLIC",
          state: "NORMAL",
        },
      },
    });
    expect(comment.status).toBe(200);

    expect(sent.length).toBe(1);
    expect(sent[0]?.to).toBe("owner2@example.com");
    expect(sent[0]?.smtpHost).toBe("smtp.example.com");
    expect(sent[0]?.subject).toBe("[memos] New comment from commenter2");
  });

  it("keeps smtpPassword when NOTIFICATION patch sends empty password", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const app = createTestApp({
      sendNotificationEmail: async (args) => {
        sent.push(args as unknown as Record<string, unknown>);
      },
    });
    await postFirstUser(app, {
      username: "owner3",
      password: "secret123",
      role: "USER",
      email: "owner3@example.com",
    });
    const { accessToken: ownerToken } = await signIn(app, "owner3", "secret123");
    await apiJson(app, "/api/v1/instance/settings/NOTIFICATION", {
      method: "PATCH",
      bearer: ownerToken,
      json: {
        notificationSetting: {
          email: {
            enabled: true,
            smtpHost: "smtp.example.com",
            smtpPort: 587,
            smtpUsername: "bot@example.com",
            smtpPassword: "original-password",
            fromEmail: "bot@example.com",
            useTls: true,
          },
        },
      },
    });
    // Empty password means "keep existing secret".
    await apiJson(app, "/api/v1/instance/settings/NOTIFICATION", {
      method: "PATCH",
      bearer: ownerToken,
      json: {
        notificationSetting: {
          email: {
            smtpPassword: "",
            smtpHost: "smtp2.example.com",
          },
        },
      },
    });
    await apiJson(app, "/api/v1/users", {
      method: "POST",
      bearer: ownerToken,
      json: {
        user: { username: "commenter3", password: "secret123", role: "USER" },
      },
    });
    const { accessToken: commenterToken } = await signIn(app, "commenter3", "secret123");
    const parent = await postMemo(app, ownerToken, {
      content: "owner memo",
      visibility: "PUBLIC",
      state: "NORMAL",
    });
    const parentId = (parent.body as { name: string }).name.replace(/^memos\//, "");
    const comment = await apiJson(app, `/api/v1/memos/${encodeURIComponent(parentId)}/comments`, {
      method: "POST",
      bearer: commenterToken,
      json: {
        comment: {
          content: "reply",
          visibility: "PUBLIC",
          state: "NORMAL",
        },
      },
    });
    expect(comment.status).toBe(200);
    expect(sent.length).toBe(1);
    expect(sent[0]?.smtpHost).toBe("smtp2.example.com");
    expect(sent[0]?.smtpPassword).toBe("original-password");
  });
});
