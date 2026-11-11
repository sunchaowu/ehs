import { createHash } from "node:crypto";

export type DesignDocument = {
  projectCode: string;
  containerGroup: string;
  menus: Array<{ code: string; name: string; parentCode: string | null; sort: number }>;
  grants: Array<{ principalType: string; principalName: string; menuCode: string; action: string }>;
  entities: Array<{ name: string; fields: Array<{ name: string; type: string; target?: string }> }>;
  workflows: Array<{ name: string; steps: string[] }>;
  extensions: Array<{ name: string }>;
};

export function compileDesign(design: DesignDocument): { sourceRevision: string; files: Record<string, string> } {
  const normalized = normalizeDesign(design);
  const root = `modules/${normalized.projectCode}`;
  const files: Record<string, string> = {
    [`${root}/module.ts`]: moduleSource(normalized),
  };
  if (normalized.extensions.length > 0) {
    files[`${root}/extension.ts`] = `export const extensions = ${JSON.stringify(normalized.extensions, null, 2)};\n`;
  }
  return { sourceRevision: `sha256:${createHash("sha256").update(stableBytes(files)).digest("hex")}`, files };
}

function normalizeDesign(design: DesignDocument): DesignDocument {
  return {
    projectCode: design.projectCode,
    containerGroup: design.containerGroup,
    menus: [...design.menus].sort(byCode),
    grants: [...design.grants].sort(byGrant),
    entities: [...design.entities]
      .map((entity) => ({
        name: entity.name,
        fields: [...entity.fields]
          .map((field) => (field.target ? { name: field.name, type: field.type, target: field.target } : { name: field.name, type: field.type }))
          .sort(byName),
      }))
      .sort(byName),
    workflows: [...design.workflows]
      .map((workflow) => ({ name: workflow.name, steps: [...workflow.steps] }))
      .sort(byName),
    extensions: [...design.extensions].sort(byName),
  };
}

function moduleSource(design: DesignDocument): string {
  const definition = {
    projectCode: design.projectCode,
    containerGroup: design.containerGroup,
    menus: design.menus,
    grants: design.grants,
    entities: design.entities,
    workflows: design.workflows,
  };
  return `import { createStandardModule } from "@platform/runtime";\n\nexport const moduleDefinition = createStandardModule(${JSON.stringify(definition, null, 2)});\n`;
}

function stableBytes(files: Record<string, string>): string {
  return Object.keys(files)
    .sort()
    .map((file) => `${file}\n${files[file]}`)
    .join("\n");
}

function byName<T extends { name: string }>(left: T, right: T): number {
  return left.name.localeCompare(right.name);
}

function byCode(left: { code: string }, right: { code: string }): number {
  return left.code.localeCompare(right.code);
}

function byGrant(
  left: { principalType: string; principalName: string; menuCode: string; action: string },
  right: { principalType: string; principalName: string; menuCode: string; action: string },
): number {
  return `${left.principalType}\n${left.principalName}\n${left.menuCode}\n${left.action}`.localeCompare(
    `${right.principalType}\n${right.principalName}\n${right.menuCode}\n${right.action}`,
  );
}
