/**
 * C0.4 remainder — P5 (which id does a stream actually hand us?) and P2 (does an incomplete item behave differently?).
 *
 * P5 matters because of a known GHC behaviour recorded in this repo: the opaque `item.id` of one
 * logical output item is **re-encrypted per event**, so `output_item.added` and `output_item.done`
 * carry different `id` values for the same item. If that holds for `web_search_call`, then "store
 * the id in the carrier" is under-specified until we say *which* event's id — and picking the wrong
 * one is exactly the defect class that produced doubled tool calls once before.
 *
 * Usage: bun run exp/responses-server-tool-continuation/probe-stream-id.ts <baseUrl> <model>
 */

type Json = Record<string, unknown>

const BASE = process.argv[2] ?? "http://localhost:45191"
const MODEL = process.argv[3] ?? "gpt-5.6-sol"
const SEARCH_PROMPT = "Search the web for the current stable version of Bun, then state it in one short sentence."

async function postJson(body: Json): Promise<{ status: number; body: Json | string }> {
  const res = await fetch(`${BASE}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as Json }
  } catch {
    return { status: res.status, body: text }
  }
}

/** Collect every SSE `data:` payload that mentions a web_search_call, keyed by the event that carried it. */
async function streamSearch(): Promise<Array<{ event: string; outputIndex: unknown; id: unknown; status: unknown }>> {
  const res = await fetch(`${BASE}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: [{ role: "user", content: [{ type: "input_text", text: SEARCH_PROMPT }] }], tools: [{ type: "web_search" }], stream: true }),
  })
  const raw = await res.text()
  const seen: Array<{ event: string; outputIndex: unknown; id: unknown; status: unknown }> = []
  for (const block of raw.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"))
    if (!dataLine) continue
    const payload = dataLine.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    let parsed: Json
    try {
      parsed = JSON.parse(payload) as Json
    } catch {
      continue
    }
    const item = parsed.item as Json | undefined
    if (item?.type !== "web_search_call") continue
    seen.push({ event: String(parsed.type), outputIndex: parsed.output_index, id: item.id, status: item.status })
  }
  return seen
}

async function main(): Promise<void> {
  // --- P5: does the id change across events for one logical item? -------------------------------
  const streamed = await streamSearch()
  console.log(`stream events carrying a web_search_call: ${streamed.length}`)
  for (const s of streamed) console.log(`  ${s.event} output_index=${String(s.outputIndex)} status=${String(s.status)} idLen=${String(s.id).length} idHead=${String(s.id).slice(0, 24)}`)

  const uniqueIds = new Set(streamed.map((s) => String(s.id)))
  const idIsStable = uniqueIds.size <= 1
  console.log(`\nP5: distinct ids across events = ${uniqueIds.size} → ${idIsStable ? "STABLE" : "RE-ENCRYPTED PER EVENT"}`)

  // Re-inject each distinct streamed id and see which the upstream still accepts.
  const acceptance: Array<Json> = []
  for (const id of uniqueIds) {
    const res = await postJson({
      model: MODEL,
      input: [{ role: "user", content: [{ type: "input_text", text: SEARCH_PROMPT }] }, { type: "web_search_call", id, status: "completed", action: { type: "search" } }, { role: "user", content: [{ type: "input_text", text: "Reply with OK." }] }],
      tools: [{ type: "web_search" }],
      stream: false,
    })
    const err = res.status === 200 ? undefined : (typeof res.body === "string" ? res.body : JSON.stringify(res.body)).slice(0, 240)
    acceptance.push({ idHead: id.slice(0, 24), idLen: id.length, status: res.status, error: err })
    console.log(`  re-inject ${id.slice(0, 24)}… (len ${id.length}): HTTP ${res.status}${err ? ` — ${err.slice(0, 160)}` : ""}`)
  }

  // --- P2: is there an incomplete web_search_call, and does it round-trip? ----------------------
  const nonStream = await postJson({ model: MODEL, input: [{ role: "user", content: [{ type: "input_text", text: SEARCH_PROMPT }] }], tools: [{ type: "web_search" }], stream: false })
  const items = typeof nonStream.body === "string" ? [] : ((nonStream.body.output ?? []) as Array<Json>)
  const searchCalls = items.filter((i) => i.type === "web_search_call")
  const statuses = searchCalls.map((i) => String(i.status))
  console.log(`\nP2: non-stream web_search_call statuses = ${JSON.stringify(statuses)}`)
  const incomplete = searchCalls.find((i) => i.status !== "completed")
  let incompleteResult: Json | undefined
  if (incomplete) {
    const res = await postJson({
      model: MODEL,
      input: [{ role: "user", content: [{ type: "input_text", text: SEARCH_PROMPT }] }, incomplete, { role: "user", content: [{ type: "input_text", text: "Reply with OK." }] }],
      tools: [{ type: "web_search" }],
      stream: false,
    })
    incompleteResult = { status: res.status, keys: Object.keys(incomplete).sort() }
    console.log(`  incomplete item present, keys=${JSON.stringify(Object.keys(incomplete).sort())}, re-inject HTTP ${res.status}`)
  } else {
    console.log("  no incomplete variant produced this run — P2 remains uncovered")
  }

  await Bun.write(
    new URL("./stream-id.json", import.meta.url).pathname,
    `${JSON.stringify({ model: MODEL, capturedAt: new Date().toISOString(), p5: { events: streamed, distinctIds: uniqueIds.size, idIsStable, acceptance }, p2: { statuses, incompleteResult } }, null, 2)}\n`,
  )
  console.log("\nwrote stream-id.json")
}

await main()
