/**
 * 测试容器内执行的测试入口。
 *
 * 由测试节点通过 `docker cp` 放进候选镜像容器，再在容器内用 Node 运行。
 * 白盒步骤用内置 fetch 直接调用运行库 HTTP 接口；黑盒步骤用 Playwright 驱动
 * 无头浏览器操作界面，定位链为「稳定标识 → 角色+可访问名称 → 上次成功定位 →
 * 模型视觉定位」，视觉定位走系统配置的 openai-chat 模型，禁止坐标点击。
 */

import { readFileSync } from "node:fs";
import * as defaultFs from "node:fs/promises";
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
          reason: "黑盒步骤需由黑盒执行器处理",
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

// ---------------------------------------------------------------------------
// 黑盒执行器：Playwright + 视觉定位
// ---------------------------------------------------------------------------

/** 步骤 target 按 "/" 拆段，与自动案例生成保持一致。 */
export function targetParts(target) {
  return String(target ?? "")
    .split("/")
    .filter(Boolean);
}

/** open 步骤把 `<项目>/<实体>/form` 映射为运行库页面地址。 */
export function openPathForTarget(target) {
  const parts = targetParts(target);
  if (parts.length === 0) {
    return "/";
  }
  return `/p/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
}

/** advance 步骤把 `<项目>/<流程>/<步骤>` 映射为流程页面地址。 */
export function workflowPathForTarget(target) {
  const parts = targetParts(target);
  if (parts.length < 2) {
    return "";
  }
  return `/p/${encodeURIComponent(parts[0])}/workflows/${encodeURIComponent(parts[1])}`;
}

function escapeAttr(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? "未知错误");
}

/** 角色+可访问名称兜底：输入用字段名，提交用「保存」，流程用步骤名。 */
function roleCandidates(step, target) {
  const parts = targetParts(target);
  const last = parts.at(-1) ?? "";
  if (step.action === "fill") {
    return [
      { role: "textbox", name: last },
      { role: "spinbutton", name: last },
    ];
  }
  if (step.action === "click") {
    return [{ role: "button", name: last === "submit" ? "保存" : last }];
  }
  if (step.action === "advance") {
    return [{ role: "button", name: last }];
  }
  return [];
}

function describeDescriptor(descriptor) {
  if (!descriptor) {
    return "";
  }
  if (descriptor.kind === "testid") {
    return `stable:[data-testid="${descriptor.value}"]`;
  }
  if (descriptor.kind === "role") {
    return `role:${descriptor.value}[name="${descriptor.name}"]`;
  }
  return `css:${descriptor.value}`;
}

function locatorFromDescriptor(page, descriptor) {
  if (!descriptor) {
    return null;
  }
  if (descriptor.kind === "testid") {
    return page.locator(`[data-testid="${escapeAttr(descriptor.value)}"]`);
  }
  if (descriptor.kind === "role") {
    return page.getByRole(descriptor.value, { name: descriptor.name, exact: false });
  }
  return page.locator(descriptor.value);
}

async function locatorReady(locator) {
  if (!locator) {
    return false;
  }
  try {
    if (typeof locator.count === "function" && (await locator.count()) === 0) {
      return false;
    }
    if (typeof locator.isVisible === "function" && !(await locator.isVisible())) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 模型返回坐标即视为失败：黑盒定位禁止坐标点击。 */
const COORDINATE_PATTERN = /(?:坐标|coordinate|pixel|像素)|(\b\d{2,4}\s*[,x×X]\s*\d{2,4}\b)/i;

function extractMessageContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : item?.text ?? ""))
      .join("")
      .trim();
  }
  return String(content ?? "").trim();
}

/**
 * 第四级定位：把当前截图发给 openai-chat 模型，要求只返回 CSS 选择器。
 * 模型不可用、不能看图或返回坐标时，明确失败并说明原因，不回退到坐标点击。
 */
export async function visualLocate(target, step, options = {}) {
  const model = options.model ?? {};
  if (!model.baseUrl || !model.name) {
    return { reason: "视觉定位未配置模型：请在系统设置里填写模型地址与模型名称" };
  }
  if (options.visualLocator) {
    // Midscene 视觉引擎可直接完成动作，也可返回一个 CSS 选择器交回定位器。
    const custom = await options.visualLocator(target, step, options);
    if (custom?.performed) {
      return { performed: true };
    }
    if (custom?.selector) {
      return { selector: String(custom.selector) };
    }
    if (custom?.reason) {
      return { reason: String(custom.reason) };
    }
  }
  let imageBuffer;
  try {
    const takeScreenshot = options.takeScreenshot ?? (() => options.page?.screenshot?.());
    imageBuffer = await takeScreenshot();
  } catch (error) {
    return { reason: `视觉定位截图失败：${errorText(error)}` };
  }
  if (!imageBuffer) {
    return { reason: "视觉定位失败：无法获取当前页面截图" };
  }
  const image = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString("base64") : String(imageBuffer);
  const base = String(model.baseUrl).replace(/\/+$/, "");
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const instruction =
    `找出页面中与下面步骤目标对应的唯一元素，只输出一个 CSS 选择器（例如 [data-testid="..."]），` +
    `不要输出坐标、解释或 Markdown。如果看不到该元素或无法理解截图，输出 ERROR: <原因>。\n` +
    `动作：${step.action}\n目标：${target}\n期望：${step.expected ?? ""}`;
  const headers = { "content-type": "application/json" };
  if (model.apiKey) {
    headers.authorization = `Bearer ${model.apiKey}`;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.name,
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content: "你是界面元素定位器。只返回 CSS 选择器字符串，禁止返回屏幕坐标；无法定位时返回 ERROR: 原因。",
          },
          {
            role: "user",
            content: [
              { type: "text", text: instruction },
              { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(Math.max(5, Number(options.timeoutSeconds ?? 30)) * 1000),
    });
    if (!response.ok) {
      return { reason: `视觉定位模型请求失败（HTTP ${response.status}）：${(await response.text()).slice(0, 200)}` };
    }
    const payload = await response.json();
    const content = extractMessageContent(payload).replace(/^```(?:css)?\s*|\s*```$/g, "").trim();
    if (!content) {
      return { reason: "视觉定位模型没有返回定位结果" };
    }
    if (/^ERROR:/i.test(content)) {
      return { reason: `视觉定位失败：${content.replace(/^ERROR:\s*/i, "")}` };
    }
    if (COORDINATE_PATTERN.test(content)) {
      return { reason: `视觉定位失败：模型返回了坐标（${content.slice(0, 120)}），黑盒禁止坐标点击` };
    }
    if (content.length > 300 || /\s/.test(content.trim()) && !/^[a-zA-Z#.[:]/.test(content.trim())) {
      return { reason: `视觉定位失败：模型返回的不是合法选择器（${content.slice(0, 120)}）` };
    }
    return { selector: content };
  } catch (error) {
    return { reason: `视觉定位模型调用失败：${errorText(error)}` };
  }
}

/**
 * 三级稳定定位 + 视觉回退。返回 { locator, descriptor, attempts } 或 { reason }。
 */
export async function locateElement(target, step, options = {}) {
  const page = options.page;
  const attempts = [];
  async function attempt(descriptor) {
    let locator;
    try {
      locator = locatorFromDescriptor(page, descriptor);
    } catch (error) {
      attempts.push(`${describeDescriptor(descriptor)}: ${errorText(error)}`);
      return null;
    }
    if (await locatorReady(locator)) {
      if (options.context) {
        (options.context.lastLocators ??= {})[target] = descriptor;
      }
      return { locator, descriptor, attempts };
    }
    attempts.push(`${describeDescriptor(descriptor)}: 未找到可见元素`);
    return null;
  }

  // 1. 稳定标识：运行库页面的 data-testid 与步骤 target 完全一致。
  const stable = await attempt({ kind: "testid", value: target });
  if (stable) {
    return stable;
  }

  // 2. 角色 + 可访问名称。
  for (const hint of roleCandidates(step, target)) {
    const found = await attempt({ kind: "role", value: hint.role, name: hint.name });
    if (found) {
      return found;
    }
  }

  // 3. 上次成功定位（同一 target 在本轮运行里缓存的选择器）。
  const cached = options.context?.lastLocators?.[target];
  if (cached) {
    const found = await attempt(cached);
    if (found) {
      return found;
    }
  }

  // 4. 模型视觉定位：Midscene 可直接完成动作；自建链路只返回选择器，绝不返回坐标。
  const visual = await visualLocate(target, step, options);
  if (visual.performed) {
    return { performed: true, attempts };
  }
  if (visual.reason) {
    attempts.push(`visual: ${visual.reason}`);
    return { reason: `${visual.reason}（已尝试：${attempts.join(" → ")}）`, attempts };
  }
  const found = await attempt({ kind: "css", value: visual.selector });
  if (found) {
    return found;
  }
  return { reason: `视觉定位选择器未匹配到元素：${visual.selector}（已尝试：${attempts.join(" → ")}）`, attempts };
}

async function saveScreenshot(step, options) {
  if (!options.reportDir || !options.fs || !options.page?.screenshot) {
    return "";
  }
  const slug = `${String(options.caseCode ?? "case").replace(/[^\w-]/g, "")}-${step.index}`;
  const file = `step-${slug}.png`;
  try {
    await options.page.screenshot({ path: `${options.reportDir.replace(/\/+$/, "")}/${file}` });
    return file;
  } catch {
    return "";
  }
}

/** 执行一个黑盒步骤。所有点击都通过定位器完成，没有 page.mouse 坐标操作。 */
export async function runBlackBoxStep(step, options = {}) {
  const target = String(step.target ?? "");
  const common = {
    caseCode: options.caseCode,
    caseName: options.caseName,
    stepIndex: step.index,
    method: "black-box",
    locator: "",
    expected: step.expected ?? "",
  };
  const input = { action: step.action, target, ...(step.value !== undefined ? { value: step.value } : {}) };
  const baseUrl = String(options.baseUrl ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
  try {
    if (!options.page) {
      return {
        ...common,
        input,
        actual: "",
        locator: "unavailable",
        passed: false,
        reason: options.browserReason ?? "浏览器依赖未就绪：Playwright/Chromium/Midscene 未安装",
      };
    }
    if (step.action === "open") {
      const path = openPathForTarget(target);
      await options.page.goto(new URL(path, baseUrl).toString());
      return { ...common, input, locator: `url:${path}`, actual: path, passed: true, reason: "" };
    }
    if (step.action === "advance") {
      const path = workflowPathForTarget(target);
      if (path) {
        await options.page.goto(new URL(path, baseUrl).toString());
      }
    }
    if (!["fill", "click", "advance"].includes(step.action)) {
      return { ...common, input, actual: "", passed: false, reason: `黑盒步骤动作不受支持：${step.action}` };
    }
    const located = await locateElement(target, step, options);
    if (located.reason) {
      return { ...common, input, actual: "", passed: false, locator: located.attempts?.join(" → ") ?? "", reason: located.reason };
    }
    if (located.performed) {
      // Midscene 通过 aiAct 自行完成动作，其定位在引擎内部完成，runner 不做坐标点击。
      return {
        ...common,
        input,
        locator: "midscene:aiAct",
        actual: `${step.action} 由 Midscene 完成`,
        passed: true,
        reason: "",
      };
    }
    if (step.action === "fill") {
      await located.locator.fill(String(step.value ?? ""));
    } else {
      await located.locator.click();
    }
    return {
      ...common,
      input,
      locator: describeDescriptor(located.descriptor),
      actual: `${step.action} 成功`,
      passed: true,
      reason: "",
    };
  } catch (error) {
    return { ...common, input, actual: "", passed: false, reason: `黑盒步骤执行失败：${errorText(error)}` };
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 生成 Midscene 风格的 HTML 步骤报告，截图留在测试区。 */
export async function writeHtmlReport(outcomes, options = {}) {
  const fs = options.fs ?? defaultFs;
  const dir = String(options.reportDir ?? "/tmp/platform-test-report").replace(/\/+$/, "");
  await fs.mkdir(dir, { recursive: true });
  const rows = outcomes
    .map((outcome) => {
      const shot = outcome.screenshot ? `<a href="${escapeHtml(outcome.screenshot)}">截图</a>` : "";
      return `<tr>
        <td>${escapeHtml(outcome.caseName)}</td>
        <td>${escapeHtml(outcome.stepIndex)}</td>
        <td>${escapeHtml(outcome.input?.action)}</td>
        <td>${escapeHtml(outcome.locator)}</td>
        <td style="color:${outcome.passed ? "green" : "red"}">${outcome.passed ? "通过" : "失败"}</td>
        <td>${escapeHtml(outcome.reason || outcome.actual)}</td>
        <td>${shot}</td>
      </tr>`;
    })
    .join("");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>黑盒测试报告</title>
<style>body{font-family:sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px;text-align:left}</style>
<h1>黑盒测试报告</h1><p>模型：${escapeHtml(options.model?.name ?? "未配置")}</p>
<table><thead><tr><th>案例</th><th>步骤</th><th>动作</th><th>定位</th><th>结果</th><th>说明</th><th>证据</th></tr></thead><tbody>${rows}</tbody></table>
</html>`;
  await fs.writeFile(`${dir}/report.html`, html, "utf8");
  return dir;
}

