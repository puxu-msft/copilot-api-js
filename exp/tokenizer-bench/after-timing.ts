const { countTotalInputTokens } = await import("../../src/lib/anthropic/token-counting.ts")
const P = (t: string) => ({ model: "claude-sonnet-4", messages: [{ role: "user", content: t }], max_tokens: 100 }) as never

await countTotalInputTokens(P("warmup"), "claude-sonnet-4" as never)
for (const [tag, text] of [
  ["英文 60KB", "the quick brown fox jumps over the lazy dog ".repeat(1400)],
  ["空格 20KB", " ".repeat(20 * 1024)],
  ["空格 60KB", " ".repeat(60 * 1024)],
  ["空格 120KB", " ".repeat(120 * 1024)],
  ["= 线 60KB", "=".repeat(60 * 1024)],
  ["单字符 60KB", "a".repeat(60 * 1024)],
] as Array<[string, string]>) {
  const t = performance.now()
  const n = await countTotalInputTokens(P(text), "claude-sonnet-4" as never)
  console.log(`${tag.padEnd(14)} ${(performance.now() - t).toFixed(0).padStart(6)} ms   tokens=${n}`)
}
