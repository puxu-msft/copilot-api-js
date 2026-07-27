import Anthropic from "@anthropic-ai/sdk"
import { spawn } from "bun"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const MODEL = "claude-sonnet-4.6"
const REQUEST_MAX_TOKENS = 64
const FIRST_USAGE = 64
const FINAL_USAGE = 88
const MARKER = "[continued after max_tokens] "

type Frame = { event: string; data: Record<string, unknown> }
type Variant = "transparent" | "marker" | "bad-colliding-index" | "bad-leaked-terminal"

interface WireObservation {
  messageStarts: number
  messageStops: number
  blockStartIndices: number[]
  stopReasons: Array<string | null>
  outputTokens: number[]
}

function messageStart(): Frame {
  return {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_max_tokens_stitch",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  }
}

function textBlock(index: number, text: string): Frame[] {
  return [
    { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index } },
  ]
}

function messageDelta(stopReason: "max_tokens" | "end_turn", outputTokens: number): Frame {
  return {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
  }
}

const messageStop: Frame = { event: "message_stop", data: { type: "message_stop" } }

function producerWire(variant: Variant): Frame[] {
  const continuationIndex = variant === "bad-colliding-index" ? 0 : variant === "marker" ? 2 : 1
  const frames: Frame[] = [messageStart(), ...textBlock(0, "Alpha beta ")]

  if (variant === "bad-leaked-terminal") {
    frames.push(messageDelta("max_tokens", FIRST_USAGE), messageStop)
  }

  if (variant === "marker") frames.push(...textBlock(1, MARKER))
  frames.push(...textBlock(continuationIndex, "gamma delta."), messageDelta("end_turn", variant === "marker" ? FINAL_USAGE + 1 : FINAL_USAGE), messageStop)
  return frames
}

function observeWire(frames: Frame[]): WireObservation {
  const observation: WireObservation = {
    messageStarts: 0,
    messageStops: 0,
    blockStartIndices: [],
    stopReasons: [],
    outputTokens: [],
  }
  for (const frame of frames) {
    if (frame.data.type === "message_start") observation.messageStarts++
    if (frame.data.type === "message_stop") observation.messageStops++
    if (frame.data.type === "content_block_start") observation.blockStartIndices.push(frame.data.index as number)
    if (frame.data.type === "message_delta") {
      observation.stopReasons.push((frame.data.delta as { stop_reason: string | null }).stop_reason)
      observation.outputTokens.push((frame.data.usage as { output_tokens: number }).output_tokens)
    }
  }
  return observation
}

function assertProducerContract(variant: Variant, frames: Frame[]): WireObservation {
  const observation = observeWire(frames)
  const expectedIndices = variant === "marker" ? [0, 1, 2] : [0, 1]

  if (observation.messageStarts !== 1) throw new Error(`expected one message_start, got ${observation.messageStarts}`)
  if (observation.messageStops !== 1) throw new Error(`expected one message_stop, got ${observation.messageStops}`)
  if (JSON.stringify(observation.blockStartIndices) !== JSON.stringify(expectedIndices)) {
    throw new Error(`expected contiguous block indices ${JSON.stringify(expectedIndices)}, got ${JSON.stringify(observation.blockStartIndices)}`)
  }
  if (observation.stopReasons.length !== 1 || observation.stopReasons[0] !== "end_turn") {
    throw new Error(`expected only final end_turn, got ${JSON.stringify(observation.stopReasons)}`)
  }
  if (!observation.outputTokens.every((value, index, values) => index === 0 || value >= values[index - 1]!)) {
    throw new Error(`usage.output_tokens is not monotonic: ${JSON.stringify(observation.outputTokens)}`)
  }
  if (observation.outputTokens.at(-1)! <= REQUEST_MAX_TOKENS) {
    throw new Error(`final usage ${observation.outputTokens.at(-1)} did not exceed requested max_tokens ${REQUEST_MAX_TOKENS}`)
  }
  return observation
}

function toSse(frames: Frame[]): string {
  return frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join("")
}