export async function runBlackBoxCases(cases, options = {}) {
  const context = options.context ?? { lastLocators: {} };
  const outcomes = [];
  for (const testCase of cases) {
    for (const step of testCase.steps ?? []) {
      const outcome = await runBlackBoxStep(step, {
        ...options,
        context,
        caseCode: testCase.code,
        caseName: testCase.name,
      });
      outcome.screenshot = await saveScreenshot(step, { ...options, caseCode: testCase.code });
      outcomes.push(outcome);
    }
  }
  const reportDir = options.reportDir ? await writeHtmlReport(outcomes, options) : "";
  return { outcomes, reportDir };
}

/** 把黑盒步骤翻译成 Midscene aiAct 的中文指令。 */
export function midscenePrompt(target, step) {
  const parts = targetParts(target);
  const last = parts.at(-1) ?? target;
  if (step.action === "fill") {
    return `在当前页面找到「${last}」输入框，填入：${String(step.value ?? "")}`;
  }
  if (step.action === "click") {
    return `在当前页面点击「${last === "submit" ? "保存" : last}」按钮`;
  }
  if (step.action === "advance") {
    return `在当前页面点击流程步骤「${last}」按钮`;
  }
  return `在当前页面完成操作：${step.expected ?? step.action}（目标：${target}）`;
}

