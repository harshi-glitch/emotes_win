// The one message shape every context agrees on. Content scripts and popups
// never talk to the model host directly; they ask the service worker, which owns
// the offscreen document.

export const PROTOCOL = "emo";

export type SkinTone = "default" | "light" | "mediumLight" | "medium" | "mediumDark" | "dark";

export interface Suggestion {
  emoji: string;
  confidence: number;
}

export type EmoRequest =
  | { kind: "suggest"; text: string; limit: number; skinTone: SkinTone }
  | { kind: "status" }
  | { kind: "warmup" }
  | { kind: "unload" };

/** Requests are broadcast to every extension context, so the host needs to know
 *  which one came through the worker it is supposed to serve. */
export type RelayedRequest = EmoRequest & { protocol: typeof PROTOCOL; via: "worker" };

/** Host -> worker, so the worker knows the listener is installed before it
 *  queues a request. Not an EmoRequest: it must never be relayed back. */
export type EmoEvent = { protocol: typeof PROTOCOL; kind: "ready" };

export interface EngineStatus {
  state: "idle" | "loading" | "ready" | "failed";
  /** 0..1 while the model loads. */
  progress: number;
  error?: string;
  loadMs?: number;
  /** Requests served since the model last loaded. */
  calls?: number;
}

export type EmoResponse =
  | { kind: "suggest"; ok: true; suggestions: Suggestion[]; ms: number }
  | { kind: "suggest"; ok: false; error: string }
  | { kind: "status"; status: EngineStatus }
  | { kind: "unload"; ok: true };

export function tag(request: EmoRequest): EmoRequest & { protocol: typeof PROTOCOL } {
  return { ...request, protocol: PROTOCOL };
}

/** Worker -> host only. Marks the message as already vetted and relayed. */
export function relay(request: EmoRequest): RelayedRequest {
  return { ...request, protocol: PROTOCOL, via: "worker" } as RelayedRequest;
}

const REQUEST_KINDS = new Set(["suggest", "status", "warmup", "unload"]);

export function asEmoRequest(data: unknown): EmoRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { protocol?: unknown; kind?: unknown };
  if (message.protocol !== PROTOCOL || typeof message.kind !== "string") return null;
  // `ready` is an EmoEvent on the same channel; without this guard the worker
  // would relay its own handshake back to the host.
  return REQUEST_KINDS.has(message.kind) ? (data as EmoRequest) : null;
}

export function asRelayedRequest(data: unknown): EmoRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { protocol?: unknown; kind?: unknown; via?: unknown };
  if (message.via !== "worker") return null;
  return asEmoRequest(data);
}

export const IDLE_STATUS: EngineStatus = { state: "idle", progress: 0, calls: 0 };
