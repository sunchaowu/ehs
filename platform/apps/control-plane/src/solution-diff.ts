export type DraftMenu = { code: string; name: string; parent_code: string | null };
export type DraftGrant = { principal_type: string; principal_name: string; menu_code: string; action: string };

export type MenuChange = {
  kind: "menu";
  code: string;
  changes: {
    name?: { from: string; to: string };
    parent_code?: { from: string | null; to: string | null };
  };
};

export type GrantChange = {
  kind: "grant";
  principal_type: string;
  principal_name: string;
  menu_code: string;
  added_actions: string[];
  removed_actions: string[];
};

export type SolutionChange = {
  added: { menus: DraftMenu[]; grants: DraftGrant[] };
  modified: Array<MenuChange | GrantChange>;
  removed: { menus: DraftMenu[]; grants: DraftGrant[] };
};

type Side = { menus: DraftMenu[]; grants: DraftGrant[] };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareMenu(left: DraftMenu, right: DraftMenu): number {
  return compareText(left.code, right.code);
}

function grantKey(grant: Pick<DraftGrant, "principal_type" | "principal_name" | "menu_code">): string {
  return JSON.stringify([grant.principal_type, grant.principal_name, grant.menu_code]);
}

function compareGrant(left: DraftGrant, right: DraftGrant): number {
  const byKey = compareText(grantKey(left), grantKey(right));
  return byKey === 0 ? compareText(left.action, right.action) : byKey;
}

function groupActions(grants: DraftGrant[]): Map<string, { sample: DraftGrant; actions: Set<string> }> {
  const result = new Map<string, { sample: DraftGrant; actions: Set<string> }>();
  for (const grant of [...grants].sort(compareGrant)) {
    const key = grantKey(grant);
    const entry = result.get(key) ?? { sample: grant, actions: new Set<string>() };
    entry.actions.add(grant.action);
    result.set(key, entry);
  }
  return result;
}

/**
 * 草稿相对已发布版本的增量。菜单按编码比对名称与上级；授权按主体+菜单分组比对动作集合。
 * 结果稳定排序，便于 OpenSpec 记录、页面展示和重复确认比对。
 */
export function diffSolution(draft: Side, published: Side): SolutionChange {
  const draftMenus = new Map([...draft.menus].sort(compareMenu).map((menu) => [menu.code, menu]));
  const publishedMenus = new Map([...published.menus].sort(compareMenu).map((menu) => [menu.code, menu]));
  const added: SolutionChange["added"] = { menus: [], grants: [] };
  const removed: SolutionChange["removed"] = { menus: [], grants: [] };
  const modified: SolutionChange["modified"] = [];

  for (const [code, menu] of draftMenus) {
    const before = publishedMenus.get(code);
    if (!before) {
      added.menus.push(menu);
      continue;
    }
    const changes: MenuChange["changes"] = {};
    if (before.name !== menu.name) {
      changes.name = { from: before.name, to: menu.name };
    }
    if (before.parent_code !== menu.parent_code) {
      changes.parent_code = { from: before.parent_code, to: menu.parent_code };
    }
    if (Object.keys(changes).length > 0) {
      modified.push({ kind: "menu", code, changes });
    }
  }
  for (const [code, menu] of publishedMenus) {
    if (!draftMenus.has(code)) {
      removed.menus.push(menu);
    }
  }

  const draftGrants = groupActions(draft.grants);
  const publishedGrants = groupActions(published.grants);
  for (const [key, current] of draftGrants) {
    const before = publishedGrants.get(key);
    if (!before) {
      added.grants.push(...[...current.actions].sort(compareText).map((action) => ({ ...current.sample, action })));
      continue;
    }
    const addedActions = [...current.actions].filter((action) => !before.actions.has(action)).sort(compareText);
    const removedActions = [...before.actions].filter((action) => !current.actions.has(action)).sort(compareText);
    if (addedActions.length > 0 || removedActions.length > 0) {
      modified.push({
        kind: "grant",
        principal_type: current.sample.principal_type,
        principal_name: current.sample.principal_name,
        menu_code: current.sample.menu_code,
        added_actions: addedActions,
        removed_actions: removedActions,
      });
    }
  }
  for (const [key, before] of publishedGrants) {
    if (!draftGrants.has(key)) {
      removed.grants.push(...[...before.actions].sort(compareText).map((action) => ({ ...before.sample, action })));
    }
  }

  added.menus.sort(compareMenu);
  removed.menus.sort(compareMenu);
  added.grants.sort(compareGrant);
  removed.grants.sort(compareGrant);
  modified.sort((left, right) => {
    // 菜单变更排在授权变更之前，再按各自稳定键排序。
    if (left.kind !== right.kind) {
      return left.kind === "menu" ? -1 : 1;
    }
    const leftKey = left.kind === "menu" ? left.code : grantKey(left);
    const rightKey = right.kind === "menu" ? right.code : grantKey(right);
    return compareText(leftKey, rightKey);
  });
  return { added, modified, removed };
}
