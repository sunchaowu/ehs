import { describe, expect, it } from "vitest";
import { diffSolution, type DraftGrant, type DraftMenu } from "../src/solution-diff.js";

const menu = (code: string, name: string, parent_code: string | null = null): DraftMenu => ({ code, name, parent_code });
const grant = (principal_name: string, menu_code: string, action: string): DraftGrant => ({
  principal_type: "user",
  principal_name,
  menu_code,
  action,
});

describe("solution diff", () => {
  it("treats the first draft as all added", () => {
    const change = diffSolution(
      { menus: [menu("leave", "请假单")], grants: [grant("alice", "leave", "访问")] },
      { menus: [], grants: [] },
    );
    expect(change.added.menus).toEqual([menu("leave", "请假单")]);
    expect(change.added.grants).toEqual([grant("alice", "leave", "访问")]);
    expect(change.modified).toEqual([]);
    expect(change.removed).toEqual({ menus: [], grants: [] });
  });

  it("reports renames, parent changes, and action changes as modifications", () => {
    const change = diffSolution(
      {
        menus: [menu("leave", "请假申请", "org")],
        grants: [grant("alice", "leave", "访问"), grant("alice", "leave", "修改")],
      },
      {
        menus: [menu("leave", "请假单", null)],
        grants: [grant("alice", "leave", "访问"), grant("alice", "leave", "删除")],
      },
    );
    expect(change.added).toEqual({ menus: [], grants: [] });
    expect(change.removed).toEqual({ menus: [], grants: [] });
    expect(change.modified).toEqual([
      {
        kind: "menu",
        code: "leave",
        changes: {
          name: { from: "请假单", to: "请假申请" },
          parent_code: { from: null, to: "org" },
        },
      },
      {
        kind: "grant",
        principal_type: "user",
        principal_name: "alice",
        menu_code: "leave",
        added_actions: ["修改"],
        removed_actions: ["删除"],
      },
    ]);
  });

  it("reports deleted menus and grants, and keeps results stable", () => {
    const change = diffSolution(
      { menus: [menu("b", "B")], grants: [] },
      { menus: [menu("z", "Z"), menu("a", "A", "z")], grants: [grant("bob", "z", "访问")] },
    );
    expect(change.removed.menus).toEqual([menu("a", "A", "z"), menu("z", "Z")]);
    expect(change.removed.grants).toEqual([grant("bob", "z", "访问")]);
    expect(change.added).toEqual({ menus: [menu("b", "B")], grants: [] });
  });

  it("produces no change for identical sides", () => {
    const sides = {
      menus: [menu("leave", "请假单", "org"), menu("org", "组织")],
      grants: [grant("alice", "leave", "访问"), grant("alice", "leave", "新增")],
    };
    expect(diffSolution(sides, sides)).toEqual({ added: { menus: [], grants: [] }, modified: [], removed: { menus: [], grants: [] } });
  });
});
