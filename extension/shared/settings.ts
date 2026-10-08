import type { SkinTone } from "./protocol.ts";

export interface Settings {
  enabled: boolean;
  /** Show chips while typing; off means the popup is the only UI. */
  liveChips: boolean;
  skinTone: SkinTone;
  limit: number;
  /** Don't ask the model until the field holds this many characters. */
  minChars: number;
  debounceMs: number;
  /** Suppress chips again this long after a dismissal, per field. */
  cooldownMs: number;
  /** Hostnames Emo stays off of. */
  blockedHosts: string[];
  /** Minutes the model stays resident after the last request. */
  idleUnloadMinutes: number;
}

export const DEFAULTS: Settings = {
  enabled: true,
  liveChips: true,
  skinTone: "default",
  limit: 6,
  minChars: 4,
  debounceMs: 120,
  cooldownMs: 20_000,
  blockedHosts: [],
  idleUnloadMinutes: 5,
};

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const value = stored[KEY] as Partial<Settings> | undefined;
  return { ...DEFAULTS, ...value };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...DEFAULTS, ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function isBlocked(host: string, blocked: string[]): boolean {
  return blocked.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export const SKIN_TONES: Array<{ value: SkinTone; label: string }> = [
  { value: "default", label: "Default" },
  { value: "light", label: "Light" },
  { value: "mediumLight", label: "Medium light" },
  { value: "medium", label: "Medium" },
  { value: "mediumDark", label: "Medium dark" },
  { value: "dark", label: "Dark" },
];
