// Builds the extension and packs it into the archive the Chrome Web Store
// upload expects: manifest.json at the root of the zip, not inside a folder.
//
//   node scripts/package.mjs
//
// The result lands in release/emo-<version>.zip, ready for
// https://chrome.google.com/webstore/devconsole
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "extension", "dist");
const release = join(root, "release");

const build = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const version = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")).version;
mkdirSync(release, { recursive: true });
const zip = join(release, `emo-${version}.zip`);
rmSync(zip, { force: true });

// Entry names have to use forward slashes, or Chrome unpacks "icons\icon16.png"
// as one literal file and the icons and model files go missing after install.
// Windows' built-in tar (bsdtar) does this correctly; PowerShell's Compress-Archive
// does not. Listing the top level explicitly also keeps the archive root clean.
const win = process.platform === "win32";
const contents = readdirSync(dist);
const packed = win
  ? spawnSync("C:\\Windows\\System32\\tar.exe", ["-a", "-cf", zip, "-C", dist, ...contents], { stdio: "inherit" })
  : spawnSync("zip", ["-r", "-q", zip, "."], { cwd: dist, stdio: "inherit" });
if (packed.status !== 0) {
  console.error(
    win
      ? "C:\\Windows\\System32\\tar.exe failed - it ships with Windows 10 1803 and later"
      : "zip failed - install zip, or run this on Windows",
  );
  process.exit(packed.status ?? 1);
}

// A zip whose first entry is nested one directory deep is rejected by the store.
const check = win
  ? spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead('${zip}').Entries | Select-Object -ExpandProperty FullName`],
      { encoding: "utf8" },
    )
  : spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" });
const entries = (check.stdout ?? "").split(/\r?\n/).filter(Boolean);
if (!entries.includes("manifest.json")) {
  console.error(`manifest.json is not at the root of ${zip} - entries: ${entries.slice(0, 6).join(", ") || "unreadable"}`);
  process.exit(1);
}
if (entries.some((e) => e.includes("\\"))) {
  console.error(`${zip} contains backslash entry names - Chrome will not unpack them`);
  process.exit(1);
}

const mb = (statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`\n[package] ${zip} - ${entries.length} entries, ${mb} MB`);
console.log("[package] upload it at https://chrome.google.com/webstore/devconsole");
