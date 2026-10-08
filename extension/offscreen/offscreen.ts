// The model host. Runs in an offscreen document: an extension-origin page with a
// real DOM, so LiteRT and the WebAssembly core work, and no page's
// Content-Security-Policy can reach it. The manifest grants 'wasm-unsafe-eval',
// which covers WebAssembly; the one thing the core tries to compile is handled by
// eval-shim.ts, so no extension context here ever needs 'unsafe-eval'.
//
// Only the service worker may talk to this document, and only one model instance
// exists for the whole browser, shared by every tab.

// Import order matters: both shims have to be installed before the SDK's own
// module graph is evaluated.
import "./eval-shim.ts";
import "./no-phone-home.ts";
import { Emo } from "@desert-ant-labs/emo";
import type { EmojiSkinTone } from "@desert-ant-labs/emo";
// LiteRT's loader would otherwise pull its glue in with document.createElement
// ("script"); bundling it here (the patched footer sets self.ModuleFactory) makes
// createWasmLib skip script loading entirely.
import "./litert-glue.js";
import { PROTOCOL, asRelayedRequest } from "../shared/protocol.ts";
import type { EmoEvent, EngineStatus, EmoResponse, Suggestion } from "../shared/protocol.ts";

const root = chrome.runtime.getURL("");
const modelBase = `${root}model/`;

let emo: Emo | null = null;
let loading: Promise<Emo> | null = null;
let status: EngineStatus = { state: "idle", progress: 0 };
let calls = 0;

function setStatus(next: Partial<EngineStatus>): void {
  status = { ...status, ...next };
}

async function ensureModel(): Promise<Emo> {
  if (emo) return emo;
  loading ??= (async () => {
    const started = performance.now();
    setStatus({ state: "loading", progress: 0, error: undefined });
    try {
      const loaded = await Emo.load({
        accelerator: "wasm",
        modelBaseUrl: modelBase,
        litertWasmDir: root,
        onProgress: (fraction) => setStatus({ progress: fraction }),
      });
      emo = loaded;
      setStatus({ state: "ready", progress: 1, loadMs: Math.round(performance.now() - started) });
      return loaded;
    } catch (err) {
      setStatus({ state: "failed", error: describe(err) });
      throw err;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/required local model file is missing|Failed to fetch|NetworkError/i.test(message)) {
    return `model files missing from ${modelBase} - run: node scripts/fetch-model.mjs`;
  }
  if (/WebAssembly|wasm-unsafe-eval|CompileError/i.test(message)) {
    return "WebAssembly was refused by the extension Content-Security-Policy";
  }
  return message;
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const request = asRelayedRequest(raw);
  // Every extension context sees every broadcast, popups included. Serve only
  // what the worker relays, so nothing bypasses its lifecycle and idle timer.
  if (!request) return false;

  void (async () => {
    let response: EmoResponse;
    try {
      if (request.kind === "suggest") {
        const model = await ensureModel();
        const started = performance.now();
        const suggestions = (await model.suggestions(request.text, {
          skinTone: request.skinTone as EmojiSkinTone,
          limit: request.limit,
        })) as Suggestion[];
        calls++;
        response = { kind: "suggest", ok: true, suggestions, ms: Math.round(performance.now() - started) };
      } else if (request.kind === "warmup") {
        await ensureModel();
        response = { kind: "status", status };
      } else if (request.kind === "unload") {
        emo?.dispose();
        emo = null;
        calls = 0;
        setStatus({ state: "idle", progress: 0 });
        response = { kind: "unload", ok: true };
      } else {
        response = { kind: "status", status: { ...status, calls } };
      }
    } catch (err) {
      response = { kind: "suggest", ok: false, error: describe(err) };
    }
    sendResponse({ ...response, status: { ...status, calls } });
  })();
  return true;
});

// Tell the service worker we're listening before it queues anything at us.
chrome.runtime.sendMessage({ protocol: PROTOCOL, kind: "ready" } satisfies EmoEvent).catch(() => {
  /* the worker may already be moving on; requests are retried anyway */
});
