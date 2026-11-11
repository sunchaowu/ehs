import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { compileDesign } from "../src/compiler.js";
import { openDatabase } from "../src/database.js";
import { installInitialAdmin } from "../src/install-admin.js";
import { buildServer } from "../src/server.js";

const design = {
  projectCode: "qing-jia-shen-pi",
  containerGroup: "qing-jia-shen-pi",
  menus: [{ code: "qing-jia-dan", name: "请假单", parentCode: null, sort: 1 }],
  grants: [{ principalType: "user", principalName: "employee", menuCode: "qing-jia-dan", action: "访问" }],
  entities: [{ name: "请假单", fields: [{ name: "申请人", type: "user" }] }],
  workflows: [{ name: "请假", steps: ["submit", "approve", "record"] }],
  extensions: [{ name: "额度计算" }],
};

describe("design compilation", () => {
  it("compiles one design to the same source without a clock, a random value, or a local path", () => {
    const first = compileDesign(design);
    const second = compileDesign({
      ...design,
      menus: [...design.menus].reverse(),
      grants: [...design.grants],
      extensions: [...design.extensions],
    });
    expect(first.sourceRevision).toBe(second.sourceRevision);
    expect(first.files).toEqual(second.files);
    expect(first.sourceRevision).toBe(`sha256:${createHash("sha256").update(stableBytes(first.files)).digest("hex")}`);
    const source = Object.values(first.files).join("\n");
    expect(source).toContain('from "@platform/runtime"');
    expect(source).toContain("额度计算");
    expect(source).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(source).not.toContain("Math.random");
    expect(source).not.toContain("C:\\");
    expect(source).not.toContain(process.cwd());
    expect(Object.keys(first.files).every((file) => file.startsWith("modules/qing-jia-shen-pi/") && !file.includes("\\"))).toBe(true);
  });
});

describe("confirmed designs", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("stores the same source revision for the same confirmed draft and keeps menus unpublished", async () => {
    const databaseUrl = process.env.DATABASE_SYSTEM_URL;
    expect(databaseUrl, "缺少 DATABASE_SYSTEM_URL").toBeTruthy();
    const database = await openDatabase(databaseUrl!);
    await database.migrate();
    await database.query("delete from sessions");
    await database.query("delete from users");
    await database.close();
    const installed = await installInitialAdmin(databaseUrl!, {
      title: "企业应用平台",
      prodAdminUrl: "postgres://platform@127.0.0.1:5432/prod",
      testAdminUrl: "postgres://platform@127.0.0.1:5432/test",
      registryAddress: "registry.internal",
    });
    app = await buildServer({ databaseUrl });
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/session/login",
      payload: { username: "admin", password: installed.password },
    });
    const adminCookie = adminLogin.cookies.find((cookie) => cookie.name === "platform_session")!.value;
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { platform_session: adminCookie },
      payload: { name: "请假审批" },
    });
    const code = created.json().project.code as string;
    await app.inject({
      method: "POST",
      url: `/api/projects/${code}/menus`,
      cookies: { platform_session: adminCookie },
      payload: { name: "请假单" },
    });
    const first = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/confirm`,
      cookies: { platform_session: adminCookie },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${code}/confirm`,
      cookies: { platform_session: adminCookie },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().sourceRevision).toBe(second.json().sourceRevision);
    expect(String(first.json().sourceRevision)).toMatch(/^sha256:[a-f0-9]{64}$/);
    const source = await app.inject({
      method: "GET",
      url: `/api/projects/${code}/source`,
      cookies: { platform_session: adminCookie },
    });
    expect(source.statusCode).toBe(200);
    expect(source.json().sourceRevision).toBe(first.json().sourceRevision);
    const files = source.json().files as Record<string, string>;
    expect(Object.values(files).join("\n")).toContain('from "@platform/runtime"');
    expect(Object.values(files).join("\n")).not.toContain(process.cwd());
    const menus = await app.inject({
      method: "GET",
      url: "/api/menus",
      cookies: { platform_session: adminCookie },
    });
    expect(menus.json()).toEqual({ menus: [] });
  });
});

function stableBytes(files: Record<string, string>): string {
  return Object.keys(files)
    .sort()
    .map((file) => `${file}\n${files[file]}`)
    .join("\n");
}
