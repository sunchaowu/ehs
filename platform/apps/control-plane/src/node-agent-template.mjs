/**
 * 测试区节点代理模板。
 *
 * 安装脚本会把本文件写成 `~/.platform-node/agent.mjs`，把 `test-runner.mjs`
 * 写成同目录的测试入口。代理只连接控制面，不开放入站端口。
 */

import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const healthScript =
  "fetch('http://127.0.0.1:8080/health').then(function (r) { return r.json(); }).then(function (j) { console.log(JSON.stringify(j)); }).catch(function () { process.exit(1); })";

function nodeName() {
  return process.env.PLATFORM_NODE_NAME ?? "";
}

function baseUrl() {
  return process.env.PLATFORM_CONTROL_PLANE_URL ?? "";
}

function token() {
  return process.env.PLATFORM_NODE_TOKEN ?? "";
}

function nodeDir() {
  return process.env.PLATFORM_NODE_DIR || "/root/.platform-node";
}

export function request(path, init = {}) {
  const options = Object.assign({}, init, {
    headers: Object.assign({ authorization: "Bearer " + token() }, init.headers || {}),
  });
  return fetch(baseUrl() + path, options).then(function (response) {
    if (!response.ok) {
      return response.text().then(function (text) {
        throw new Error(text);
      });
    }
    return response.headers.get("content-type") && response.headers.get("content-type").indexOf("json") !== -1
      ? response.json()
      : response.text();
  });
}

export function docker(args, options = {}) {
  return new Promise(function (resolve) {
    const child = spawn("docker", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = options.timeoutMs
      ? setTimeout(function () {
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;
    child.stdout.on("data", function (chunk) {
      stdout += chunk;
    });
    child.stderr.on("data", function (chunk) {
      stderr += chunk;
    });
    child.on("error", function (error) {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stderr: error.message, stdout: stdout });
    });
    child.on("close", function (code) {
      if (timer) clearTimeout(timer);
      resolve({ code: code === null ? 1 : code, stderr: stderr, stdout: stdout });
    });
  });
}

export function databaseUrlTemplate() {
  if (process.env.PLATFORM_DATABASE_URL_TEMPLATE) {
    return process.env.PLATFORM_DATABASE_URL_TEMPLATE;
  }
  try {
    return readFileSync(nodeDir() + "/database.url", "utf8").trim();
  } catch {
    return "";
  }
}

export function databaseUrl(databaseName) {
  const template = databaseUrlTemplate();
  if (!template) {
    return "";
  }
  return template.indexOf("{database}") === -1 ? template : template.split("{database}").join(databaseName);
}

export function containerHealth(name, dockerFn = docker, attempts = 20, intervalMs = 1500) {
  let attempt = 0;
  function next() {
    return dockerFn(["exec", name, "node", "-e", healthScript]).then(function (result) {
      if (result.code === 0) {
        try {
          return JSON.parse(result.stdout.trim());
        } catch {
          // 容器刚启动时还没有输出，继续重试。
        }
      }
      attempt += 1;
      if (attempt >= attempts) {
        return undefined;
      }
      return new Promise(function (resolve) {
        setTimeout(resolve, intervalMs);
      }).then(next);
    });
  }
  return next();
}

export async function reconcileProject(item, options = {}) {
  const dockerFn = options.docker ?? docker;
  const pulled = await dockerFn(["pull", item.imageDigest]);
  if (pulled.code !== 0) {
    return {
      code: item.code,
      running: false,
      databaseConnected: false,
      imageDigest: "",
      reason: (pulled.stderr || pulled.stdout || "镜像拉取失败").trim(),
    };
  }
  await dockerFn(["rm", "-f", "platform-" + item.code]);
  const args = ["run", "-d", "--name", "platform-" + item.code, "-e", "DATABASE_NAME=" + item.databaseName, "-e", "runtime.mode=prod"];
  const url = databaseUrl(item.databaseName);
  if (url) {
    args.push("-e", "DATABASE_URL=" + url);
  }
  args.push(item.imageDigest);
  const started = await dockerFn(args);
  if (started.code !== 0) {
    return {
      code: item.code,
      running: false,
      databaseConnected: false,
      imageDigest: item.imageDigest,
      reason: (started.stderr || started.stdout || "容器启动失败").trim(),
    };
  }
  const health = await containerHealth("platform-" + item.code, dockerFn);
  const connected = Boolean(health && health.storage === "postgres");
  return {
    code: item.code,
    running: true,
    databaseConnected: connected,
    imageDigest: item.imageDigest,
    reason: connected ? undefined : "运行库未连接项目数据库",
  };
}

function lastJsonLine(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // 继续向前找 JSON 行。
    }
  }
  return undefined;
}

