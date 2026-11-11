import { pinyin } from "pinyin-pro";

const projectCodePattern = /^[a-z][a-z0-9-]{0,62}$/;

export function isProjectCode(code: string): boolean {
  return projectCodePattern.test(code);
}

export function suggestProjectCode(name: string): { code: string } | { reason: string } {
  const tokens = pinyin(name.trim(), { toneType: "none", type: "array", nonZh: "consecutive" });
  const parts = tokens.map((token) => token.toLowerCase().replace(/[^a-z0-9]+/g, "")).filter((part) => part.length > 0);
  let code = parts.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (code.length > 63) {
    code = code.slice(0, 63).replace(/-+$/g, "");
  }
  if (!isProjectCode(code)) {
    return { reason: "无法生成项目编码" };
  }
  return { code };
}
