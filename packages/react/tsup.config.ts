import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  external: ["react", "@usepatchwork/client"],
  // The audio engine ships inside the SDK: a consumer installs one package and
  // gets voice. It is a dependency rather than a devDependency so the types
  // resolve, and tsup externalises dependencies by default — hence noExternal.
  noExternal: ["@usepatchwork/audio"],
});
