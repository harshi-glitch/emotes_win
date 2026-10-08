// Headless smoke test that drives the real built extension in a real browser.
//
//   npm run build && node scripts/e2e.mjs
//
// Proves the two things the old build could not: suggestions appear while typing,
// and they still appear on a page whose Content-Security-Policy blocks all inline
// and cross-origin scripts.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser } from "./chrome.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// EMO_DIST lets the test run against an unpacked release archive, so the exact
// bytes that go to the store get exercised rather than only the build tree.
const dist = process.env.EMO_DIST ? resolve(process.env.EMO_DIST) : join(root, "extension", "dist");

const PORT = Number(process.env.PORT ?? 8123);
const CDP = 9333;
const origin = `http://127.0.0.1:${PORT}`;

const PAGES = {
  "/": `<!doctype html><meta charset="utf-8"><title>e2e</title>
    <body><input id="f" placeholder="type here"><textarea id="t"></textarea></body>`,
  // No script may run on this page, extension-provided ones included. The
  // suggestion chips must be unaffected, because they never live here.
  "/strict": `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none';">
    <title>e2e strict</title><body><input id="f" placeholder="type here"></body>`,
  // Web mailboxes, docs editors and help widgets build their text area as an
  // iframe. The compose box here is deliberately not the top-level document.
  "/inner": `<!doctype html><meta charset="utf-8"><body style="margin:0"><input id="f" style="width:96%;margin:8px" placeholder="type here"></body>`,
  "/frame": `<!doctype html><meta charset="utf-8"><title>e2e frame</title>
    <body><iframe id="editor" src="/inner" style="width:600px;height:200px;border:1px solid #888"></iframe></body>`,
};

