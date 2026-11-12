import type { StoredTestCase } from "./test-cases.js";

export type TestStepOutcome = {
  caseCode: string;
  caseName: string;
  stepIndex: number;
  method: string;
  /** 定位方式：稳定标识 | 角色+可访问名称 | 上次成功定位记录；白盒为入口名 */
  locator?: string;
  /** 执行器应原样带回本步 { action, target, value }，供回放复现；缺失时控制面按案例步骤补齐 */
  input?: unknown;
  expected?: string;
  actual?: string;
  passed: boolean;
  reason?: string;
};

export type TestExecutionInput = {
  projectCode: string;
  imageDigest: string;
  databaseName: string;
  cases: StoredTestCase[];
  stepTimeoutSeconds: number;
  runTimeoutSeconds: number;
  modelBaseUrl: string;
  modelName: string;
  modelApiKey: string;
};

export type TestExecutionResult = { steps: TestStepOutcome[] } | { reason: string };

export type TestExecutor = (input: TestExecutionInput) => Promise<TestExecutionResult>;

/**
 * 默认执行器：平台侧编排与记录已就绪，真实执行器（黑盒 Midscene.js + Playwright、
 * 白盒 Vitest 容器入口）在测试区接入时，通过 buildServer({ testExecutor }) 注入。
 * 未配置时明确失败，绝不生成虚假的通过记录。
 */
export function defaultTestExecutor(): TestExecutor {
  return async () => ({ reason: "测试执行器未配置：Midscene.js 与 Vitest 白盒入口在测试区接入" });
}
