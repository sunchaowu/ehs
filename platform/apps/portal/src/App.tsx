import { HomeOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SettingOutlined, AppstoreOutlined, CloudOutlined, TeamOutlined, SafetyCertificateOutlined, ClusterOutlined } from "@ant-design/icons";
import { Alert, Avatar, Button, Card, Checkbox, ConfigProvider, Drawer, Dropdown, Empty, Form, Input, InputNumber, Layout, List, Menu, Select, Space, Spin, Switch, Tag, Typography } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useRef, useState } from "react";
import "./auth-page.css";
import { languageName, shellCopy } from "./shell-copy.js";

const { Header, Sider, Content } = Layout;

function useNarrowScreen() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 768px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

export type SessionUser = {
  username: string;
  displayName: string;
  language: string;
  platformAdmin: boolean;
  wechatBound: boolean;
};

export type SystemConfigView = {
  "platform.title": string;
  "platform.languages": string[];
  "registration.enabled": boolean;
  "wechat.appId": string;
  "wechat.redirectUri": string;
  "model.baseUrl": string;
  "model.name": string;
  "database.prodAdminUrl": string;
  "database.testAdminUrl": string;
  "registry.address": string;
  wechatSecretConfigured: boolean;
  modelKeyConfigured: boolean;
};

type Section = "system" | "plugin" | "model" | "users" | "nodes" | "account";

type ProjectSummary = { name: string; code: string; containerGroup: string; projectAdmin: boolean };

type DraftMenuView = { code: string; name: string; parent_code: string | null };
type DraftGrantView = { principal_type: string; principal_name: string; menu_code: string; action: string };
type ManagedUserView = {
  username: string;
  displayName: string;
  language: string;
  platformAdmin: boolean;
  disabled: boolean;
  wechatBound: boolean;
};
type ProjectMemberView = { username: string; displayName: string; projectAdmin: boolean };
type ProjectAccessView = {
  menus: DraftMenuView[];
  roles: Array<{ name: string; members: string[] }>;
  grants: DraftGrantView[];
};
type ManagedNodeView = {
  name: string;
  zone: string;
  pool: string;
  reportedAt: string | null;
  projectCount: number;
  gateway: string;
};
type SolutionChangeView = {
  added: { menus: DraftMenuView[]; grants: DraftGrantView[] };
  modified: Array<
    | { kind: "menu"; code: string; changes: { name?: { from: string; to: string }; parent_code?: { from: string | null; to: string | null } } }
    | { kind: "grant"; principal_type: string; principal_name: string; menu_code: string; added_actions: string[]; removed_actions: string[] }
  >;
  removed: { menus: DraftMenuView[]; grants: DraftGrantView[] };
};

export type PluginSummary = {
  id: string;
  title: string;
  description: string;
  available: boolean;
  enabled: boolean;
  status: "disabled" | "active" | "failed";
  failure: string;
  config: Record<string, string | number | boolean>;
  configSchema: Array<{ key: string; label: string; type: "string" | "number" | "boolean"; required?: boolean }>;
};

export function App(props: {
  session?: SessionUser | null;
  wechatAvailable?: boolean;
  registrationEnabled?: boolean;
  page?: "login" | "register";
  loginResult?: { reason?: string };
  title?: string;
  section?: Section;
  config?: SystemConfigView;
  plugins?: PluginSummary[];
  canCreateProject?: boolean;
  modelConfigured?: boolean;
}) {
  const provided = props.session !== undefined;
  const [session, setSession] = useState<SessionUser | null>(provided ? props.session ?? null : null);
  const [page, setPage] = useState<"login" | "register">(props.page ?? "login");
  const [reason, setReason] = useState(props.loginResult?.reason ?? "");
  const [title, setTitle] = useState(props.title ?? "企业应用平台");
  const [canCreateProject, setCanCreateProject] = useState(props.canCreateProject ?? props.session?.platformAdmin === true);
  const [modelConfigured, setModelConfigured] = useState(props.modelConfigured === true);
  const [languages, setLanguages] = useState<string[]>(["zh-CN", "en-US"]);

  useEffect(() => {
    if (props.title) {
      setTitle(props.title);
    }
  }, [props.title]);

  useEffect(() => {
    if (provided) {
      return;
    }
    void fetch("/api/session")
      .then(async (response) => {
        if (!response.ok) {
          setSession(null);
          return;
        }
        const body = (await response.json()) as {
          user: SessionUser;
          title?: string;
          canCreateProject?: boolean;
          modelConfigured?: boolean;
          languages?: string[];
        };
        setSession(body.user);
        setCanCreateProject(body.canCreateProject === true);
        setModelConfigured(body.modelConfigured === true);
        if (body.languages && body.languages.length > 0) {
          setLanguages(body.languages);
        }
        if (body.title) {
          setTitle(body.title);
        }
      })
      .catch(() => setSession(null));
  }, [provided]);

  const locale = session?.language === "en-US" ? enUS : zhCN;
  const screen = !session ? (
    page === "register" ? (
      <RegisterPage
        enabled={props.registrationEnabled !== false}
        onRegistered={(user, nextTitle, nextCanCreate, nextModelConfigured, nextLanguages) => {
          setSession(user);
          setCanCreateProject(nextCanCreate);
          setModelConfigured(nextModelConfigured);
          if (nextLanguages && nextLanguages.length > 0) {
            setLanguages(nextLanguages);
          }
          if (nextTitle) {
            setTitle(nextTitle);
          }
        }}
      />
    ) : (
      <LoginPage
        wechatAvailable={props.wechatAvailable === true}
        reason={reason}
        onRegister={() => setPage("register")}
        onReason={setReason}
        onLoggedIn={(user, nextTitle, nextCanCreate, nextModelConfigured, nextLanguages) => {
          setSession(user);
          setCanCreateProject(nextCanCreate);
          setModelConfigured(nextModelConfigured);
          if (nextLanguages && nextLanguages.length > 0) {
            setLanguages(nextLanguages);
          }
          if (nextTitle) {
            setTitle(nextTitle);
          }
        }}
      />
    )
  ) : (
    <Workbench
      session={session}
      title={title}
      onTitle={setTitle}
      onLanguage={(language) => setSession((current) => (current ? { ...current, language } : current))}
      onLogout={() => setSession(null)}
      languages={languages}
      initialSection={props.section ?? null}
      config={props.config}
      plugins={props.plugins}
      canCreateProject={canCreateProject}
      modelConfigured={modelConfigured}
    />
  );
  return <ConfigProvider locale={locale}>{screen}</ConfigProvider>;
}

