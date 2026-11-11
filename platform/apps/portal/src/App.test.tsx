import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("opens the workbench after a successful login", async () => {
    const user = { username: "admin", displayName: "管理员", language: "zh-CN", platformAdmin: true, wechatBound: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ user, title: "企业应用平台" }),
      })),
    );
    render(<App session={null} wechatAvailable={false} />);
    fireEvent.change(screen.getByTestId("platform/login/username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByTestId("platform/login/password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByTestId("platform/login/submit"));
    expect(await screen.findByTestId("platform/shell/user")).toHaveTextContent("管理员");
    vi.unstubAllGlobals();
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

  it("opens account actions and collapses the navigation to icons", async () => {
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/shell/account"));
    expect(await screen.findByTestId("platform/shell/account-settings")).toHaveTextContent("账号设置");
    expect(screen.getByTestId("platform/shell/menu-system-config")).toHaveTextContent("系统配置");
    expect(screen.getByTestId("platform/shell/logout")).toHaveTextContent("退出");
    fireEvent.click(screen.getByTestId("platform/shell/nav-collapse"));
    expect(screen.getByTestId("platform/shell/sider")).toHaveClass("ant-layout-sider-collapsed");
  });

  it("tells a user without menus to contact an administrator", () => {
    render(<App session={employee} title="企业应用平台" />);
    expect(screen.queryByTestId("platform/shell/nav-system-config")).toBeNull();
    expect(screen.queryByTestId("platform/shell/nav-plugin-config")).toBeNull();
    expect(screen.queryByTestId("platform/shell/nav-model-config")).toBeNull();
    expect(screen.getByTestId("platform/shell/content")).toHaveTextContent("联系管理员");
    expect(screen.queryByTestId("platform/project/new")).toBeNull();
  });

  it("opens a draft session after an administrator creates a project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ project: { name: "请假审批", code: "qing-jia-shen-pi" } }),
      })),
    );
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/project/new"));
    fireEvent.change(screen.getByTestId("platform/project/name"), { target: { value: "请假审批" } });
    fireEvent.click(screen.getByTestId("platform/project/save"));
    expect(await screen.findByTestId("platform/project/draft")).toHaveTextContent("草稿");
    expect(screen.getByTestId("platform/project/session")).toHaveStyle({ width: "400px" });
    expect(screen.getByText("会话和运维智能体不会调用模型")).toBeInTheDocument();
    expect(screen.getByTestId("platform/project/message")).toBeDisabled();
    vi.unstubAllGlobals();
  });

  it("shows a node that has not reported healthy on the release check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/release")) {
          return { ok: true, json: async () => ({ published: false, nodes: [{ name: "prod-1", healthy: false, reason: "尚未报告" }] }) };
        }
        return { ok: true, json: async () => ({ project: { name: "请假审批", code: "qing-jia-shen-pi" } }) };
      }),
    );
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/project/new"));
    fireEvent.change(screen.getByTestId("platform/project/name"), { target: { value: "请假审批" } });
    fireEvent.click(screen.getByTestId("platform/project/save"));
    fireEvent.click(await screen.findByTestId("platform/project/release"));
    expect(await screen.findByText("prod-1：尚未报告")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("shows the container group and design summary on the release check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/release")) {
          return {
            ok: true,
            json: async () => ({
              published: false,
              containerGroup: "leave",
              otherProjects: [{ code: "leave", name: "请假" }],
              designSummary: ["入库"],
              candidateDigest: "sha256:abc",
              testResult: { required: false },
              nodes: [],
            }),
          };
        }
        return { ok: true, json: async () => ({ project: { name: "库存", code: "stock" } }) };
      }),
    );
    render(<App session={admin} title="企业应用平台" />);
    fireEvent.click(screen.getByTestId("platform/project/new"));
    fireEvent.change(screen.getByTestId("platform/project/name"), { target: { value: "库存" } });
    fireEvent.click(screen.getByTestId("platform/project/save"));
    fireEvent.click(await screen.findByTestId("platform/project/release"));
    const summary = await screen.findByTestId("platform/project/release-summary");
    expect(summary).toHaveTextContent("容器组 leave");
    expect(summary).toHaveTextContent("同组项目 请假");
    expect(summary).toHaveTextContent("设计 入库");
    expect(summary).toHaveTextContent("测试未设为发布门槛");
    vi.unstubAllGlobals();
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
