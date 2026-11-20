import type { ToolDefinition } from "./llm.js";

/**
 * 需求会话对模型开放的工具。参数与行为细则第 6.4 节一致：
 * 项目由当前会话确定，模型不传项目编码；编码一律由平台生成。
 */
export function sessionToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "create_project",
        description: "创建一个新项目。仅用于需求人员明确要求新建项目时；编码省略时由名称自动生成。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "项目名称" },
            code: { type: "string", description: "项目编码，可省略，省略时由名称生成" },
            containerGroup: { type: "string", description: "已有容器组编码，可省略" },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_menu",
        description: "在当前项目草稿中新增菜单。parent 省略时作为顶级菜单，排在同级最后。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "菜单名称" },
            parent: { type: "string", description: "上级菜单编码，可省略" },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_entity",
        description: "在当前项目草稿中新增数据实体。字段类型只能是 text、longText、number、boolean、date、datetime、user、ref，ref 必须指定目标实体。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "实体名称" },
            fields: {
              type: "array",
              description: "字段列表",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "字段名" },
                  label: { type: "string", description: "显示名称" },
                  type: { type: "string", description: "字段类型" },
                  target: { type: "string", description: "ref 字段的目标实体" },
                },
                required: ["name", "type"],
              },
            },
          },
          required: ["name", "fields"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_workflow",
        description: "在当前项目草稿中新增审批流程。步骤类型只能是 submit、approve、record，按顺序执行。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "流程名称" },
            steps: { type: "array", description: "按顺序的步骤", items: { type: "string" } },
          },
          required: ["name", "steps"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grant_role",
        description: "给用户或角色授予菜单动作。动作只能是 访问、新增、修改、删除。主体是角色且角色不存在时会创建角色。",
        parameters: {
          type: "object",
          properties: {
            principalType: { type: "string", description: "user 或 role" },
            principalName: { type: "string", description: "用户名或角色名" },
            menu: { type: "string", description: "菜单编码" },
            actions: { type: "array", description: "动作列表", items: { type: "string" } },
          },
          required: ["principalType", "principalName", "menu", "actions"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mark_extension",
        description: "记录领域包无法表达的受控扩展名称和边界。第一版 OA 不产生受控扩展。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "扩展名称" },
            boundary: { type: "string", description: "扩展边界说明" },
          },
          required: ["name", "boundary"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "add_test_case",
        description: "追加一条用户测试案例。方法只能是 black-box 或 white-box；用户案例会保留到用户删除。",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", description: "black-box 或 white-box" },
            name: { type: "string", description: "案例名称" },
            steps: { type: "array", description: "步骤列表", items: { type: "object" } },
          },
          required: ["method", "name", "steps"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_tests",
        description: "对当前候选镜像执行全部测试案例。还没有候选镜像时会被拒绝并说明原因。",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "replay_test",
        description: "按测试记录对当前候选镜像重新执行。记录不属于当前项目时被拒绝。",
        parameters: {
          type: "object",
          properties: { record: { type: "string", description: "测试记录编号" } },
          required: ["record"],
        },
      },
    },
  ];
}
