import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { StreamEvent } from "~/types/api/anthropic"

import { extractToolParamTypes } from "~/lib/anthropic/recover-tool-call/schema-extract"
import { createToolCallTextRecoverer } from "~/lib/anthropic/recover-tool-call/stream"

const schemas = extractToolParamTypes([{ name: "Write", input_schema: { properties: { file_path: { type: "string" }, content: { type: "string" } } } }])
const deps = { enabled: true, toolNames: new Set(["Write"]), toolSchemas: schemas }

function ev(obj: Record<string, unknown>): { parsed: StreamEvent; raw: ServerSentEventMessage } {
  return { parsed: obj as unknown as StreamEvent, raw: { data: JSON.stringify(obj) } }
}
function drive(r: ReturnType<typeof createToolCallTextRecoverer>, events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const e of events) {
    const { parsed, raw } = ev(e)
    for (const f of r.processEvent(parsed, raw)) out.push(JSON.parse(f.data as string) as Record<string, unknown>)
  }
  for (const f of r.flush()) out.push(JSON.parse(f.data as string) as Record<string, unknown>)
  return out
}

describe("createToolCallTextRecoverer", () => {
  const downgradeStream = [
    { type: "message_start", message: { id: "msg_1" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "…" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text" } },
    {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "text_delta",
        text: '先写文件。\n\ncall\n<invoke name="Write">\n<parameter name="file_path">/a</parameter>\n<parameter name="content">x</parameter>\n</invoke>\n',
      },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]

  test("降级流 → text(散文) + 合成 tool_use + message_delta=tool_use", () => {
    const out = drive(createToolCallTextRecoverer(deps), downgradeStream)
    const tuStart = out.find((e) => e.type === "content_block_start" && (e.content_block as { type?: string })?.type === "tool_use")
    expect(tuStart).toBeDefined()
    expect((tuStart!.content_block as { name?: string }).name).toBe("Write")
    const md = out.find((e) => e.type === "message_delta")
    expect((md!.delta as { stop_reason?: string }).stop_reason).toBe("tool_use")
    expect(out.some((e) => e.type === "content_block_delta" && ((e.delta as { text?: string })?.text ?? "").includes("先写文件"))).toBe(true)
    const proseDeltas = out
      .filter((e) => e.type === "content_block_delta" && (e.delta as { type?: string })?.type === "text_delta")
      .map((e) => (e.delta as { text?: string }).text ?? "")
      .join("")
    expect(proseDeltas).not.toContain("call")
    expect(proseDeltas).not.toContain("<invoke")
  })

  test("CANDIDATE 后又来 content_block_start（非终结）→ 放弃改写，补发原始帧、不发合成 tool_use", () => {
    const notTerminal = [
      ...downgradeStream.slice(0, 7),
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_real", name: "Write" } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]
    const out = drive(createToolCallTextRecoverer(deps), notTerminal)
    const synthesized = out.filter(
      (e) =>
        e.type === "content_block_start"
        && (e.content_block as { id?: string })?.id?.startsWith("toolu_")
        && (e.content_block as { id?: string }).id !== "toolu_real",
    )
    expect(synthesized).toHaveLength(0)
    const allText = out
      .filter((e) => e.type === "content_block_delta")
      .map((e) => (e.delta as { text?: string })?.text ?? "")
      .join("")
    expect(allText).toContain("<invoke")
  })

  test("BUFFERING 中途 abort（flush）→ 回放缓冲原始帧、不发合成", () => {
    const r = createToolCallTextRecoverer(deps)
    const out: Array<Record<string, unknown>> = []
    for (const e of downgradeStream.slice(0, 6)) {
      const { parsed, raw } = ev(e)
      for (const f of r.processEvent(parsed, raw)) out.push(JSON.parse(f.data as string) as Record<string, unknown>)
    }
    for (const f of r.flush()) out.push(JSON.parse(f.data as string) as Record<string, unknown>)
    const allText = out
      .filter((e) => e.type === "content_block_delta")
      .map((e) => (e.delta as { text?: string })?.text ?? "")
      .join("")
    expect(allText).toContain("<invoke")
  })

  test("enabled:false → 全透传", () => {
    const out = drive(createToolCallTextRecoverer({ ...deps, enabled: false }), downgradeStream)
    expect(out.find((e) => e.type === "message_delta")!.delta).toEqual({ stop_reason: "end_turn" })
  })

  test("非 text block（真实 tool_use）透传不受影响", () => {
    const normal = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_x", name: "Write" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]
    const out = drive(createToolCallTextRecoverer(deps), normal)
    expect(out).toHaveLength(4)
    expect(out[0]).toEqual(normal[0])
  })
})
