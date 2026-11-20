const zhCN = {
  home: "工作台",
  system: "系统配置",
  plugin: "插件配置",
  model: "模型配置",
  users: "用户管理",
  access: "授权管理",
  account: "账号设置",
  personal: "个人配置",
  logout: "退出",
  language: "语言",
  contactAdmin: "联系管理员",
  createProject: "创建项目",
  projectName: "创建项目",
  myProjects: "我的项目",
  draft: "草稿",
  session: "会话",
  modelUnavailable: "会话和运维智能体不会调用模型",
  chinese: "简体中文",
  english: "English",
};

const enUS = {
  home: "Workbench",
  system: "System settings",
  plugin: "Plugins",
  model: "Model",
  users: "Users",
  access: "Access",
  account: "Account settings",
  personal: "Account settings",
  logout: "Sign out",
  language: "Language",
  contactAdmin: "Contact an administrator",
  createProject: "Create project",
  projectName: "Create project",
  myProjects: "My projects",
  draft: "Draft",
  session: "Conversation",
  modelUnavailable: "Conversations and operations will not call a model",
  chinese: "Chinese",
  english: "English",
};

export type ShellCopy = typeof zhCN;

export function shellCopy(language: string): ShellCopy {
  return language === "en-US" ? enUS : zhCN;
}

export function languageName(code: string, language: string): string {
  const copy = shellCopy(language);
  if (code === "zh-CN") {
    return copy.chinese;
  }
  if (code === "en-US") {
    return copy.english;
  }
  return code;
}
