/**
 * 平台运行库：把编译出的模块定义装配成可启动的服务。
 *
 * 生成的模块统一写成 `createStandardModule(definition)`，镜像内由
 * `server.mjs` 扫描 modules 目录并启动进程。运行库不依赖第三方包，
 * 因此镜像只需要 Node 基础镜像即可运行。
 */

const fieldTypes = new Set(["text", "longText", "number", "boolean", "date", "datetime", "user", "ref"]);
const projectCodePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function createStandardModule(definition) {
  return deepFreeze(normalizeDefinition(definition));
}

export function normalizeDefinition(input) {
  if (!input || typeof input !== "object") {
    throw new Error("模块定义无效");
  }
  const projectCode = String(input.projectCode ?? "");
  if (!projectCodePattern.test(projectCode)) {
    throw new Error(`项目编码无效：${projectCode}`);
  }
  const containerGroup = String(input.containerGroup ?? projectCode);
  const menus = asArray(input.menus).map((menu) => {
    const code = String(menu?.code ?? "").trim();
    const name = String(menu?.name ?? "").trim();
    if (!code || !name) {
      throw new Error(`菜单定义无效：${projectCode}`);
    }
    return {
      code,
      name,
      parentCode: menu?.parentCode ? String(menu.parentCode) : null,
      sort: Number.isFinite(menu?.sort) ? Number(menu.sort) : 0,
    };
  });
  const entities = asArray(input.entities).map((entity) => {
    const name = String(entity?.name ?? "").trim();
    if (!name) {
      throw new Error(`实体定义无效：${projectCode}`);
    }
    const fields = asArray(entity?.fields).map((field) => normalizeField(field, name));
    if (fields.length === 0) {
      throw new Error(`实体缺少字段：${name}`);
    }
    return { name, fields };
  });
  const workflows = asArray(input.workflows).map((workflow) => {
    const name = String(workflow?.name ?? "").trim();
    const steps = asArray(workflow?.steps).map((step) => String(step).trim()).filter(Boolean);
    if (!name || steps.length === 0) {
      throw new Error(`流程定义无效：${projectCode}`);
    }
    return { name, steps };
  });
  const grants = asArray(input.grants).map((grant) => ({
    principalType: String(grant?.principalType ?? "role"),
    principalName: String(grant?.principalName ?? ""),
    menuCode: String(grant?.menuCode ?? ""),
    action: String(grant?.action ?? ""),
  }));
  const extensions = asArray(input.extensions).map((extension) => ({ name: String(extension?.name ?? "") }));
  return { projectCode, containerGroup, menus, entities, workflows, grants, extensions };
}

function normalizeField(field, entityName) {
  const name = String(field?.name ?? "").trim();
  const type = String(field?.type ?? "");
  if (!name) {
    throw new Error(`字段缺少名称：${entityName}`);
  }
  if (!fieldTypes.has(type)) {
    throw new Error(`字段类型无效：${entityName}.${name}`);
  }
  if (type === "ref" && !String(field?.target ?? "").trim()) {
    throw new Error(`引用字段缺少目标：${entityName}.${name}`);
  }
  return type === "ref" ? { name, type, target: String(field.target) } : { name, type };
}

/** 按字段类型校验一条记录；返回规范化后的值或失败原因。 */
export function validateRecord(entity, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { reason: "记录必须是对象" };
  }
  const values = {};
  const missing = [];
  const errors = [];
  const names = new Set(entity.fields.map((field) => field.name));
  for (const key of Object.keys(input)) {
    if (!names.has(key)) {
      errors.push(`未知字段：${key}`);
    }
  }
  for (const field of entity.fields) {
    const raw = input[field.name];
    if (raw === undefined || raw === null || raw === "") {
      missing.push(field.name);
      continue;
    }
    const checked = coerceField(field, raw);
    if (typeof checked === "object" && checked.reason) {
      errors.push(checked.reason);
    } else {
      values[field.name] = checked.value;
    }
  }
  if (missing.length > 0) {
    return { reason: `缺少字段：${missing.join("、")}` };
  }
  if (errors.length > 0) {
    return { reason: errors.join("；") };
  }
  return { values };
}

