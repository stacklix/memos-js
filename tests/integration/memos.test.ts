import { describe, expect, it } from "vitest";
import { apiJson, apiRequest } from "../helpers/http.js";
import { createTestApp } from "../helpers/test-app.js";
import {
  memoIdFromName,
  postFirstUser,
  postMemo,
  postUserAsAdmin,
  seedAdmin,
  signIn,
} from "../helpers/seed.js";

describe("integration: memos", () => {
  it("POST memo with numeric visibility/state then GET list matches", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "writer", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "writer", "secret123");

    const created = await postMemo(app, accessToken, {
      content: "hello from test",
      visibility: 1,
      state: 1,
    });
    expect(created.status).toBe(200);
    const memo = created.body as { visibility: string; state: string };
    expect(memo.visibility).toBe("PRIVATE");
    expect(memo.state).toBe("NORMAL");

    const list = await apiJson<{ memos: { content: string }[] }>(
      app,
      "/api/v1/memos?state=NORMAL&pageSize=10",
      { bearer: accessToken },
    );
    expect(list.status).toBe(200);
    expect(list.body.memos.length).toBe(1);
    expect(list.body.memos[0].content).toBe("hello from test");
  });

  it("POST memo then GET by id returns same content and location", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "geo", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "geo", "secret123");

    const created = await postMemo(app, accessToken, {
      content: "at a place",
      visibility: "PRIVATE",
      location: { placeholder: "Test Pin", latitude: 31.23, longitude: 121.47 },
    });
    expect(created.status).toBe(200);
    const row = created.body as {
      name: string;
      content: string;
      location?: { placeholder: string; latitude: number; longitude: number };
    };
    expect(row.location?.placeholder).toBe("Test Pin");
    const id = memoIdFromName(row.name);

    const got = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id)}`, { bearer: accessToken });
    expect(got.status).toBe(200);
    const g = got.body as typeof row;
    expect(g.content).toBe("at a place");
    expect(g.location?.latitude).toBe(31.23);
  });

  it("PATCH memo updates content then GET matches", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "patcher", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "patcher", "secret123");
    const created = await postMemo(app, accessToken, { content: "v1", visibility: "PRIVATE" });
    expect(created.status).toBe(200);
    const id = memoIdFromName((created.body as { name: string }).name);

    const patch = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      bearer: accessToken,
      json: { content: "v2", updateMask: { paths: ["content"] } },
    });
    expect(patch.status).toBe(200);
    expect((patch.body as { content: string }).content).toBe("v2");

    const get = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id)}`, { bearer: accessToken });
    expect((get.body as { content: string }).content).toBe("v2");
  });

  it("PATCH memo accepts update_mask query param (grpc-gateway style)", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "qmask", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "qmask", "secret123");
    const created = await postMemo(app, accessToken, { content: "v1", visibility: "PRIVATE" });
    expect(created.status).toBe(200);
    const id = memoIdFromName((created.body as { name: string }).name);

    const patch = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id)}?update_mask=content,visibility`, {
      method: "PATCH",
      bearer: accessToken,
      json: { content: "v2", visibility: "PUBLIC" },
    });
    expect(patch.status).toBe(200);
    expect((patch.body as { content: string; visibility: string }).content).toBe("v2");
    expect((patch.body as { visibility: string }).visibility).toBe("PUBLIC");
  });

  it("PATCH memo without updateMask returns 400", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "nomask", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "nomask", "secret123");
    const created = await postMemo(app, accessToken, { content: "v1", visibility: "PRIVATE" });
    expect(created.status).toBe(200);
    const id = memoIdFromName((created.body as { name: string }).name);

    const patch = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      bearer: accessToken,
      json: { content: "v2" },
    });
    expect(patch.status).toBe(400);
  });

  it("DELETE memo (soft) returns archived state to creator; ?force=true hard-deletes (404)", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "deler", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "deler", "secret123");

    // Soft-delete (default): memo is archived, still accessible to creator.
    const created = await postMemo(app, accessToken, { content: "x", visibility: "PRIVATE" });
    const id = memoIdFromName((created.body as { name: string }).name);
    const del = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id)}`, {
      method: "DELETE",
      bearer: accessToken,
    });
    expect(del.status).toBe(200);
    const getAfterSoft = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id)}`, { bearer: accessToken });
    expect(getAfterSoft.status).toBe(200);
    expect((getAfterSoft.body as { state: string }).state).toBe("ARCHIVED");

    // Hard-delete (?force=true): memo is removed, returns 404 on GET.
    const created2 = await postMemo(app, accessToken, { content: "y", visibility: "PRIVATE" });
    const id2 = memoIdFromName((created2.body as { name: string }).name);
    const del2 = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id2)}?force=true`, {
      method: "DELETE",
      bearer: accessToken,
    });
    expect(del2.status).toBe(200);
    const getAfterHard = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id2)}`, { bearer: accessToken });
    expect(getAfterHard.status).toBe(404);
  });

  it("POST memo empty location object stores zero defaults", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "emptyloc", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "emptyloc", "secret123");
    const created = await postMemo(app, accessToken, {
      content: "no coords",
      visibility: "PRIVATE",
      location: {},
    });
    expect(created.status).toBe(200);
    const m = created.body as {
      location?: { placeholder: string; latitude: number; longitude: number };
    };
    expect(m.location?.placeholder).toBe("");
    expect(m.location?.latitude).toBe(0);
    expect(m.location?.longitude).toBe(0);
  });

  it("POST comment then GET comments lists it", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "commenter", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "commenter", "secret123");
    const parent = await postMemo(app, accessToken, { content: "parent", visibility: "PRIVATE" });
    const pid = memoIdFromName((parent.body as { name: string }).name);

    const comment = await apiJson(app, `/api/v1/memos/${encodeURIComponent(pid)}/comments`, {
      method: "POST",
      bearer: accessToken,
      json: {
        comment: {
          content: "reply text",
          location: { placeholder: "Cafe", latitude: 1.5, longitude: 2.5 },
        },
      },
    });
    expect(comment.status).toBe(200);
    expect((comment.body as { content: string }).content).toBe("reply text");

    const list = await apiJson<{ memos: { content: string }[] }>(
      app,
      `/api/v1/memos/${encodeURIComponent(pid)}/comments`,
      { bearer: accessToken },
    );
    expect(list.status).toBe(200);
    expect(list.body.memos.length).toBe(1);
    expect(list.body.memos[0].content).toBe("reply text");
  });

  it("POST comment from another user creates MEMO_COMMENT inbox notification for owner", async () => {
    const app = createTestApp();
    const { accessToken: adminTok } = await seedAdmin(app, {
      username: "adm",
      password: "secret123",
    });
    expect((await postUserAsAdmin(app, adminTok, { username: "memoowner", password: "secret123" })).status).toBe(
      200,
    );
    expect((await postUserAsAdmin(app, adminTok, { username: "buddy", password: "secret123" })).status).toBe(200);
    const { accessToken: ownerTok } = await signIn(app, "memoowner", "secret123");
    const { accessToken: buddyTok } = await signIn(app, "buddy", "secret123");

    const parent = await postMemo(app, ownerTok, { content: "root", visibility: "PUBLIC" });
    expect(parent.status).toBe(200);
    const pid = memoIdFromName((parent.body as { name: string }).name);

    const comment = await apiJson(app, `/api/v1/memos/${encodeURIComponent(pid)}/comments`, {
      method: "POST",
      bearer: buddyTok,
      json: { comment: { content: "hi", visibility: "PUBLIC" } },
    });
    expect(comment.status).toBe(200);
    const commentId = memoIdFromName((comment.body as { name: string }).name);

    const ntf = await apiJson<{
      notifications: {
        name: string;
        sender: string;
        status: string;
        type: string;
        memoComment?: { memo: string; relatedMemo: string };
      }[];
    }>(app, "/api/v1/users/memoowner/notifications", { bearer: ownerTok });
    expect(ntf.status).toBe(200);
    expect(ntf.body.notifications.length).toBe(1);
    expect(ntf.body.notifications[0].sender).toBe("users/buddy");
    expect(ntf.body.notifications[0].status).toBe("UNREAD");
    expect(ntf.body.notifications[0].type).toBe("MEMO_COMMENT");
    expect(ntf.body.notifications[0].memoComment?.memo).toBe(`memos/${commentId}`);
    expect(ntf.body.notifications[0].memoComment?.relatedMemo).toBe(`memos/${pid}`);

    const nid = ntf.body.notifications[0].name.split("/").pop()!;
    const patch = await apiJson(app, `/api/v1/users/memoowner/notifications/${encodeURIComponent(nid)}`, {
      method: "PATCH",
      bearer: ownerTok,
      json: {
        notification: { status: "ARCHIVED" },
        updateMask: { paths: ["status"] },
      },
    });
    expect(patch.status).toBe(200);
    expect((patch.body as { status: string }).status).toBe("ARCHIVED");
  });

  it("POST memo rejects non-number latitude", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "badlat", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "badlat", "secret123");
    const res = await postMemo(app, accessToken, {
      content: "x",
      visibility: "PRIVATE",
      location: { placeholder: "x", latitude: "31", longitude: 0 },
    });
    expect(res.status).toBe(400);
  });

  it("POST reaction then GET list then DELETE", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "rx", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "rx", "secret123");
    const m = await postMemo(app, accessToken, { content: "hi", visibility: "PRIVATE" });
    const id = memoIdFromName((m.body as { name: string }).name);

    const post = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id)}/reactions`, {
      method: "POST",
      bearer: accessToken,
      json: { reaction: { reactionType: "👍" } },
    });
    expect(post.status).toBe(200);
    const rname = (post.body as { name: string }).name;
    const rid = rname.split("/").pop()!;

    const list = await apiJson<{ reactions: { reactionType: string }[] }>(
      app,
      `/api/v1/memos/${encodeURIComponent(id)}/reactions`,
      { bearer: accessToken },
    );
    expect(list.status).toBe(200);
    expect(list.body.reactions.some((x) => x.reactionType === "👍")).toBe(true);

    const del = await apiRequest(app, `/api/v1/memos/${encodeURIComponent(id)}/reactions/${encodeURIComponent(rid)}`, {
      method: "DELETE",
      bearer: accessToken,
    });
    expect(del.status).toBe(200);

    const list2 = await apiJson<{ reactions: unknown[] }>(
      app,
      `/api/v1/memos/${encodeURIComponent(id)}/reactions`,
      { bearer: accessToken },
    );
    expect(list2.body.reactions.length).toBe(0);
  });

  it("PATCH relations then GET lists related memo", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "rel", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "rel", "secret123");
    const a = await postMemo(app, accessToken, { content: "A", visibility: "PRIVATE" });
    const b = await postMemo(app, accessToken, { content: "B", visibility: "PRIVATE" });
    const idA = memoIdFromName((a.body as { name: string }).name);
    const nameB = (b.body as { name: string }).name;

    const patch = await apiJson(app, `/api/v1/memos/${encodeURIComponent(idA)}/relations`, {
      method: "PATCH",
      bearer: accessToken,
      json: { relations: [{ relatedMemo: { name: nameB }, type: "REFERENCE" }] },
    });
    expect(patch.status).toBe(200);

    const get = await apiJson<{ relations: { relatedMemo: { name: string } }[] }>(
      app,
      `/api/v1/memos/${encodeURIComponent(idA)}/relations`,
      { bearer: accessToken },
    );
    expect(get.status).toBe(200);
    expect(get.body.relations.length).toBe(1);
    expect(get.body.relations[0].relatedMemo.name).toBe(nameB);
  });

  it("GET memo includes relations and reactions like golang responses", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "fullmemo", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "fullmemo", "secret123");
    const a = await postMemo(app, accessToken, { content: "A", visibility: "PRIVATE" });
    const b = await postMemo(app, accessToken, { content: "B", visibility: "PRIVATE" });
    const idA = memoIdFromName((a.body as { name: string }).name);
    const nameB = (b.body as { name: string }).name;

    await apiJson(app, `/api/v1/memos/${encodeURIComponent(idA)}/relations`, {
      method: "PATCH",
      bearer: accessToken,
      json: { relations: [{ relatedMemo: { name: nameB }, type: "REFERENCE" }] },
    });
    await apiJson(app, `/api/v1/memos/${encodeURIComponent(idA)}/reactions`, {
      method: "POST",
      bearer: accessToken,
      json: { reaction: { reactionType: "❤️" } },
    });

    const got = await apiJson<{
      relations: { relatedMemo: { name: string }; type: string }[];
      reactions: { reactionType: string; creator: string }[];
    }>(app, `/api/v1/memos/${encodeURIComponent(idA)}`, { bearer: accessToken });

    expect(got.status).toBe(200);
    expect(got.body.relations.map((r) => r.relatedMemo.name)).toEqual([nameB]);
    expect(got.body.reactions.map((r) => [r.creator, r.reactionType])).toEqual([
      ["users/fullmemo", "❤️"],
    ]);
  });

  it("POST memo attaches existing attachments and relations", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "createfull", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "createfull", "secret123");
    const related = await postMemo(app, accessToken, { content: "related", visibility: "PRIVATE" });
    const relatedName = (related.body as { name: string }).name;
    const attachment = await apiJson<{ name: string }>(app, "/api/v1/attachments", {
      method: "POST",
      bearer: accessToken,
      json: {
        attachment: {
          filename: "createfull.txt",
          content: "Y3JlYXRl",
          type: "text/plain",
        },
      },
    });
    expect(attachment.status).toBe(200);

    const created = await postMemo(app, accessToken, {
      content: "with extras",
      visibility: "PRIVATE",
      attachments: [{ name: attachment.body.name }],
      relations: [{ relatedMemo: { name: relatedName }, type: "REFERENCE" }],
    });

    expect(created.status).toBe(200);
    const body = created.body as {
      attachments: { name: string }[];
      relations: { relatedMemo: { name: string }; type: string }[];
    };
    expect(body.attachments.map((a) => a.name)).toEqual([attachment.body.name]);
    expect(body.relations.map((r) => r.relatedMemo.name)).toEqual([relatedName]);
  });

  it("POST share then GET shares list then anonymous GET /shares/:token returns memo", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "shr", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "shr", "secret123");
    const m = await postMemo(app, accessToken, { content: "secret shared", visibility: "PRIVATE" });
    const id = memoIdFromName((m.body as { name: string }).name);

    const sh = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id)}/shares`, {
      method: "POST",
      bearer: accessToken,
      json: { memoShare: {} },
    });
    expect(sh.status).toBe(200);
    const shareName = (sh.body as { name: string }).name;
    const token = shareName.split("/").pop()!;

    const listed = await apiJson<{ shares: { name: string }[] }>(
      app,
      `/api/v1/memos/${encodeURIComponent(id)}/shares`,
      { bearer: accessToken },
    );
    expect(listed.status).toBe(200);
    expect(listed.body.shares.some((s) => s.name.endsWith(token))).toBe(true);

    const publicGet = await apiJson<{ content: string }>(
      app,
      `/api/v1/shares/${encodeURIComponent(token)}`,
    );
    expect(publicGet.status).toBe(200);
    expect(publicGet.body.content).toBe("secret shared");
  });

  it("visibility: anonymous list only PUBLIC; owner sees PRIVATE", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "vis", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "vis", "secret123");
    await postMemo(app, accessToken, { content: "pub", visibility: "PUBLIC" });
    await postMemo(app, accessToken, { content: "priv", visibility: "PRIVATE" });

    const anon = await apiJson<{ memos: { content: string }[] }>(app, "/api/v1/memos?pageSize=50");
    expect(anon.status).toBe(200);
    expect(anon.body.memos.length).toBe(1);
    expect(anon.body.memos[0].content).toBe("pub");

    const authed = await apiJson<{ memos: { content: string }[] }>(app, "/api/v1/memos?pageSize=50", {
      bearer: accessToken,
    });
    expect(authed.status).toBe(200);
    expect(authed.body.memos.length).toBe(2);
  });

  it("admin cannot list other users PRIVATE memos by default", async () => {
    const app = createTestApp();
    const { accessToken: adminTok } = await seedAdmin(app, { username: "adm2", password: "secret123" });
    await postUserAsAdmin(app, adminTok, { username: "alice", password: "secret123", role: "USER" });
    const { accessToken: aliceTok } = await signIn(app, "alice", "secret123");
    await postMemo(app, aliceTok, { content: "alice private", visibility: "PRIVATE" });
    await postMemo(app, aliceTok, { content: "alice protected", visibility: "PROTECTED" });
    await postMemo(app, aliceTok, { content: "alice public", visibility: "PUBLIC" });

    const list = await apiJson<{ memos: { content: string }[] }>(app, "/api/v1/memos?pageSize=50", {
      bearer: adminTok,
    });
    expect(list.status).toBe(200);
    const contents = list.body.memos.map((m) => m.content);
    expect(contents).toContain("alice public");
    expect(contents).toContain("alice protected");
    expect(contents).not.toContain("alice private");
  });

  it("admin cannot GET another user's PRIVATE memo", async () => {
    const app = createTestApp();
    const { accessToken: adminTok } = await seedAdmin(app, { username: "adm3", password: "secret123" });
    await postUserAsAdmin(app, adminTok, { username: "bob", password: "secret123", role: "USER" });
    const { accessToken: bobTok } = await signIn(app, "bob", "secret123");
    const created = await postMemo(app, bobTok, { content: "bob private", visibility: "PRIVATE" });
    const id = memoIdFromName((created.body as { name: string }).name);

    const get = await apiJson(app, `/api/v1/memos/${encodeURIComponent(id)}`, { bearer: adminTok });
    expect(get.status).toBe(403);
  });

  it("GET /memos with tag filter returns matching memo", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "filtag", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "filtag", "secret123");
    await postMemo(app, accessToken, {
      content: "x #alpha",
      visibility: "PRIVATE",
      state: "NORMAL",
    });
    const q = new URLSearchParams({
      state: "NORMAL",
      pageSize: "50",
      filter: 'creator == "users/filtag" && tag in ["alpha"]',
    });
    const list = await apiJson<{ memos: { content: string }[] }>(
      app,
      `/api/v1/memos?${q.toString()}`,
      { bearer: accessToken },
    );
    expect(list.status).toBe(200);
    expect(list.body.memos.length).toBe(1);
    expect(list.body.memos[0].content).toContain("#alpha");
  });

  it("GET /memos filter created_ts range includes memo", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "timef", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "timef", "secret123");
    await postMemo(app, accessToken, {
      content: "in window",
      visibility: "PRIVATE",
      state: "NORMAL",
    });
    const start = 0;
    const end = Math.floor(Date.now() / 1000) + 86400;
    const q = new URLSearchParams({
      state: "NORMAL",
      pageSize: "50",
      filter: `creator == "users/timef" && created_ts >= ${start} && created_ts < ${end}`,
    });
    const list = await apiJson<{ memos: { content: string }[] }>(
      app,
      `/api/v1/memos?${q.toString()}`,
      { bearer: accessToken },
    );
    expect(list.status).toBe(200);
    expect(list.body.memos.some((m) => m.content === "in window")).toBe(true);
  });

  it("GET /memos filter pinned and visibility in", async () => {
    const app = createTestApp();
    await postFirstUser(app, { username: "pinu", password: "secret123", role: "USER" });
    const { accessToken } = await signIn(app, "pinu", "secret123");
    await postMemo(app, accessToken, {
      content: "pinned #x",
      visibility: "PROTECTED",
      pinned: true,
      state: "NORMAL",
    });
    await postMemo(app, accessToken, {
      content: "not pinned",
      visibility: "PROTECTED",
      pinned: false,
      state: "NORMAL",
    });

    const q = new URLSearchParams({
      state: "NORMAL",
      pageSize: "50",
      filter: 'creator == "users/pinu" && pinned && visibility in ["PROTECTED"]',
    });
    const list = await apiJson<{ memos: { content: string }[] }>(
      app,
      `/api/v1/memos?${q.toString()}`,
      { bearer: accessToken },
    );
    expect(list.status).toBe(200);
    expect(list.body.memos.length).toBe(1);
    expect(list.body.memos[0].content).toContain("pinned");
  });
});
