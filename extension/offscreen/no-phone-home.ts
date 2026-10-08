// The model's WebAssembly core counts its usage by POSTing to the vendor's
// endpoint. That is somebody else's server sitting in the path of a feature that
// works with the network cable pulled, and this extension tells users their text
// never leaves the browser - so the call is answered here and nothing is sent.
// Deleting this import from offscreen.ts is the only way to opt back in, and the
// Chrome Web Store data declarations then have to say what actually happens.

/** Only the vendor's host is matched; the model's own files load as normal. */
const VENDOR = "platform.desertant.ai";

const realFetch = globalThis.fetch;

function targets(input: RequestInfo | URL): boolean {
  const url = typeof input === "string" ? input : ((input as Request)?.url ?? (input as URL)?.href ?? "");
  return url.includes(VENDOR);
}

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  targets(input) ? Promise.resolve(new Response(null, { status: 204 })) : realFetch(input as RequestInfo, init)) as typeof fetch;

// sendBeacon is the other door the core can use for the same report.
Object.defineProperty(navigator, "sendBeacon", { value: () => true, configurable: true, writable: true });

export {};
