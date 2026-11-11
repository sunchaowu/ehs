import { Button, Form, Input, Layout, Typography } from "antd";
import { useEffect, useState } from "react";

const { Header, Sider, Content } = Layout;

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

export function App(props: {
  session?: SessionUser | null;
  wechatAvailable?: boolean;
  registrationEnabled?: boolean;
  page?: "login" | "register";
  loginResult?: { reason?: string };
  title?: string;
  section?: Section;
  config?: SystemConfigView;
  plugins?: Array<{ id: string; name: string; enabled: boolean }>;
}) {
  const provided = props.session !== undefined;
  const [session, setSession] = useState<SessionUser | null>(provided ? props.session ?? null : null);
  const [page, setPage] = useState<"login" | "register">(props.page ?? "login");
  const [reason, setReason] = useState(props.loginResult?.reason ?? "");
  const [title, setTitle] = useState(props.title ?? "企业应用平台");

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
        const body = (await response.json()) as { user: SessionUser; title?: string };
        setSession(body.user);
        if (body.title) {
          setTitle(body.title);
        }
      })
      .catch(() => setSession(null));
  }, [provided]);

  if (!session) {
    return page === "register" ? (
      <RegisterPage enabled={props.registrationEnabled !== false} />
    ) : (
      <LoginPage
        wechatAvailable={props.wechatAvailable === true}
        reason={reason}
        onRegister={() => setPage("register")}
        onReason={setReason}
      />
    );
  }

  return (
    <Workbench
      session={session}
      title={title}
      onTitle={setTitle}
      initialSection={props.section ?? null}
      config={props.config}
      plugins={props.plugins}
    />
  );
}

function Workbench(props: {
  session: SessionUser;
  title: string;
  onTitle: (title: string) => void;
  initialSection: Section | null;
  config?: SystemConfigView;
  plugins?: Array<{ id: string; name: string; enabled: boolean }>;
}) {
  const [section, setSection] = useState<Section | null>(props.initialSection);
  useEffect(() => {
    setSection(props.initialSection);
  }, [props.initialSection]);
  return (
    <Layout data-testid="platform/shell/root" style={{ minHeight: "100vh" }}>
      <Sider width={240} theme="light">
        <Typography.Title level={4} data-testid="platform/shell/title">
          {props.title}
        </Typography.Title>
        {props.session.platformAdmin ? (
          <nav>
            <button type="button" data-testid="platform/shell/nav-system-config" onClick={() => setSection("system")}>
              系统配置
            </button>
            <button type="button" data-testid="platform/shell/nav-plugin-config" onClick={() => setSection("plugin")}>
              插件配置
            </button>
            <button type="button" data-testid="platform/shell/nav-model-config" onClick={() => setSection("model")}>
              模型配置
            </button>
          </nav>
        ) : null}
      </Sider>
      <Layout>
        <Header data-testid="platform/shell/header" style={{ height: "56px", lineHeight: "56px", background: "#fff" }}>
          <span data-testid="platform/shell/user">{props.session.displayName}</span>
          <span data-testid="platform/shell/language">{props.session.language}</span>
          <button type="button" data-testid="platform/shell/settings" onClick={() => setSection("account")}>
            配置
          </button>
        </Header>
        <Content data-testid="platform/shell/content">
          {section === "system" && props.session.platformAdmin ? (
            <SystemConfigPage config={props.config} onTitle={props.onTitle} />
          ) : null}
          {section === "plugin" && props.session.platformAdmin ? <PluginPage plugins={props.plugins} /> : null}
          {section === "model" && props.session.platformAdmin ? <ModelPage config={props.config} /> : null}
          {section === "account" ? <AccountPage session={props.session} /> : null}
          {section === null ? (props.session.platformAdmin ? "暂无可用菜单" : "联系管理员") : null}
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
    return <Typography.Paragraph>{loadError || "正在读取系统配置"}</Typography.Paragraph>;
  }
  const secretState = config.wechatSecretConfigured ? "已配置" : "未配置";
  return (
    <Form
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
        <input type="checkbox" data-testid="platform/system-config/registration" />
      </Form.Item>
      <Form.Item name="wechatAppId" label="微信 AppId">
        <Input data-testid="platform/system-config/wechat-app-id" />
      </Form.Item>
      <Form.Item name="wechatSecret" label="微信 AppSecret">
        <Input.Password data-testid="platform/system-config/wechat-secret" />
      </Form.Item>
      <span data-testid="platform/system-config/wechat-secret-state">{secretState}</span>
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
  );
}