function coerceField(field, raw) {
  const label = field.name;
  switch (field.type) {
    case "number": {
      const value = typeof raw === "number" ? raw : Number(String(raw).trim());
      return Number.isFinite(value) ? { value } : { reason: `${label} 必须是数字` };
    }
    case "boolean": {
      if (typeof raw === "boolean") {
        return { value: raw };
      }
      const text = String(raw).trim().toLowerCase();
      if (text === "true" || text === "false") {
        return { value: text === "true" };
      }
      return { reason: `${label} 必须是布尔值` };
    }
    case "date": {
      const text = String(raw).trim();
      return datePattern.test(text) ? { value: text } : { reason: `${label} 必须是 YYYY-MM-DD` };
    }
    case "datetime": {
      const text = String(raw).trim();
      return Number.isNaN(Date.parse(text)) ? { reason: `${label} 必须是日期时间` } : { value: text };
    }
    case "ref": {
      const text = String(raw).trim();
      return text ? { value: text } : { reason: `${label} 必须引用一条记录` };
    }
    case "user": {
      const text = String(raw).trim();
      return text ? { value: text } : { reason: `${label} 必须是用户` };
    }
    default: {
      return { value: String(raw) };
    }
  }
}

export function createStore() {
  /** key 为 `${projectCode}:${entityName}`，值为记录数组 */
  const records = new Map();
  /** key 为 `${projectCode}:${workflowName}`，值为已完成的步骤数 */
  const workflowPositions = new Map();

  return {
    kind: "memory",
    async list(projectCode, entityName) {
      return records.get(`${projectCode}:${entityName}`) ?? [];
    },
    async insert(projectCode, entityName, values) {
      const key = `${projectCode}:${entityName}`;
      const list = records.get(key) ?? [];
      const record = { id: crypto.randomUUID(), ...values, createdAt: new Date().toISOString() };
      list.push(record);
      records.set(key, list);
      return record;
    },
    async remove(projectCode, entityName, id) {
      const key = `${projectCode}:${entityName}`;
      const list = records.get(key) ?? [];
      const next = list.filter((record) => record.id !== id);
      records.set(key, next);
      return next.length !== list.length;
    },
    async workflowPosition(projectCode, workflowName) {
      return workflowPositions.get(`${projectCode}:${workflowName}`) ?? 0;
    },
    async advance(projectCode, workflowName, step) {
      const key = `${projectCode}:${workflowName}`;
      const position = workflowPositions.get(key) ?? 0;
      workflowPositions.set(key, position + 1);
      return position;
    },
  };
}

/**
 * PostgreSQL 存储：每个项目使用自己的库，表结构固定，实体名作为常量列保存，
 * 因此新增实体不需要做 DDL。记录体存 jsonb，便于按设计字段原样读回。
 */
export function createPostgresStore(pool) {
  return {
    kind: "postgres",
    async ensureSchema() {
      await pool.query(
        `create table if not exists platform_records (
           entity text not null,
           id uuid primary key,
           data jsonb not null,
           created_at timestamptz not null default now()
         )`,
      );
      await pool.query(
        `create table if not exists platform_workflows (
           workflow text primary key,
           completed integer not null default 0
         )`,
      );
    },
    async list(_projectCode, entityName) {
      const result = await pool.query(
        "select data from platform_records where entity = $1 order by created_at, id",
        [entityName],
      );
      return result.rows.map((row) => row.data);
    },
    async insert(_projectCode, entityName, values) {
      const record = { id: crypto.randomUUID(), ...values, createdAt: new Date().toISOString() };
      await pool.query(
        "insert into platform_records (entity, id, data) values ($1, $2, $3::jsonb)",
        [entityName, record.id, JSON.stringify(record)],
      );
      return record;
    },
    async remove(_projectCode, entityName, id) {
      const result = await pool.query(
        "delete from platform_records where entity = $1 and id = $2 returning id",
        [entityName, id],
      );
      return result.rows.length > 0;
    },
    async workflowPosition(_projectCode, workflowName) {
      const result = await pool.query("select completed from platform_workflows where workflow = $1", [workflowName]);
      return result.rows[0]?.completed ?? 0;
    },
    async advance(_projectCode, workflowName) {
      const result = await pool.query(
        `insert into platform_workflows (workflow, completed) values ($1, 1)
         on conflict (workflow) do update set completed = platform_workflows.completed + 1
         returning completed`,
        [workflowName],
      );
      return result.rows[0].completed - 1;
    },
  };
}

export async function connectPostgres(databaseUrl) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  await pool.query("select 1");
  const store = createPostgresStore(pool);
  await store.ensureSchema();
  return { store, pool };
}

