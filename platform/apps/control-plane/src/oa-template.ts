export type OaTemplateField = { name: string; type: string; target?: string };

export type OaTemplateStep = { action: string; target: string; value?: string; expected: string };

export type OaTemplateCase = {
  method: "black-box" | "white-box";
  name: string;
  steps: OaTemplateStep[];
};

export type OaTemplate = {
  code: string;
  name: string;
  menus: Array<{ key: string; name: string; parent?: string }>;
  entities: Array<{ name: string; fields: OaTemplateField[] }>;
  workflow: { name: string; steps: string[] };
  grants: Array<{ role: string; menu: string; actions: string[] }>;
  cases: OaTemplateCase[];
};

export function oaTemplate(projectCode: string): OaTemplate {
  const leave = `${projectCode}/请假单`;
  const flow = `${projectCode}/请假流程`;
  return {
    code: "oa",
    name: "OA 办公模板",
    menus: [
      { key: "org", name: "组织" },
      { key: "employee", name: "员工", parent: "组织" },
      { key: "department", name: "部门", parent: "组织" },
      { key: "leave", name: "请假" },
      { key: "announcement", name: "公告" },
    ],
    entities: [
      { name: "部门", fields: [{ name: "名称", type: "text" }] },
      {
        name: "员工",
        fields: [
          { name: "姓名", type: "text" },
          { name: "部门", type: "ref", target: "部门" },
          { name: "入职日期", type: "date" },
        ],
      },
      {
        name: "请假单",
        fields: [
          { name: "员工", type: "ref", target: "员工" },
          { name: "请假类型", type: "text" },
          { name: "开始日期", type: "date" },
          { name: "结束日期", type: "date" },
          { name: "事由", type: "longText" },
        ],
      },
      {
        name: "公告",
        fields: [
          { name: "标题", type: "text" },
          { name: "内容", type: "longText" },
          { name: "发布日期", type: "date" },
        ],
      },
    ],
    workflow: { name: "请假流程", steps: ["submit", "approve", "record"] },
    grants: [
      { role: "员工", menu: "请假", actions: ["访问", "新增"] },
      { role: "员工", menu: "公告", actions: ["访问"] },
      { role: "员工", menu: "组织", actions: ["访问"] },
      { role: "部门负责人", menu: "请假", actions: ["访问", "新增", "修改"] },
      { role: "人事", menu: "组织", actions: ["访问", "新增", "修改", "删除"] },
      { role: "人事", menu: "请假", actions: ["访问", "新增", "修改"] },
      { role: "人事", menu: "公告", actions: ["访问", "新增", "修改", "删除"] },
    ],
    cases: [
      {
        method: "black-box",
        name: "员工提交请假",
        steps: [
          { action: "open", target: `${leave}/form`, expected: "表单打开" },
          { action: "fill", target: `${leave}/员工`, value: "ref:员工", expected: "已输入" },
          { action: "fill", target: `${leave}/请假类型`, value: "事假", expected: "已输入" },
          { action: "fill", target: `${leave}/开始日期`, value: "2000-01-01", expected: "已输入" },
          { action: "fill", target: `${leave}/结束日期`, value: "2000-01-02", expected: "已输入" },
          { action: "click", target: `${leave}/submit`, expected: "保存成功" },
        ],
      },
      {
        method: "black-box",
        name: "部门负责人审批",
        steps: [{ action: "advance", target: `${flow}/approve`, expected: "审批通过" }],
      },
      {
        method: "black-box",
        name: "人事备案",
        steps: [{ action: "advance", target: `${flow}/record`, expected: "备案完成" }],
      },
      {
        method: "white-box",
        name: "员工不能删除人事菜单",
        steps: [{ action: "call", target: `${projectCode}/组织.delete`, value: "员工", expected: "拒绝并说明缺少删除授权" }],
      },
      {
        method: "white-box",
        name: "请假单缺少必填字段被拒绝",
        steps: [{ action: "validate", target: `${leave}/员工`, value: "", expected: "拒绝并说明缺少员工" }],
      },
    ],
  };
}
