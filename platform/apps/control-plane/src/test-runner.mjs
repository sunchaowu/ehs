/**
 * 测试容器内执行的白盒测试入口。
 *
 * 由测试节点通过 `docker cp` 放进候选镜像容器，再在容器内用 Node 运行。
 * 只依赖内置 fetch，不引入 Playwright/Midscene；黑盒步骤明确失败。
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function parseValue(value) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * 把白盒案例步骤映射成运行库 HTTP 请求。
 * 支持的 target：
 * - `<项目编码>/<实体>.create`：创建记录
 * - `<项目编码>/<实体>/<字段>`：字段校验（value 是完整记录 JSON）
 * - `<项目编码>/workflows/<流程>/<步骤>`：流程迁移
 * - `<项目编码>/menus/<菜单编码>`：未授权用户访问菜单详情
 */
export function requestForStep(step) {
  const parts = String(step.target ?? "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) {
    return { reason: `无法解析步骤目标：${step.target}` };
  }
  const code = parts[0];
  const rest = parts.slice(1);
  if (step.action === "call" && rest.length === 2 && rest[0] === "menus") {
    return {
      method: "GET",
      path: `/api/${encodeURIComponent(code)}/menus/${encodeURIComponent(rest[1])}`,
      headers: { "x-platform-user": encodeURIComponent(String(step.value ?? "未授权用户")) },
      expect: "menu-denied",
      input: { action: step.action, target: step.target, ...(step.value !== undefined ? { value: step.value } : {}) },
    };
  }
  if (step.action === "call" && rest.length === 1 && rest[0].endsWith(".create")) {
    const entity = rest[0].slice(0, -".create".length);
    return {
      method: "POST",
      path: `/api/${encodeURIComponent(code)}/${encodeURIComponent(entity)}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: parseValue(step.value) }),
      expect: "created",
      input: { action: step.action, target: step.target, ...(step.value !== undefined ? { value: step.value } : {}) },
    };
  }
  if (step.action === "validate" && rest.length === 2) {
    const [entity, field] = rest;
    return {
      method: "POST",
      path: `/api/${encodeURIComponent(code)}/${encodeURIComponent(entity)}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: parseValue(step.value) }),
      expect: "invalid",
      field,
      input: { action: step.action, target: step.target, ...(step.value !== undefined ? { value: step.value } : {}) },
    };
  }
  if (step.action === "migrate" && rest.length === 3 && rest[0] === "workflows") {
    return {
      method: "POST",
      path: `/api/${encodeURIComponent(code)}/workflows/${encodeURIComponent(rest[1])}/${encodeURIComponent(rest[2])}`,
      expect: "migrated",
      input: { action: step.action, target: step.target },
    };
  }
  return { reason: `白盒步骤不受支持：${step.action} ${step.target}` };
}

export function judgeStep(step, request, status, body) {
  const actual = `HTTP ${status}${body?.reason ? ` ${body.reason}` : ""}`;
  if (request.expect === "created") {
    const record = body?.record;
    const passed = status === 201 && Boolean(record?.id);
    return {
      passed,
      actual: passed ? `201 返回记录 ${record.id}` : actual,
      reason: passed ? "" : "创建接口未返回带 id 的记录",
    };
  }
  if (request.expect === "invalid") {
    const reason = String(body?.reason ?? "");
    const passed = status === 400 && reason.includes(request.field);
    return {
      passed,
      actual,
      reason: passed ? "" : `字段 ${request.field} 的非法值未被拒绝并说明`,
    };
  }
  if (request.expect === "menu-denied") {
    return { passed: status === 403, actual, reason: status === 403 ? "" : "未授权用户没有被拒绝" };
  }
  if (request.expect === "migrated") {
    return { passed: status === 200, actual, reason: status === 200 ? "" : "流程迁移失败" };
  }
  return { passed: false, actual, reason: "未知的断言类型" };
}

export async function runWhiteBoxCases(cases, options) {
  const baseUrl = String(options.baseUrl ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
  const timeoutMs = Math.max(1, Number(options.timeoutSeconds ?? 30)) * 1000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = {
    baseUrl: typeof options.modelBaseUrl === "string" ? options.modelBaseUrl.trim() : "",
    name: typeof options.modelName === "string" ? options.modelName.trim() : "",
    apiKey: typeof options.modelApiKey === "string" ? options.modelApiKey.trim() : "",
  };
  // 黑盒步骤尚未接入执行器；若模型配置已下发，说明配置就绪、仅缺执行器，便于排障。
  const blackBoxReason = model.baseUrl && model.name && model.apiKey
    ? "黑盒执行器未配置：模型已就绪，Midscene.js 与 Playwright 待接入"
    : "黑盒执行器未配置：Midscene.js 与 Playwright 待接入（视觉定位模型未下发）";
  const outcomes = [];
  for (const testCase of cases) {
    for (const step of testCase.steps ?? []) {
      const common = {
        caseCode: testCase.code,
        caseName: testCase.name,
        stepIndex: step.index,
        method: testCase.method,
        locator: step.target,
        expected: step.expected ?? "",
      };
      if (testCase.method !== "white-box") {
        outcomes.push({
          ...common,
          input: { action: step.action, target: step.target, ...(step.value !== undefined ? { value: step.value } : {}) },
          actual: "",
          passed: false,
          reason: blackBoxReason,
        });
        continue;
      }
      const request = requestForStep(step);
      if (request.reason) {
        outcomes.push({
          ...common,
          input: { action: step.action, target: step.target, ...(step.value !== undefined ? { value: step.value } : {}) },
          actual: "",
          passed: false,
          reason: request.reason,
        });
        continue;
      }
      try {
        const response = await fetchImpl(`${baseUrl}${request.path}`, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        let body = {};
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = { reason: text.slice(0, 200) };
        }
        const judged = judgeStep(step, request, response.status, body);
        outcomes.push({ ...common, input: request.input, actual: judged.actual, passed: judged.passed, reason: judged.reason });
      } catch (error) {
        outcomes.push({
          ...common,
          input: request.input,
          actual: "",
          passed: false,
          reason: error instanceof Error ? error.message : "请求失败",
        });
      }
    }
  }
  return outcomes;
}

async function main() {
  const payload = process.env.PLATFORM_TEST_PAYLOAD_FILE
    ? JSON.parse(readFileSync(process.env.PLATFORM_TEST_PAYLOAD_FILE, "utf8"))
    : JSON.parse(Buffer.from(process.env.PLATFORM_TEST_PAYLOAD ?? "", "base64").toString("utf8"));
  try {
    const outcomes = await runWhiteBoxCases(payload.cases ?? [], {
      baseUrl: "http://127.0.0.1:8080",
      timeoutSeconds: payload.stepTimeoutSeconds ?? 30,
      modelBaseUrl: payload.modelBaseUrl,
      modelName: payload.modelName,
      modelApiKey: payload.modelApiKey,
    });
    console.log(JSON.stringify({ outcomes }));
  } catch (error) {
    console.log(JSON.stringify({ failure: error instanceof Error ? error.message : "测试执行失败" }));
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