function Workbench(props: {
  session: SessionUser;
  title: string;
  onTitle: (title: string) => void;
  onLanguage: (language: string) => void;
  onLogout: () => void;
  languages: string[];
  initialSection: Section | null;
  config?: SystemConfigView;
  plugins?: PluginSummary[];
  canCreateProject: boolean;
  modelConfigured: boolean;
}) {
  const copy = shellCopy(props.session.language);
  const narrow = useNarrowScreen();
  const [section, setSection] = useState<Section | null>(props.initialSection);
  const [creating, setCreating] = useState(false);
  const [project, setProject] = useState<{ name: string; code: string } | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const loadProjects = () => {
    void fetch("/api/projects")
      .then(async (response) => {
        if (!response.ok) {
          return [];
        }
        const body = (await response.json()) as { projects?: ProjectSummary[] };
        return body.projects ?? [];
      })
      .then((list) => {
        setProjects(list);
        setProjectsLoaded(true);
        // 恢复上次打开的项目：刷新页面后自动回到工作状态
        setProject((current) => {
          if (current) {
            return current;
          }
          const stored = localStorage.getItem("platform.project");
          const found = stored ? list.find((item) => item.code === stored) : undefined;
          return found ? { name: found.name, code: found.code } : current;
        });
      })
      .catch(() => setProjectsLoaded(true));
  };
  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const openProject = (item: { name: string; code: string }) => {
    setProject(item);
    localStorage.setItem("platform.project", item.code);
  };
  useEffect(() => {
    setSection(props.initialSection);
  }, [props.initialSection]);
  const choose = (key: string) => {
    setSection(key === "home" ? null : (key as Section));
    setDrawerOpen(false);
  };
  const menuItems = [
    { key: "home", icon: <HomeOutlined />, label: <span data-testid="platform/shell/nav-home">{copy.home}</span> },
    ...(props.session.platformAdmin
      ? [
          { key: "system", icon: <SettingOutlined />, label: <span data-testid="platform/shell/nav-system-config">{copy.system}</span> },
          { key: "plugin", icon: <AppstoreOutlined />, label: <span data-testid="platform/shell/nav-plugin-config">{copy.plugin}</span> },
          { key: "model", icon: <CloudOutlined />, label: <span data-testid="platform/shell/nav-model-config">{copy.model}</span> },
          { key: "users", icon: <TeamOutlined />, label: <span data-testid="platform/shell/nav-users">{copy.users}</span> },
          { key: "nodes", icon: <ClusterOutlined />, label: <span data-testid="platform/shell/nav-nodes">{copy.nodes}</span> },
        ]
      : []),
  ];
  const navigation = (
    <Menu
      mode="inline"
      theme="light"
      inlineCollapsed={!narrow && collapsed}
      selectedKeys={[section ?? "home"]}
      onClick={({ key }) => choose(key)}
      items={menuItems}
      style={{ borderInlineEnd: 0 }}
    />
  );
  const editingTitle =
    section === "system" ? copy.system : section === "plugin" ? copy.plugin : section === "model" ? copy.model : section === "users" ? copy.users : section === "nodes" ? copy.nodes : section === "account" ? copy.personal : project ? project.name : creating ? copy.projectName : copy.home;
  const languageChoices = props.languages.includes(props.session.language) ? props.languages : [props.session.language, ...props.languages];
  return (
    <Layout data-testid="platform/shell/root" className="platform-shell">
      {narrow ? (
        <Drawer placement="left" width={240} open={drawerOpen} onClose={() => setDrawerOpen(false)} title={props.title}>
          {navigation}
        </Drawer>
      ) : (
        <Sider data-testid="platform/shell/sider" collapsed={collapsed} collapsedWidth={64} width={240} theme="light" trigger={null} style={{ background: "#fff", borderRight: "1px solid #f0f0f0" }}>
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                height: 56,
                paddingInline: collapsed ? 0 : 16,
                justifyContent: collapsed ? "center" : "space-between",
                borderBottom: "1px solid #f0f0f0",
              }}
            >
              {collapsed ? null : (
                <Typography.Title level={5} data-testid="platform/shell/title" style={{ margin: 0 }} ellipsis>
                  {props.title}
                </Typography.Title>
              )}
              <Button
                type="text"
                data-testid="platform/shell/nav-collapse"
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setCollapsed((value) => !value)}
              />
            </div>
            {navigation}
          </div>
        </Sider>
      )}
      <Layout>
        <Header
          data-testid="platform/shell/header"
          style={{ height: "56px", lineHeight: "56px", background: "#fff", display: "flex", alignItems: "center", gap: 12, paddingInline: 16, borderBottom: "1px solid #f0f0f0" }}
        >
          {narrow ? (
            <Button type="text" data-testid="platform/shell/nav-open" icon={<MenuUnfoldOutlined />} onClick={() => setDrawerOpen(true)} />
          ) : null}
          <Typography.Text ellipsis>{editingTitle}</Typography.Text>
          <Dropdown
            trigger={["click"]}
            menu={{
              triggerSubMenuAction: "click",
              items: [
                {
                  key: "language",
                  label: copy.language,
                  children: languageChoices.map((code) => ({ key: `language:${code}`, label: languageName(code, props.session.language) })),
                },
                { key: "account", label: <span data-testid="platform/shell/account-settings">{copy.account}</span> },
                ...(props.session.platformAdmin ? [{ key: "system", label: <span data-testid="platform/shell/menu-system-config">{copy.system}</span> }] : []),
                { key: "logout", label: <span data-testid="platform/shell/logout">{copy.logout}</span> },
              ],
              onClick: ({ key }) => {
                if (key.startsWith("language:")) {
                  const language = key.slice("language:".length);
                  void fetch("/api/account", {
                    method: "PUT",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ displayName: props.session.displayName, language, password: "" }),
                  }).then((response) => {
                    if (response.ok) {
                      props.onLanguage(language);
                    }
                  });
                  return;
                }
                if (key === "account") {
                  setSection("account");
                }
                if (key === "system") {
                  setSection("system");
                }
                if (key === "logout") {
                  localStorage.removeItem("platform.project");
                  void fetch("/api/session/logout", { method: "POST" }).finally(() => props.onLogout());
                }
              },
            }}
          >
            <Button type="text" data-testid="platform/shell/account" style={{ marginLeft: "auto", height: 56, paddingInline: narrow ? 8 : undefined }}>
              <Space size={narrow ? 0 : 8}>
                <Avatar style={{ backgroundColor: "#1677ff" }}>{props.session.displayName.slice(0, 1)}</Avatar>
                {narrow ? null : <span data-testid="platform/shell/user">{props.session.displayName}</span>}
                {narrow ? null : <Tag data-testid="platform/shell/language">{props.session.language}</Tag>}
              </Space>
            </Button>
          </Dropdown>
        </Header>
        <Content data-testid="platform/shell/content" className="platform-shell-content" style={{ padding: narrow ? 8 : 16, background: "#f5f5f5" }}>
          <div style={{ background: "#fff", borderRadius: 8, minHeight: "100%", padding: narrow ? 12 : 24 }}>
          {section === "system" && props.session.platformAdmin ? (
            <SystemConfigPage config={props.config} onTitle={props.onTitle} />
          ) : null}
          {section === "plugin" && props.session.platformAdmin ? <PluginPage plugins={props.plugins} /> : null}
          {section === "model" && props.session.platformAdmin ? <ModelPage config={props.config} /> : null}
          {section === "users" && props.session.platformAdmin ? <UserManagementPage /> : null}
          {section === "nodes" && props.session.platformAdmin ? <NodeManagementPage /> : null}
          {section === "account" ? <AccountPage session={props.session} /> : null}
          {section === null && project ? (
            <ProjectPage project={project} modelConfigured={props.modelConfigured} modelNotice={copy.modelUnavailable} />
          ) : null}
          {section === null && !project && creating ? (
            <CreateProjectPage
              onCreated={(created) => {
                openProject(created);
                loadProjects();
              }}
            />
          ) : null}
          {section === null && !project && !creating && projects.length > 0 ? (
            <Card title={copy.myProjects} style={{ marginBottom: props.canCreateProject ? 16 : 0 }}>
              <List
                data-testid="platform/project/list"
                dataSource={projects}
                renderItem={(item) => (
                  <List.Item style={{ cursor: "pointer" }} onClick={() => openProject(item)}>
                    <List.Item.Meta
                      title={<span data-testid="platform/project/open">{item.name}</span>}
                      description={item.code}
                    />
                  </List.Item>
                )}
              />
            </Card>
          ) : null}
          {section === null && !project && !creating && props.canCreateProject ? (
            <Card>
              <Button type="primary" data-testid="platform/project/new" onClick={() => setCreating(true)}>
                {copy.createProject}
              </Button>
            </Card>
          ) : null}
          {section === null && !project && !creating && projects.length === 0 && !props.canCreateProject ? (
            <Empty description={copy.contactAdmin} />
          ) : null}
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}

function SystemConfigPage(props: { config?: SystemConfigView; onTitle: (title: string) => void }) {
  const [config, setConfig] = useState<SystemConfigView | undefined>(props.config);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (props.config) {
      setConfig(props.config);
      return;
    }
    void fetch("/api/system-config")
      .then(async (response) => {
        const body = (await response.json()) as SystemConfigView & { reason?: string };
        if (!response.ok) {
          setLoadError(body.reason ?? "系统配置读取失败");
          return;
        }
        setConfig(body);
        props.onTitle(body["platform.title"]);
      })
      .catch(() => setLoadError("系统配置读取失败"));
  }, [props.config]);
  if (!config) {
    return loadError ? <Alert type="error" showIcon message={loadError} /> : <Spin tip="正在读取系统配置" />;
  }
  const secretState = config.wechatSecretConfigured ? "已配置" : "未配置";
  return (
    <Card title="系统配置">
    <Form
      layout="vertical"
      initialValues={{
        title: config["platform.title"],
        languages: config["platform.languages"].join(","),
        registration: config["registration.enabled"],
        wechatAppId: config["wechat.appId"],
        wechatSecret: "",
        wechatRedirectUri: config["wechat.redirectUri"],
        prodAdminUrl: config["database.prodAdminUrl"],
        testAdminUrl: config["database.testAdminUrl"],
        registryAddress: config["registry.address"],
      }}
      onFinish={async (values: Record<string, string | boolean>) => {
        const response = await fetch("/api/system-config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            "platform.title": values.title,
            "platform.languages": String(values.languages)
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
            "registration.enabled": values.registration,
            "wechat.appId": values.wechatAppId,
            "wechat.appSecret": values.wechatSecret,
            "wechat.redirectUri": values.wechatRedirectUri,
            "database.prodAdminUrl": values.prodAdminUrl,
            "database.testAdminUrl": values.testAdminUrl,
            "registry.address": values.registryAddress,
          }),
        });
        if (!response.ok) {
          return;
        }
        const saved = (await response.json()) as SystemConfigView;
        setConfig(saved);
        props.onTitle(saved["platform.title"]);
      }}
    >
      <Form.Item name="title" label="标题">
        <Input data-testid="platform/system-config/title" />
      </Form.Item>
      <Form.Item name="languages" label="语言">
        <Input data-testid="platform/system-config/languages" />
      </Form.Item>
      <Form.Item name="registration" label="开放注册" valuePropName="checked">
        <Checkbox data-testid="platform/system-config/registration" />
      </Form.Item>
      <Form.Item name="wechatAppId" label="微信 AppId">
        <Input data-testid="platform/system-config/wechat-app-id" />
      </Form.Item>
      <Form.Item name="wechatSecret" label="微信 AppSecret">
        <Input.Password data-testid="platform/system-config/wechat-secret" />
      </Form.Item>
      <Form.Item label="微信密钥">
        <span data-testid="platform/system-config/wechat-secret-state">{secretState}</span>
      </Form.Item>
      <Form.Item name="wechatRedirectUri" label="微信回调地址">
        <Input data-testid="platform/system-config/wechat-redirect" />
      </Form.Item>
      <Form.Item name="prodAdminUrl" label="正式库地址">
        <Input data-testid="platform/system-config/prod-admin-url" />
      </Form.Item>
      <Form.Item name="testAdminUrl" label="测试库地址">
        <Input data-testid="platform/system-config/test-admin-url" />
      </Form.Item>
      <Form.Item name="registryAddress" label="镜像库地址">
        <Input data-testid="platform/system-config/registry" />
      </Form.Item>
      <Button htmlType="submit" type="primary" data-testid="platform/system-config/save">
        保存
      </Button>
    </Form>
    </Card>
  );
}

function PluginPage(props: { plugins?: PluginSummary[] }) {
  const [plugins, setPlugins] = useState<PluginSummary[] | undefined>(props.plugins);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (props.plugins) {
      setPlugins(props.plugins);
      return;
    }
    void fetch("/api/plugins")
      .then(async (response) => {
        const body = (await response.json()) as { plugins?: PluginSummary[]; reason?: string };
        if (!response.ok || !body.plugins) {
          setLoadError(body.reason ?? "插件读取失败");
          return;
        }
        setPlugins(body.plugins);
      })
      .catch(() => setLoadError("插件读取失败"));
  }, [props.plugins]);
  if (!plugins) {
    return loadError ? <Alert type="error" showIcon message={loadError} /> : <Spin tip="正在读取插件" />;
  }
  const replace = (plugin: PluginSummary) => setPlugins((current) => (current ?? []).map((item) => (item.id === plugin.id ? plugin : item)));
  return (
    <Card title="插件配置">
      {plugins.length === 0 ? (
        <Empty data-testid="platform/plugin-config/empty" description="暂无插件" />
      ) : (
        <List
          dataSource={plugins}
          renderItem={(plugin) => <PluginRow plugin={plugin} onUpdated={replace} />}
        />
      )}
    </Card>
  );
}

const pluginStatusText: Record<PluginSummary["status"], string> = {
  disabled: "已停用",
  active: "运行中",
  failed: "启动失败",
};

