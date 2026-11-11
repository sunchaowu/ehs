import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["apps/**/test/**/*.test.ts"],
          environment: "node",
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
    ],
  },
});
