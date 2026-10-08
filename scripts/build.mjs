// Builds every extension context into extension/dist, then copies the static
// assets around it. Run with `npm run build`.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "extension", "dist");

const TARGETS = ["background", "content", "offscreen", "options", "popup"];

// Flattened into dist/ next to their bundles, since an extension page can only
// reference siblings by relative URL.
const HTML = ["offscreen/offscreen.html", "popup/popup.html", "options/options.html"];
const CSS = ["popup/popup.css", "options/options.css"];

const WASM = [
  ["node_modules/@desert-ant-labs/emo/dist/EmoWeb.wasm", "EmoWeb.wasm"],
  ["node_modules/@litertjs/core/wasm/litert_wasm_internal.wasm", "litert_wasm_internal.wasm"],
];

function run(args, env) {
  const vite = join(root, "node_modules", "vite", "bin", "vite.js");
  const result = spawnSync(process.execPath, [vite, ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`vite ${args.join(" ")} failed (exit ${result.status})`);
}

function node(script) {
  const result = spawnSync(process.execPath, [script], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${script} failed (exit ${result.status})`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const target of TARGETS) run(["build", "--config", "vite.config.ts"], { EMO_TARGET: target });

const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
writeFileSync(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(root, "extension", "icons"), join(dist, "icons"), { recursive: true });

for (const file of HTML) {
  cpSync(join(root, "extension", file), join(dist, file.split("/").pop()));
}
for (const file of CSS) {
  const src = join(root, "extension", file);
  if (existsSync(src)) cpSync(src, join(dist, file.split("/").pop()));
}
for (const [from, to] of WASM) cpSync(join(root, from), join(dist, to));

node("scripts/fetch-model.mjs");

const built = new Set(readdirSync(dist));
for (const required of ["sw.js", "content.js", "offscreen.js", "popup.js", "options.js"]) {
  if (!built.has(required)) throw new Error(`${required} missing from dist - build incomplete`);
}

console.log(`[build] extension/dist ready (${[...built].filter((f) => !f.startsWith("model")).length} entries)`);
