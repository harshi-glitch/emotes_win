import { tag } from "../shared/protocol.ts";
import type { EmoResponse, EngineStatus, Suggestion } from "../shared/protocol.ts";
import { DEFAULTS, loadSettings } from "../shared/settings.ts";
import type { Settings } from "../shared/settings.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const text = $<HTMLInputElement>("text");
const results = $<HTMLDivElement>("results");
const timing = $<HTMLSpanElement>("timing");
const copy = $<HTMLButtonElement>("copy");
const state = $<HTMLSpanElement>("state");
const modelText = $<HTMLSpanElement>("modelText");
const toggleModel = $<HTMLButtonElement>("toggleModel");
const options = $<HTMLButtonElement>("options");

let settings: Settings = DEFAULTS;
let latest: Suggestion[] = [];
let timer: number | undefined;

void boot();

async function boot(): Promise<void> {
  settings = await loadSettings();
  text.placeholder = "Pay my bills";
  await refreshStatus();
}

text.addEventListener("input", () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void run(text.value), 260);
});

options.addEventListener("click", () => void chrome.runtime.openOptionsPage());
copy.addEventListener("click", () => {
  void navigator.clipboard.writeText(latest.map((s) => s.emoji).join(" "));
  copy.textContent = "Copied";
  window.setTimeout(() => (copy.textContent = "Copy last"), 1200);
});

toggleModel.addEventListener("click", () => {
  void (async () => {
    toggleModel.disabled = true;
    const current = modelText.dataset.state;
    await chrome.runtime.sendMessage(tag({ kind: current === "ready" || current === "loading" ? "unload" : "warmup" }));
    await refreshStatus();
    toggleModel.disabled = false;
  })();
});

async function run(value: string): Promise<void> {
  const query = value.trim();
  if (!query) {
    results.replaceChildren(hint("Type a phrase above, or just start typing in any field on the page."));
    timing.textContent = "";
    copy.hidden = true;
    latest = [];
    return;
  }

  results.replaceChildren(hint("Thinking…"));
  const reply = (await chrome.runtime.sendMessage(
    tag({ kind: "suggest", text: query, limit: settings.limit, skinTone: settings.skinTone }),
  )) as EmoResponse;
  await refreshStatus();

  if (!reply || reply.kind !== "suggest") {
    results.replaceChildren(hint("The model host did not answer."));
    return;
  }
  if (!reply.ok) {
    results.replaceChildren(hint(reply.error));
    return;
  }
  latest = reply.suggestions;
  if (latest.length === 0) {
    results.replaceChildren(hint("Nothing confident enough for that phrase."));
    timing.textContent = `${reply.ms}ms`;
    copy.hidden = true;
    return;
  }

  results.replaceChildren(
    ...latest.map((s) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "suggestion";
      btn.title = `${Math.round(s.confidence * 100)}% match — click to copy`;
      btn.textContent = s.emoji;
      const pct = document.createElement("span");
      pct.className = "pct";
      pct.textContent = `${Math.round(s.confidence * 100)}`;
      btn.append(pct);
      btn.addEventListener("click", () => {
        void navigator.clipboard.writeText(s.emoji);
        btn.animate([{ transform: "scale(1.18)" }, { transform: "scale(1)" }], { duration: 160 });
      });
      return btn;
    }),
  );
  timing.textContent = `${reply.ms}ms · ${latest.length} of the model's vocabulary`;
  copy.hidden = false;
}

function hint(message: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = message;
  return p;
}

async function refreshStatus(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage(tag({ kind: "status" }))) as { status?: EngineStatus };
  const status = reply?.status;
  const tone: Record<string, string> = { idle: "", loading: "loading", ready: "ready", failed: "failed" };
  state.className = `dot ${status ? (tone[status.state] ?? "") : ""}`;
  modelText.dataset.state = status?.state ?? "idle";

  if (!status || status.state === "idle") modelText.textContent = "model idle";
  else if (status.state === "loading") modelText.textContent = `loading ${Math.round(status.progress * 100)}%`;
  else if (status.state === "ready")
    modelText.textContent = `model ready · ${(status.calls ?? 0)} calls · loaded in ${status.loadMs}ms`;
  else modelText.textContent = status.error ?? "model failed";

  toggleModel.textContent = status?.state === "ready" || status?.state === "loading" ? "Unload model" : "Load model";
}

// Keep the popup honest if settings change in another tab.
chrome.storage.onChanged.addListener(() => {
  void loadSettings().then((s) => {
    settings = s;
  });
});

export {};