function PluginPage(props: { plugins?: Array<{ id: string; name: string; enabled: boolean }> }) {
  const [plugins, setPlugins] = useState(props.plugins);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (props.plugins) {
      setPlugins(props.plugins);
      return;
    }
    void fetch("/api/plugins")
      .then(async (response) => {
        const body = (await response.json()) as { plugins?: Array<{ id: string; name: string; enabled: boolean }>; reason?: string };
        if (!response.ok || !body.plugins) {
          setLoadError(body.reason ?? "插件读取失败");
          return;
        }
        setPlugins(body.plugins);
      })
      .catch(() => setLoadError("插件读取失败"));
  }, [props.plugins]);
  if (!plugins) {
    return <Typography.Paragraph>{loadError || "正在读取插件"}</Typography.Paragraph>;
  }
  if (plugins.length === 0) {
    return <Typography.Paragraph data-testid="platform/plugin-config/empty">暂无插件</Typography.Paragraph>;
  }
  return (
    <ul>
      {plugins.map((plugin) => (
        <li key={plugin.id}>{plugin.name}</li>
      ))}
    </ul>
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
    return <Typography.Paragraph>{loadError || "正在读取模型配置"}</Typography.Paragraph>;
  }
  const empty = !config["model.baseUrl"] && !config["model.name"] && !config.modelKeyConfigured;
  return (
    <Form
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
      {empty ? <Typography.Paragraph data-testid="platform/model-config/empty">会话和运维智能体不会调用模型</Typography.Paragraph> : null}
      <Form.Item name="baseUrl" label="模型地址">
        <Input data-testid="platform/model-config/base-url" />
      </Form.Item>
      <Form.Item name="name" label="模型名称">
        <Input data-testid="platform/model-config/name" />
      </Form.Item>
      <Form.Item name="apiKey" label="模型密钥">
        <Input.Password data-testid="platform/model-config/api-key" />
      </Form.Item>
      <span data-testid="platform/model-config/api-key-state">{config.modelKeyConfigured ? "已配置" : "未配置"}</span>
      <Button htmlType="submit" type="primary" data-testid="platform/model-config/save">
        保存
      </Button>
    </Form>
  );
}

function AccountPage(props: { session: SessionUser }) {
  return (
    <Form
      initialValues={{ displayName: props.session.displayName, password: "", language: props.session.language }}
      onFinish={async (values: { displayName: string; password: string; language: string }) => {
        await fetch("/api/account", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(values),
        });
      }}
    >
      <Form.Item name="displayName" label="显示名">
        <Input data-testid="platform/account/display-name" />
      </Form.Item>
      <Form.Item name="password" label="密码">
        <Input.Password data-testid="platform/account/password" />
      </Form.Item>
      <Form.Item name="language" label="语言">
        <Input data-testid="platform/account/language" />
      </Form.Item>
      <span data-testid="platform/account/wechat">{props.session.wechatBound ? "已绑定" : "未绑定"}</span>
      <Button htmlType="submit" type="primary" data-testid="platform/account/save">
        保存
      </Button>
    </Form>
  );
}

function LoginPage(props: {
  wechatAvailable: boolean;
  reason: string;
  onRegister: () => void;
  onReason: (reason: string) => void;
}) {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <Form
        data-testid="platform/login/card"
        style={{ width: "420px" }}
        onFinish={async (values: { username: string; password: string }) => {
          const response = await fetch("/api/session/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(values),
          });
          const body = (await response.json()) as { reason?: string };
          if (!response.ok) {
            props.onReason(body.reason ?? "用户名或密码错误");
          }
        }}
      >
        <Form.Item name="username">
          <Input data-testid="platform/login/username" placeholder="用户名" />
        </Form.Item>
        <Form.Item name="password">
          <Input.Password data-testid="platform/login/password" placeholder="密码" />
        </Form.Item>
        {props.reason ? <Typography.Paragraph>{props.reason}</Typography.Paragraph> : null}
        <Button data-testid="platform/login/submit" htmlType="submit" type="primary">
          登录
        </Button>
        <Button data-testid="platform/login/register" onClick={props.onRegister}>
          注册
        </Button>
        {props.wechatAvailable ? (
          <a data-testid="platform/login/wechat-qr" href="/api/session/wechat/start">
            微信扫码登录
          </a>
        ) : (
          <Typography.Paragraph data-testid="platform/login/wechat-unavailable">微信登录未配置</Typography.Paragraph>
        )}
      </Form>
    </main>
  );
}

function RegisterPage(props: { enabled: boolean }) {
  if (!props.enabled) {
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <Typography.Paragraph>请联系管理员</Typography.Paragraph>
      </main>
    );
  }
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <Form data-testid="platform/register/card" style={{ width: "420px" }}>
        <Form.Item name="username">
          <Input data-testid="platform/register/username" placeholder="用户名" />
        </Form.Item>
        <Form.Item name="displayName">
          <Input data-testid="platform/register/display-name" placeholder="显示名" />
        </Form.Item>
        <Form.Item name="password">
          <Input.Password data-testid="platform/register/password" placeholder="密码" />
        </Form.Item>
        <Button data-testid="platform/register/submit" htmlType="submit" type="primary">
          注册
        </Button>
      </Form>
    </main>
  );
}
