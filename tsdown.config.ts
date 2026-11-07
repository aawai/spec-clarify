import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  target: "node24",
  platform: "node",
  dts: { entry: ["src/index.ts"] },
  clean: true,
  sourcemap: true,
});
