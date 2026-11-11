import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
});

describe("portal login", () => {
  it("shows password login when WeChat is not configured", () => {
    render(<App session={null} wechatAvailable={false} />);
    expect(screen.getByTestId("platform/login/username")).toBeInTheDocument();
    expect(screen.getByTestId("platform/login/password")).toBeInTheDocument();
    expect(screen.getByTestId("platform/login/submit")).toBeInTheDocument();
    expect(screen.getByTestId("platform/login/wechat-unavailable")).toHaveTextContent("微信登录未配置");
    expect(screen.queryByTestId("platform/login/wechat-qr")).toBeNull();
    expect(screen.getByTestId("platform/login/card")).toHaveStyle({ width: "420px" });
  });

  it("shows the QR entry only after WeChat is configured", () => {
    render(<App session={null} wechatAvailable={true} />);
    expect(screen.getByTestId("platform/login/wechat-qr")).toBeInTheDocument();
    expect(screen.queryByTestId("platform/login/wechat-unavailable")).toBeNull();
  });

  it("keeps the login page and shows the returned reason", async () => {
    render(<App session={null} wechatAvailable={false} loginResult={{ reason: "用户名或密码错误" }} />);
    expect(await screen.findByText("用户名或密码错误")).toBeInTheDocument();
    expect(screen.getByTestId("platform/login/username")).toBeInTheDocument();
  });

  it("explains that registration is closed", () => {
    render(<App session={null} wechatAvailable={false} registrationEnabled={false} page="register" />);
    expect(screen.getByText("请联系管理员")).toBeInTheDocument();
    expect(screen.queryByTestId("platform/register/submit")).toBeNull();
  });
});

const admin = { username: "admin", displayName: "管理员", language: "zh-CN", platformAdmin: true, wechatBound: false };
const employee = { username: "employee", displayName: "员工", language: "zh-CN", platformAdmin: false, wechatBound: false };

describe("portal shell", () => {
  it("shows the three settings links only to a platform administrator", () => {
    render(<App session={admin} title="企业应用平台" />);
    expect(screen.getByTestId("platform/shell/nav-system-config")).toHaveTextContent("系统配置");
    expect(screen.getByTestId("platform/shell/nav-plugin-config")).toHaveTextContent("插件配置");
    expect(screen.getByTestId("platform/shell/nav-model-config")).toHaveTextContent("模型配置");
    expect(screen.getByTestId("platform/shell/header")).toHaveStyle({ height: "56px" });
    expect(screen.getByTestId("platform/shell/user")).toHaveTextContent("管理员");
    expect(screen.getByTestId("platform/shell/language")).toHaveTextContent("zh-CN");
  });

  it("tells a user without menus to contact an administrator", () => {
    render(<App session={employee} title="企业应用平台" />);
    expect(screen.queryByTestId("platform/shell/nav-system-config")).toBeNull();
    expect(screen.queryByTestId("platform/shell/nav-plugin-config")).toBeNull();
    expect(screen.queryByTestId("platform/shell/nav-model-config")).toBeNull();
    expect(screen.getByTestId("platform/shell/content")).toHaveTextContent("联系管理员");
  });

  it("renders system, plugin, model, and personal settings", () => {
    const config = {
      "platform.title": "企业应用平台",
      "platform.languages": ["zh-CN"],
      "registration.enabled": true,
      "wechat.appId": "",
      "wechat.redirectUri": "",
      "model.baseUrl": "",
      "model.name": "",
      "database.prodAdminUrl": "postgres://platform@127.0.0.1:5432/prod",
      "database.testAdminUrl": "postgres://platform@127.0.0.1:5432/test",
      "registry.address": "registry.internal",
      wechatSecretConfigured: false,
      modelKeyConfigured: false,
    };
    const { rerender } = render(<App session={admin} title="企业应用平台" section="system" config={config} />);
    expect(screen.getByTestId("platform/system-config/title")).toHaveValue("企业应用平台");
    expect(screen.getByTestId("platform/system-config/wechat-secret")).toHaveValue("");
    expect(screen.getByTestId("platform/system-config/wechat-secret-state")).toHaveTextContent("未配置");
    rerender(<App session={admin} title="企业应用平台" section="plugin" plugins={[]} />);
    expect(screen.getByTestId("platform/plugin-config/empty")).toHaveTextContent("暂无插件");
    rerender(<App session={admin} title="企业应用平台" section="model" config={config} />);
    expect(screen.getByTestId("platform/model-config/empty")).toHaveTextContent("会话和运维智能体不会调用模型");
    expect(screen.getByTestId("platform/model-config/api-key")).toHaveValue("");
    expect(screen.getByTestId("platform/model-config/api-key-state")).toHaveTextContent("未配置");
    rerender(<App session={admin} title="企业应用平台" section="account" />);
    expect(screen.getByTestId("platform/account/display-name")).toHaveValue("管理员");
    expect(screen.getByTestId("platform/account/wechat")).toHaveTextContent("未绑定");
  });
});
