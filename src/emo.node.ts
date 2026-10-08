import { Emo } from "@desert-ant-labs/emo/native";
import type { EmoSuggestion, LoadOptions, SuggestOptions } from "@desert-ant-labs/emo";

export { Emo };
export type { EmoSuggestion, EmojiSkinTone, LoadOptions, SuggestOptions } from "@desert-ant-labs/emo";

let shared: Emo | null = null;

/** Lazily loaded, reusable suggester for Node (server-side) via native core. */
export async function loadEmo(options?: LoadOptions): Promise<Emo> {
  if (shared) return shared;
  shared = await Emo.load(options);
  return shared;
}

/** Suggest emojis for `text` (most likely first). */
export async function suggest(text: string, options?: SuggestOptions): Promise<EmoSuggestion[]> {
  return loadEmo().then((emo) => emo.suggestions(text, options));
}

/** Release the shared model. The suggester must be loaded again afterwards. */
export function dispose(): void {
  shared?.dispose();
  shared = null;
}