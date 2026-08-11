const which = process.argv[2]
const PROJ = "/home/xp/src/copilot-api-js/node_modules"
let enc: (t: string) => number
if (which === "gpt") {
  const m = await import(`${PROJ}/gpt-tokenizer/esm/encoding/o200k_base.js`)
  enc = (t) => m.encode(t, { disallowedSpecial: new Set() }).length
} else if (which === "wasm") {
  const { get_encoding } = await import("tiktoken")
  const e = get_encoding("o200k_base")
  enc = (t) => e.encode(t).length
} else {
  const { getEncoding } = await import("js-tiktoken")
  const e = getEncoding("o200k_base")
  enc = (t) => e.encode(t).length
}
const corpus: Array<[string, string]> = [
  ["英文 60KB", "the quick brown fox jumps over the lazy dog ".repeat(1400)],
  ["JSON 60KB", JSON.stringify({ f: Array.from({ length: 300 }, (_, i) => ({ p: `src/m${i}.ts`, b: "export function f(){return 1}\n".repeat(6) })) })],
  ["空格 20KB", " ".repeat(20 * 1024)],
  ["空格 60KB", " ".repeat(60 * 1024)],
  ["= 线 60KB", "=".repeat(60 * 1024)],
]
enc("warmup")
for (const [tag, text] of corpus) {
  const t = performance.now()
  const n = enc(text)
  console.log(`${which.padEnd(5)} ${tag.padEnd(12)} ${(performance.now() - t).toFixed(0).padStart(7)} ms   tokens=${n}`)
}
