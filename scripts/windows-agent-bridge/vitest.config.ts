import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    environment: "node",
    include: ["scripts/windows-agent-bridge/**/*.test.ts"],
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    testTimeout: 15_000,
  },
});