export function createApp(modules, store) {
  const byCode = new Map(modules.map((module) => [module.projectCode, module]));
  const activeStore = store ?? createStore();

  return {
    modules: byCode,
    store: activeStore,
    async handle(request, response) {
      try {
        await route(request, response, byCode, activeStore);
      } catch (error) {
        sendJson(response, 500, { reason: error instanceof Error ? error.message : "运行库内部错误" });
      }
    },
  };
}

async function route(request, response, modules, store) {
  const url = new URL(request.url ?? "/", "http://runtime.local");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method ?? "GET";

  if (parts.length === 0) {
    return sendHtml(response, 200, indexPage(modules));
  }
  if (parts[0] === "health") {
    return sendJson(response, 200, {
      status: "ok",
      mode: process.env["runtime.mode"] ?? "prod",
      storage: store.kind,
      projects: [...modules.values()].map((module) => ({
        code: module.projectCode,
        entities: module.entities.length,
        workflows: module.workflows.length,
      })),
    });
  }
  if (parts[0] === "api" && parts.length >= 3) {
    return apiRoute(request, response, method, parts, modules, store);
  }
  if (parts[0] === "p" && parts.length >= 3) {
    return pageRoute(request, response, method, parts, modules, store);
  }
  return sendJson(response, 404, { reason: "路径不存在" });
}

function principalFrom(request) {
  const header = (name) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value.join(",") : String(value ?? "");
  };
  return {
    user: decodeHeader(header("x-platform-user")).trim(),
    roles: decodeHeader(header("x-platform-roles"))
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean),
  };
}

