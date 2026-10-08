import { defineConfig } from "vite";
import { resolve } from "node:path";
import { litertModuleGluePlugin } from "./scripts/vite-plugins.ts";

// One config, five bundles. `npm run build` (see scripts/build.mjs) invokes this
// once per target with EMO_TARGET set, because each extension context needs its
// own single self-contained file: a loadable extension cannot rely on Vite's
// chunk graph or dynamic imports.
//
//   content    → isolated-world overlay, small, no model
//   background → service worker: offscreen lifecycle + request relay
//   offscreen  → the model host (WASM + LiteRT + the emo core)
//   popup      → toolbar GUI
//   options    → settings GUI
const TARGETS: Record<string, { entry: string; out: string; plugins?: boolean }> = {
  content: { entry: "extension/content/content.ts", out: "content" },
  background: { entry: "extension/background/sw.ts", out: "sw" },
  offscreen: { entry: "extension/offscreen/offscreen.ts", out: "offscreen", plugins: true },
  popup: { entry: "extension/popup/popup.ts", out: "popup" },
  options: { entry: "extension/options/options.ts", out: "options" },
};

const name = process.env.EMO_TARGET as keyof typeof TARGETS | undefined;
const target = name ? TARGETS[name] : undefined;
if (!name || !target) {
  throw new Error(`EMO_TARGET must be one of: ${Object.keys(TARGETS).join(", ")}`);
}

export default defineConfig({
  build: {
    outDir: "extension/dist",
    emptyOutDir: false,
    target: "esnext",
    sourcemap: false,
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, target.entry),
      formats: ["es"],
      fileName: () => `${target.out}.js`,
    },
    rollupOptions: {
      output: { codeSplitting: false },
    },
  },
  plugins: target.plugins ? [litertModuleGluePlugin()] : [],
});
