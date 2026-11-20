import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["apps/**/test/**/*.test.ts"],
          environment: "node",
          globalSetup: ["apps/control-plane/test/restore-admin.ts"],
          poolOptions: {
            forks: { singleFork: true },
          },
        },
      },
      {
        test: {
          name: "portal",
          include: ["apps/portal/src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["apps/portal/src/test-setup.ts"],
        },
      },
      {
        test: {
          name: "runtime",
          include: ["apps/control-plane/test/runtime.test.mjs", "apps/control-plane/test/node-agent.test.mjs", "apps/control-plane/test/entry-proxy.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