async function consumeWithSdk(variant: "transparent" | "marker"): Promise<Record<string, unknown>> {
  const frames = producerWire(variant)
  const wire = assertProducerContract(variant, frames)
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(toSse(frames), { headers: { "content-type": "text/event-stream" } }),
  })
  const client = new Anthropic({ baseURL: `http://127.0.0.1:${server.port}`, apiKey: "offline-poc", maxRetries: 0 })
  try {
    const stream = client.messages.stream({ model: MODEL, max_tokens: REQUEST_MAX_TOKENS, messages: [{ role: "user", content: "Continue the sequence." }] })
    const sdkEvents: string[] = []
    for await (const event of stream) sdkEvents.push(event.type)
    const final = await stream.finalMessage()
    const text = final.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    const expectedText = variant === "marker" ? `Alpha beta ${MARKER}gamma delta.` : "Alpha beta gamma delta."
    if (text !== expectedText) throw new Error(`SDK content mismatch: expected ${JSON.stringify(expectedText)}, got ${JSON.stringify(text)}`)
    if (final.stop_reason !== "end_turn") throw new Error(`SDK stop_reason mismatch: ${final.stop_reason}`)
    if (final.usage.output_tokens !== (variant === "marker" ? FINAL_USAGE + 1 : FINAL_USAGE)) {
      throw new Error(`SDK usage mismatch: ${final.usage.output_tokens}`)
    }
    return {
      variant,
      verdict: "PASS",
      text,
      blocks: final.content.length,
      stopReason: final.stop_reason,
      requestedMaxTokens: REQUEST_MAX_TOKENS,
      finalOutputTokens: final.usage.output_tokens,
      wire,
      sdkEventCounts: Object.fromEntries([...new Set(sdkEvents)].map((type) => [type, sdkEvents.filter((candidate) => candidate === type).length])),
    }
  } finally {
    server.stop(true)
  }
}

function runPositiveControls(): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = []
  for (const variant of ["bad-colliding-index", "bad-leaked-terminal"] as const) {
    try {
      assertProducerContract(variant, producerWire(variant))
      throw new Error(`${variant} unexpectedly passed the producer oracle`)
    } catch (error) {
      results.push({ variant, verdict: "EXPECTED_FAIL", reason: (error as Error).message })
    }
  }
  return results
}

async function driveClaudeCli(label: string, frames: Frame[], expectedResult: string): Promise<Record<string, unknown>> {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(toSse(frames), { headers: { "content-type": "text/event-stream" } }),
  })
  const home = mkdtempSync(join(tmpdir(), "max-tokens-cli-poc-"))
  mkdirSync(join(home, ".claude"), { recursive: true })
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }))
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_AUTH_TOKEN: "offline-poc", ANTHROPIC_MODEL: MODEL } }),
  )
  try {
    const proc = spawn(["claude", "-p", "Continue the sequence.", "--model", MODEL, "--output-format", "json"], {
      cwd: home,
      env: { ...process.env, HOME: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_AUTH_TOKEN: "offline-poc" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeout = setTimeout(() => proc.kill(), 45_000)
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).finally(() => clearTimeout(timeout))
    if (exitCode !== 0) throw new Error(`claude exited ${exitCode}: ${stderr || stdout}`)
    const parsed = JSON.parse(stdout) as { result?: string; num_turns?: number; stop_reason?: string; is_error?: boolean }
    if (parsed.result !== expectedResult) throw new Error(`CLI result mismatch: expected ${JSON.stringify(expectedResult)}, got ${JSON.stringify(parsed.result)}`)
    if (parsed.num_turns !== 1) throw new Error(`CLI stalled/looped: num_turns=${parsed.num_turns}`)
    if (parsed.is_error) throw new Error(`CLI reported is_error=true: ${stdout}`)
    return { label, verdict: "PASS", result: parsed.result, numTurns: parsed.num_turns, stopReason: parsed.stop_reason, exitCode }
  } finally {
    server.stop(true)
  }
}

console.log(JSON.stringify({ positiveControls: runPositiveControls() }))
for (const variant of ["transparent", "marker"] as const) console.log(JSON.stringify(await consumeWithSdk(variant)))
console.log(JSON.stringify({ variant: "transparent-claude-cli", ...(await driveClaudeCli("stitched", producerWire("transparent"), "gamma delta.")) }))
console.log(JSON.stringify({ variant: "single-block-claude-cli-control", ...(await driveClaudeCli("single-block-control", [messageStart(), ...textBlock(0, "gamma delta."), messageDelta("end_turn", 24), messageStop], "gamma delta.")) }))
