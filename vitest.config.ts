import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/adapter/test/**/*.test.ts", "packages/bff/test/**/*.test.ts"] },
});
