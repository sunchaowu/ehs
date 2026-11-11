import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const platformRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("deploy script", () => {
  it("names the missing server account and keeps the host out of the script", () => {
    const source = readFileSync(join(platformRoot, "scripts/deploy.sh"), "utf8");
    expect(source).not.toContain("172.18.0.31");
    const dir = mkdtempSync(join(tmpdir(), "deploy-env-"));
    const envFile = join(dir, ".env").replaceAll("\\", "/");
    writeFileSync(envFile, "DEPLOY_HOST=127.0.0.1\n");
    const result = spawnSync("bash", ["scripts/deploy.sh"], {
      cwd: platformRoot,
      env: { ...process.env, DEPLOY_ENV_FILE: envFile },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("缺少 DEPLOY_USER");
    expect(result.stderr).toContain("DEPLOY_PASSWORD");
  });
});