function PluginRow(props: { plugin: PluginSummary; onUpdated: (plugin: PluginSummary) => void }) {
  const plugin = props.plugin;
  const [switching, setSwitching] = useState(false);
  const [configError, setConfigError] = useState("");
  const [events, setEvents] = useState<Array<{ action: string; actor: string; result: string; detail: string; createdAt: string }> | null>(null);
  const statusTag = (
    <Tag
      data-testid={`platform/plugin-config/${plugin.id}/status`}
      color={plugin.status === "active" ? "green" : plugin.status === "failed" ? "red" : "default"}
    >
      {pluginStatusText[plugin.status]}
    </Tag>
  );
  const toggle = async (enabled: boolean) => {
    setSwitching(true);
    setConfigError("");
    try {
      const response = await fetch(`/api/plugins/${plugin.id}/state`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = (await response.json()) as { plugin?: PluginSummary; reason?: string };
      if (!response.ok || !body.plugin) {
        setConfigError(body.reason ?? "启停失败");
        return;
      }
      props.onUpdated(body.plugin);
    } catch {
      setConfigError("启停失败");
    } finally {
      setSwitching(false);
    }
  };
  const loadEvents = async () => {
    if (events) {
      setEvents(null);
      return;
    }
    try {
      const response = await fetch(`/api/plugins/${plugin.id}/events`);
      const body = (await response.json()) as { events?: Array<{ action: string; actor: string; result: string; detail: string; createdAt: string }>; reason?: string };
      setEvents(body.events ?? []);
    } catch {
      setEvents([]);
    }
  };
  return (
    <Card data-testid={`platform/plugin-config/row-${plugin.id}`} size="small" style={{ marginBottom: 12 }}>
      <Space style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
        <div>
          <Space size={8}>
            <strong>{plugin.title}</strong>
            {statusTag}
          </Space>
          <div>
            <Typography.Text type="secondary">{plugin.description}</Typography.Text>
          </div>
        </div>
        <Switch
          data-testid={`platform/plugin-config/${plugin.id}/switch`}
          checked={plugin.enabled}
          loading={switching}
          disabled={!plugin.available}
          onChange={(checked) => void toggle(checked)}
        />
      </Space>
      {plugin.status === "failed" && plugin.failure ? (
        <Alert
          data-testid={`platform/plugin-config/${plugin.id}/failure`}
          style={{ marginTop: 8 }}
          type="error"
          showIcon
          message={plugin.failure}
        />
      ) : null}
      {!plugin.available ? (
        <Alert style={{ marginTop: 8 }} type="warning" showIcon message="插件定义不存在，无法运行" />
      ) : null}
      {plugin.available && plugin.configSchema.length > 0 ? (
        <Form
          layout="vertical"
          style={{ marginTop: 12 }}
          initialValues={plugin.config}
          onFinish={async (values: Record<string, unknown>) => {
            setConfigError("");
            try {
              const response = await fetch(`/api/plugins/${plugin.id}/config`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ config: values }),
              });
              const body = (await response.json()) as { plugin?: PluginSummary; reason?: string };
              if (!response.ok || !body.plugin) {
                setConfigError(body.reason ?? "配置保存失败");
                return;
              }
              props.onUpdated(body.plugin);
            } catch {
              setConfigError("配置保存失败");
            }
          }}
        >
          {plugin.configSchema.map((field) => (
            <Form.Item key={field.key} name={field.key} label={field.label} rules={field.required ? [{ required: true, message: `请填写${field.label}` }] : undefined}>
              {field.type === "number" ? (
                <InputNumber data-testid={`platform/plugin-config/${plugin.id}/config-${field.key}`} style={{ width: "100%" }} />
              ) : field.type === "boolean" ? (
                <Checkbox data-testid={`platform/plugin-config/${plugin.id}/config-${field.key}`} />
              ) : (
                <Input data-testid={`platform/plugin-config/${plugin.id}/config-${field.key}`} />
              )}
            </Form.Item>
          ))}
          {configError ? <Alert type="error" showIcon message={configError} style={{ marginBottom: 8 }} /> : null}
          <Button htmlType="submit" data-testid={`platform/plugin-config/${plugin.id}/save`}>
            保存配置
          </Button>
        </Form>
      ) : configError ? (
        <Alert type="error" showIcon message={configError} style={{ marginTop: 8 }} />
      ) : null}
      <div style={{ marginTop: 12 }}>
        <Button size="small" data-testid={`platform/plugin-config/${plugin.id}/events-button`} onClick={() => void loadEvents()}>
          {events ? "收起启停记录" : "启停记录"}
        </Button>
        {events ? (
          <List
            size="small"
            style={{ marginTop: 8 }}
            dataSource={events}
            locale={{ emptyText: "暂无启停记录" }}
            renderItem={(event, index) => (
              <List.Item data-testid={`platform/plugin-config/${plugin.id}/event-${index}`}>
                <Space size={8}>
                  <Tag color={event.result === "ok" ? "green" : "red"}>{event.action}</Tag>
                  <span>{event.actor}</span>
                  <Typography.Text type="secondary">{new Date(event.createdAt).toLocaleString()}</Typography.Text>
                  {event.detail ? <Typography.Text type="secondary">{event.detail}</Typography.Text> : null}
                </Space>
              </List.Item>
            )}
          />
        ) : null}
      </div>
    </Card>
  );
}

function ModelPage(props: { config?: SystemConfigView }) {
  const [config, setConfig] = useState<SystemConfigView | undefined>(props.config);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (props.config) {
      setConfig(props.config);
      return;
    }
    void fetch("/api/system-config")
      .then(async (response) => {
        const body = (await response.json()) as SystemConfigView & { reason?: string };
        if (!response.ok) {
          setLoadError(body.reason ?? "模型配置读取失败");
          return;
        }
        setConfig(body);
      })
      .catch(() => setLoadError("模型配置读取失败"));
  }, [props.config]);
  if (!config) {
    return loadError ? <Alert type="error" showIcon message={loadError} /> : <Spin tip="正在读取模型配置" />;
  }
  const empty = !config["model.baseUrl"] && !config["model.name"] && !config.modelKeyConfigured;
  return (
    <Card title="模型配置">
    <Form
      layout="vertical"
      initialValues={{
        baseUrl: config["model.baseUrl"],
        name: config["model.name"],
        apiKey: "",
      }}
      onFinish={async (values: { baseUrl: string; name: string; apiKey: string }) => {
        const response = await fetch("/api/system-config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            "model.baseUrl": values.baseUrl,
            "model.name": values.name,
            "model.apiKey": values.apiKey,
          }),
        });
        if (!response.ok) {
          return;
        }
        setConfig((await response.json()) as SystemConfigView);
      }}
    >
      {empty ? <Alert data-testid="platform/model-config/empty" type="warning" showIcon message="会话和运维智能体不会调用模型" /> : null}
      <Form.Item name="baseUrl" label="模型地址">
        <Input data-testid="platform/model-config/base-url" />
      </Form.Item>
      <Form.Item name="name" label="模型名称">
        <Input data-testid="platform/model-config/name" />
      </Form.Item>
      <Form.Item name="apiKey" label="模型密钥">
        <Input.Password data-testid="platform/model-config/api-key" />
      </Form.Item>
      <Form.Item label="密钥状态">
        <span data-testid="platform/model-config/api-key-state">{config.modelKeyConfigured ? "已配置" : "未配置"}</span>
      </Form.Item>
      <Button htmlType="submit" type="primary" data-testid="platform/model-config/save">
        保存
      </Button>
    </Form>
    </Card>
  );
}

function AccountPage(props: { session: SessionUser }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  return (
    <Card title="个人配置">
    <Form
      form={form}
      layout="vertical"
      initialValues={{ displayName: props.session.displayName, password: "", language: props.session.language }}
      onFinish={async (values: { displayName: string; password?: string; language: string }) => {
        setSaving(true);
        setFeedback(null);
        try {
          const password = values.password?.trim() ?? "";
          const response = await fetch("/api/account", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              displayName: values.displayName.trim(),
              language: values.language.trim(),
              password,
            }),
          });
          const body = (await response.json().catch(() => ({}))) as { reason?: string };
          if (!response.ok) {
            setFeedback({ type: "error", message: body.reason ?? "保存失败" });
            return;
          }
          form.setFieldValue("password", "");
          setFeedback({ type: "success", message: password === "" ? "已保存" : "已保存，下次登录请使用新密码" });
        } catch (error) {
          setFeedback({ type: "error", message: error instanceof Error ? error.message : "保存失败" });
        } finally {
          setSaving(false);
        }
      }}
    >
      <Form.Item name="displayName" label="显示名" rules={[{ required: true, whitespace: true, message: "请输入显示名" }]}>
        <Input data-testid="platform/account/display-name" />
      </Form.Item>
      <Form.Item name="password" label="密码" extra="留空表示不修改密码">
        <Input.Password data-testid="platform/account/password" autoComplete="new-password" />
      </Form.Item>
      <Form.Item name="language" label="语言" rules={[{ required: true, whitespace: true, message: "请输入语言" }]}>
        <Input data-testid="platform/account/language" />
      </Form.Item>
      <Form.Item label="微信">
        <span data-testid="platform/account/wechat">{props.session.wechatBound ? "已绑定" : "未绑定"}</span>
      </Form.Item>
      {feedback ? (
        <Alert
          data-testid="platform/account/feedback"
          type={feedback.type}
          showIcon
          message={feedback.message}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Button htmlType="submit" type="primary" loading={saving} data-testid="platform/account/save">
        保存
      </Button>
    </Form>
    </Card>
  );
}

