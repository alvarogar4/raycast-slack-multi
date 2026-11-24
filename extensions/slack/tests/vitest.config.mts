import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@raycast/api": fileURLToPath(new URL("./raycast.ts", import.meta.url)) } },
  test: { include: ["tests/*.spec.ts"] },
});
