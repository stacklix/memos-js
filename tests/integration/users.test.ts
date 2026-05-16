import { describe, expect, it } from "vitest";
import { apiJson } from "../helpers/http.js";
import { createTestApp } from "../helpers/test-app.js";
import { postMemo, postUserAsAdmin, postFirstUser, seedAdmin, signIn } from "../helpers/seed.js";

describe("integration: users", () => {
  it("GET user email redacted for anonymous; visible for admin viewer", async () => {
    const app = createTestApp();
    await postFirstUser(app, {
      username: "admin",
      password: "secret123",
      role: "ADMIN",
      email: "admin@example.com",
    });

    const anon = await apiJson(app, "/api/v1/users/admin");
    expect(anon.status).toBe(200);
    expect((anon.body as { email: string }).email).toBe("");

    const { accessToken } = await signIn(app, "admin", "secret123");
    const authed = await apiJson(app, "/api/v1/users/admin", { bearer: accessToken });
    expect(authed.status).toBe(200);
    expect((authed.body as { email: string }).email).toBe("admin@example.com");
  });

  it("admin lists users with pageSize and pageToken chain", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "adm", password: "secret123" });
    await postUserAsAdmin(app, accessToken, {
      username: "u1",
      password: "secret123",
      role: "USER",
    });
    await postUserAsAdmin(app, accessToken, {
      username: "u2",
      password: "secret123",
      role: "USER",
    });

    const p1 = await apiJson<{
      users: { username: string }[];
      nextPageToken?: string;
    }>(app, "/api/v1/users?pageSize=1", { bearer: accessToken });
    expect(p1.status).toBe(200);
    expect(p1.body.users.length).toBe(1);
    expect(p1.body.nextPageToken).toBeTruthy();

    const p2 = await apiJson<{
      users: { username: string }[];
    }>(app, `/api/v1/users?pageSize=1&pageToken=${encodeURIComponent(p1.body.nextPageToken!)}`, {
      bearer: accessToken,
    });
    expect(p2.status).toBe(200);
    expect(p2.body.users.length).toBe(1);
    expect(p2.body.users[0].username).not.toBe(p1.body.users[0].username);
  });

  it("user PATCH displayName then GET reflects change", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "self", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "self", "secret123");

    const patch = await apiJson(app, "/api/v1/users/self", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        user: { displayName: "New Name" },
        updateMask: { paths: ["displayName"] },
      },
    });
    expect(patch.status).toBe(200);
    expect((patch.body as { displayName: string }).displayName).toBe("New Name");

    const get = await apiJson(app, "/api/v1/users/self", { bearer: accessToken });
    expect(get.status).toBe(200);
    expect((get.body as { displayName: string }).displayName).toBe("New Name");
  });

  it("PATCH user accepts gRPC-Gateway-style flat JSON body (snake_case) and infers update mask", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "gwflat", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "gwflat", "secret123");

    const patch = await apiJson(app, "/api/v1/users/gwflat", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        display_name: "Magnux",
        description: "Hello",
        email: "scliqiao@gmail.com",
      },
    });
    expect(patch.status).toBe(200);
    const b = patch.body as { displayName: string; description: string; email: string };
    expect(b.displayName).toBe("Magnux");
    expect(b.description).toBe("Hello");
    expect(b.email).toBe("scliqiao@gmail.com");
  });

  it("PATCH user merges updateMask from query with flat body (OpenAPI)", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "gwquery", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "gwquery", "secret123");

    const patch = await apiJson(app, "/api/v1/users/gwquery?updateMask=email,description", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        email: "open@api.test",
        description: "via query mask",
      },
    });
    expect(patch.status).toBe(200);
    const b = patch.body as { email: string; description: string };
    expect(b.email).toBe("open@api.test");
    expect(b.description).toBe("via query mask");
  });

  it("PATCH user returns INVALID_ARGUMENT for unknown update mask path", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "badmask", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "badmask", "secret123");

    const patch = await apiJson<{ code: number }>(app, "/api/v1/users/badmask", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        user: { displayName: "X" },
        updateMask: { paths: ["not_a_field"] },
      },
    });
    expect(patch.status).toBe(400);
    expect(patch.body.code).toBe(3);
  });

  it("admin PATCH state archives and restores user with numeric enum values", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "admstate", password: "secret123" });
    const created = await postUserAsAdmin(app, accessToken, {
      username: "selfstate",
      password: "secret123",
      role: "USER",
    });
    expect(created.status).toBe(200);

    const archive = await apiJson(app, "/api/v1/users/selfstate", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        user: { state: 2 },
        updateMask: { paths: ["state"] },
      },
    });
    expect(archive.status).toBe(200);
    expect((archive.body as { state: string }).state).toBe("ARCHIVED");

    const restore = await apiJson(app, "/api/v1/users/selfstate", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        user: { state: 1 },
        updateMask: { paths: ["state"] },
      },
    });
    expect(restore.status).toBe(200);
    expect((restore.body as { state: string }).state).toBe("NORMAL");
  });

  it("admin PATCH role accepts numeric enum value", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "admrole", password: "secret123" });
    const created = await postUserAsAdmin(app, accessToken, {
      username: "u-role",
      password: "secret123",
      role: "USER",
    });
    expect(created.status).toBe(200);

    const patch = await apiJson(app, "/api/v1/users/u-role", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        user: { role: 2 },
        updateMask: { paths: ["role"] },
      },
    });
    expect(patch.status).toBe(200);
    expect((patch.body as { role: string }).role).toBe("ADMIN");
  });

  it("non-admin cannot PATCH another user's role", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "admperm", password: "secret123" });
    const userA = await postUserAsAdmin(app, accessToken, {
      username: "ua",
      password: "secret123",
      role: "USER",
    });
    expect(userA.status).toBe(200);
    const userB = await postUserAsAdmin(app, accessToken, {
      username: "ub",
      password: "secret123",
      role: "USER",
    });
    expect(userB.status).toBe(200);
    const { accessToken: ubToken } = await signIn(app, "ub", "secret123");

    const patch = await apiJson<{ code: number }>(app, "/api/v1/users/ua", {
      method: "PATCH",
      bearer: ubToken,
      json: {
        user: { role: 2 },
        updateMask: { paths: ["role"] },
      },
    });
    expect(patch.status).toBe(403);
    expect(patch.body.code).toBe(7);
  });

  it("returns INVALID_ARGUMENT for invalid role/state patch values", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "adminvalid", password: "secret123" });
    const created = await postUserAsAdmin(app, accessToken, {
      username: "u-invalid",
      password: "secret123",
      role: "USER",
    });
    expect(created.status).toBe(200);

    const badRole = await apiJson<{ code: number }>(app, "/api/v1/users/u-invalid", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        user: { role: 9 },
        updateMask: { paths: ["role"] },
      },
    });
    expect(badRole.status).toBe(400);
    expect(badRole.body.code).toBe(3);

    const badState = await apiJson<{ code: number }>(app, "/api/v1/users/u-invalid", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        user: { state: 9 },
        updateMask: { paths: ["state"] },
      },
    });
    expect(badState.status).toBe(400);
    expect(badState.body.code).toBe(3);
  });

  it("user PATCH username persists and GET works with new resource path", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "oldname", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "oldname", "secret123");

    const patch = await apiJson(app, "/api/v1/users/oldname", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        user: { username: "newname" },
        updateMask: { paths: ["username"] },
      },
    });
    expect(patch.status).toBe(200);
    expect((patch.body as { username: string; name: string }).username).toBe("newname");
    expect((patch.body as { name: string }).name).toBe("users/newname");

    const get = await apiJson(app, "/api/v1/users/newname", { bearer: accessToken });
    expect(get.status).toBe(200);
    expect((get.body as { username: string }).username).toBe("newname");
  });

  it(":getStats and GET /users:stats agree after memos with tags", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "tagger", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "tagger", "secret123");

    const created = await postMemo(app, accessToken, {
      content: "note with #test tag",
      visibility: "PRIVATE",
      state: "NORMAL",
    });
    expect(created.status).toBe(200);

    const stats = await apiJson<{
      name: string;
      tagCount: Record<string, number>;
      totalMemoCount: number;
    }>(app, "/api/v1/users/" + encodeURIComponent("tagger:getStats"), { bearer: accessToken });
    expect(stats.status).toBe(200);
    expect(stats.body.name).toBe("users/tagger/stats");
    expect(stats.body.tagCount.test).toBe(1);
    expect(stats.body.totalMemoCount).toBe(1);

    const all = await apiJson<{ stats: { name: string; tagCount: Record<string, number> }[] }>(
      app,
      "/api/v1/users:stats",
      { bearer: accessToken },
    );
    expect(all.status).toBe(200);
    const row = all.body.stats.find((s) => s.name === "users/tagger/stats");
    expect(row).toBeDefined();
    expect(row!.tagCount.test).toBe(1);
  });
});