function UserManagementPage() {
  const [users, setUsers] = useState<ManagedUserView[]>([]);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [form] = Form.useForm();
  const load = () => {
    void fetch("/api/users")
      .then(async (response) => {
        const body = (await response.json()) as { users?: ManagedUserView[]; reason?: string };
        if (!response.ok) {
          setLoadError(body.reason ?? "用户列表读取失败");
          return;
        }
        setUsers(body.users ?? []);
      })
      .catch(() => setLoadError("用户列表读取失败"));
  };
  useEffect(load, []);
  return (
    <Card
      data-testid="platform/users/page"
      title="用户管理"
      extra={<Typography.Text type="secondary">共 {users.length} 名用户</Typography.Text>}
    >
      {loadError ? <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} /> : null}
      {feedback ? (
        <Alert data-testid="platform/users/feedback" type={feedback.type} showIcon message={feedback.message} style={{ marginBottom: 16 }} />
      ) : null}
      <Form
        form={form}
        layout="inline"
        style={{ marginBottom: 16 }}
        initialValues={{ username: "", displayName: "", password: "" }}
        onFinish={async (values: { username: string; displayName: string; password: string }) => {
          setFeedback(null);
          const response = await fetch("/api/users", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(values),
          });
          const body = (await response.json().catch(() => ({}))) as { reason?: string };
          if (!response.ok) {
            setFeedback({ type: "error", message: body.reason ?? "创建失败" });
            return;
          }
          form.resetFields();
          setFeedback({ type: "success", message: `${values.username} 已创建` });
          load();
        }}
      >
        <Form.Item name="username" label="用户名" rules={[{ required: true, whitespace: true, message: "请输入用户名" }]}>
          <Input data-testid="platform/users/username" />
        </Form.Item>
        <Form.Item name="displayName" label="显示名" rules={[{ required: true, whitespace: true, message: "请输入显示名" }]}>
          <Input data-testid="platform/users/display-name" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
          <Input.Password data-testid="platform/users/password" autoComplete="new-password" />
        </Form.Item>
        <Button htmlType="submit" type="primary" data-testid="platform/users/create">创建用户</Button>
      </Form>
      <List
        dataSource={users}
        locale={{ emptyText: "暂无用户" }}
        renderItem={(user) => (
          <List.Item
            data-testid={`platform/users/row-${user.username}`}
            actions={[
              <Button
                key="toggle"
                size="small"
                loading={busy === user.username}
                data-testid={`platform/users/toggle-${user.username}`}
                onClick={async () => {
                  setBusy(user.username);
                  setFeedback(null);
                  const action = user.disabled ? "enable" : "disable";
                  const response = await fetch(`/api/users/${encodeURIComponent(user.username)}/${action}`, { method: "POST" });
                  setBusy("");
                  if (!response.ok) {
                    const body = (await response.json().catch(() => ({}))) as { reason?: string };
                    setFeedback({ type: "error", message: body.reason ?? "操作失败" });
                    return;
                  }
                  setFeedback({ type: "success", message: `${user.username} 已${user.disabled ? "启用" : "停用"}` });
                  load();
                }}
              >
                {user.disabled ? "启用" : "停用"}
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={<span>{user.displayName}（{user.username}）</span>}
              description={
                <Space wrap size={8}>
                  <Tag data-testid={`platform/users/state-${user.username}`}>{user.disabled ? "已停用" : "正常"}</Tag>
                  {user.platformAdmin ? <Tag color="blue">平台管理员</Tag> : null}
                  <span>{user.language}</span>
                  <span>微信{user.wechatBound ? "已绑定" : "未绑定"}</span>
                </Space>
              }
            />
          </List.Item>
        )}
      />
    </Card>
  );
}

function AccessManagementPage(props: { project: { name: string; code: string }; onBack: () => void }) {
  const [members, setMembers] = useState<ProjectMemberView[]>([]);
  const [access, setAccess] = useState<ProjectAccessView | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [memberForm] = Form.useForm();
  const [roleForm] = Form.useForm();
  const [grantForm] = Form.useForm();
  const load = () => {
    setError("");
    void Promise.all([
      fetch(`/api/projects/${props.project.code}/members`),
      fetch(`/api/projects/${props.project.code}/grants`),
    ])
      .then(async ([memberResponse, grantResponse]) => {
        const memberBody = (await memberResponse.json()) as { members?: ProjectMemberView[]; reason?: string };
        const grantBody = (await grantResponse.json()) as { access?: ProjectAccessView; reason?: string };
        if (!memberResponse.ok || !grantResponse.ok) {
          setError(memberBody.reason ?? grantBody.reason ?? "授权数据读取失败");
          return;
        }
        setMembers(memberBody.members ?? []);
        setAccess(grantBody.access ?? null);
      })
      .catch(() => setError("授权数据读取失败"));
  };
  useEffect(load, [props.project.code]);
  const mutate = async (url: string, method: "POST" | "DELETE", body: unknown, successMessage: string) => {
    setFeedback(null);
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { reason?: string };
    if (!response.ok) {
      setFeedback({ type: "error", message: payload.reason ?? `${successMessage}失败` });
      return;
    }
    setFeedback({ type: "success", message: successMessage });
    load();
  };
  const grantKey = (grant: DraftGrantView) =>
    `${grant.principal_type}-${grant.principal_name}-${grant.menu_code}-${grant.action}`;
  return (
    <Card
      data-testid="platform/access/page"
      title="授权管理"
      extra={<Button data-testid="platform/access/back" onClick={props.onBack}>返回草稿</Button>}
    >
      <Typography.Paragraph>项目 {props.project.name} 的成员、角色与草稿授权。发布后菜单按已发布授权生效。</Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
      {feedback ? (
        <Alert data-testid="platform/access/feedback" type={feedback.type} showIcon message={feedback.message} style={{ marginBottom: 16 }} />
      ) : null}
      <Typography.Title level={5}>项目成员</Typography.Title>
      <Form
        form={memberForm}
        layout="inline"
        style={{ marginBottom: 8 }}
        initialValues={{ username: "", projectAdmin: false }}
        onFinish={async (values: { username: string; projectAdmin: boolean }) => {
          await mutate(
            `/api/projects/${props.project.code}/members`,
            "POST",
            { username: values.username, projectAdmin: values.projectAdmin },
            `${values.username} 已加入项目`,
          );
          memberForm.resetFields();
        }}
      >
        <Form.Item name="username" label="用户名" rules={[{ required: true, whitespace: true, message: "请输入用户名" }]}>
          <Input data-testid="platform/access/member-username" />
        </Form.Item>
        <Form.Item name="projectAdmin" label="项目管理员" valuePropName="checked">
          <Checkbox data-testid="platform/access/member-admin" />
        </Form.Item>
        <Button htmlType="submit" type="primary" data-testid="platform/access/member-add">添加成员</Button>
      </Form>
      {members.map((member) => (
        <Typography.Paragraph key={member.username} data-testid={`platform/access/member-row-${member.username}`}>
          {member.displayName}（{member.username}）{member.projectAdmin ? " · 项目管理员" : ""}
          <Button
            size="small"
            danger
            style={{ marginLeft: 8 }}
            data-testid={`platform/access/member-remove-${member.username}`}
            onClick={() =>
              void mutate(
                `/api/projects/${props.project.code}/members/${encodeURIComponent(member.username)}`,
                "DELETE",
                undefined,
                `${member.username} 已移出项目`,
              )
            }
          >
            移除
          </Button>
        </Typography.Paragraph>
      ))}
      <Typography.Title level={5}>角色</Typography.Title>
      <Form
        form={roleForm}
        layout="inline"
        style={{ marginBottom: 8 }}
        initialValues={{ role: "", username: "" }}
        onFinish={async (values: { role: string; username: string }) => {
          await mutate(
            `/api/projects/${props.project.code}/roles/assign`,
            "POST",
            values,
            `${values.username} 已加入角色 ${values.role}`,
          );
          roleForm.resetFields();
        }}
      >
        <Form.Item name="role" label="角色" rules={[{ required: true, whitespace: true, message: "请输入角色" }]}>
          <Input data-testid="platform/access/role-name" />
        </Form.Item>
        <Form.Item name="username" label="用户名" rules={[{ required: true, whitespace: true, message: "请输入用户名" }]}>
          <Input data-testid="platform/access/role-user" />
        </Form.Item>
        <Button htmlType="submit" type="primary" data-testid="platform/access/role-assign">分配角色</Button>
      </Form>
      {(access?.roles ?? []).map((role) => (
        <Typography.Paragraph key={role.name} data-testid={`platform/access/role-row-${role.name}`}>
          {role.name}：{role.members.length > 0 ? role.members.join("、") : "暂无成员"}
          {role.members.map((member) => (
            <Button
              key={member}
              size="small"
              danger
              style={{ marginLeft: 8 }}
              data-testid={`platform/access/role-unassign-${role.name}-${member}`}
              onClick={() =>
                void mutate(
                  `/api/projects/${props.project.code}/roles/assign`,
                  "DELETE",
                  { role: role.name, username: member },
                  `${member} 已退出角色 ${role.name}`,
                )
              }
            >
              取消 {member}
            </Button>
          ))}
        </Typography.Paragraph>
      ))}
      <Typography.Title level={5}>草稿授权</Typography.Title>
      <Form
        form={grantForm}
        layout="inline"
        style={{ marginBottom: 8 }}
        initialValues={{ principalType: "user", principalName: "", menu: "", actions: "访问" }}
        onFinish={async (values: { principalType: string; principalName: string; menu: string; actions: string }) => {
          const actions = String(values.actions)
            .split(/[,，]/)
            .map((item) => item.trim())
            .filter(Boolean);
          await mutate(
            `/api/projects/${props.project.code}/grants`,
            "POST",
            {
              principalType: values.principalType,
              principalName: values.principalName,
              menu: values.menu,
              actions,
            },
            "授权已添加",
          );
          grantForm.resetFields();
        }}
      >
        <Form.Item name="principalType" label="主体类型" rules={[{ required: true, message: "请输入 user 或 role" }]}>
          <Input data-testid="platform/access/grant-type" />
        </Form.Item>
        <Form.Item name="principalName" label="主体" rules={[{ required: true, whitespace: true, message: "请输入主体" }]}>
          <Input data-testid="platform/access/grant-name" />
        </Form.Item>
        <Form.Item name="menu" label="菜单编码" rules={[{ required: true, whitespace: true, message: "请输入菜单编码" }]}>
          <Input data-testid="platform/access/grant-menu" />
        </Form.Item>
        <Form.Item name="actions" label="动作（逗号分隔）" rules={[{ required: true, message: "请输入动作" }]}>
          <Input data-testid="platform/access/grant-actions" />
        </Form.Item>
        <Button htmlType="submit" type="primary" data-testid="platform/access/grant-add">添加授权</Button>
      </Form>
      {(access?.grants ?? []).map((grant) => (
        <Typography.Paragraph key={grantKey(grant)} data-testid={`platform/access/grant-row-${grantKey(grant)}`}>
          {grantLabel(grant)}
          <Button
            size="small"
            danger
            style={{ marginLeft: 8 }}
            data-testid={`platform/access/grant-remove-${grantKey(grant)}`}
            onClick={() =>
              void mutate(
                `/api/projects/${props.project.code}/grants`,
                "DELETE",
                {
                  principalType: grant.principal_type,
                  principalName: grant.principal_name,
                  menu: grant.menu_code,
                  action: grant.action,
                },
                "授权已撤销",
              )
            }
          >
            撤销
          </Button>
        </Typography.Paragraph>
      ))}
    </Card>
  );
}

