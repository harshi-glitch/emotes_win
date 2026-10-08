// The emoji model's WebAssembly core hops back into JavaScript for Unicode
// normalization by *compiling a string at runtime* (`new Function`). Extension
// pages are not allowed to do that - `wasm-unsafe-eval` permits WebAssembly, not
// eval - and a refused compile does not surface as an error: the core's own
// promise simply never settles, so a suggestion hangs forever instead of failing.
//
// Handing over the same behaviour pre-written means the core never needs to
// compile anything. Keep this module imported first: it has to be installed
// before the SDK's own module graph is evaluated.

const RealFunction = Function;

/** A normalization helper is the only thing the core has ever asked for. */
const NFKC = /^return\s+(\w+)\.normalize\(\s*['"]NFKC['"]\s*\)\s*;?\s*$/;

globalThis.Function = function emoHostFunction(...args: string[]): unknown {
  const body = String(args.at(-1) ?? "");
  if (NFKC.test(body)) {
    return (value: string) => String(value).normalize("NFKC");
  }
  // Anything else genuinely needs compiling; if this ever starts throwing, the
  // model gained a new host call and needs another case above.
  return Reflect.construct(RealFunction, args);
} as unknown as typeof Function;

export {};
