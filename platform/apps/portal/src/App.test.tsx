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
