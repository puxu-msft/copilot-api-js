/**
 * C0.4 — which shape of a Responses `web_search_call` does the real upstream accept back?
 *
 * RFC §17. The carrier can hold either a re-pointable reference or the whole authoritative item
 * (`ContinuationRecord`), and the RFC deliberately does not freeze which is the default — that is
 * this probe's job.
 *
 * Read the companion README before trusting a green run: HTTP 200 is a weak oracle here. A prior
 * probe (`exp/anthropic-responses-direct/FINDINGS.md`) established that this endpoint accepts an
 * *empty* `encrypted_content` for reasoning, i.e. it does not validate continuation payloads at all.
 * So P4 — does a tampered id fail in a distinguishable way — is what decides whether "accepted"
 * means anything. If tampering is also accepted, acceptance is not evidence and the conservative
 * whole-item default stands.
 *
 * Usage: bun run exp/responses-server-tool-continuation/probe-forms.ts <baseUrl> <model>
 */

type Json = Record<string, unknown>

const BASE = process.argv[2] ?? "http://localhost:45191"
const MODEL = process.argv[3] ?? "gpt-5.6-sol"

const SEARCH_PROMPT = "Search the web for the current stable version of Bun, then state it in one short sentence."
/** Answerable only from the first turn's search — a turn that lost the context has to search again or hedge. */
const FOLLOW_UP = "Without searching again, repeat the exact version number you just found. If you do not have it, reply exactly: NO_CONTEXT"

async function postResponses(body: Json): Promise<{ status: number; body: Json | string }> {
  const res = await fetch(`${BASE}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as Json }
  } catch {
    return { status: res.status, body: text }
  }
}

function textOf(response: Json): string {
  const output = (response.output ?? []) as Array<Json>
  const parts: Array<string> = []
  for (const item of output) {
    if (item.type !== "message") continue
    for (const c of (item.content ?? []) as Array<Json>) {
      if (typeof c.text === "string") parts.push(c.text)
    }
  }
  return parts.join(" ").trim()
}

async function main(): Promise<void> {
  // --- Turn 1: get a real web_search_call -------------------------------------------------------
  const turn1 = await postResponses({
    model: MODEL,
    input: [{ role: "user", content: [{ type: "input_text", text: SEARCH_PROMPT }] }],
    tools: [{ type: "web_search" }],
    stream: false,
  })
  if (turn1.status !== 200 || typeof turn1.body === "string") throw new Error(`turn 1 failed: ${turn1.status} ${JSON.stringify(turn1.body).slice(0, 400)}`)

  const output = (turn1.body.output ?? []) as Array<Json>
  const searchCall = output.find((i) => i.type === "web_search_call")
  const message = output.find((i) => i.type === "message")
  if (!searchCall || !message) throw new Error(`turn 1 produced no web_search_call/message: ${output.map((i) => i.type).join(",")}`)

  const answer1 = textOf(turn1.body)
  console.log(`turn1: HTTP 200, items=[${output.map((i) => i.type).join(", ")}]`)
  console.log(`turn1 answer: ${answer1.slice(0, 160)}`)
  console.log(`web_search_call keys: ${JSON.stringify(Object.keys(searchCall).sort())}`)

  const id = searchCall.id as string
  const tamperedId = `${id.slice(0, Math.max(0, id.length - 8))}ZZZZZZZZ`

  // --- Turn 2 variants ---------------------------------------------------------------------------
  const variants: Array<{ name: string; note: string; item: Json | undefined }> = [
    { name: "A-whole-item", note: "the authoritative item, verbatim", item: searchCall },
    { name: "B-type-and-id", note: "minimal: {type,id}", item: { type: "web_search_call", id } },
    { name: "C-item-reference", note: "item_reference envelope", item: { type: "item_reference", id } },
    { name: "D-tampered-id", note: "NEGATIVE CONTROL: whole item, id corrupted", item: { ...searchCall, id: tamperedId } },
    { name: "E-omitted", note: "BASELINE: no search item at all", item: undefined },
  ]

  const results: Array<Json> = []
  for (const v of variants) {
    // The turn-1 message is deliberately NOT replayed. It states the version in plain text, so replaying it lets every variant answer from the transcript and the observable stops discriminating. With only the search item carried over, the answer can come from the continuation state or not at all — which is what makes variant E a usable control.
    const input: Array<Json> = [
      { role: "user", content: [{ type: "input_text", text: SEARCH_PROMPT }] },
      ...(v.item ? [v.item] : []),
      { role: "user", content: [{ type: "input_text", text: FOLLOW_UP }] },
    ]
    const res = await postResponses({ model: MODEL, input, tools: [{ type: "web_search" }], stream: false })
    const answer = typeof res.body === "string" ? res.body.slice(0, 200) : textOf(res.body)
    const errorBody = res.status === 200 ? undefined : typeof res.body === "string" ? res.body.slice(0, 600) : JSON.stringify(res.body).slice(0, 600)
    results.push({ variant: v.name, note: v.note, status: res.status, saidNoContext: answer.includes("NO_CONTEXT"), answer: answer.slice(0, 200), errorBody })
    console.log(`${v.name}: HTTP ${res.status}${errorBody ? ` — ${errorBody.slice(0, 200)}` : ""}`)
    console.log(`  answer: ${answer.slice(0, 140)}`)
  }

  await Bun.write(
    new URL("./results.json", import.meta.url).pathname,
    `${JSON.stringify({ model: MODEL, capturedAt: new Date().toISOString(), turn1: { answer: answer1, searchCallKeys: Object.keys(searchCall).sort() }, results }, null, 2)}\n`,
  )
  console.log("\nwrote results.json")
}

await main()
