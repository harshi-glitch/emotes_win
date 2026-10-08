import type { Plugin } from "vite";

// LiteRT loads its wasm glue with either document.createElement("script") (DOM)
// or importScripts() (classic workers) - never with a dynamic import(). The glue
// is instead bundled statically into offscreen.js (see offscreen.ts), where its
// patched footer sets self.ModuleFactory, so createWasmLib skips script loading.
// The only code the WebAssembly core asks to compile is a Unicode normalization
// helper, and extension/offscreen/eval-shim.ts hands it that helper pre-written,
// so nothing here ever needs 'unsafe-eval'.
export function litertModuleGluePlugin(): Plugin {
  return {
    name: "litert-module-glue",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("@litertjs/wasm-utils/dist/index.js")) return;
      if (!code.includes("importScripts(scriptUrl.toString())")) return;
      return code.replace(
        '  if (typeof importScripts === "function") {\n    importScripts(scriptUrl.toString());\n  } else {',
        "  if (self.ModuleFactory) return;\n  if (typeof importScripts === \"function\") {\n    importScripts(scriptUrl.toString());\n  } else {",
      );
    },
  };
}