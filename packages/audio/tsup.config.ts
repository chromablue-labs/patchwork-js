import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", visualizers: "src/visualizers.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
});
