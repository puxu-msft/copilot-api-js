/**
 * C0.4 follow-up — pin down *why* the tampered id failed, and whether the id survives a model change.
 *
 * The first pass rejected a tampered id with "string too long … maximum length 64, but got 424",
 * while an untampered id of the *same* length was accepted. That asymmetry only makes sense if the
 * upstream decrypts the id: decryptable → opaque server-side reference, length irrelevant;
 * undecryptable → falls back to the plain item-id rule and trips its 64-char cap. This checks that
 * reading instead of assuming it, because a negative control that fires for an unintended reason is
 * not a negative control.
 *
 * Usage: bun run exp/responses-server-tool-continuation/probe-mechanism.ts <baseUrl> <model> [altModel]
 */

type Json = Record<string, unknown>

const BASE = process.argv[2] ?? "http://localhost:45191"
const MODEL = process.argv[3] ?? "gpt-5.6-sol"
const ALT_MODEL = process.argv[4] ?? "gpt-5.5"

const SEARCH_PROMPT = "Search the web for the current stable version of Bun, then state it in one short sentence."

async function postResponses(body: Json): Promise<{ status: number; body: Json | string }> {
  const res = await fetch(`${BASE}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as Json }
  } catch {
    return { status: res.status, body: text }
  }
}

function errorOf(res: { status: number; body: Json | string }): string | undefined {
  if (res.status === 200) return undefined
  return (typeof res.body === "string" ? res.body : JSON.stringify(res.body)).slice(0, 300)
}

async function main(): Promise<void> {
  const turn1 = await postResponses({
    model: MODEL,
    input: [{ role: "user", content: [{ type: "input_text", text: SEARCH_PROMPT }] }],
    tools: [{ type: "web_search" }],
    stream: false,
  })
  if (turn1.status !== 200 || typeof turn1.body === "string") throw new Error(`turn 1 failed: ${turn1.status}`)
  const searchCall = ((turn1.body.output ?? []) as Array<Json>).find((i) => i.type === "web_search_call")
  if (!searchCall) throw new Error("no web_search_call in turn 1")
  const id = searchCall.id as string

  const mid = Math.floor(id.length / 2)
  const flipped = id[mid] === "A" ? "B" : "A"
  const oneCharTamper = `${id.slice(0, mid)}${flipped}${id.slice(mid + 1)}`

  const cases: Array<{ name: string; note: string; model: string; item: Json }> = [
    { name: "same-model-untampered", note: "control: identical id, same model", model: MODEL, item: searchCall },
    { name: "same-model-one-char-tamper", note: "id length unchanged, one character flipped", model: MODEL, item: { ...searchCall, id: oneCharTamper } },
    { name: "same-model-short-id", note: "a plainly short id, to see the 64-char rule on its own", model: MODEL, item: { ...searchCall, id: "ws_short_id_1" } },
    { name: "cross-model-untampered", note: "P3: same id replayed at a different resolved model", model: ALT_MODEL, item: searchCall },
  ]

  const results: Array<Json> = []
  for (const c of cases) {
    const res = await postResponses({
      model: c.model,
      input: [{ role: "user", content: [{ type: "input_text", text: SEARCH_PROMPT }] }, c.item, { role: "user", content: [{ type: "input_text", text: "Reply with OK." }] }],
      tools: [{ type: "web_search" }],
      stream: false,
    })
    const error = errorOf(res)
    results.push({ case: c.name, note: c.note, model: c.model, status: res.status, error })
    console.log(`${c.name} (${c.model}): HTTP ${res.status}${error ? ` — ${error.slice(0, 220)}` : ""}`)
  }

  await Bun.write(
    new URL("./mechanism.json", import.meta.url).pathname,
    `${JSON.stringify({ model: MODEL, altModel: ALT_MODEL, capturedAt: new Date().toISOString(), idLength: id.length, results }, null, 2)}\n`,
  )
  console.log("\nwrote mechanism.json")
}

await main()
