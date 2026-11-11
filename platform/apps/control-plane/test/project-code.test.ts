import { describe, expect, it } from "vitest";
import { suggestProjectCode } from "../src/project-code.js";

describe("suggestProjectCode", () => {
  it("turns Chinese and Latin names into a project code", () => {
    expect(suggestProjectCode("请假审批")).toEqual({ code: "qing-jia-shen-pi" });
    expect(suggestProjectCode("OA系统")).toEqual({ code: "oa-xi-tong" });
  });

  it("explains when a name cannot become a code", () => {
    expect(suggestProjectCode("!!!")).toEqual({ reason: "无法生成项目编码" });
  });
});
