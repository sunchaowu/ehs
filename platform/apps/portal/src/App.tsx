import { HomeOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SettingOutlined, AppstoreOutlined, CloudOutlined } from "@ant-design/icons";
import { Alert, Avatar, Button, Card, Checkbox, ConfigProvider, Drawer, Dropdown, Empty, Form, Input, InputNumber, Layout, List, Menu, Space, Spin, Switch, Tag, Typography } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useState } from "react";
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

type Section = "system" | "plugin" | "model" | "account";

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
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
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
    section === "system" ? copy.system : section === "plugin" ? copy.plugin : section === "model" ? copy.model : section === "account" ? copy.personal : project ? project.name : creating ? copy.projectName : copy.home;
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
          {section === "account" ? <AccountPage session={props.session} /> : null}
          {section === null && project ? (
            <ProjectPage project={project} modelConfigured={props.modelConfigured} modelNotice={copy.modelUnavailable} />
          ) : null}
          {section === null && !project && creating ? <CreateProjectPage onCreated={setProject} /> : null}
          {section === null && !project && !creating && props.canCreateProject ? (
            <Card>
              <Button type="primary" data-testid="platform/project/new" onClick={() => setCreating(true)}>
                {copy.createProject}
              </Button>
            </Card>
          ) : null}
          {section === null && !project && !creating && !props.canCreateProject ? <Empty description={copy.contactAdmin} /> : null}
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
      <Form.Item name="code" label="项目编码">
        <Input data-testid="platform/project/code" />
      </Form.Item>
      {reason ? <Alert type="error" showIcon message={reason} style={{ marginBottom: 16 }} /> : null}
      <Button htmlType="submit" type="primary" data-testid="platform/project/save">
        保存
      </Button>
    </Form>
    </Card>
  );
}

type TestCaseView = {
  origin: string;
  method: string;
  code: string;
  name: string;
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

const methodLabel = (method: string) => (method === "black-box" ? "黑盒" : "白盒");
const shortDigest = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 12);
const formatTime = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });

function TestResultsCard(props: { projectCode: string }) {
  const [tests, setTests] = useState<TestsView | null>(null);
  const [steps, setSteps] = useState<TestStepView[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const loadSteps = async (runId: string) => {
    try {
      const response = await fetch(`/api/projects/${props.projectCode}/tests/runs/${runId}`);
      const body = (await response.json()) as { steps?: TestStepView[] };
      setSteps(response.ok && Array.isArray(body.steps) ? body.steps : []);
    } catch {
      setSteps([]);
    }
  };

  const loadTests = async () => {
    try {
      const response = await fetch(`/api/projects/${props.projectCode}/tests`);
      const body = (await response.json()) as Partial<TestsView> & { reason?: string };
      if (!response.ok) {
        setReason(body.reason ?? "测试结果读取失败");
        return;
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
    } catch (error) {
      setReason(error instanceof Error ? error.message : "测试结果读取失败");
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
      await loadTests();
    } catch (error) {
      setReason(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
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

function ProjectPage(props: { project: { name: string; code: string }; modelConfigured: boolean; modelNotice: string }) {
  const [reason, setReason] = useState("");
  const [templateState, setTemplateState] = useState("");
  const [release, setRelease] = useState<ReleaseView | null>(null);
  const waiting = (release?.nodes ?? []).filter((node) => !node.healthy).map((node) => `${node.name}：${node.reason ?? "尚未报告"}`);
  return (
    <div>
      {props.modelConfigured ? null : <Alert type="warning" showIcon message={props.modelNotice} style={{ marginBottom: 16 }} />}
      <div data-testid="platform/project/layout" className="platform-project-layout" style={{ display: "flex", gap: 16 }}>
        <Card data-testid="platform/project/draft" title="草稿" style={{ flex: 1 }}>
          <Typography.Title level={3}>{props.project.name}</Typography.Title>
          <Space wrap>
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
              {waiting.length > 0 ? <Alert type="info" showIcon message={waiting.join("；")} /> : null}
              {!release.published && waiting.length === 0 && !release.reason ? <Alert type="info" showIcon message="目标节点尚未报告健康" /> : null}
            </div>
          ) : null}
        </Card>
        <Card data-testid="platform/project/session" className="platform-project-session" title="会话" style={{ width: 400 }}>
          <Form
            onFinish={async (values: { body: string }) => {
              const response = await fetch(`/api/projects/${props.project.code}/messages`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ body: values.body }),
              });
              if (!response.ok) {
                const body = (await response.json()) as { reason?: string };
                setReason(body.reason ?? "发送失败");
              }
            }}
          >
            <Form.Item name="body">
              <Input data-testid="platform/project/message" disabled={!props.modelConfigured} />
            </Form.Item>
            {reason ? <Alert type="error" showIcon message={reason} /> : null}
          </Form>
        </Card>
      </div>
      <TestResultsCard projectCode={props.project.code} />
    </div>
  );
}
