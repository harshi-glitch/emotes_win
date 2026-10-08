import { loadEmo, dispose } from "./emo.node.ts";

const samples = [
  "Pay my bills",
  "Dentist appointment tomorrow",
  "go for a run",
  "Homemade pasta for dinner",
  "Happy birthday!",
];

const args = process.argv.slice(2);
const inputs = args.length > 0 ? args : samples;

const emo = await loadEmo();

for (const text of inputs) {
  const start = performance.now();
  const suggestions = await emo.suggestions(text);
  const rendered = suggestions
    .map((s) => `${s.emoji} ${(s.confidence * 100).toFixed(0)}%`)
    .join("  ");
  console.log(`${text.padEnd(28)} -> ${rendered || "—"}  (${(performance.now() - start).toFixed(1)}ms)`);
}

dispose();