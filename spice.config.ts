import { resolve } from "node:path";
import { defineConfig } from "@spicemod/creator";

// Learn more: https://github.com/sanoojes/spicetify-creator
export default defineConfig({
  name: "playlist-manager",
  framework: "vanilla",
  linter: "biome",
  template: "extension",
  packageManager: "bun",
  esbuildOptions: {
    format: "iife",
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
