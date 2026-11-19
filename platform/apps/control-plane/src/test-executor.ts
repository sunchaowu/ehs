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
 * 生产路径不再在控制面进程内执行测试。控制面把用例下发给测试节点，
 * 节点在候选镜像容器里运行 `test-runner.mjs` 并回报步骤；`buildServer({ testExecutor })`
 * 只用于测试注入同步执行器。未注入时走 `node-tests.ts` 的异步任务。
 */
