import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("portal shell", () => {
  it("shows the empty workbench", () => {
    render(<App />);
    expect(screen.getByTestId("platform/shell/title")).toHaveTextContent("企业应用平台");
    expect(screen.getByTestId("platform/shell/content")).toHaveTextContent("暂无可用菜单");
    expect(screen.queryByTestId("platform/shell/conversation")).toBeNull();
  });
});