const server = createServer((req, res) => {
  const html = PAGES[req.url.split("?")[0]] ?? PAGES["/"];
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const userDataDir = mkdtempSync(join(tmpdir(), "emo-e2e-"));
const { bin, branded } = findBrowser();
console.log(`browser: ${bin}${branded ? " (branded: --load-extension may be ignored)" : ""}`);

// HEADED=1 removes every convenience flag the headless run needs, so the test
// exercises the same browser a user gets: no timer-throttling escape hatch,
// sandbox on, real window.
const headed = process.env.HEADED === "1";

const proc = spawn(bin, [
  `--user-data-dir=${userDataDir}`,
  `--load-extension=${dist}`,
  "--enable-extensions",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${CDP}`,
  ...(headed
    ? []
    : [
        "--headless=new",
        "--disable-gpu",
        // Chrome for Testing's headless pages all count as backgrounded, which freezes
        // their timers. The offscreen host schedules work with setTimeout, so without
        // these the model loads but a suggestion never resolves.
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        // Chrome's sandbox cannot read a Chrome-for-Testing binary in a user-writable
        // path on this machine; headless CI launches conventionally drop it here.
        "--no-sandbox",
      ]),
  "about:blank",
]);
proc.stderr.on("data", (d) => {
  const line = String(d);
  if (/(uncaught|error|fatal)/i.test(line) && !/DevTools|GPU|dbus|FontHelper/.test(line)) process.stderr.write(line);
});

let failures = 0;
// Whether the model has served anything yet: the first answer of a session pays
// for loading it, every later one is expected to be quick.
let warmed = false;
const ok = (msg) => console.log(`  ok   ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const done = (code) => {
  proc.kill("SIGKILL");
  server.close();
  // Chrome holds a lock on the profile briefly after SIGKILL on Windows.
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
      break;
    } catch {
      const until = Date.now() + 400;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  process.exit(code);
};

// ---------------------------------------------------------------- devtools
// Keep asking until the extension's worker shows up: the DevTools endpoint comes
// up before Chrome has finished installing an unpacked extension, and a target
// list without our worker in it is not a final answer.
let targets = [];
for (let i = 0; i < 60 && !targets.some((t) => t.type === "service_worker" && t.url.endsWith("/sw.js")); i++) {
  await new Promise((r) => setTimeout(r, 500));
  targets = await fetch(`http://127.0.0.1:${CDP}/json/list`)
    .then((r) => r.json())
    .catch(() => targets);
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => {
      ws.addEventListener("open", r, { once: true });
      ws.addEventListener("error", j, { once: true });
    });
    return new Session(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const r = res.result ?? {};
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(page, expression, timeoutMs, everyMs = 100) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const value = await page.evaluate(expression);
      if (value) return value;
    } catch {
      /* the page navigated mid-poll */
    }
    await sleep(everyMs);
  }
  return null;
}

// ------------------------------------------------------- extension presence
const worker = targets.find((t) => t.type === "service_worker" && t.url.endsWith("sw.js"));

if (!worker) {
  const seen = targets.map((t) => `${t.type} ${t.url.slice(0, 70)}`).join("\n      ");
  bad(`the extension service worker did not start. targets:\n      ${seen}`);
  console.log("\nHINT: branded Chrome ignores --load-extension. Install Chrome for Testing\n" + "      (npx @puppeteer/browsers install chrome@stable --path ./chrome) and re-run.");
  done(1);
}
ok("service worker is running");

const pageTarget = targets.find((t) => t.type === "page");
const page = await Session.open(pageTarget.webSocketDebuggerUrl);
await page.send("Page.enable");
await page.send("Runtime.enable");
await page.send("Log.enable");

// ------------------------------------------------------------------- run it
/**
 * Real keystrokes over CDP, one character at a time. Setting `.value` and
 * dispatching an `input` event proves nothing about what a person typing on a
 * keyboard actually sees - it skips focus handling, the caret, the debounce, and
 * every intermediate state, so a field that looks dead to a user can still pass.
 */
function keyEvents(ch) {
  const isLetter = /[a-z]/i.test(ch);
  const upper = ch.toUpperCase();
  const code = ch === " " ? "Space" : isLetter ? `Key${upper}` : `Digit${ch}`;
  const vk = ch === " " ? 32 : isLetter ? upper.charCodeAt(0) : ch.charCodeAt(0);
  const key = ch === " " ? " " : ch;
  return [
    { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: key },
    { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk },
  ];
}

/**
 * Headed Chrome drops `Input.dispatchKeyEvent` into whichever window the OS has
 * in front, and `Page.bringToFront` does not raise a background window - so in a
 * visible run the text arrives through the renderer's own insertion path
 * instead. That still fires the real `beforeinput`/`input` events a caret
 * produces; it only skips the key codes.
 */
async function typePhrase(session, doc, phrase) {
  await session.send("Page.bringToFront");
  await session.evaluate(`(() => {
    const f = ${doc}.getElementById("f");
    if (!f) throw new Error("the test page has no #f field");
    f.value = "";
    f.focus();
    return true;
  })()`);
  if (headed) {
    await session.send("Input.insertText", { text: phrase });
  } else {
    for (const ch of phrase) {
      for (const ev of keyEvents(ch)) await session.send("Input.dispatchKeyEvent", ev);
      await sleep(15);
    }
  }
  const landed = await session.evaluate(`${doc}.getElementById("f").value`);
  if (landed !== phrase) throw new Error(`typed ${JSON.stringify(phrase)}, field holds ${JSON.stringify(landed)}`);
}

/** Read the chip strip a real user sees, in whichever frame owns the caret. */
const chipsIn = (doc = "document") => `(() => {
  const host = ${doc}.getElementById("emo-host");
  if (!host) return null;
  const strip = host.shadowRoot.querySelector(".emo-chips");
  if (!strip || strip.hidden) return null;
  const found = [...strip.querySelectorAll(".emo-chip")];
  return found.length ? found.map((c) => c.textContent) : null;
})()`;

/** Whether the strip is absent or hidden, i.e. nothing is on screen. */
const quietIn = (doc = "document") => `(() => {
  const host = ${doc}.getElementById("emo-host");
  if (!host) return true;
  const strip = host.shadowRoot.querySelector(".emo-chips");
  return !strip || strip.hidden;
})()`;

async function trySite(session, { path = "", phrase, doc = "document", navigate = true, label }) {
  console.log(`\n${label ?? `${origin}${path}`}  ("${phrase}")`);
  if (navigate) {
    await session.send("Page.navigate", { url: `${origin}${path}` });
    await sleep(2500);
  }

  const chipsExpr = chipsIn(doc);
  // Latency is the difference between a tool and a toy, and "eventually it
  // appears" is not a passing grade. Timed from the first keystroke, because
  // chips that only arrive once the user has stopped typing are already late.
  const typedAt = Date.now();
  try {
    await typePhrase(session, doc, phrase);
  } catch (err) {
    bad(`could not type into the field: ${err.message}`);
    return false;
  }
  const chips = await until(session, chipsExpr, 90_000);
  const ms = Date.now() - typedAt;

  if (!chips) {
    bad(`no suggestion chips appeared in ${label ?? path}`);
    for (const event of session.events) {
      if (event.method === "Runtime.exceptionThrown") {
        console.log(`       throw: ${event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text}`);
      }
      if (event.method === "Log.entryAdded" && event.params.entry.level !== "info") {
        console.log(`       ${event.params.entry.level}: ${event.params.entry.text.slice(0, 220)}`);
      }
    }
    // The keystrokes are verified to have landed, so say which layer went quiet
    // after them: a question that was never asked, or one that got no answer.
    await session
      .evaluate(`(() => {
      const f = ${doc}.getElementById("f");
      f.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`)
      .catch(() => {});
    const synthetic = await until(session, chipsExpr, 20_000);
    console.log(
      synthetic
        ? `       note: another input event did produce chips (${synthetic.join(" ")}) - the keystroke was swallowed, not the answer`
        : `       note: a second request produced nothing either - the engine never answered`,
    );
    return false;
  }
  ok(`chips ${ms}ms after the first keystroke: ${chips.join(" ")}`);
  if (warmed && ms > 1500) bad(`took ${ms}ms from the first keystroke with the model already loaded - that is what "slow" feels like`);
  warmed = true;

  // A real click, at the chip's own coordinates. A synthetic `mousedown` never
  // moves the caret or blurs the field, which is exactly the hazard inserting at
  // the caret has to survive.
  const pos = await session.evaluate(`(() => {
    const d = ${doc};
    const chip = d.getElementById("emo-host").shadowRoot.querySelector(".emo-chip");
    const r = chip.getBoundingClientRect();
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    let win = d.defaultView;
    while (win && win !== window.top) {
      const fe = win.frameElement;
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      win = win.parent;
    }
    return { x: Math.round(x), y: Math.round(y) };
  })()`);
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1, buttons: 1 });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await sleep(150);
  const after = await session.evaluate(`${doc}.getElementById("f").value`);
  const inserted = after.length > phrase.length && /\p{Extended_Pictographic}/u.test(after.slice(phrase.length));
  if (!inserted) {
    bad(`clicking a chip did not insert an emoji: ${JSON.stringify(after)}`);
    return false;
  }
  ok(`chip click inserted at the caret: ${JSON.stringify(after)}`);
  return true;
}