function NodeManagementPage() {
  const [nodes, setNodes] = useState<ManagedNodeView[]>([]);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [form] = Form.useForm();
  const load = () => {
    void fetch("/api/nodes")
      .then(async (response) => {
        const body = (await response.json()) as { nodes?: ManagedNodeView[]; reason?: string };
        if (!response.ok) {
          setLoadError(body.reason ?? "节点列表读取失败");
          return;
        }
        setNodes(body.nodes ?? []);
      })
      .catch(() => setLoadError("节点列表读取失败"));
  };
  useEffect(load, []);
  const mutate = async (url: string, method: "POST" | "DELETE" | "PUT", body: unknown, success: string) => {
    setFeedback(null);
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { reason?: string; token?: string; name?: string };
    if (!response.ok) {
      setFeedback({ type: "error", message: payload.reason ?? `${success}失败` });
      return null;
    }
    setFeedback({ type: "success", message: success });
    load();
    return payload;
  };
  const poolLabel = (pool: string) => (pool === "prod" ? "正式池" : pool === "test" ? "测试池" : "未入池");
  return (
    <Card
      data-testid="platform/nodes/page"
      title="节点管理"
      extra={<Typography.Text type="secondary">共 {nodes.length} 个节点</Typography.Text>}
    >
      <Typography.Paragraph>
        登记节点后使用安装脚本接入；接入的节点不会自动入池，需按区域加入正式池或测试池。令牌与脚本只在生成时显示一次。
      </Typography.Paragraph>
      {loadError ? <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} /> : null}
      {feedback ? (
        <Alert data-testid="platform/nodes/feedback" type={feedback.type} showIcon message={feedback.message} style={{ marginBottom: 16 }} />
      ) : null}
      {newToken ? (
        <Alert
          data-testid="platform/nodes/token"
          type="info"
          showIcon
          message={`${newToken.name} 的注册令牌（仅显示一次）`}
          description={<Typography.Text code copyable>{newToken.token}</Typography.Text>}
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <Form
        form={form}
        layout="inline"
        style={{ marginBottom: 16 }}
        initialValues={{ name: "", zone: "测试区" }}
        onFinish={async (values: { name: string; zone: string }) => {
          setFeedback(null);
          const response = await fetch("/api/nodes", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(values),
          });
          const body = (await response.json().catch(() => ({}))) as { node?: { name: string }; token?: string; reason?: string };
          if (!response.ok || !body.token) {
            setFeedback({ type: "error", message: body.reason ?? "节点登记失败" });
            return;
          }
          setNewToken({ name: values.name, token: body.token });
          setFeedback({ type: "success", message: `${values.name} 已登记` });
          form.resetFields();
          load();
        }}
      >
        <Form.Item name="name" label="节点名称" rules={[{ required: true, whitespace: true, pattern: /^[a-z0-9][a-z0-9-]{0,62}$/, message: "小写字母/数字/连字符，最长 63 位" }]}>
          <Input data-testid="platform/nodes/name" />
        </Form.Item>
        <Form.Item name="zone" label="区域" rules={[{ required: true, message: "请选择区域" }]}>
          <Select
            data-testid="platform/nodes/zone"
            style={{ width: 140 }}
            options={["系统运行区", "测试区", "正式区"].map((value) => ({ value, label: value }))}
          />
        </Form.Item>
        <Button htmlType="submit" type="primary" data-testid="platform/nodes/create">登记节点</Button>
      </Form>
      {nodes.map((node) => (
        <List.Item key={node.name} data-testid={`platform/nodes/row-${node.name}`} style={{ borderBottom: "1px solid #f0f0f0", paddingBlock: 12 }}>
          <List.Item.Meta
            title={
              <Space wrap size={8}>
                <strong>{node.name}</strong>
                <Tag data-testid={`platform/nodes/zone-${node.name}`}>{node.zone}</Tag>
                <Tag color={node.pool === "prod" ? "blue" : node.pool === "test" ? "green" : undefined} data-testid={`platform/nodes/pool-${node.name}`}>
                  {poolLabel(node.pool)}
                </Tag>
              </Space>
            }
            description={
              <span data-testid={`platform/nodes/health-${node.name}`}>
                {node.reportedAt
                  ? `最近心跳 ${new Date(node.reportedAt).toLocaleString()} · ${node.projectCount} 个项目${node.gateway ? ` · ${node.gateway}` : ""}`
                  : "尚未上报心跳"}
              </span>
            }
          />
          <Space wrap size={8}>
            <a data-testid={`platform/nodes/install-${node.name}`} href={`/api/nodes/${encodeURIComponent(node.name)}/install`} target="_blank" rel="noreferrer">
              安装脚本
            </a>
            <Button
              size="small"
              loading={busy === node.name}
              data-testid={`platform/nodes/rotate-${node.name}`}
              onClick={async () => {
                setBusy(node.name);
                const result = await mutate(`/api/nodes/${encodeURIComponent(node.name)}/rotate-token`, "POST", undefined, `${node.name} 令牌已轮换`);
                setBusy("");
                if (result?.token) {
                  setNewToken({ name: node.name, token: result.token });
                }
              }}
            >
              轮换令牌
            </Button>
            {node.zone === "正式区" ? (
              <Button
                size="small"
                data-testid={`platform/nodes/pool-prod-${node.name}`}
                onClick={() =>
                  void mutate(`/api/nodes/${encodeURIComponent(node.name)}/pool`, "PUT", { pool: node.pool === "prod" ? "" : "prod" }, node.pool === "prod" ? `${node.name} 已移出正式池` : `${node.name} 已加入正式池`)
                }
              >
                {node.pool === "prod" ? "移出正式池" : "加入正式池"}
              </Button>
            ) : null}
            {node.zone === "测试区" ? (
              <Button
                size="small"
                data-testid={`platform/nodes/pool-test-${node.name}`}
                onClick={() =>
                  void mutate(`/api/nodes/${encodeURIComponent(node.name)}/pool`, "PUT", { pool: node.pool === "test" ? "" : "test" }, node.pool === "test" ? `${node.name} 已移出测试池` : `${node.name} 已加入测试池`)
                }
              >
                {node.pool === "test" ? "移出测试池" : "加入测试池"}
              </Button>
            ) : null}
            <Button
              size="small"
              danger
              data-testid={`platform/nodes/remove-${node.name}`}
              onClick={() =>
                void mutate(`/api/nodes/${encodeURIComponent(node.name)}`, "DELETE", undefined, `${node.name} 已删除`)
              }
            >
              删除
            </Button>
          </Space>
        </List.Item>
      ))}
    </Card>
  );
}

function LoginPage(props: {
  wechatAvailable: boolean;
  reason: string;
  onRegister: () => void;
  onReason: (reason: string) => void;
  onLoggedIn: (user: SessionUser, title: string | undefined, canCreateProject: boolean, modelConfigured: boolean, languages?: string[]) => void;
}) {
  return (
    <main className="platform-auth">
      <Card data-testid="platform/login/card" title="登录" style={{ width: 420 }}>
      <Form
        layout="vertical"
        onFinish={async (values: { username: string; password: string }) => {
          try {
            const response = await fetch("/api/session/login", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(values),
            });
            const body = (await response.json()) as {
              reason?: string;
              user?: SessionUser;
              title?: string;
              canCreateProject?: boolean;
              modelConfigured?: boolean;
              languages?: string[];
            };
            if (!response.ok || !body.user) {
              props.onReason(body.reason ?? "用户名或密码错误");
              return;
            }
            props.onLoggedIn(body.user, body.title, body.canCreateProject === true, body.modelConfigured === true, body.languages);
          } catch (error) {
            props.onReason(error instanceof Error ? error.message : "登录失败");
          }
        }}
      >
        <Form.Item name="username">
          <Input data-testid="platform/login/username" placeholder="用户名" />
        </Form.Item>
        <Form.Item name="password">
          <Input.Password data-testid="platform/login/password" placeholder="密码" />
        </Form.Item>
        {props.reason ? <Alert type="error" showIcon message={props.reason} style={{ marginBottom: 16 }} /> : null}
        <Space>
          <Button data-testid="platform/login/submit" htmlType="submit" type="primary">
            登录
          </Button>
          <Button data-testid="platform/login/register" htmlType="button" onClick={props.onRegister}>
            注册
          </Button>
        </Space>
        {props.wechatAvailable ? (
          <div style={{ marginTop: 16 }}>
            <a data-testid="platform/login/wechat-qr" href="/api/session/wechat/start">
              微信扫码登录
            </a>
          </div>
        ) : (
          <Alert data-testid="platform/login/wechat-unavailable" type="info" showIcon message="微信登录未配置" style={{ marginTop: 16 }} />
        )}
      </Form>
      </Card>
    </main>
  );
}

function RegisterPage(props: {
  enabled: boolean;
  onRegistered: (user: SessionUser, title: string | undefined, canCreateProject: boolean, modelConfigured: boolean, languages?: string[]) => void;
}) {
  const [reason, setReason] = useState("");
  if (!props.enabled) {
    return (
      <main className="platform-auth">
        <Card style={{ width: 420 }}>
          <Alert type="info" showIcon message="请联系管理员" />
        </Card>
      </main>
    );
  }
  return (
    <main className="platform-auth">
      <Card data-testid="platform/register/card" title="注册" style={{ width: 420 }}>
      <Form
        layout="vertical"
        onFinish={async (values: { username: string; displayName: string; password: string }) => {
          try {
            const response = await fetch("/api/account/register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(values),
            });
            const body = (await response.json()) as { reason?: string; user?: SessionUser };
            if (!response.ok || !body.user) {
              setReason(body.reason ?? "注册失败");
              return;
            }
            const bootstrap = await fetch("/api/session");
            const context = bootstrap.ok
              ? ((await bootstrap.json()) as {
                  title?: string;
                  canCreateProject?: boolean;
                  modelConfigured?: boolean;
                  languages?: string[];
                })
              : null;
            props.onRegistered(
              body.user,
              context?.title,
              context?.canCreateProject === true,
              context?.modelConfigured === true,
              context?.languages,
            );
          } catch (error) {
            setReason(error instanceof Error ? error.message : "注册失败");
          }
        }}
      >
        <Form.Item name="username">
          <Input data-testid="platform/register/username" placeholder="用户名" />
        </Form.Item>
        <Form.Item name="displayName">
          <Input data-testid="platform/register/display-name" placeholder="显示名" />
        </Form.Item>
        <Form.Item name="password">
          <Input.Password data-testid="platform/register/password" placeholder="密码" />
        </Form.Item>
        {reason ? <Alert type="error" showIcon message={reason} style={{ marginBottom: 16 }} /> : null}
        <Button data-testid="platform/register/submit" htmlType="submit" type="primary">
          注册
        </Button>
      </Form>
      </Card>
    </main>
  );
}

