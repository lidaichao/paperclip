import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/windows-agent-bridge/*.test.ts"],
    testTimeout: 15_000,
  },
});
