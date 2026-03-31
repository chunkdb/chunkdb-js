import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    outDir: "dist/esm",
    target: "node20",
    sourcemap: true,
    clean: true,
  },
  {
    entry: ["src/index.ts"],
    format: ["cjs"],
    outDir: "dist/cjs",
    target: "node20",
    sourcemap: true,
    clean: false,
    outExtension() {
      return { js: ".cjs" };
    },
  },
]);
