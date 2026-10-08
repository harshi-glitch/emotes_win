// The service worker owns one thing: the single model host. It creates the
// offscreen document on first request, relays suggestions to it, and closes it
// when nobody has typed for a while. Content scripts and popups never reach the
// engine directly, so there is exactly one model in memory for the whole browser.

import { IDLE_STATUS, PROTOCOL, asEmoRequest, relay } from "../shared/protocol.ts";
import type { EmoEvent, EmoRequest, EmoResponse, EngineStatus } from "../shared/protocol.ts";
import { loadSettings } from "../shared/settings.ts";

const OFFSCREEN_URL = "offscreen.html";
const IDLE_ALARM = "emo-idle-unload";
let starting: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] });
  return contexts.length > 0;
}

/** Create the host if absent and resolve once its listener is installed. */
function ensureHost(): Promise<void> {
  starting ??= startHost().finally(() => {
    starting = null;
  });
  return starting;
}

async function startHost(): Promise<void> {
  // A document outliving a worker restart is normal: the worker is free to be
  // killed at any time, the host is not.
  if (await hasOffscreen()) {
    await ping();
    return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // LiteRT.js compiles and instantiates through the DOM, so DOM_PARSER is the
    // honest reason. TESTING exists but Chrome only permits it behind
    // --offscreen-document-testing, which a shipped extension cannot rely on.
    reasons: ["DOM_PARSER" as chrome.offscreen.Reason],
    justification: "Compiles the emoji model to WebAssembly, which needs a DOM and cannot run in a service worker.",
  });
  await waitForReady();
}

function waitForReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onReady);
      reject(new Error("model host did not start"));
    }, 30_000);
    const onReady = (raw: unknown) => {
      const event = raw as EmoEvent;
      if (event?.protocol !== PROTOCOL || event.kind !== "ready") return;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(onReady);
      resolve();
    };
    chrome.runtime.onMessage.addListener(onReady);
  });
}

/** A document can survive a worker restart, so ask rather than assume. */
async function ping(): Promise<void> {
  await chrome.runtime.sendMessage(relay({ kind: "status" })).catch(() => {
    throw new Error("model host is unreachable");
  });
}

// The popup polls status; answering it must never be a reason to spin up a
// 7 MB document and warm a model nobody asked for.
let lastStatus: EngineStatus = IDLE_STATUS;

// The engine lives in WebAssembly owned by someone else, and a run there can
// fail to settle rather than fail. One frozen suggestion must not become a
// permanently frozen extension.
const HOST_TIMEOUT_MS = 20_000;

async function ask(request: EmoRequest): Promise<EmoResponse & { status?: EngineStatus }> {
  await ensureHost();
  armIdleUnload();
  let impatient: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = (await Promise.race([
      chrome.runtime.sendMessage(relay(request)),
      new Promise<never>((_, reject) => {
        impatient = setTimeout(() => reject(new Error("model host did not answer")), HOST_TIMEOUT_MS);
      }),
    ])) as EmoResponse & { status?: EngineStatus };
    if (reply?.status) lastStatus = reply.status;
    return reply;
  } catch (err) {
    // A host that ignores a request is not coming back: close it so the next
    // keystroke gets a fresh document instead of another twenty second wait.
    await closeHost();
    throw err;
  } finally {
    clearTimeout(impatient);
  }
}

function armIdleUnload(): void {
  void (async () => {
    const { idleUnloadMinutes } = await loadSettings();
    chrome.alarms.create(IDLE_ALARM, { delayInMinutes: Math.max(0.2, idleUnloadMinutes) });
  })();
}

async function closeHost(): Promise<void> {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const request = asEmoRequest(raw);
  // Only answer pages and content scripts; the host's own traffic is handled by
  // the ready listener above.
  if (!request) return false;

  void (async () => {
    try {
      if (request.kind === "suggest") {
        const text = request.text.trim();
        if (!text) {
          sendResponse({ kind: "suggest", ok: true, suggestions: [], ms: 0 });
          return;
        }
        sendResponse(await ask(request));
      } else if (request.kind === "status") {
        if (await hasOffscreen()) sendResponse(await ask(request));
        else sendResponse({ kind: "status", status: lastStatus });
      } else if (request.kind === "unload") {
        await ask(request);
        await closeHost();
        lastStatus = IDLE_STATUS;
        sendResponse({ kind: "unload", ok: true });
      } else {
        sendResponse(await ask(request));
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      sendResponse(
        request.kind === "suggest"
          ? { kind: "suggest", ok: false, error }
          : { kind: "status", status: { ...IDLE_STATUS, state: "failed", error } },
      );
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== IDLE_ALARM) return;
  // The worker may wake for a badge click or a storage write; only unload when
  // nothing is asking and the popup isn't open.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["POPUP" as chrome.runtime.ContextType],
  });
  if (contexts.length > 0) return;
  lastStatus = IDLE_STATUS;
  await closeHost();
});