await trySite(page, { path: "/", phrase: "pay my bills today" });
await trySite(page, { path: "/strict", phrase: "deploy the app to production" });
await trySite(page, {
  path: "/frame",
  phrase: "happy birthday to you",
  doc: `document.getElementById("editor").contentDocument`,
  label: "iframe editor (how web mail composes)",
});

// A second tab, open at the same time as the first: the whole point of the
// offscreen host is one model shared by every tab, so the new tab must get
// suggestions without a second model appearing anywhere.
console.log("\na second tab, with the first still open");
// /json/new is the browser-level way to open a tab: a Target.createTarget call
// made through a page session does come back with an id, but Chrome for Testing
// does not list the tab it creates on the page-scoped endpoint.
const created = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`${origin}/`)}`, { method: "PUT" })
  .then((r) => r.json())
  .catch(() => null);
let tab2Target = created?.webSocketDebuggerUrl ? created : null;
for (let i = 0; i < 15 && !tab2Target; i++) {
  await sleep(400);
  const l = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json()).catch(() => []);
  tab2Target = l.find((t) => t.type === "page" && t.url === `${origin}/` && t.targetId !== pageTarget.targetId) ?? null;
}
if (!tab2Target?.webSocketDebuggerUrl) {
  const seen = (await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json()).catch(() => []))
    .map((t) => `${t.type} ${t.url.slice(0, 60)}`)
    .join(", ");
  bad(`could not open a second tab. saw: ${seen.slice(0, 300)}`);
} else {
  const tab2 = await Session.open(tab2Target.webSocketDebuggerUrl);
  await tab2.send("Page.enable");
  await tab2.send("Runtime.enable");
  await tab2.send("Log.enable");
  const inTab2 = await trySite(tab2, { phrase: "ship the release today please", navigate: false, label: "second tab" });

  // The first tab must still work - a second tab must not evict anything.
  await page.send("Page.navigate", { url: `${origin}/` });
  await sleep(2000);
  await trySite(page, { phrase: "dentist appointment tomorrow", navigate: false, label: "first tab, afterwards" });

  const fresh = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
  const freshHosts = fresh.filter((t) => t.url.includes("offscreen.html")).length;
  if (inTab2 && freshHosts === 1) ok(`two tabs served by exactly one model host (${freshHosts} offscreen document)`);
  else bad(`expected one offscreen host for two tabs, saw ${freshHosts}`);
  tab2.close();
}

// Open the popup in a tab: chrome.runtime is unavailable to ordinary pages, but
// an extension page is a real GUI target we can drive and read.
const extensionBase = worker.url.replace(/\/sw\.js$/, "");
console.log("\npopup GUI");
await page.send("Page.navigate", { url: `${extensionBase}/popup.html` });
await sleep(2000);
await page.evaluate(`(() => {
  const t = document.getElementById("text");
  t.value = "homemade pasta for dinner";
  t.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
const popupResults = await until(
  page,
  `(() => {
    const found = [...document.querySelectorAll(".suggestion")];
    return found.length ? found.map((b) => b.textContent.replace(/\\d+$/, "")) : null;
  })()`,
  30_000,
);
if (popupResults) ok(`popup suggestions: ${popupResults.join(" ")}`);
else bad(`popup produced no suggestions - it says: ${JSON.stringify(await page.evaluate(`document.getElementById("results").textContent`))}`);

const modelLine = await page.evaluate(`document.getElementById("modelText").textContent`);
if (/loaded in \d+ms/.test(modelLine ?? "") && /[1-9]\d* calls/.test(modelLine ?? "")) ok(`model host: ${modelLine}`);
else bad(`model host did not report a load time and a served call: ${JSON.stringify(modelLine)}`);

// Options page: it must render every control, and a switch flipped there must
// change what the page itself does - otherwise it is decoration, not a GUI.
console.log("\noptions GUI");
await page.send("Page.navigate", { url: `${extensionBase}/options.html` });
await sleep(2000);
const missing = await page.evaluate(`(() => {
  const ids = ["enabled", "liveChips", "skinTone", "limit", "minChars", "debounceMs", "cooldownMs", "idleUnloadMinutes", "blockedHosts"];
  return ids.filter((i) => !document.getElementById(i));
})()`);
if (missing.length === 0) ok("every control renders");
else bad(`options page is missing: ${missing.join(", ")}`);

const optionsStatus = await page.evaluate(`document.getElementById("modelText").textContent`);
if (/\d+ suggestions served/.test(optionsStatus ?? "")) ok(`options model line: ${optionsStatus}`);
else bad(`options page did not report served calls: ${JSON.stringify(optionsStatus)}`);

async function setLiveChips(on) {
  await page.send("Page.navigate", { url: `${extensionBase}/options.html` });
  await sleep(1200);
  const read = await page.evaluate(`(() => {
    const box = document.getElementById("liveChips");
    box.checked = ${on ? "true" : "false"};
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return box.checked;
  })()`);
  await sleep(800);
  return read === on;
}

const typed = "ship the release today please";
if (!(await setLiveChips(false))) bad("the live-chips switch would not turn off");
await page.send("Page.navigate", { url: `${origin}/` });
await sleep(2000);
await page.evaluate(`(() => {
  const f = document.getElementById("f");
  f.focus();
  f.value = ${JSON.stringify(typed)};
  f.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await sleep(2500);
const quiet = await page.evaluate(quietIn());
if (quiet) ok("switching the option off stops the chips on the page");
else bad("chips still appeared after turning the live-chips option off");

if (!(await setLiveChips(true))) bad("the live-chips switch would not turn back on");
await trySite(page, { path: "/", phrase: typed });

// Dismissal has to be reversible from the keyboard, and the key that re-asks has
// to be one Chrome does not consume for itself - Alt+E opens Chrome's own menu on
// Windows, so it never reaches a page. A synthetic keydown cannot prove what the
// browser swallows; it can prove our handler answers the binding we settled on.
console.log("\ndismissing, and asking again from the keyboard");
await page.send("Page.navigate", { url: `${origin}/` });
await sleep(2000);
await typePhrase(page, "document", "lunch with friends on saturday");
const shown = await until(page, chipsIn(), 60_000);
if (!shown) {
  bad("nothing appeared that could be dismissed");
} else {
  ok(`chips before dismissing: ${shown.join(" ")}`);
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(400);
  if (await page.evaluate(quietIn())) ok("Esc takes the chips away");
  else bad("Esc left the chips on screen");

  await page.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", altKey: true, bubbles: true }))`);
  await sleep(1200);
  if (await page.evaluate(quietIn())) ok("plain Alt+E stays inert, which is why the binding needs Shift");
  else bad("plain Alt+E re-opened the chips - a key Chrome owns cannot be ours");

  const askedAt = Date.now();
  await page.evaluate(
    `document.dispatchEvent(new KeyboardEvent("keydown", { key: "E", altKey: true, shiftKey: true, bubbles: true }))`,
  );
  const again = await until(page, chipsIn(), 20_000);
  const roundTrip = Date.now() - askedAt;
  if (!again) bad("Alt+Shift+E did not bring the chips back, so dismissing is a dead end");
  else if (roundTrip > 700) bad(`a loaded model took ${roundTrip}ms to answer one phrase`);
  else ok(`Alt+Shift+E asks again in ${roundTrip}ms: ${again.join(" ")}`);
}

// The model is not permanent: it unloads when idle and when the options GUI says
// so. The next phrase a user types has to survive that, because for a person who
// installed Emo ten seconds ago every single request is that first one.
console.log("\nafter the model has been unloaded");
await page.send("Page.navigate", { url: `${extensionBase}/options.html` });
await sleep(1500);
await page.evaluate(`document.getElementById("unload").click()`);
await sleep(1200);
const lingering = (await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json())).filter((t) =>
  t.url.includes("offscreen.html"),
).length;
if (lingering === 0) ok("the options GUI closed the model host");
else bad(`expected the model host to close, ${lingering} still open`);
await trySite(page, { path: "/", phrase: "congrats on the new job" });

