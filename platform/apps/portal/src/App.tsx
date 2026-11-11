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

export function App(props: {
  session?: SessionUser | null;
  wechatAvailable?: boolean;
  registrationEnabled?: boolean;
  page?: "login" | "register";
  loginResult?: { reason?: string };
  title?: string;
}) {
  const provided = props.session !== undefined;
  const [session, setSession] = useState<SessionUser | null>(provided ? props.session ?? null : null);
  const [page, setPage] = useState<"login" | "register">(props.page ?? "login");
  const [reason, setReason] = useState(props.loginResult?.reason ?? "");

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
        const body = (await response.json()) as { user: SessionUser };
        setSession(body.user);
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
    <Layout data-testid="platform/shell/root" style={{ minHeight: "100vh" }}>
      <Sider width={240} theme="light">
        <Typography.Title level={4} data-testid="platform/shell/title">
          {props.title ?? "企业应用平台"}
        </Typography.Title>
      </Sider>
      <Layout>
        <Header data-testid="platform/shell/header" />
        <Content data-testid="platform/shell/content">暂无可用菜单</Content>
      </Layout>
    </Layout>
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
