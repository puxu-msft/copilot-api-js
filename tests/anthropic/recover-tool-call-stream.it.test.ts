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

  test("空 text_delta 立即透传，不能被 tool-call lookahead 吞掉", () => {
    const r = createToolCallTextRecoverer(deps)
    const start = ev({ type: "content_block_start", index: 0, content_block: { type: "text" } })
    expect(r.processEvent(start.parsed, start.raw)).toEqual([start.raw])

    const keepalive = ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })
    expect(r.processEvent(keepalive.parsed, keepalive.raw)).toEqual([keepalive.raw])
  })

  test("空 delta 穿插在 marker 识别前与 BUFFERING 后仍逐帧透传", () => {
    const r = createToolCallTextRecoverer(deps)
    const emptyBefore = ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })
    const emptyBuffered = ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "足够长的普通散文用于填满 lookahead 窗口。\ncall\n<in" } },
      JSON.parse(emptyBefore.raw.data as string),
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 'voke name="Write">\n<parameter name="file_path">/a</parameter>\n' } },
      JSON.parse(emptyBuffered.raw.data as string),
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '<parameter name="content">x</parameter>\n</invoke>\n' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]
    const out = drive(r, events)
    const emptyDeltas = out.filter(
      (event) =>
        event.type === "content_block_delta"
        && (event.delta as { type?: string; text?: string })?.type === "text_delta"
        && (event.delta as { text?: string }).text === "",
    )
    expect(emptyDeltas).toHaveLength(2)
    const text = out
      .filter((event) => event.type === "content_block_delta" && (event.delta as { type?: string })?.type === "text_delta")
      .map((event) => (event.delta as { text?: string }).text ?? "")
      .join("")
    expect(text).not.toContain("<invoke")
    expect(text).not.toContain("call")
    expect(out.filter((event) => event.type === "content_block_start" && (event.content_block as { type?: string })?.type === "tool_use")).toHaveLength(1)
  })

  test("lookahead 跨 delta 切分（marker 被拆成两帧）→ 不泄漏 <invoke/call 残留 + 合成 tool_use", () => {
    // 把降级文本拆成多个 text_delta，marker `<invoke` 恰好跨 delta 边界（delta1 尾="…\n<in"，delta2 头="voke …"）。
    // 32 字符 lookahead 应阻止半截 marker 泄漏给客户端。
    const prose = "这是一段足够长的散文，超过三十二个字符以确保 lookahead 窗口被填满后才开始转发。\n\n"
    const tail = 'call\n<invoke name="Write">\n<parameter name="file_path">/a</parameter>\n<parameter name="content">x</parameter>\n</invoke>\n'
    const full = prose + tail
    const splitAt = full.indexOf("<invoke") + 3 // "<in" | "voke …"
    const stream = [
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: full.slice(0, splitAt) } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: full.slice(splitAt) } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]
    const out = drive(createToolCallTextRecoverer(deps), stream)
    const proseDeltas = out
      .filter((e) => e.type === "content_block_delta" && (e.delta as { type?: string })?.type === "text_delta")
      .map((e) => (e.delta as { text?: string }).text ?? "")
      .join("")
    expect(proseDeltas).not.toContain("<invoke")
    expect(proseDeltas).not.toContain("call")
    expect(proseDeltas).toContain("这是一段足够长的散文")
    const tuStart = out.find((e) => e.type === "content_block_start" && (e.content_block as { type?: string })?.type === "tool_use")
    expect(tuStart).toBeDefined()
    expect((tuStart!.content_block as { name?: string }).name).toBe("Write")
    const md = out.find((e) => e.type === "message_delta")
    expect((md!.delta as { stop_reason?: string }).stop_reason).toBe("tool_use")
  })

  test("tier A 成功（stop_reason=tool_use、无真实 tool_use block、降级文本无 call 残留）→ 重建 + stop_reason 保持 tool_use", () => {
    // tier A 不要求残留 token：纯 `<invoke name="Write">…</invoke>`，stop_reason=tool_use 即可命中。
    const tail = '<invoke name="Write">\n<parameter name="file_path">/a</parameter>\n<parameter name="content">x</parameter>\n</invoke>'
    const stream = [
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "先输出一段普通散文足够长超过三十二个字符以触发 lookahead。\n" + tail } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]
    const out = drive(createToolCallTextRecoverer(deps), stream)
    const tuStart = out.find((e) => e.type === "content_block_start" && (e.content_block as { type?: string })?.type === "tool_use")
    expect(tuStart).toBeDefined()
    expect((tuStart!.content_block as { name?: string }).name).toBe("Write")
    const tuDelta = out.find((e) => e.type === "content_block_delta" && (e.delta as { type?: string })?.type === "input_json_delta")
    expect(JSON.parse((tuDelta!.delta as { partial_json: string }).partial_json)).toEqual({ file_path: "/a", content: "x" })
    const proseDeltas = out
      .filter((e) => e.type === "content_block_delta" && (e.delta as { type?: string })?.type === "text_delta")
      .map((e) => (e.delta as { text?: string }).text ?? "")
      .join("")
    expect(proseDeltas).not.toContain("<invoke")
    const md = out.find((e) => e.type === "message_delta")
    // stop_reason 本就是 tool_use，commitTier 命中 "A"，不应被改写也不应回退
    expect((md!.delta as { stop_reason?: string }).stop_reason).toBe("tool_use")
  })

  test("单实例跨 message：message_start 重置状态，第二个降级 message 仍能恢复", () => {
    const r = createToolCallTextRecoverer(deps)
    // message 1：含真实 tool_use block（会置 sawToolUseBlock=true），index 到 2
    const msg1 = [
      { type: "message_start", message: { id: "msg_1" } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_real", name: "Write" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]
    // message 2：干净降级（tier A：stop_reason=tool_use，无真实 tool_use block）
    const msg2 = [
      { type: "message_start", message: { id: "msg_2" } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `<invoke name="Write"><parameter name="file_path">/b</parameter><parameter name="content">y</parameter></invoke>` },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]
    const out = drive(r, [...msg1, ...msg2])
    // message_start 重置 sawToolUseBlock，故 message 2 的 tier A 门控不被 message 1 的 tool_use 污染
    const synthesized = out.find(
      (e) =>
        e.type === "content_block_start"
        && (e.content_block as { id?: string })?.id?.startsWith("toolu_")
        && (e.content_block as { id?: string }).id !== "toolu_real",
    )
    expect(synthesized).toBeDefined()
    expect((synthesized!.content_block as { name?: string }).name).toBe("Write")
    // 合成 index 基于 message 2 自己的 maxSeen（重置后从 0 起），不被 message 1 的 index 污染
    expect(synthesized!.index).toBe(1)
  })

  test("长 MCP 工具名（>32 字符）逐字流式：lookahead 动态尺寸，不泄漏 call/<invoke 残留", () => {
    // 检测发生在完整 `<invoke name="X">`（跨度 16+len(name)）。固定 32 lookahead 对长 MCP
    // 工具名会在 markPos 检出前把 call+半截开标签转发出去。lookahead 须按最长工具名动态定。
    const longName = "mcp__plugin_serena_serena__find_referencing_symbols" // 51 字符
    const longDeps = {
      enabled: true,
      toolNames: new Set([longName]),
      toolSchemas: extractToolParamTypes([{ name: longName, input_schema: { properties: { name_path: { type: "string" } } } }]),
    }
    const prose = "这是一段足够长的前置散文，用来确保 lookahead 窗口被填满后开始转发。\n\n"
    const tail = `call\n<invoke name="${longName}">\n<parameter name="name_path">Foo/bar</parameter>\n</invoke>\n`
    const full = prose + tail
    // 逐字符喂 delta，最大化暴露泄漏
    const stream: Array<Record<string, unknown>> = [{ type: "content_block_start", index: 0, content_block: { type: "text" } }]
    for (const ch of full) stream.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ch } })
    stream.push({ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" })

    const out = drive(createToolCallTextRecoverer(longDeps), stream)
    const proseDeltas = out
      .filter((e) => e.type === "content_block_delta" && (e.delta as { type?: string })?.type === "text_delta")
      .map((e) => (e.delta as { text?: string }).text ?? "")
      .join("")
    expect(proseDeltas).not.toContain("<invoke")
    expect(proseDeltas).not.toContain("call")
    expect(proseDeltas).toContain("这是一段足够长的前置散文")
    const tuStart = out.find((e) => e.type === "content_block_start" && (e.content_block as { type?: string })?.type === "tool_use")
    expect(tuStart).toBeDefined()
    expect((tuStart!.content_block as { name?: string }).name).toBe(longName)
    const md = out.find((e) => e.type === "message_delta")
    expect((md!.delta as { stop_reason?: string }).stop_reason).toBe("tool_use")
  })
})
