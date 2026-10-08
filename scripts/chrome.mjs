// Locates a Chromium-family browser to drive. This repo used to hardcode a Linux
// Chrome-for-Testing binary, which cannot run on Windows or macOS at all.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SYSTEM = {
  win32: [
    process.env["PROGRAMFILES"],
    process.env["PROGRAMFILES(X86)"],
    process.env["LOCALAPPDATA"],
  ]
    .filter(Boolean)
    .flatMap((base) => [
      join(base, "Google/Chrome/Application/chrome.exe"),
      join(base, "Microsoft/Edge/Application/msedge.exe"),
    ]),
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"],
}[platform()] ?? [];

/** The bundled Chrome for Testing, if present: the only build guaranteed to
 *  honour --load-extension, since branded Chrome ignores it on Windows/macOS.
 *  Layout varies by installer (`chrome/win64-<ver>/chrome-win64/…`), so search. */
function bundled() {
  const dir = join(root, "chrome");
  if (!existsSync(dir)) return null;
  const wanted =
    platform() === "win32"
      ? [join("chrome-win64", "chrome.exe")]
      : platform() === "darwin"
        ? [join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")]
        : [join("chrome-linux64", "chrome")];
  const found = [];
  const walk = (at, depth) => {
    if (depth > 3) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(at, entry.name);
      for (const pattern of wanted) {
        const candidate = join(child, pattern);
        if (existsSync(candidate)) found.push(candidate);
      }
      walk(child, depth + 1);
    }
  };
  walk(dir, 0);
  // Newest build first: version strings sort lexicographically well enough here.
  return found.sort().reverse()[0] ?? null;
}

export function findBrowser() {
  if (process.env.CHROME_BIN) {
    if (!existsSync(process.env.CHROME_BIN)) throw new Error(`CHROME_BIN does not exist: ${process.env.CHROME_BIN}`);
    return { bin: process.env.CHROME_BIN, branded: false };
  }
  const testing = bundled();
  if (testing) return { bin: testing, branded: false };
  const system = SYSTEM.find(existsSync);
  if (system) return { bin: system, branded: true };
  throw new Error("no Chromium browser found - install Chrome, or set CHROME_BIN");
}