function CreateProjectPage(props: { onCreated: (project: { name: string; code: string }) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Card title="创建项目">
    <Form
      data-testid="platform/project/form"
      layout="vertical"
      onFinish={async (values: { name: string; code?: string }) => {
        const response = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: values.name, code: values.code || undefined }),
        });
        const body = (await response.json()) as { reason?: string; project?: { name: string; code: string } };
        if (!response.ok || !body.project) {
          setReason(body.reason ?? "项目创建失败");
          return;
        }
        props.onCreated(body.project);
      }}
    >
      <Form.Item name="name" label="项目名称">
        <Input data-testid="platform/project/name" />
      </Form.Item>
      <Form.Item
        name="code"
        label="项目编码"
        rules={[{ pattern: /^[a-z][a-z0-9-]{0,62}$/, message: "以小写字母开头，仅含小写字母、数字与连字符，最长 63 位" }]}
        extra={<span data-testid="platform/project/code-hint">{"留空则根据项目名称自动生成；格式 ^[a-z][a-z0-9-]{0,62}$"}</span>}
      >
        <Input data-testid="platform/project/code" placeholder="例如 qing-jia-shen-pi" />
      </Form.Item>
      {reason ? <Alert type="error" showIcon message={reason} style={{ marginBottom: 16 }} /> : null}
      <Button htmlType="submit" type="primary" data-testid="platform/project/save">
        保存
      </Button>
    </Form>
    </Card>
  );
}

type TestCaseStepView = {
  index: number;
  action: string;
  target: string;
  value?: string | number | boolean;
  expected: string;
  dependsOn?: string;
};

type TestCaseView = {
  origin: string;
  method: string;
  code: string;
  name: string;
  steps?: TestCaseStepView[];
};

type TestRunView = {
  id: string;
  imageDigest: string;
  status: string;
  failure: string;
  replayedFrom: string | null;
  replayedFromDigest: string | null;
  startedAt: string;
  finishedAt: string | null;
  failedCases: string[];
};

type TestStepView = {
  caseCode: string;
  caseName: string;
  stepIndex: number;
  method: string;
  startedAt: string;
  expected: string;
  actual: string;
  passed: boolean;
  reason: string;
};

type TestsView = {
  candidateDigest: string | null;
  cases: TestCaseView[];
  runs: TestRunView[];
};

type TestJobView = {
  id: string;
  nodeName: string;
  status: string;
  attempt: number;
  failure: string;
  log: string;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
};

const methodLabel = (method: string) => (method === "black-box" ? "黑盒" : "白盒");
const shortDigest = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 12);
const formatTime = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });

type UserCaseStepForm = { action: string; target: string; value: string; expected: string };

