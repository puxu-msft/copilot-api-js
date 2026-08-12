const ROOT = "/home/xp/src/copilot-api-js/.claude/worktrees/zesty-honking-floyd"
const { countTextTokens } = await import(`${ROOT}/src/lib/models/tokenizer.ts`)
const { computeTextTokens } = await import(`${ROOT}/src/lib/models/tokenizer-core.ts`)

const model = { id: "claude-sonnet-4", capabilities: { tokenizer: "o200k_base" } } as never
// Ordinary English is the honest worst case now that single-character runs short-circuit.
const text = "the quick brown fox jumps over the lazy dog ".repeat(46_000)
console.log(`payload: ${(text.length / 1024 / 1024).toFixed(2)} MB of English`)

const measure = async (label: string, run: () => Promise<number>) => {
  const gaps: Array<number> = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    gaps.push(now - last)
    last = now
  }, 5)
  const started = performance.now()
  const tokens = await run()
  const total = performance.now() - started
  clearInterval(timer)
  const max = Math.max(...gaps)
  console.log(`${label.padEnd(22)} total=${total.toFixed(0).padStart(5)}ms  ticks=${String(gaps.length).padStart(4)}  maxEventLoopGap=${max.toFixed(1).padStart(7)}ms  tokens=${tokens}`)
}

// Warm both paths so neither measurement includes module loading or worker startup.
await countTextTokens("warm", model)
await computeTextTokens("warm", model)

await measure("in-thread (old shape)", async () => await computeTextTokens(text, model))
await measure("worker (new shape)", async () => await countTextTokens(text, model))
