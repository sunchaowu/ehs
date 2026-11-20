import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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

export type ManagedNode = {
  name: string;
  zone: string;
  pool: string;
  reportedAt: string | null;
  projectCount: number;
  gateway: string;
};

/** 平台管理员的节点列表：分区、节点池与最近一次心跳，不返回任何令牌哈希。 */
export async function listNodes(database: SystemDatabase): Promise<ManagedNode[]> {
  const config = await database.readConfig();
  const prod = new Set(poolNames(config["scheduler.defaultNodePool"]));
  const test = new Set(poolNames(config["test.nodePool"]));
  const found = await database.query<{
    name: string;
    zone: string;
    reported_at: Date | string | null;
    projects: unknown;
    gateway: string | null;
  }>(
    `select nodes.name, nodes.zone, node_reports.reported_at, node_reports.projects, node_reports.gateway
     from nodes left join node_reports on node_reports.node_name = nodes.name
     order by nodes.name`,
  );
  return found.rows.map((row) => ({
    name: row.name,
    zone: row.zone,
    pool: prod.has(row.name) ? "prod" : test.has(row.name) ? "test" : "",
    reportedAt: row.reported_at ? new Date(row.reported_at).toISOString() : null,
    projectCount: Array.isArray(row.projects) ? row.projects.length : 0,
    gateway: row.gateway ?? "",
  }));
}

/** 删除节点：清理两个节点池与期望状态中的目标节点；心跳、任务由外键级联删除。 */
export async function removeNode(database: SystemDatabase, name: string): Promise<{ removed: true } | { reason: string; status: number }> {
  const found = await database.query("select 1 from nodes where name = $1", [name]);
  if (found.rows.length === 0) {
    return { reason: "节点不存在", status: 404 };
  }
  const config = await database.readConfig();
  const next: SystemConfig = {
    ...config,
    "scheduler.defaultNodePool": poolNames(config["scheduler.defaultNodePool"]).filter((item) => item !== name).join(","),
    "test.nodePool": poolNames(config["test.nodePool"]).filter((item) => item !== name).join(","),
  };
  await database.saveConfig(next);
  await database.query(
    `update desired_states
     set target_nodes = array_to_string(array_remove(string_to_array(target_nodes, ','), $1), ',')
     where $1 = any(string_to_array(target_nodes, ','))`,
    [name],
  );
  await database.query("delete from nodes where name = $1", [name]);
  return { removed: true };
}

/** 轮换节点注册令牌；旧令牌立即失效，明文只返回一次。 */
export async function rotateNodeToken(
  database: SystemDatabase,
  name: string,
): Promise<{ name: string; token: string } | { reason: string; status: number }> {
  const token = randomBytes(32).toString("base64url");
  const updated = await database.query("update nodes set token_hash = $2 where name = $1", [
    name,
    createHash("sha256").update(token).digest("hex"),
  ]);
  if ((updated.rowCount ?? 0) === 0) {
    return { reason: "节点不存在", status: 404 };
  }
  return { name, token };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/** 节点用 Bearer 令牌（安装令牌或注册令牌）鉴权；令牌只存哈希。 */
export async function authenticateNode(
  database: SystemDatabase,
  name: string,
  authorization: string,
): Promise<{ name: string } | null> {
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const found = await database.query<{ token_hash: string; install_token_hash: string }>(
    "select token_hash, install_token_hash from nodes where name = $1",
    [name],
  );
  const actual = createHash("sha256").update(token).digest("hex");
  const hashes = [found.rows[0]?.token_hash ?? "", found.rows[0]?.install_token_hash ?? ""].filter(
    (hash) => hash.length === actual.length,
  );
  if (!token || !hashes.some((hash) => timingSafeEqual(Buffer.from(hash), Buffer.from(actual)))) {
    return null;
  }
  return { name };
}