/** 请求头只能放 ASCII，中文用户名和角色按 encodeURIComponent 编码。 */
function decodeHeader(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 菜单可见需要「访问」授权；角色和用户授权取并集。 */
function menuAllowed(module, menuCode, principal) {
  return module.grants.some(
    (grant) =>
      grant.menuCode === menuCode &&
      grant.action === "访问" &&
      ((grant.principalType === "user" && grant.principalName === principal.user) ||
        (grant.principalType === "role" && principal.roles.includes(grant.principalName))),
  );
}

async function apiRoute(request, response, method, parts, modules, store) {
  const code = parts[1];
  const module = modules.get(code);
  if (!module) {
    return sendJson(response, 404, { reason: "项目模块不存在" });
  }
  const rest = parts.slice(2);

  if (rest[0] === "menus" && method === "GET") {
    const principal = principalFrom(request);
    if (!principal.user && principal.roles.length === 0) {
      return sendJson(response, 401, { reason: "缺少用户身份" });
    }
    if (rest.length === 1) {
      return sendJson(response, 200, { menus: module.menus.filter((menu) => menuAllowed(module, menu.code, principal)) });
    }
    if (rest.length === 2) {
      const menuCode = decodeURIComponent(rest[1]);
      const menu = module.menus.find((item) => item.code === menuCode);
      if (!menu) {
        return sendJson(response, 404, { reason: `菜单不存在：${menuCode}` });
      }
      if (!menuAllowed(module, menu.code, principal)) {
        return sendJson(response, 403, { reason: "未授权访问" });
      }
      return sendJson(response, 200, { menu });
    }
    return sendJson(response, 405, { reason: "方法不支持" });
  }

  if (rest[0] === "workflows" && rest.length >= 2) {
    const name = decodeURIComponent(rest[1]);
    const workflow = module.workflows.find((item) => item.name === name);
    if (!workflow) {
      return sendJson(response, 404, { reason: `流程不存在：${name}` });
    }
    if (rest.length === 2 && method === "GET") {
      const position = await store.workflowPosition(code, name);
      return sendJson(response, 200, { name, steps: workflow.steps, completed: position });
    }
    if (rest.length === 3 && method === "POST") {
      const step = decodeURIComponent(rest[2]);
      const position = await store.workflowPosition(code, name);
      const expected = workflow.steps[position];
      if (!expected) {
        return sendJson(response, 409, { reason: "流程已完成" });
      }
      if (step !== expected) {
        return sendJson(response, 409, { reason: `流程步骤顺序不符，期望 ${expected}` });
      }
      await store.advance(code, name, step);
      return sendJson(response, 200, { name, step, completed: position + 1 });
    }
    return sendJson(response, 405, { reason: "方法不支持" });
  }

  const entityName = decodeURIComponent(rest[0]);
  const entity = module.entities.find((item) => item.name === entityName);
  if (!entity) {
    return sendJson(response, 404, { reason: `实体不存在：${entityName}` });
  }

  if (rest.length === 1 && method === "GET") {
    return sendJson(response, 200, { records: await store.list(code, entity.name) });
  }
  if (rest.length === 1 && method === "POST") {
    const body = await readJson(request);
    if (body.reason) {
      return sendJson(response, 400, { reason: body.reason });
    }
    const checked = validateRecord(entity, body.value);
    if (checked.reason) {
      return sendJson(response, 400, { reason: checked.reason });
    }
    const record = await store.insert(code, entity.name, checked.values);
    return sendJson(response, 201, { record });
  }
  if (rest.length === 2 && method === "DELETE") {
    const removed = await store.remove(code, entity.name, decodeURIComponent(rest[1]));
    return removed
      ? sendJson(response, 200, { removed: true })
      : sendJson(response, 404, { reason: "记录不存在" });
  }
  return sendJson(response, 405, { reason: "方法不支持" });
}

async function pageRoute(request, response, method, parts, modules, store) {
  const code = parts[1];
  const module = modules.get(code);
  if (!module) {
    return sendHtml(response, 404, "<h1>项目模块不存在</h1>");
  }
  const entityName = decodeURIComponent(parts[2]);
  const entity = module.entities.find((item) => item.name === entityName);
  if (!entity) {
    return sendHtml(response, 404, "<h1>实体不存在</h1>");
  }
  const suffix = parts[3];

  if (!suffix && method === "GET") {
    const records = await store.list(code, entity.name);
    return sendHtml(response, 200, listPage(module, entity, records));
  }
  if (suffix === "form" && method === "GET") {
    return sendHtml(response, 200, formPage(module, entity, ""));
  }
  if (!suffix && method === "POST") {
    const form = await readForm(request);
    const checked = validateRecord(entity, form);
    if (checked.reason) {
      return sendHtml(response, 400, formPage(module, entity, checked.reason));
    }
    await store.insert(code, entity.name, checked.values);
    response.writeHead(303, { location: `/p/${encodeURIComponent(code)}/${encodeURIComponent(entity.name)}?created=1` });
    return response.end();
  }
  return sendHtml(response, 405, "<h1>方法不支持</h1>");
}

function indexPage(modules) {
  const items = [...modules.values()]
    .map(
      (module) =>
        `<li>${escapeHtml(module.projectCode)}
           <ul>${module.entities
             .map(
               (entity) =>
                 `<li><a href="/p/${encodeURIComponent(module.projectCode)}/${encodeURIComponent(entity.name)}">${escapeHtml(entity.name)}</a></li>`,
             )
             .join("")}</ul>
         </li>`,
    )
    .join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>项目模块</title><body><h1>项目模块</h1><ul>${items}</ul></body></html>`;
}

function formPage(module, entity, reason) {
  const inputs = entity.fields
    .map((field) => {
      const type = field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
      const hint = field.type === "ref" ? `引用 ${field.target}` : field.type;
      return `<label>${escapeHtml(field.name)}（${escapeHtml(hint)}）
        <input name="${escapeHtml(field.name)}" type="${type}" required></label>`;
    })
    .join("");
  return pageShell(
    module,
    entity,
    `${reason ? `<p role="alert">${escapeHtml(reason)}</p>` : ""}
     <form method="post" action="/p/${encodeURIComponent(module.projectCode)}/${encodeURIComponent(entity.name)}">
       ${inputs}
       <button type="submit">保存</button>
     </form>`,
  );
}

function listPage(module, entity, records) {
  const rows = records
    .map((record) => {
      const cells = entity.fields
        .map((field) => `<td>${escapeHtml(String(record[field.name] ?? ""))}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  const headers = entity.fields.map((field) => `<th>${escapeHtml(field.name)}</th>`).join("");
  return pageShell(
    module,
    entity,
    `<p><a href="/p/${encodeURIComponent(module.projectCode)}/${encodeURIComponent(entity.name)}/form">新增</a></p>
     <table border="1" cellpadding="6"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function pageShell(module, entity, body) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>${escapeHtml(entity.name)} - ${escapeHtml(module.projectCode)}</title>
<body><h1>${escapeHtml(entity.name)}</h1>${body}</body></html>`;
}

async function readJson(request) {
  const raw = await readBody(request);
  if (raw.length === 0) {
    return { reason: "请求体为空" };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { reason: "请求体不是合法 JSON" };
  }
}

async function readForm(request) {
  const raw = await readBody(request);
  return Object.fromEntries(new URLSearchParams(raw));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error("请求体过大");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(body);
}

function sendHtml(response, status, body) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}
