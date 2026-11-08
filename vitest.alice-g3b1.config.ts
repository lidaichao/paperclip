import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@paperclipai\/db$/, replacement: fileURLToPath(new URL("./packages/db/src/index.ts", import.meta.url)) },
      { find: /^@paperclipai\/shared$/, replacement: fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)) },
    ],
  },
  test: {
    include: [
      "packages/db/src/work-record-view-preferences-migration.test.ts",
      "server/src/__tests__/work-record-view-preferences.test.ts",
      "server/src/__tests__/work-record-view-preference-routes.test.ts",
    ],
    hookTimeout: 90_000,
    teardownTimeout: 30_000,
    testTimeout: 30_000,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    setupFiles: ["./server/src/__tests__/setup-supertest.ts"],
  },
});
