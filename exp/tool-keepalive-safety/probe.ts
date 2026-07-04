// Consume each mock scenario with the REAL @anthropic-ai/sdk and assert the FINAL accumulated
// tool input / thinking / signature. If the empty keepalive delta corrupted anything, the SDK's
// own accumulation (finalMessage) — the same code Claude Code runs — will show it.
//
// Run: MOCK_PORT=8801 bun run exp/tool-keepalive-safety/mock.ts &  then  bun run exp/tool-keepalive-safety/probe.ts

import Anthropic from "@anthropic-ai/sdk"

const PORT = Number(process.env.MOCK_PORT ?? 8801)
const BASE = `http://localhost:${PORT}`

interface Case {
  mode: string
  expect: (msg: Anthropic.Message) => { ok: boolean; got: string; want: string }
}

const toolInput = (want: unknown) => (msg: Anthropic.Message) => {
  const block = msg.content.find((b) => b.type === "tool_use") as Anthropic.ToolUseBlock | undefined
  const got = JSON.stringify(block?.input ?? null)
  return { ok: got === JSON.stringify(want), got, want: JSON.stringify(want) }
}

const cases: Array<Case> = [
  { mode: "normal-tool", expect: toolInput({ command: "ls -la" }) },
  { mode: "keepalive-mid-tool", expect: toolInput({ command: "ls -la" }) },
  { mode: "keepalive-pre-tool", expect: toolInput({ command: "ls -la" }) },
  { mode: "keepalive-multi-tool", expect: toolInput({ command: "ls -la" }) },
  { mode: "keepalive-zero-arg", expect: toolInput({}) },
  {
    mode: "keepalive-thinking",
    expect: (msg) => {
      const t = msg.content.find((b) => b.type === "thinking") as Anthropic.ThinkingBlock | undefined
      const got = `thinking=${JSON.stringify(t?.thinking)} sig=${JSON.stringify(t?.signature)}`
      const want = `thinking="Let me reason about this" sig="c2lnMTIz"`
      return { ok: t?.thinking === "Let me reason about this" && t?.signature === "c2lnMTIz", got, want }
    },
  },
  {
    mode: "keepalive-text",
    expect: (msg) => {
      const t = msg.content.find((b) => b.type === "text") as Anthropic.TextBlock | undefined
      const got = JSON.stringify(t?.text)
      return { ok: t?.text === "Hello world", got, want: '"Hello world"' }
    },
  },
]

async function runCase(c: Case): Promise<{ mode: string; ok: boolean; got: string; want: string; err?: string }> {
  const client = new Anthropic({ apiKey: "dummy-key", baseURL: BASE, maxRetries: 0, defaultHeaders: { "x-mock-mode": c.mode } })
  try {
    const stream = client.messages.stream({ model: "claude-opus-4-8", max_tokens: 64, messages: [{ role: "user", content: "hi" }] })
    const msg = await stream.finalMessage()
    const r = c.expect(msg)
    return { mode: c.mode, ...r }
  } catch (e) {
    return { mode: c.mode, ok: false, got: "(threw)", want: "(no throw)", err: e instanceof Error ? e.message : String(e) }
  }
}

async function main() {
  const results = []
  for (const c of cases) results.push(await runCase(c))
  console.log("=== tool-keepalive safety (real @anthropic-ai/sdk accumulation) ===\n")
  let allOk = true
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL"
    if (!r.ok) allOk = false
    console.log(`[${mark}] ${r.mode.padEnd(22)} got=${r.got}  want=${r.want}${r.err ? `  err=${r.err}` : ""}`)
  }
  console.log(`\n${allOk ? "ALL PASS — empty keepalive delta does NOT corrupt client accumulation" : "SOME FAIL — keepalive corrupts the tool/thinking block"}`)
}

void main()