async function reportTestJob(jobId, body, requestFn = request) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await requestFn("/api/nodes/" + nodeName() + "/tests/" + jobId, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise(function (resolve) {
        setTimeout(resolve, 2000);
      });
    }
  }
  throw lastError;
}

/**
 * 在测试节点上运行一个候选镜像测试任务：
 * 拉取镜像、启动测试容器、把白盒入口和用例复制进容器、执行并上报步骤。
 */
export async function runTestJob(job, options = {}) {
  const dockerFn = options.docker ?? docker;
  const requestFn = options.request ?? request;
  const directory = options.nodeDir ?? nodeDir();
  const containerName = "platform-test-" + String(job.id).replace(/[^a-z0-9]/gi, "").slice(0, 12);
  const payloadPath = directory + "/test-payload-" + containerName + ".json";
  const runnerPath = directory + "/test-runner.mjs";
  try {
    const pulled = await dockerFn(["pull", job.imageDigest]);
    if (pulled.code !== 0) {
      await reportTestJob(job.id, { reason: (pulled.stderr || pulled.stdout || "镜像拉取失败").trim() }, requestFn);
      return;
    }
    await dockerFn(["rm", "-f", containerName]);
    const args = ["run", "-d", "--name", containerName, "-e", "DATABASE_NAME=" + job.databaseName, "-e", "runtime.mode=test"];
    const url = databaseUrl(job.databaseName);
    if (url) {
      args.push("-e", "DATABASE_URL=" + url);
    }
    args.push(job.imageDigest);
    const started = await dockerFn(args);
    if (started.code !== 0) {
      await reportTestJob(job.id, { reason: (started.stderr || started.stdout || "测试容器启动失败").trim() }, requestFn);
      return;
    }
    const health = await containerHealth(containerName, dockerFn);
    if (!health) {
      await reportTestJob(job.id, { reason: "测试容器健康检查未返回结果" }, requestFn);
      return;
    }
    writeFileSync(
      payloadPath,
      JSON.stringify({ cases: job.cases ?? [], stepTimeoutSeconds: job.stepTimeoutSeconds }),
      "utf8",
    );
    const copiedRunner = await dockerFn(["cp", runnerPath, containerName + ":/tmp/platform-test-runner.mjs"]);
    if (copiedRunner.code !== 0) {
      await reportTestJob(job.id, { reason: (copiedRunner.stderr || "无法复制白盒测试入口").trim() }, requestFn);
      return;
    }
    const copiedPayload = await dockerFn(["cp", payloadPath, containerName + ":/tmp/platform-test-payload.json"]);
    if (copiedPayload.code !== 0) {
      await reportTestJob(job.id, { reason: (copiedPayload.stderr || "无法复制测试用例").trim() }, requestFn);
      return;
    }
    const executed = await dockerFn(
      ["exec", "-e", "PLATFORM_TEST_PAYLOAD_FILE=/tmp/platform-test-payload.json", containerName, "node", "/tmp/platform-test-runner.mjs"],
      { timeoutMs: Math.max(60000, Number(job.runTimeoutSeconds ?? 900) * 1000) },
    );
    const parsed = lastJsonLine(executed.stdout);
    if (!parsed) {
      await reportTestJob(job.id, { reason: (executed.stderr || executed.stdout || "白盒测试入口没有返回结果").trim() }, requestFn);
      return;
    }
    if (parsed.failure) {
      await reportTestJob(job.id, { reason: String(parsed.failure) }, requestFn);
      return;
    }
    await reportTestJob(job.id, { outcomes: Array.isArray(parsed.outcomes) ? parsed.outcomes : [] }, requestFn);
  } finally {
    await dockerFn(["rm", "-f", containerName]);
    try {
      unlinkSync(payloadPath);
    } catch {
      // 临时文件可能还没创建。
    }
  }
}

export async function cycle() {
  const desired = await request("/api/nodes/" + nodeName() + "/desired");
  for (const job of desired.tests || []) {
    const payload = Buffer.from(JSON.stringify(job)).toString("base64");
    const child = spawn(process.execPath, [process.argv[1], "--test-job", payload], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }
  const projects = [];
  for (const item of desired.projects || []) {
    projects.push(await reconcileProject(item));
  }
  await request("/api/nodes/" + nodeName() + "/health", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projects: projects }),
  });
}

async function main() {
  if (process.argv[2] === "--test-job") {
    const job = JSON.parse(Buffer.from(process.argv[3] || "", "base64").toString("utf8"));
    await runTestJob(job);
    return;
  }
  while (true) {
    try {
      await cycle();
    } catch {
      // 控制面暂时不可用时继续下一轮，不退出代理。
    }
    await new Promise(function (resolve) {
      setTimeout(resolve, 30000);
    });
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
