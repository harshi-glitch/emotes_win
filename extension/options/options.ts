import { tag } from "../shared/protocol.ts";
import type { EngineStatus, SkinTone } from "../shared/protocol.ts";
import { SKIN_TONES, loadSettings, saveSettings } from "../shared/settings.ts";
import type { Settings } from "../shared/settings.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = <K extends keyof Settings>(id: K) => $<HTMLInputElement & HTMLSelectElement>(id as string);

const numbers = ["limit", "minChars", "debounceMs"] as const;
const checks = ["enabled", "liveChips"] as const;
const selects = ["skinTone", "cooldownMs", "idleUnloadMinutes"] as const;

const toneSelect = field("skinTone");
for (const tone of SKIN_TONES) {
  const option = document.createElement("option");
  option.value = tone.value;
  option.textContent = tone.label;
  toneSelect.appendChild(option);
}

const blockedHosts = $<HTMLTextAreaElement>("blockedHosts");
const saved = $<HTMLParagraphElement>("saved");

let settings: Settings;

async function render(): Promise<void> {
  settings = await loadSettings();
  for (const key of numbers) field(key).value = String(settings[key]);
  for (const key of checks) field(key).checked = settings[key];
  for (const key of selects) field(key).value = String(settings[key]);
  blockedHosts.value = settings.blockedHosts.join("\n");
}

let flash: number | undefined;
function commit(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  void saveSettings(patch).then(() => {
    saved.classList.add("show");
    window.clearTimeout(flash);
    flash = window.setTimeout(() => saved.classList.remove("show"), 1100);
  });
}

for (const key of numbers) {
  field(key).addEventListener("change", () => {
    const raw = Number(field(key).value);
    if (!Number.isFinite(raw)) return;
    commit({ [key]: Math.round(raw) } as Partial<Settings>);
  });
}

for (const key of checks) {
  field(key).addEventListener("change", () => commit({ [key]: field(key).checked } as Partial<Settings>));
}

for (const key of selects) {
  field(key).addEventListener("change", () => {
    const value = field(key).value;
    commit({ [key]: key === "skinTone" ? (value as SkinTone) : Number(value) } as Partial<Settings>);
  });
}

blockedHosts.addEventListener("input", () => {
  commit({
    blockedHosts: blockedHosts.value
      .split("\n")
      .map((line) => line.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
      .filter(Boolean),
  });
});

const dot = $<HTMLSpanElement>("dot");
const modelText = $<HTMLSpanElement>("modelText");

async function refreshStatus(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage(tag({ kind: "status" }))) as { status?: EngineStatus };
  const status = reply?.status;
  dot.className = `dot ${status?.state === "ready" ? "ready" : status?.state === "loading" ? "loading" : status?.state === "failed" ? "failed" : ""}`;
  if (!status || status.state === "idle") modelText.textContent = "not loaded yet - loads the first time you type";
  else if (status.state === "loading") modelText.textContent = `loading ${Math.round(status.progress * 100)}%`;
  else if (status.state === "ready") modelText.textContent = `loaded in ${status.loadMs}ms · ${(status.calls ?? 0)} suggestions served`;
  else modelText.textContent = status.error ?? "failed";
}

$<HTMLButtonElement>("load").addEventListener("click", () => {
  void chrome.runtime.sendMessage(tag({ kind: "warmup" })).then(refreshStatus);
});

$<HTMLButtonElement>("unload").addEventListener("click", () => {
  void chrome.runtime.sendMessage(tag({ kind: "unload" })).then(refreshStatus);
});

window.setInterval(refreshStatus, 1500);
void render().then(refreshStatus);
