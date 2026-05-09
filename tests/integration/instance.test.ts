import { describe, expect, it } from "vitest";
import { apiJson } from "../helpers/http.js";
import { createTestApp } from "../helpers/test-app.js";
import { seedAdmin } from "../helpers/seed.js";

describe("integration: instance", () => {
  it("GET instance/profile includes golang commit field", async () => {
    const app = createTestApp();
    const res = await apiJson<{ commit?: string }>(app, "/api/v1/instance/profile");
    expect(res.status).toBe(200);
    expect(res.body.commit).toBe("");
  });

  it("PATCH instance/settings/TAGS then GET returns persisted tags", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "adm", password: "secret123" });

    const patch = await apiJson(app, "/api/v1/instance/settings/TAGS", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        setting: {
          tagsSetting: {
            tags: { demo: { blurContent: true, backgroundColor: { red: 1, green: 0, blue: 0 } } },
          },
        },
      },
    });
    expect(patch.status).toBe(200);

    const get = await apiJson(app, "/api/v1/instance/settings/TAGS", { bearer: accessToken });
    expect(get.status).toBe(200);
    const body = get.body as { tagsSetting: { tags: { demo: { blurContent: boolean } } } };
    expect(body.tagsSetting.tags.demo.blurContent).toBe(true);
  });

  it("PATCH GENERAL disallow flags then GET reflects", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "ia", password: "secret123" });

    const patch = await apiJson(app, "/api/v1/instance/settings/GENERAL", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        setting: {
          generalSetting: {
            disallowUserRegistration: true,
            disallowPasswordAuth: false,
          },
        },
      },
    });
    expect(patch.status).toBe(200);
    expect((patch.body as { generalSetting: { disallowUserRegistration: boolean } }).generalSetting
      .disallowUserRegistration).toBe(true);

    const get = await apiJson(app, "/api/v1/instance/settings/GENERAL");
    expect(get.status).toBe(200);
    expect(
      (get.body as { generalSetting: { disallowUserRegistration: boolean } }).generalSetting
        .disallowUserRegistration,
    ).toBe(true);
  });

  it("PATCH GENERAL additionalScript/additionalStyle then GET returns persisted values", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "igas", password: "secret123" });

    const patch = await apiJson(app, "/api/v1/instance/settings/GENERAL", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        setting: {
          generalSetting: {
            additionalScript: "console.log('hello')",
            additionalStyle: "body { color: red; }",
          },
        },
      },
    });
    expect(patch.status).toBe(200);
    type GSBody = { generalSetting: { additionalScript: string; additionalStyle: string } };
    expect((patch.body as GSBody).generalSetting.additionalScript).toBe("console.log('hello')");
    expect((patch.body as GSBody).generalSetting.additionalStyle).toBe("body { color: red; }");

    const get = await apiJson(app, "/api/v1/instance/settings/GENERAL");
    expect(get.status).toBe(200);
    expect((get.body as GSBody).generalSetting.additionalScript).toBe("console.log('hello')");
    expect((get.body as GSBody).generalSetting.additionalStyle).toBe("body { color: red; }");
  });

  it("PATCH GENERAL customProfile then GET returns persisted profile", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "igcp", password: "secret123" });

    const patch = await apiJson(app, "/api/v1/instance/settings/GENERAL", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        setting: {
          generalSetting: {
            customProfile: { title: "My Memos", description: "A personal memo app", logoUrl: "/logo.png" },
          },
        },
      },
    });
    expect(patch.status).toBe(200);
    type CPBody = { generalSetting: { customProfile: { title: string; description: string; logoUrl: string } } };
    expect((patch.body as CPBody).generalSetting.customProfile.title).toBe("My Memos");
    expect((patch.body as CPBody).generalSetting.customProfile.description).toBe("A personal memo app");
    expect((patch.body as CPBody).generalSetting.customProfile.logoUrl).toBe("/logo.png");

    const get = await apiJson(app, "/api/v1/instance/settings/GENERAL");
    expect(get.status).toBe(200);
    expect((get.body as CPBody).generalSetting.customProfile.title).toBe("My Memos");
  });

  it("PATCH GENERAL weekStartDayOffset then GET returns persisted offset", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "igwd", password: "secret123" });

    const patch = await apiJson(app, "/api/v1/instance/settings/GENERAL", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        setting: {
          generalSetting: {
            weekStartDayOffset: 1,
          },
        },
      },
    });
    expect(patch.status).toBe(200);
    type WBody = { generalSetting: { weekStartDayOffset: number } };
    expect((patch.body as WBody).generalSetting.weekStartDayOffset).toBe(1);

    const get = await apiJson(app, "/api/v1/instance/settings/GENERAL");
    expect(get.status).toBe(200);
    expect((get.body as WBody).generalSetting.weekStartDayOffset).toBe(1);
  });

  it("PATCH MEMO_RELATED with empty reactions then GET round-trip", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "im", password: "secret123" });

    const patch = await apiJson(app, "/api/v1/instance/settings/MEMO_RELATED", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        setting: {
          memoRelatedSetting: {
            displayWithUpdateTime: true,
            contentLengthLimit: 100,
            enableDoubleClickEdit: false,
            reactions: [],
          },
        },
      },
    });
    expect(patch.status).toBe(200);

    const get = await apiJson(app, "/api/v1/instance/settings/MEMO_RELATED", { bearer: accessToken });
    expect(get.status).toBe(200);
    const mr = (get.body as { memoRelatedSetting: { reactions: string[] } }).memoRelatedSetting;
    expect(mr.reactions).toEqual([]);
  });

  it("GET instance/settings/STORAGE requires admin and returns storage setting", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "is", password: "secret123" });
    const res = await apiJson(app, "/api/v1/instance/settings/STORAGE", { bearer: accessToken });
    expect(res.status).toBe(200);
    expect((res.body as { storageSetting: { storageType: string } }).storageSetting.storageType).toBe(
      "DATABASE",
    );
  });

  it("GET instance/settings/NOTIFICATION requires admin and returns placeholder shape", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "in", password: "secret123" });
    const res = await apiJson(app, "/api/v1/instance/settings/NOTIFICATION", { bearer: accessToken });
    expect(res.status).toBe(200);
    expect((res.body as { notificationSetting: { email: { enabled: boolean } } }).notificationSetting.email
      .enabled).toBe(false);
  });

  it("NOTIFICATION does not expose smtpPassword in GET/PATCH responses", async () => {
    const app = createTestApp();
    const { accessToken } = await seedAdmin(app, { username: "np", password: "secret123" });
    const patch = await apiJson(app, "/api/v1/instance/settings/NOTIFICATION", {
      method: "PATCH",
      bearer: accessToken,
      json: {
        setting: {
          notificationSetting: {
            email: {
              enabled: true,
              smtpHost: "smtp.example.com",
              smtpPort: 587,
              smtpUsername: "bot@example.com",
              smtpPassword: "secret-value",
              fromEmail: "bot@example.com",
              useTls: true,
            },
          },
        },
      },
    });
    expect(patch.status).toBe(200);
    expect(
      (patch.body as { notificationSetting: { email: { smtpPassword: string } } }).notificationSetting.email
        .smtpPassword,
    ).toBe("");

    const get = await apiJson(app, "/api/v1/instance/settings/NOTIFICATION", { bearer: accessToken });
    expect(get.status).toBe(200);
    expect(
      (get.body as { notificationSetting: { email: { smtpPassword: string } } }).notificationSetting.email
        .smtpPassword,
    ).toBe("");
  });

});
