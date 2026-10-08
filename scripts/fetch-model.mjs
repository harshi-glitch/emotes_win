// Downloads the web model files into extension/dist/model/ so the extension can
// serve them from chrome-extension:// and never touch the network at runtime.
// Pinned by commit + sha256 so builds are reproducible and tamper-evident.
//
//   node scripts/fetch-model.mjs [--force]
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "extension", "dist", "model");

const COMMIT = "e6aa335ab18c2a68c70b48a090b24b2977925e85";
const BASE = `https://huggingface.co/desert-ant-labs/emo/resolve/${COMMIT}`;

const FILES = [
  { name: "emo.tflite", size: 10_222_736, sha256: "2c382e8da94bab64172c0694b0350abb96829bf89eb623008ed0085128621de2" },
  { name: "emo_tokenizer.bin", size: 733_197, sha256: "f54462a7a2344f15c9430ed4e399c49444f890dd6094c745a0c5391690bf019d" },
  { name: "emo_meta.json", size: 6_280, sha256: null },
];

const force = process.argv.includes("--force");
mkdirSync(outDir, { recursive: true });

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

let downloaded = 0;
for (const file of FILES) {
  const dest = join(outDir, file.name);
  if (existsSync(dest) && !force) {
    if (file.sha256 && sha256(dest) !== file.sha256) {
      console.log(`[fetch-model] ${file.name} corrupt, redownloading`);
      rmSync(dest);
    } else {
      console.log(`[fetch-model] ${file.name} present`);
      continue;
    }
  }
  process.stdout.write(`[fetch-model] ${file.name} ... `);
  const res = await fetch(`${BASE}/${file.name}`, { redirect: "follow" });
  if (!res.ok) {
    console.log("FAILED");
    throw new Error(`${res.status} ${res.statusText} for ${file.name}`);
  }
  await pipeline(res.body, createWriteStream(dest));
  const hash = sha256(dest);
  if (file.sha256 && hash !== file.sha256) {
    rmSync(dest);
    throw new Error(`sha256 mismatch for ${file.name}: got ${hash}`);
  }
  console.log(`ok (${(file.size / 1048576).toFixed(2)} MB)`);
  downloaded++;
}

console.log(
  downloaded
    ? `[fetch-model] done, commit ${COMMIT.slice(0, 8)}`
    : `[fetch-model] up to date, commit ${COMMIT.slice(0, 8)}`,
);