// The claim a listing gets rejected for making carelessly: nothing leaves the
// browser. Watch the model host's actual network while it serves a suggestion.
console.log("\nno outbound traffic");
await page.send("Page.navigate", { url: `${extensionBase}/popup.html` });
await sleep(1500);
const hostTarget = (await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json())).find((t) => t.url.includes("offscreen.html"));
if (!hostTarget) {
  bad("the model host is gone, so its traffic could not be observed");
} else {
  const host = await Session.open(hostTarget.webSocketDebuggerUrl);
  await host.send("Runtime.enable");
  await host.send("Network.enable");
  await page.evaluate(`(() => {
    const t = document.getElementById("text");
    t.value = "thank you so much for dinner";
    t.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(4000);
  const sent = host.events
    .filter((e) => e.method === "Network.requestWillBeSent")
    .map((e) => e.params.request.url)
    .filter((url) => !url.startsWith(`${extensionBase}/`) && !url.startsWith("data:") && !url.includes("127.0.0.1"));
  if (sent.length === 0) ok("a served suggestion made no request outside the extension");
  else bad(`the model host contacted: ${sent.join(", ").slice(0, 240)}`);
  const answered = await until(page, `document.querySelectorAll(".suggestion").length`, 20_000);
  if (answered) ok(`and still answered: ${answered} suggestions`);
  else bad("blocking outbound traffic stopped the model from answering");
  host.close();
}

console.log(failures ? `\nFAILED (${failures})` : "\nPASS");
page.close();
done(failures ? 1 : 0);
