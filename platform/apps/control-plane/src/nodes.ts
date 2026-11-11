import { createHash, randomBytes } from "node:crypto";
import type { SystemDatabase } from "./database.js";
import type { SystemConfig } from "./system-config.js";
import { nodeInstallScript, type NodeCertificate } from "./node-install.js";

const zones = ["系统运行区", "测试区", "正式区"];
const namePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function poolNames(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].sort();
}

export function poolsOverlap(prodPool: string, testPool: string): boolean {
  const testNames = new Set(poolNames(testPool));
  return poolNames(prodPool).some((name) => testNames.has(name));
}

export async function registerNode(
  database: SystemDatabase,
  input: { name?: string; zone?: string },
): Promise<{ node: { name: string; zone: string; pool: string }; token: string } | { reason: string; status: number }> {
  const name = input.name?.trim() ?? "";
  const zone = input.zone?.trim() ?? "";
  if (!namePattern.test(name)) {
    return { reason: "节点名称无效", status: 400 };
  }
  if (!zones.includes(zone)) {
    return { reason: "节点区域无效", status: 400 };
  }
  const token = randomBytes(32).toString("base64url");
  try {
    await database.query("insert into nodes (id, name, zone, token_hash) values (gen_random_uuid(), $1, $2, $3)", [
      name,
      zone,
      createHash("sha256").update(token).digest("hex"),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { reason: "节点已存在", status: 409 };
    }
    throw error;
  }
  return { node: { name, zone, pool: "" }, token };
}

export async function assignNodePool(
  database: SystemDatabase,
  name: string,
  pool: string,
): Promise<{ node: { name: string; zone: string; pool: string } } | { reason: string; status: number }> {
  if (!["", "prod", "test"].includes(pool)) {
    return { reason: "节点池无效", status: 400 };
  }
  const found = await database.query<{ zone: string }>("select zone from nodes where name = $1", [name]);
  const node = found.rows[0];
  if (!node) {
    return { reason: "节点不存在", status: 404 };
  }
  if (pool === "prod" && node.zone !== "正式区") {
    return { reason: node.zone === "系统运行区" ? "系统运行区节点不能加入节点池" : "正式节点池只接受正式区节点", status: 400 };
  }
  if (pool === "test" && node.zone !== "测试区") {
    return { reason: node.zone === "系统运行区" ? "系统运行区节点不能加入节点池" : "测试节点池只接受测试区节点", status: 400 };
  }
  const config = await database.readConfig();
  const prod = poolNames(config["scheduler.defaultNodePool"]).filter((item) => item !== name);
  const test = poolNames(config["test.nodePool"]).filter((item) => item !== name);
  if (pool === "prod") {
    prod.push(name);
  }
  if (pool === "test") {
    test.push(name);
  }
  const next: SystemConfig = {
    ...config,
    "scheduler.defaultNodePool": prod.sort().join(","),
    "test.nodePool": test.sort().join(","),
  };
  if (poolsOverlap(next["scheduler.defaultNodePool"], next["test.nodePool"])) {
    return { reason: "同一节点不能同时属于正式节点池和测试节点池", status: 400 };
  }
  await database.saveConfig(next);
  return { node: { name, zone: node.zone, pool } };
}

export async function prepareNodeInstall(
  database: SystemDatabase,
  name: string,
  controlPlaneUrl: string,
  issuer: (nodeName: string) => Promise<NodeCertificate | { reason: string }>,
): Promise<{ script: string } | { reason: string; status: number }> {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(controlPlaneUrl)) {
    return { reason: "无法生成安装脚本：缺少控制面地址", status: 400 };
  }
  const found = await database.query<{ zone: string }>("select zone from nodes where name = $1", [name]);
  const node = found.rows[0];
  if (!node) {
    return { reason: "节点不存在", status: 404 };
  }
  if (node.zone === "系统运行区") {
    return { reason: "系统运行区节点不生成安装脚本", status: 400 };
  }
  const issued = await issuer(name);
  if ("reason" in issued) {
    return { reason: issued.reason, status: 409 };
  }
  const token = randomBytes(32).toString("base64url");
  await database.query("update nodes set install_token_hash = $2 where name = $1", [
    name,
    createHash("sha256").update(token).digest("hex"),
  ]);
  return {
    script: nodeInstallScript({
      nodeName: name,
      controlPlaneUrl,
      token,
      certificate: issued.certificate,
      privateKey: issued.privateKey,
      caCertificate: issued.caCertificate,
    }),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
