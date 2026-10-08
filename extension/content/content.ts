import styles from "./content.css?inline";
import { tag } from "../shared/protocol.ts";
import type { EmoResponse, Suggestion } from "../shared/protocol.ts";
import { DEFAULTS, isBlocked, loadSettings } from "../shared/settings.ts";
import type { Settings } from "../shared/settings.ts";

// Isolated-world content script: overlay only, no model. It never depends on the
// page's CSP (content scripts are exempt) and never holds WebAssembly, so this
// file stays small enough to inject on every page.

main();

function main(): void {
  // This file runs in every frame, including the about:blank and srcdoc frames a
  // lot of web mailboxes build their compose box out of. It draws nothing until
  // that frame actually has a caret in an editable field, so frames the user
  // never types in stay untouched.
  if (document.getElementById("emo-host")) return;

  let settings: Settings = DEFAULTS;
  let activeField: HTMLElement | null = null;
  let lastQuery = "";
  let dismissedAt = 0;
  let failedAt = 0;
  let retries = 0;
  let seq = 0;
  let asking = false;
  let warmedUp = false;
  let timer: number | undefined;
  let host: HTMLDivElement | null = null;
  let strip: HTMLElement | null = null;

  const resync = () => void loadSettings().then((s) => (settings = s));
  resync();
  chrome.storage.onChanged.addListener(resync);

  // A fresh install spends its first seconds warming the model, so the earliest
  // keystrokes are exactly the ones most likely to fail. Failing quietly there
  // looks like a dead extension: nothing retried until the user happened to type
  // again, and re-typing the same phrase was blocked as a repeat.
  const ERROR_BACKOFF_MS = 1500;
  const RETRY_MS = 1700;
  const MAX_RETRIES = 3;

  // ---------------------------------------------------------------- overlay
  /** Build the chip strip on first use: a fixed host is cheap, but a scroll
   *  listener and a shadow tree in every frame of every page is not. */
  function ensureStrip(): HTMLElement {
    if (strip) return strip;
    host = document.createElement("div");
    host.id = "emo-host";
    // Neutralise the page's stylesheets on the host, not just the shadow tree.
    host.style.cssText = "all:initial; position:fixed; z-index:2147483647; left:0; top:0;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${styles}</style><div class="emo-chips" hidden role="listbox" aria-label="Emoji suggestions"></div>`;
    strip = shadow.querySelector(".emo-chips") as HTMLElement;
    document.documentElement.appendChild(host);
    window.addEventListener(
      "scroll",
      () => {
        if (strip && !strip.hidden && activeField && document.contains(activeField)) {
          place(caretRect(activeField) ?? activeField.getBoundingClientRect());
        }
      },
      { passive: true },
    );
    return strip;
  }

  /** Chips live in the frame that holds the caret, positioned against that
   *  frame's own viewport, which is what getBoundingClientRect reports. */
  function place(anchor: DOMRect): void {
    if (!host || !strip) return;
    const gap = 6;
    const size = strip.getBoundingClientRect();
    const viewportW = document.documentElement.clientWidth;
    const viewportH = document.documentElement.clientHeight;
    const below = anchor.bottom + gap;
    const flipUp = below + size.height + gap > viewportH && anchor.top - size.height - gap > 0;
    const top = flipUp ? anchor.top - size.height - gap : below;
    const left = Math.max(8, Math.min(anchor.left, viewportW - size.width - 8));
    host.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function hide(): void {
    if (!strip) return;
    strip.hidden = true;
    strip.replaceChildren();
  }

  function show(suggestions: Suggestion[], anchor: DOMRect): void {
    const strip = ensureStrip();
    strip.replaceChildren();
    for (const s of suggestions) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "emo-chip";
      chip.setAttribute("role", "option");
      chip.title = `${s.emoji} · ${Math.round(s.confidence * 100)}%`;
      chip.textContent = s.emoji;
      chip.addEventListener("mousedown", (event) => {
        // mousedown, not click: if the field blurs first the caret the
        // insertion depends on is already gone.
        event.preventDefault();
        insert(s.emoji);
        dismissedAt = Date.now();
        lastQuery = "";
        hide();
      });
      strip.appendChild(chip);
    }
    strip.hidden = false;
    place(anchor);
  }

  // ----------------------------------------------------------------- editing
  function caretRect(el: HTMLElement): DOMRect | null {
    if (el.isContentEditable) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && el.contains(selection.anchorNode)) {
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        // A collapsed caret can report an all-zero rect; fall back to the box.
        if (rect.width || rect.height || rect.top) return rect;
      }
      return el.getBoundingClientRect();
    }
    return el.getBoundingClientRect();
  }

  function valueOf(el: HTMLElement): string {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    return el.textContent ?? "";
  }

  function insert(emoji: string): void {
    const el = activeField;
    if (!el) return;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.setRangeText(emoji, start, end, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus();
    } else if (el.isContentEditable) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0 && el.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0).cloneRange();
        range.deleteContents();
        const node = document.createTextNode(emoji);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // ------------------------------------------------------------------- query
  function skip(el: HTMLElement): boolean {
    if (el instanceof HTMLInputElement) {
      // Passwords and pickers have nothing to emoji-ise, and reading a password
      // field is never acceptable.
      return ["password", "file", "range", "checkbox", "radio", "hidden", "color"].includes(el.type);
    }
    return false;
  }

  async function refresh(el: HTMLElement, force = false): Promise<void> {
    if (!settings.enabled || !settings.liveChips) return;
    if (!document.contains(el)) return;
    if (skip(el)) return;
    if (!force && Date.now() - dismissedAt < settings.cooldownMs) return;
    if (!force && Date.now() - failedAt < ERROR_BACKOFF_MS) return;
    if (frameHosts().some((h) => isBlocked(h, settings.blockedHosts))) return;

    const text = valueOf(el).trim().slice(-200);
    if (text.length < settings.minChars) {
      hide();
      return;
    }
    if (!force && text === lastQuery) return;
    lastQuery = text;

    const anchor = caretRect(el);
    if (!anchor) return;
    const mySeq = ++seq;
    asking = true;

    let reply: EmoResponse | undefined;
    try {
      reply = (await chrome.runtime.sendMessage(
        tag({ kind: "suggest", text, limit: settings.limit, skinTone: settings.skinTone }),
      )) as EmoResponse;
    } catch {
      // The worker can be torn down mid-request. That is a hiccup, not a verdict.
      asking = false;
      requestFailed(el);
      return;
    }
    asking = false;
    if (mySeq !== seq) return;
    if (!document.contains(el)) return;

    if (reply?.kind === "suggest" && reply.ok) {
      failedAt = 0;
      if (reply.suggestions.length === 0) {
        hide();
        return;
      }
      show(reply.suggestions, anchor);
    } else {
      requestFailed(el);
    }
  }

  /** A request that failed is not a user dismissal: the engine may still be
   *  starting, or may have just been recycled. Ask again shortly on the user's
   *  behalf - they have done everything right and are waiting for chips - and
   *  give up after a few attempts so a genuinely broken host is not hammered. */
  function requestFailed(el: HTMLElement): void {
    failedAt = Date.now();
    lastQuery = "";
    hide();
    if (retries >= MAX_RETRIES) return;
    retries++;
    window.setTimeout(() => {
      // The user may have moved on in the meantime; chips arriving beside a
      // field they abandoned read as a popup appearing at random.
      if (activeField === el) void refresh(el);
    }, RETRY_MS);
  }

  /** Loading the model costs a second or two, and a person who has just clicked
   *  into a field is about to type in it. Starting the engine under the cursor
   *  moves that cost off the first phrase - the one that decides whether the
   *  extension feels alive. Once per frame; the worker still unloads it when the
   *  browser goes idle. */
  function warmUp(): void {
    if (warmedUp || !settings.enabled || !settings.liveChips) return;
    if (frameHosts().some((h) => isBlocked(h, settings.blockedHosts))) return;
    warmedUp = true;
    void chrome.runtime.sendMessage(tag({ kind: "warmup" })).catch(() => {
      warmedUp = false;
    });
  }

  /** A blocked site has to stay blocked when its editor is an iframe, so check
   *  the frame's own host and, when it can be read at all, the host that
   *  embedded it. Cross-origin frames cannot see their parent - the same
   *  limitation every per-site switch lives with. */
  function frameHosts(): string[] {
    const hosts = [location.hostname];
    try {
      if (window.top !== window && window.top) hosts.push(window.top.location.hostname);
    } catch {
      /* opaque to us */
    }
    return hosts;
  }

  function isEditable(el: EventTarget | null): el is HTMLElement {
    return (
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)
    );
  }

  document.addEventListener("focusin", (event) => {
    if (!isEditable(event.target)) return;
    activeField = event.target;
    lastQuery = "";
    retries = 0;
    warmUp();
    void refresh(event.target);
  });

  document.addEventListener(
    "input",
    (event) => {
      const el = event.target;
      if (!isEditable(el)) return;
      // Adopt the field even if we never saw a focusin for it: sites that
      // restore focus programmatically, and pages that were not focused when the
      // caret landed, must still get suggestions.
      if (el !== activeField) {
        activeField = el;
        lastQuery = "";
      }
      // A keystroke is the user asking again, so the automatic attempts restart.
      retries = 0;
      window.clearTimeout(timer);
      // The debounce exists to stop refining a strip that is already on screen.
      // While nothing is showing, waiting for it only makes the user think Emo is
      // not answering at all.
      if (!asking) void refresh(el);
      else timer = window.setTimeout(() => void refresh(el), settings.debounceMs);
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      dismissedAt = Date.now();
      hide();
      // Alt+E is Chrome's own menu accelerator on Windows, so it never reaches a
      // content script; Shift keeps it for us.
    } else if (event.altKey && event.shiftKey && event.key.toLowerCase() === "e" && activeField) {
      retries = 0;
      // Manual re-trigger, bypassing the cooldown.
      void refresh(activeField, true);
    }
  });
}