/** 把 Midscene Agent 包装成 visualLocator：aiAct 直接完成动作，失败时交回自建视觉链路。 */
export function createMidsceneVisualLocator(agent) {
  return async (target, step) => {
    const prompt = midscenePrompt(target, step);
    try {
      await agent.aiAct(prompt);
      return { performed: true, prompt };
    } catch (error) {
      return { reason: `Midscene 视觉执行失败：${errorText(error)}` };
    }
  };
}

/**
 * 在容器里按需加载 Playwright/Chromium 与 Midscene，并注入模型配置。
 * 模型密钥只写入容器进程环境变量，绝不进入日志或回报。
 */
export async function bootstrapBrowser(options = {}) {
  const env = options.env ?? process.env;
  const importModule = options.importModule ?? ((path) => import(path));
  const model = options.model ?? {};

  // openai-chat 是 Midscene 的「协议」；family 必须是受支持的视觉模型族，
  // 用于解析模型返回的定位结果。默认 qwen2.5-vl，可通过系统设置覆盖。
  if (model.baseUrl) {
    env.MIDSCENE_MODEL_BASE_URL = String(model.baseUrl).replace(/\/+$/, "");
  }
  if (model.name) {
    env.MIDSCENE_MODEL_NAME = String(model.name);
  }
  if (model.apiKey) {
    env.MIDSCENE_MODEL_API_KEY = String(model.apiKey);
  }
  env.MIDSCENE_MODEL_PROTOCOL = "openai-chat";
  if (model.family || !env.MIDSCENE_MODEL_FAMILY || env.MIDSCENE_MODEL_FAMILY === "openai-chat") {
    env.MIDSCENE_MODEL_FAMILY = String(model.family || env.PLATFORM_MIDSCENE_MODEL_FAMILY || "qwen2.5-vl");
  }

  const candidates = [
    env.PLATFORM_BROWSER_MODULE,
    "/opt/test-harness/node_modules/playwright/index.mjs",
    "/opt/test-harness/node_modules/playwright/index.js",
    "playwright",
  ].filter(Boolean);
  let lastError;
  for (const modulePath of candidates) {
    try {
      const mod = await importModule(modulePath);
      const launch = { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
      if (env.PLATFORM_CHROMIUM_PATH) {
        launch.executablePath = env.PLATFORM_CHROMIUM_PATH;
      }
      const browser = await mod.chromium.launch(launch);
      const page = await browser.newPage();
      if (options.timeoutSeconds) {
        page.setDefaultTimeout?.(Math.max(1, Number(options.timeoutSeconds)) * 1000);
      }

      // Midscene 在模型配置完整时加载；加载失败不阻断浏览器，由自建视觉链路兜底。
      let visualLocator;
      let midsceneReason = "";
      if (model.baseUrl && model.name) {
        const midsceneCandidates = [
          env.PLATFORM_MIDSCENE_MODULE,
          "/opt/test-harness/node_modules/@midscene/web/dist/es/playwright/index.mjs",
          "@midscene/web/playwright",
          "@midscene/web",
        ].filter(Boolean);
        let midsceneError;
        for (const midscenePath of midsceneCandidates) {
          try {
            const midscene = await importModule(midscenePath);
            const Agent = midscene.PlaywrightAgent ?? midscene.default?.PlaywrightAgent;
            if (!Agent) {
              throw new Error("模块未导出 PlaywrightAgent");
            }
            visualLocator = createMidsceneVisualLocator(new Agent(page));
            break;
          } catch (error) {
            midsceneError = error;
          }
        }
        if (!visualLocator) {
          midsceneReason = `Midscene 未就绪：${errorText(midsceneError)}`;
        }
      } else {
        midsceneReason = "Midscene 未配置模型：视觉定位走 openai-chat 直连";
      }

      return { page, close: () => browser.close(), visualLocator, midsceneReason };
    } catch (error) {
      lastError = error;
    }
  }
  return { reason: `浏览器依赖未就绪：Playwright/Chromium 不可用（${errorText(lastError)}）` };
}

/** 按案例方法分发白盒与黑盒，合并结果并按案例顺序返回。 */
export async function runAllCases(cases, options = {}) {
  const white = [];
  const black = [];
  for (const testCase of cases) {
    (testCase.method === "black-box" ? black : white).push(testCase);
  }
  const outcomes = [];
  if (white.length) {
    outcomes.push(...(await runWhiteBoxCases(white, options)));
  }
  let reportDir = "";
  if (black.length) {
    const result = await runBlackBoxCases(black, options);
    outcomes.push(...result.outcomes);
    reportDir = result.reportDir;
  }
  const order = new Map(cases.map((testCase, index) => [testCase.code, index]));
  outcomes.sort((a, b) => (order.get(a.caseCode) ?? 0) - (order.get(b.caseCode) ?? 0) || a.stepIndex - b.stepIndex);
  return { outcomes, reportDir };
}

async function main() {
  const payload = process.env.PLATFORM_TEST_PAYLOAD_FILE
    ? JSON.parse(readFileSync(process.env.PLATFORM_TEST_PAYLOAD_FILE, "utf8"))
    : JSON.parse(Buffer.from(process.env.PLATFORM_TEST_PAYLOAD ?? "", "base64").toString("utf8"));
  let browser;
  try {
    const options = {
      baseUrl: "http://127.0.0.1:8080",
      timeoutSeconds: payload.stepTimeoutSeconds ?? 30,
      reportDir: process.env.PLATFORM_TEST_REPORT_DIR ?? "/tmp/platform-test-report",
      model: {
        baseUrl: payload.modelBaseUrl ?? "",
        name: payload.modelName ?? "",
        apiKey: payload.modelApiKey ?? "",
      },
      fs: defaultFs,
    };
    const hasBlackBox = (payload.cases ?? []).some((testCase) => testCase.method === "black-box");
    if (hasBlackBox) {
      browser = await bootstrapBrowser(options);
      options.page = browser.page;
      options.browserReason = browser.reason;
      options.visualLocator = browser.visualLocator;
    }
    const result = await runAllCases(payload.cases ?? [], options);
    console.log(JSON.stringify({ outcomes: result.outcomes, reportDir: result.reportDir }));
  } catch (error) {
    console.log(JSON.stringify({ failure: error instanceof Error ? error.message : "测试执行失败" }));
  } finally {
    try {
      await browser?.close?.();
    } catch {
      // 浏览器关闭失败不影响已产出的结果。
    }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
