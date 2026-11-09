import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("portal shell", () => {
  it("shows the empty workbench", () => {
    render(<App />);
    expect(screen.getByTestId("platform/shell/root")).toBeInTheDocument();
    expect(screen.getByTestId("platform/shell/header")).toBeInTheDocument();
    const title = screen.getByTestId("platform/shell/title");
    expect(title).toHaveTextContent("企业应用平台");
    expect(title.closest(".ant-layout-sider")).toHaveClass("ant-layout-sider-light");
    expect(screen.getByTestId("platform/shell/content")).toHaveTextContent("暂无可用菜单");
    expect(screen.queryByTestId("platform/shell/conversation")).toBeNull();
  });
});
