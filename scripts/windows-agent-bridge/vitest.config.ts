import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "../.."),
  test: {
    environment: "node",
    include: ["scripts/windows-agent-bridge/**/*.test.ts"],
    maxWorkers: 1,
    pool: "forks",
  },
});
