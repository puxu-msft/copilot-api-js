export {}

const BASE_URL = process.env.COPILOT_API_BASE_URL ?? "http://127.0.0.1:4141"
const MODEL = process.env.MODEL ?? "claude-haiku-4.5"
const FIRST_MAX_TOKENS = 64
const SECOND_MAX_TOKENS = 64

interface ObservedTurn {
  text: string
  stopReason: string | null
  sawMessageDelta: boolean
  sawMessageStop: boolean
  outputTokens: number | null
  eventTypes: string[]
}

async function streamTurn(messages: Array<{ role: "user" | "assistant"; content: string }>, maxTokens: number): Promise<ObservedTurn> {
  const response = await fetch(`${BASE_URL}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "poc" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, stream: true, messages }),
  })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${await response.text()}`)

  const turn: ObservedTurn = {
    text: "",
    stopReason: null,
    sawMessageDelta: false,
    sawMessageStop: false,
    outputTokens: null,
    eventTypes: [],
  }
  const decoder = new TextDecoder()
  let pending = ""
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true })
    while (pending.includes("\n\n")) {
      const boundary = pending.indexOf("\n\n")
      const record = pending.slice(0, boundary)
      pending = pending.slice(boundary + 2)
      const dataLine = record.split("\n").find((line) => line.startsWith("data:"))
      if (!dataLine || dataLine === "data: [DONE]") continue
      const event = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>
      const type = event.type as string
      turn.eventTypes.push(type)
      if (type === "content_block_delta") {
        const delta = event.delta as { type?: string; text?: string }
        if (delta.type === "text_delta") turn.text += delta.text ?? ""
      } else if (type === "message_delta") {
        turn.sawMessageDelta = true
        turn.stopReason = (event.delta as { stop_reason?: string | null }).stop_reason ?? null
        turn.outputTokens = (event.usage as { output_tokens?: number } | undefined)?.output_tokens ?? null
      } else if (type === "message_stop") {
        turn.sawMessageStop = true
      } else if (type === "error") {
        throw new Error(`stream error: ${JSON.stringify(event)}`)
      }
    }
  }
  return turn
}

function parseIntegers(text: string): number[] {
  return [...text.matchAll(/\d+/g)].map((match) => Number(match[0]))
}

function assertSequential(values: number[], label: string): void {
  if (values.length < 3) throw new Error(`${label} produced too few integers: ${JSON.stringify(values)}`)
  for (let index = 1; index < values.length; index++) {
    if (values[index] !== values[index - 1]! + 1) {
      throw new Error(`${label} is not sequential at ${values[index - 1]} -> ${values[index]}`)
    }
  }
}

const prompt = "Output only the comma-separated integer sequence 1 through 500, with no prose and no code fence."
const first = await streamTurn([{ role: "user", content: prompt }], FIRST_MAX_TOKENS)
if (first.stopReason !== "max_tokens") throw new Error(`first turn did not hit max_tokens: ${first.stopReason}`)
if (!first.sawMessageDelta || !first.sawMessageStop) throw new Error(`first turn did not terminate cleanly: ${JSON.stringify(first)}`)
if (first.outputTokens !== FIRST_MAX_TOKENS) throw new Error(`first usage mismatch: expected ${FIRST_MAX_TOKENS}, got ${first.outputTokens}`)
const firstValues = parseIntegers(first.text)
assertSequential(firstValues, "first turn")

const second = await streamTurn(
  [
    { role: "user", content: prompt },
    { role: "assistant", content: first.text },
    { role: "user", content: "Continue exactly with the next integer. Output only more comma-separated integers; do not repeat any integer already shown." },
  ],
  SECOND_MAX_TOKENS,
)
const secondValues = parseIntegers(second.text)
assertSequential(secondValues, "continuation turn")
if (secondValues[0] !== firstValues.at(-1)! + 1) {
  throw new Error(`continuation repeated or skipped: first ended ${firstValues.at(-1)}, continuation began ${secondValues[0]}`)
}

console.log(
  JSON.stringify({
    verdict: "PASS",
    model: MODEL,
    first: {
      maxTokens: FIRST_MAX_TOKENS,
      stopReason: first.stopReason,
      outputTokens: first.outputTokens,
      sawMessageDelta: first.sawMessageDelta,
      sawMessageStop: first.sawMessageStop,
      firstInteger: firstValues[0],
      lastInteger: firstValues.at(-1),
      sample: first.text,
    },
    continuation: {
      maxTokens: SECOND_MAX_TOKENS,
      stopReason: second.stopReason,
      outputTokens: second.outputTokens,
      firstInteger: secondValues[0],
      lastInteger: secondValues.at(-1),
      sample: second.text,
    },
  }),
)