function UserCasesCard(props: { projectCode: string; canEdit: boolean }) {
  const [cases, setCases] = useState<TestCaseView[]>([]);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState("white-box");
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<UserCaseStepForm[]>([{ action: "call", target: "", value: "", expected: "" }]);
  const load = () => {
    void fetch(`/api/projects/${encodeURIComponent(props.projectCode)}/tests/cases`)
      .then(async (response) => {
        const body = (await response.json()) as { cases?: TestCaseView[]; reason?: string };
        if (!response.ok) {
          setLoadError(body.reason ?? "案例读取失败");
          return;
        }
        setCases(body.cases ?? []);
      })
      .catch(() => setLoadError("案例读取失败"));
  };
  useEffect(load, [props.projectCode]);
  const updateStep = (index: number, patch: Partial<UserCaseStepForm>) => {
    setSteps((current) => current.map((step, position) => (position === index ? { ...step, ...patch } : step)));
  };
  const submit = async () => {
    setFeedback(null);
    setBusy(true);
    const body = {
      method,
      name,
      steps: steps.map((step) => ({
        action: step.action.trim(),
        target: step.target.trim(),
        expected: step.expected.trim(),
        ...(step.value !== "" ? { value: step.value } : {}),
      })),
    };
    const response = await fetch(`/api/projects/${encodeURIComponent(props.projectCode)}/tests/cases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { reason?: string };
    setBusy(false);
    if (!response.ok) {
      setFeedback({ type: "error", message: payload.reason ?? "案例新增失败" });
      return;
    }
    setFeedback({ type: "success", message: `案例「${name}」已新增` });
    setName("");
    setSteps([{ action: "call", target: "", value: "", expected: "" }]);
    load();
  };
  const remove = (code: string) => {
    setFeedback(null);
    void fetch(`/api/projects/${encodeURIComponent(props.projectCode)}/tests/cases/${encodeURIComponent(code)}`, { method: "DELETE" })
      .then(async (response) => {
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { reason?: string };
          setFeedback({ type: "error", message: payload.reason ?? "案例删除失败" });
          return;
        }
        setFeedback({ type: "success", message: "案例已删除" });
        load();
      })
      .catch(() => setFeedback({ type: "error", message: "案例删除失败" }));
  };
  return (
    <Card data-testid="platform/user-cases/page" title="用户测试案例" style={{ marginBottom: 16 }}>
      <Typography.Paragraph type="secondary">
        手工追加的案例按方法与步骤稳定编码，方案确认后仍保留。黑盒步骤需要执行器，当前环境将记为失败。
      </Typography.Paragraph>
      {loadError ? <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} /> : null}
      {feedback ? (
        <Alert data-testid="platform/user-cases/feedback" type={feedback.type} showIcon message={feedback.message} style={{ marginBottom: 16 }} />
      ) : null}
      <List
        dataSource={cases}
        locale={{ emptyText: "尚无用户案例" }}
        style={{ marginBottom: 16 }}
        renderItem={(item) => (
          <List.Item
            data-testid={`platform/user-cases/row-${item.code}`}
            actions={props.canEdit ? [<Button key="remove" size="small" danger data-testid={`platform/user-cases/remove-${item.code}`} onClick={() => remove(item.code)}>删除</Button>] : undefined}
          >
            <List.Item.Meta
              title={<span>{item.name} <Tag data-testid={`platform/user-cases/method-${item.code}`}>{methodLabel(item.method)}</Tag></span>}
              description={`${item.steps?.length ?? 0} 个步骤 · ${item.code}`}
            />
          </List.Item>
        )}
      />
      {props.canEdit ? (
        <div data-testid="platform/user-cases/form">
          <Space wrap style={{ marginBottom: 12 }}>
            <Select
              data-testid="platform/user-cases/method"
              value={method}
              onChange={setMethod}
              style={{ width: 120 }}
              options={[{ value: "white-box", label: "白盒" }, { value: "black-box", label: "黑盒" }]}
            />
            <Input data-testid="platform/user-cases/name" value={name} onChange={(event) => setName(event.target.value)} placeholder="案例名称" style={{ width: 220 }} />
          </Space>
          {steps.map((step, index) => (
            <Space wrap key={index} style={{ display: "flex", marginBottom: 8 }} data-testid={`platform/user-cases/step-${index}`}>
              <Input data-testid={`platform/user-cases/step-action-${index}`} value={step.action} onChange={(event) => updateStep(index, { action: event.target.value })} placeholder="action" style={{ width: 96 }} />
              <Input data-testid={`platform/user-cases/step-target-${index}`} value={step.target} onChange={(event) => updateStep(index, { target: event.target.value })} placeholder="target，例如 qing-jia-shen-pi/请假单.create" style={{ width: 300 }} />
              <Input data-testid={`platform/user-cases/step-value-${index}`} value={step.value} onChange={(event) => updateStep(index, { value: event.target.value })} placeholder="value（可选）" style={{ width: 120 }} />
              <Input data-testid={`platform/user-cases/step-expected-${index}`} value={step.expected} onChange={(event) => updateStep(index, { expected: event.target.value })} placeholder="expected" style={{ width: 160 }} />
              <Button size="small" data-testid={`platform/user-cases/step-remove-${index}`} disabled={steps.length === 1} onClick={() => setSteps((current) => current.filter((_, position) => position !== index))}>移除步骤</Button>
            </Space>
          ))}
          <Space wrap>
            <Button size="small" data-testid="platform/user-cases/step-add" onClick={() => setSteps((current) => [...current, { action: "call", target: "", value: "", expected: "" }])}>添加步骤</Button>
            <Button type="primary" data-testid="platform/user-cases/add" loading={busy} onClick={() => void submit()}>新增案例</Button>
          </Space>
        </div>
      ) : null}
    </Card>
  );
}

function TestResultsCard(props: { projectCode: string }) {
  const [tests, setTests] = useState<TestsView | null>(null);
  const [steps, setSteps] = useState<TestStepView[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<TestJobView[] | null>(null);
  const [jobsRunId, setJobsRunId] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadSteps = async (runId: string) => {
    try {
      const response = await fetch(`/api/projects/${props.projectCode}/tests/runs/${runId}`);
      const body = (await response.json()) as { steps?: TestStepView[] };
      setSteps(response.ok && Array.isArray(body.steps) ? body.steps : []);
    } catch {
      setSteps([]);
    }
  };

  const loadTests = async (): Promise<TestsView | null> => {
    try {
      const response = await fetch(`/api/projects/${props.projectCode}/tests`);
      const body = (await response.json()) as Partial<TestsView> & { reason?: string };
      if (!response.ok) {
        setReason(body.reason ?? "测试结果读取失败");
        return null;
      }
      setReason("");
      const view: TestsView = {
        candidateDigest: body.candidateDigest ?? null,
        cases: Array.isArray(body.cases) ? body.cases : [],
        runs: Array.isArray(body.runs) ? body.runs : [],
      };
      setTests(view);
      if (view.runs[0]) {
        await loadSteps(view.runs[0].id);
      } else {
        setSteps([]);
      }
      return view;
    } catch (error) {
      setReason(error instanceof Error ? error.message : "测试结果读取失败");
      return null;
    }
  };

  /** 测试节点异步执行：运行中每 3 秒刷新一次，结束后停止。 */
  const reloadUntilSettled = async () => {
    for (let attempt = 0; attempt < 200 && mounted.current; attempt += 1) {
      const view = await loadTests();
      if (!view || view.runs[0]?.status !== "running") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  };

  const callAndReload = async (url: string) => {
    setBusy(true);
    try {
      const response = await fetch(url, { method: "POST" });
      const body = (await response.json()) as { reason?: string };
      if (!response.ok) {
        setReason(body.reason ?? "操作失败");
      } else {
        setReason("");
      }
      await reloadUntilSettled();
    } catch (error) {
      setReason(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  /** 展开/收起一次运行的节点任务日志；再点同一次运行则收起。 */
  const toggleJobs = async (runId: string) => {
    if (jobsRunId === runId) {
      setJobsRunId("");
      setJobs(null);
      return;
    }
    try {
      const response = await fetch(`/api/projects/${props.projectCode}/tests/runs/${runId}/jobs`);
      const body = (await response.json()) as { jobs?: TestJobView[]; reason?: string };
      if (!response.ok) {
        setReason(body.reason ?? "任务日志读取失败");
        return;
      }
      setJobs(Array.isArray(body.jobs) ? body.jobs : []);
      setJobsRunId(runId);
    } catch {
      setReason("任务日志读取失败");
    }
  };

  useEffect(() => {
    void loadTests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectCode]);

  const latest = tests?.runs[0];
  const latestSteps = latest ? steps : [];
  const casesByCode = new Map((tests?.cases ?? []).map((testCase) => [testCase.code, testCase]));
  const perCase = new Map<string, TestStepView[]>();
  for (const step of latestSteps) {
    const grouped = perCase.get(step.caseCode) ?? [];
    grouped.push(step);
    perCase.set(step.caseCode, grouped);
  }
  const caseRows = [...perCase.entries()].map(([code, caseSteps]) => {
    const failedStep = caseSteps.find((step) => !step.passed);
    const first = caseSteps[0];
    const known = casesByCode.get(code);
    return {
      code,
      name: known?.name ?? first?.caseName ?? code,
      method: known?.method ?? first?.method ?? "",
      passed: caseSteps.every((step) => step.passed),
      startedAt: first ? first.startedAt : "",
      failedStep: failedStep ? `第 ${failedStep.stepIndex} 步${failedStep.reason ? `：${failedStep.reason}` : ""}` : "",
    };
  });

  return (
    <Card data-testid="platform/test-results/card" title="测试结果" style={{ marginTop: 16 }}>
      <Space wrap>
        <Button
          data-testid="platform/test-results/start"
          type="primary"
          loading={busy}
          onClick={() => void callAndReload(`/api/projects/${props.projectCode}/tests`)}
        >
          运行测试
        </Button>
        <Button data-testid="platform/test-results/refresh" onClick={() => void loadTests()}>
          刷新
        </Button>
        <Typography.Text type="secondary">{tests?.candidateDigest ? `候选镜像 ${shortDigest(tests.candidateDigest)}` : "还没有候选镜像"}</Typography.Text>
      </Space>
      {reason ? <Alert type="error" showIcon message={reason} style={{ marginTop: 12 }} /> : null}
      {tests && tests.runs.length === 0 ? (
        <Empty data-testid="platform/test-results/empty" style={{ marginTop: 16 }} description="还没有测试记录" />
      ) : null}
      {tests && tests.runs.length > 0 ? (
        <List
          data-testid="platform/test-results/runs"
          style={{ marginTop: 12 }}
          dataSource={tests.runs}
          renderItem={(run) => (
            <List.Item
              data-testid={`platform/test-results/run-${run.id}`}
              actions={[
                <Button
                  key="jobs"
                  data-testid={`platform/test-results/jobs-${run.id}`}
                  onClick={() => void toggleJobs(run.id)}
                >
                  {jobsRunId === run.id ? "收起日志" : "任务日志"}
                </Button>,
                <Button
                  key="replay"
                  data-testid={`platform/test-results/replay-${run.id}`}
                  onClick={() => void callAndReload(`/api/projects/${props.projectCode}/tests/runs/${run.id}/replay`)}
                >
                  回放
                </Button>,
              ]}
            >
              <Space direction="vertical" size={0}>
                <Space>
                  <Tag color={run.status === "passed" ? "green" : run.status === "failed" ? "red" : "default"}>
                    {run.status === "passed" ? "通过" : run.status === "failed" ? "失败" : "运行中"}
                  </Tag>
                  <Typography.Text>{formatTime(run.startedAt)}</Typography.Text>
                  <Typography.Text type="secondary">候选 {shortDigest(run.imageDigest)}</Typography.Text>
                  {run.replayedFrom ? <Typography.Text type="secondary">回放自镜像 {shortDigest(run.replayedFromDigest ?? "")}</Typography.Text> : null}
                </Space>
                {run.failure ? <Typography.Text type="danger">{run.failure}</Typography.Text> : null}
                {run.failedCases.length > 0 ? <Typography.Text type="danger">失败案例 {run.failedCases.join("、")}</Typography.Text> : null}
              </Space>
            </List.Item>
          )}
        />
      ) : null}
      {jobs && jobsRunId ? (
        <div data-testid="platform/test-results/jobs" style={{ marginTop: 12 }}>
          <Typography.Text strong>节点任务与实时日志</Typography.Text>
          {jobs.length === 0 ? (
            <Empty data-testid="platform/test-results/jobs-empty" style={{ marginTop: 8 }} description="这次运行没有节点任务（同步执行）" />
          ) : (
            jobs.map((job) => (
              <div key={job.id} data-testid={`platform/test-results/job-${job.id}`} style={{ marginTop: 8 }}>
                <Space wrap>
                  <Tag>{job.nodeName}</Tag>
                  <Tag color={job.status === "done" ? (job.failure ? "red" : "green") : "blue"}>
                    {job.status === "done" ? (job.failure ? "失败" : "完成") : job.status === "running" ? "执行中" : "等待领取"}
                  </Tag>
                  <Typography.Text type="secondary">领取次数 {job.attempt}</Typography.Text>
                  {job.claimedAt ? <Typography.Text type="secondary">领取于 {formatTime(job.claimedAt)}</Typography.Text> : null}
                </Space>
                {job.failure ? <Typography.Paragraph type="danger" style={{ marginBottom: 4 }}>{job.failure}</Typography.Paragraph> : null}
                <pre
                  data-testid={`platform/test-results/job-log-${job.id}`}
                  style={{ margin: 0, padding: 8, background: "rgba(0,0,0,0.04)", maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                >
                  {job.log || "还没有日志"}
                </pre>
              </div>
            ))
          )}
        </div>
      ) : null}
      {caseRows.length > 0 ? (
        <List
          data-testid="platform/test-results/cases"
          style={{ marginTop: 12 }}
          header={<Typography.Text strong>最新一次运行的案例结果</Typography.Text>}
          dataSource={caseRows}
          renderItem={(row) => (
            <List.Item data-testid={`platform/test-results/case-${row.code}`}>
              <Space wrap>
                <Tag>{methodLabel(row.method)}</Tag>
                <Typography.Text>{row.name}</Typography.Text>
                <Tag color={row.passed ? "green" : "red"}>{row.passed ? "通过" : "失败"}</Tag>
                <Typography.Text type="secondary">{row.startedAt ? formatTime(row.startedAt) : ""}</Typography.Text>
                {row.failedStep ? <Typography.Text type="danger">{row.failedStep}</Typography.Text> : null}
              </Space>
            </List.Item>
          )}
        />
      ) : null}
    </Card>
  );
}

type ReleaseView = {
  reason?: string;
  published?: boolean;
  nodes?: Array<{ name: string; healthy: boolean; reason?: string }>;
  containerGroup?: string;
  otherProjects?: Array<{ code: string; name: string }>;
  designSummary?: string[];
  candidateDigest?: string | null;
  testResult?: { required?: boolean; passed?: boolean; failedCases?: string[] };
};

function menuLabel(menu: DraftMenuView): string {
  return `${menu.name}（${menu.code}${menu.parent_code ? `，上级 ${menu.parent_code}` : ""}）`;
}

function grantLabel(grant: DraftGrantView): string {
  return `${grant.principal_type === "role" ? "角色" : "用户"} ${grant.principal_name} · ${grant.menu_code} · ${grant.action}`;
}

function SolutionConfirmPage(props: { project: { name: string; code: string }; onBack: () => void }) {
  const [change, setChange] = useState<SolutionChangeView | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState("");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    void fetch(`/api/projects/${props.project.code}/change`)
      .then(async (response) => {
        const body = (await response.json()) as { change?: SolutionChangeView; reason?: string };
        if (!response.ok) {
          setError(body.reason ?? "增量读取失败");
          return;
        }
        setChange(body.change ?? null);
      })
      .catch(() => setError("增量读取失败"));
  }, [props.project.code]);
  const total = change
    ? change.added.menus.length + change.added.grants.length + change.modified.length + change.removed.menus.length + change.removed.grants.length
    : 0;
  return (
    <Card
      data-testid="platform/solution/page"
      title="方案确认"
      extra={<Button data-testid="platform/solution/back" onClick={props.onBack}>返回草稿</Button>}
    >
      <Typography.Paragraph>项目 {props.project.name} 当前草稿相对已发布版本的增量。确认后生成设计、测试案例与源码，正式菜单不变。</Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
      {revision ? <Alert type="success" showIcon message={`方案已确认，源码版本 ${revision}`} style={{ marginBottom: 16 }} /> : null}
      {change ? (
        <div data-testid="platform/solution/summary">
          <Typography.Paragraph>共 {total} 项变更：新增 {change.added.menus.length + change.added.grants.length}、修改 {change.modified.length}、删除 {change.removed.menus.length + change.removed.grants.length}。</Typography.Paragraph>
          <Typography.Title level={5}>新增</Typography.Title>
          {change.added.menus.map((item) => <Typography.Paragraph key={`menu-${item.code}`} data-testid="platform/solution/added-menu">菜单 {menuLabel(item)}</Typography.Paragraph>)}
          {change.added.grants.map((item) => <Typography.Paragraph key={`grant-${item.principal_type}-${item.principal_name}-${item.menu_code}-${item.action}`} data-testid="platform/solution/added-grant">授权 {grantLabel(item)}</Typography.Paragraph>)}
          <Typography.Title level={5}>修改</Typography.Title>
          {change.modified.map((item, index) => (
            <Typography.Paragraph key={`modified-${index}`} data-testid="platform/solution/modified-item">
              {item.kind === "menu"
                ? `菜单 ${item.code}：${Object.entries(item.changes).map(([field, value]) => `${field} ${JSON.stringify(value?.from)} → ${JSON.stringify(value?.to)}`).join("；")}`
                : `授权 ${item.principal_type} ${item.principal_name} · ${item.menu_code}：新增动作 ${item.added_actions.join("、") || "无"}；移除动作 ${item.removed_actions.join("、") || "无"}`}
            </Typography.Paragraph>
          ))}
          <Typography.Title level={5}>删除</Typography.Title>
          {change.removed.menus.map((item) => <Typography.Paragraph key={`removed-menu-${item.code}`} data-testid="platform/solution/removed-menu">菜单 {menuLabel(item)}</Typography.Paragraph>)}
          {change.removed.grants.map((item) => <Typography.Paragraph key={`removed-grant-${item.principal_type}-${item.principal_name}-${item.menu_code}-${item.action}`} data-testid="platform/solution/removed-grant">授权 {grantLabel(item)}</Typography.Paragraph>)}
          {total === 0 ? <Empty description="没有变更" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
        </div>
      ) : null}
      <Button
        type="primary"
        data-testid="platform/solution/confirm"
        loading={confirming}
        style={{ marginTop: 16 }}
        onClick={async () => {
          setConfirming(true);
          setError("");
          const response = await fetch(`/api/projects/${props.project.code}/confirm`, { method: "POST" });
          const body = (await response.json()) as { sourceRevision?: string; reason?: string };
          setConfirming(false);
          if (!response.ok) {
            setError(body.reason ?? "方案确认失败");
            return;
          }
          setRevision(body.sourceRevision ?? "");
        }}
      >
        确认方案
      </Button>
    </Card>
  );
}

function ProjectPage(props: { project: { name: string; code: string }; modelConfigured: boolean; modelNotice: string }) {
  const [reason, setReason] = useState("");
  const [templateState, setTemplateState] = useState("");
  const [release, setRelease] = useState<ReleaseView | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [view, setView] = useState<"draft" | "confirm" | "access">("draft");
  const [messages, setMessages] = useState<Array<{ role: string; body: string }>>([]);
  const [sending, setSending] = useState(false);
  const loadMessages = () => {
    void fetch(`/api/projects/${props.project.code}/messages`)
      .then(async (response) => {
        if (!response.ok) {
          return [];
        }
        const body = (await response.json()) as { messages?: Array<{ role?: string; body: string }> };
        return (body.messages ?? []).map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", body: item.body }));
      })
      .then(setMessages)
      .catch(() => setMessages([]));
  };
  useEffect(() => {
    loadMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.project.code]);
  const waiting = (release?.nodes ?? []).filter((node) => !node.healthy).map((node) => `${node.name}：${node.reason ?? "尚未报告"}`);
  // 门槛关闭（required===false）时不拦截；门槛开启时只有存在全部通过的候选才允许发布。
  const gateRequired = release?.testResult?.required !== false;
  const testsPassed = release?.testResult?.passed === true;
  const publishBlocked = gateRequired && !testsPassed;
  const publishBlockReason = !gateRequired
    ? ""
    : release?.testResult?.failedCases && release.testResult.failedCases.length > 0
      ? `当前候选测试未全部通过：${release.testResult.failedCases.join("、")}`
      : "当前候选尚无全部通过的测试记录";
  const confirmPublish = async () => {
    setPublishing(true);
    setPublishError("");
    const response = await fetch(`/api/projects/${encodeURIComponent(props.project.code)}/publish`, { method: "POST" });
    const body = (await response.json().catch(() => ({}))) as { reason?: string; failedCases?: string[] };
    setPublishing(false);
    if (!response.ok) {
      setPublishError(body.failedCases?.length ? `${body.reason ?? "发布失败"}：${body.failedCases.join("、")}` : body.reason ?? "发布失败");
      return;
    }
    const next = await fetch(`/api/projects/${encodeURIComponent(props.project.code)}/release`);
    if (next.ok) {
      setRelease((await next.json()) as ReleaseView);
    }
  };
  if (view === "confirm") {
    return <SolutionConfirmPage project={props.project} onBack={() => setView("draft")} />;
  }
  if (view === "access") {
    return <AccessManagementPage project={props.project} onBack={() => setView("draft")} />;
  }
  return (
    <div>
      {props.modelConfigured ? null : <Alert type="warning" showIcon message={props.modelNotice} style={{ marginBottom: 16 }} />}
      <div data-testid="platform/project/layout" className="platform-project-layout" style={{ display: "flex", gap: 16 }}>
        <Card data-testid="platform/project/draft" title="草稿" style={{ flex: 1 }}>
          <Typography.Title level={3}>{props.project.name}</Typography.Title>
          <Space wrap>
          <Button
            data-testid="platform/project/solution"
            onClick={() => setView("confirm")}
          >
            方案确认
          </Button>
          <Button
            data-testid="platform/project/access"
            onClick={() => setView("access")}
          >
            授权管理
          </Button>
          <Button
            data-testid="platform/project/release"
            onClick={async () => {
              const response = await fetch(`/api/projects/${props.project.code}/release`);
              const body = (await response.json()) as ReleaseView;
              if (!response.ok) {
                setRelease({ reason: body.reason ?? "发布状态读取失败" });
                return;
              }
              setRelease(body);
            }}
          >
            发布确认
          </Button>
          <Button
            data-testid="platform/project/apply-template"
            onClick={async () => {
              const response = await fetch(`/api/projects/${props.project.code}/apply-template`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ template: "oa" }),
              });
              const body = (await response.json()) as { reason?: string; template?: string; menus?: number; entities?: number; workflows?: number; grants?: number; cases?: number };
              if (!response.ok) {
                setTemplateState(body.reason ?? "模板应用失败");
                return;
              }
              setTemplateState(
                `${body.template}：菜单 ${body.menus}、数据 ${body.entities}、流程 ${body.workflows}、授权 ${body.grants}、案例 ${body.cases}`,
              );
            }}
          >
            应用 OA 模板
          </Button>
          <Button
            data-testid="platform/project/open-entry"
            href={`/p/${props.project.code}`}
            target="_blank"
            rel="noreferrer"
          >
            打开项目
          </Button>
          </Space>
          {templateState ? <Typography.Paragraph data-testid="platform/project/template-result" style={{ marginTop: 16 }}>{templateState}</Typography.Paragraph> : null}
          {release ? (
            <div data-testid="platform/project/release-summary" style={{ marginTop: 16 }}>
              {release.reason ? <Alert type="error" showIcon message={release.reason} /> : null}
              {release.published ? <Alert type="success" showIcon message="已发布" /> : null}
              {release.containerGroup ? <Typography.Paragraph>容器组 {release.containerGroup}</Typography.Paragraph> : null}
              {release.otherProjects && release.otherProjects.length > 0 ? (
                <Typography.Paragraph>同组项目 {release.otherProjects.map((project) => project.name).join("、")}</Typography.Paragraph>
              ) : null}
              {release.designSummary && release.designSummary.length > 0 ? (
                <Typography.Paragraph>设计 {release.designSummary.join("、")}</Typography.Paragraph>
              ) : null}
              {release.candidateDigest ? <Typography.Paragraph>镜像 {release.candidateDigest}</Typography.Paragraph> : null}
              {release.testResult?.required === false ? <Typography.Paragraph>测试未设为发布门槛</Typography.Paragraph> : null}
              {release.testResult?.passed === false ? <Typography.Paragraph>当前候选测试未全部通过</Typography.Paragraph> : null}
              {release.testResult?.failedCases && release.testResult.failedCases.length > 0 ? (
                <Typography.Paragraph data-testid="platform/project/failed-cases">失败案例 {release.testResult.failedCases.join("、")}</Typography.Paragraph>
              ) : null}
              {publishError ? <Alert type="error" showIcon message={publishError} style={{ marginBottom: 8 }} /> : null}
              <Button
                type="primary"
                data-testid="platform/project/publish"
                loading={publishing}
                disabled={publishBlocked || Boolean(release.reason)}
                title={publishBlocked ? publishBlockReason : undefined}
                style={{ marginBottom: 8 }}
                onClick={() => void confirmPublish()}
              >
                确认发布
              </Button>
              {publishBlocked ? (
                <Typography.Paragraph type="warning" data-testid="platform/project/publish-blocked">{publishBlockReason}</Typography.Paragraph>
              ) : null}
              {waiting.length > 0 ? <Alert type="info" showIcon message={waiting.join("；")} /> : null}
              {!release.published && waiting.length === 0 && !release.reason ? <Alert type="info" showIcon message="目标节点尚未报告健康" /> : null}
            </div>
          ) : null}
        </Card>
        <Card data-testid="platform/project/session" className="platform-project-session" title="会话" style={{ width: 400 }}>
          <List
            data-testid="platform/project/message-list"
            locale={{ emptyText: "尚无会话记录" }}
            style={{ maxHeight: 320, overflowY: "auto", marginBottom: 12 }}
            dataSource={messages}
            renderItem={(item) => (
              <List.Item
                data-testid="platform/project/message-item"
                style={{ display: "block", borderBottom: "none", paddingBlock: 4 }}
              >
                <Tag color={item.role === "assistant" ? "blue" : "default"}>{item.role === "assistant" ? "方案分析师" : "我"}</Tag>
                <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>{item.body}</Typography.Paragraph>
              </List.Item>
            )}
          />
          <Form
            onFinish={async (values: { body: string }) => {
              setSending(true);
              setReason("");
              const response = await fetch(`/api/projects/${props.project.code}/messages`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ body: values.body }),
              });
              const body = (await response.json()) as { reason?: string };
              setSending(false);
              if (!response.ok) {
                setReason(body.reason ?? "发送失败");
                return;
              }
              loadMessages();
            }}
          >
            <Form.Item name="body">
              <Input
                data-testid="platform/project/message"
                placeholder={props.modelConfigured ? "描述需要的菜单、数据、流程或授权" : props.modelNotice}
                disabled={!props.modelConfigured || sending}
              />
            </Form.Item>
            {reason ? <Alert type="error" showIcon message={reason} /> : null}
            <Button
              htmlType="submit"
              type="primary"
              data-testid="platform/project/send"
              loading={sending}
              disabled={!props.modelConfigured}
            >
              发送
            </Button>
          </Form>
        </Card>
      </div>
      <UserCasesCard projectCode={props.project.code} canEdit />
      <TestResultsCard projectCode={props.project.code} />
    </div>
  );
}
