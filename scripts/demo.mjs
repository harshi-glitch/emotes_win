// Serves a test page and opens a visible browser with the built extension, so
// suggestions can be tried by hand.
//
//   npm run build && npm run demo
//
// Env: PORT (default 8099), CHROME_BIN to force a specific browser.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser } from "./chrome.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.env.EMO_DIST ? resolve(process.env.EMO_DIST) : join(root, "extension", "dist");
const port = Number(process.env.PORT ?? 8099);

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("extension/dist not built - run: npm run build");
  process.exit(1);
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Emo demo</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 40px; max-width: 720px; background:#0f1115; color:#e6e9ef; }
  h1 { font-size: 22px; }
  input, textarea { width: 100%; padding: 10px; font: inherit; border: 1px solid #2c323c; border-radius: 8px; background:#171a20; color:inherit; }
  .row { margin: 16px 0; }
  p { color:#98a2b3; }
</style></head>
<body>
  <h1>Emo demo</h1>
  <p>Click the field and type a phrase. Chips float up under the caret. Click one to insert it. <b>Esc</b> dismisses, <b>Alt+Shift+E</b> asks again. Everything else in this browser is a real site: type in any field anywhere and the same chips appear, in any tab and inside iframes.</p>
  <div class="row"><input id="single" placeholder="pay my bills today" autofocus></div>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});

server.listen(port, () => {
  const { bin, branded } = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), "emo-demo-"));
  console.log(`demo page: http://localhost:${port}/`);
  console.log(`browser:   ${bin}`);
  if (branded) {
    console.log(
      "\nWARNING: branded Chrome ignores --load-extension on Windows. Load the\n" +
        "extension manually at chrome://extensions (Developer mode -> Load unpacked)\n" +
        `pointing at ${dist}\n`,
    );
  }
  const child = spawn(bin, [`--user-data-dir=${profile}`, `--load-extension=${dist}`, "--no-first-run", `http://localhost:${port}/`], {
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    server.close();
    process.exit(code ?? 0);
  });
});
