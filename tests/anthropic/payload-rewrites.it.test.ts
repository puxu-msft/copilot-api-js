/**
 * P1.2 golden — the Anthropic request-rewrite registry must be byte-equivalent
 * to the prior hand-wired composition
 * `sanitizeAnthropicMessages(applyAnthropicToolNameSanitization(preprocessTools(p), mapper))`.
 *
 * The oracle is that exact manual composition (the underlying sub-functions are
 * unchanged), so this test guards the *orchestration*: if anyone reorders the
 * modules or drops one, the assembled output diverges from the oracle and this
 * fails. Each scenario also asserts the chain actually did work (stats reflect a
 * real change) so a no-op cannot masquerade as passing.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  MessageParam,
  MessagesPayload,
  Tool,
} from "~/types/api/anthropic"

import { preprocessTools } from "~/lib/anthropic/message-tools"
import {
  //
  runAnthropicPayloadRewrites,
  type AnthropicRewriteContext,
} from "~/lib/anthropic/payload-rewrites"
import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"
import {
  //
  applyAnthropicToolNameSanitization,
  buildAnthropicToolNameMapper,
} from "~/lib/anthropic/sanitize/tool-name-sanitize"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

function user(content: Array<Record<string, unknown>> | string): MessageParam {
  return { role: "user", content } as unknown as MessageParam
}
function assistant(content: Array<Record<string, unknown>> | string): MessageParam {
  return { role: "assistant", content } as unknown as MessageParam
}
function payload(messages: Array<MessageParam>, extra?: Partial<MessagesPayload>): MessagesPayload {
  return { model: "claude-opus-4.8", max_tokens: 1024, messages, ...extra } as unknown as MessagesPayload
}

/** The exact prior composition — the byte-equivalence oracle. */
function oracle(p: MessagesPayload, ctx: AnthropicRewriteContext) {
  return sanitizeAnthropicMessages(applyAnthropicToolNameSanitization(preprocessTools(p), ctx.toolNameMapper))
}

const NO_MAPPER: AnthropicRewriteContext = { toolNameMapper: null }

interface Scenario {
  name: string
  setup?: () => void
  payload: MessagesPayload
  ctx: AnthropicRewriteContext
  /** Optional assertion that the chain did meaningful work (anti false-green). */
  didWork?: (stats: Record<string, number>) => boolean
}

const scenarios: Array<Scenario> = [
  {
    name: "plain conversation (baseline, no rewrites fire)",
    payload: payload([user("hello"), assistant("hi")]),
    ctx: NO_MAPPER,
  },
  {
    // At default config (rewriteSystemReminders: false) reminders are passed
    // through unchanged — a faithful-passthrough equivalence case. Active reminder
    // stripping is exhaustively covered by message-sanitizer.it.test.ts.
    name: "system + message reminders passthrough at default config",
    payload: payload([user([{ type: "text", text: "real question\n<system-reminder>\nnoise\n</system-reminder>" }])], {
      system: [
        { type: "text", text: "base" },
        { type: "text", text: "<system-reminder>sys noise</system-reminder>" },
      ] as unknown as MessagesPayload["system"],
    }),
    ctx: NO_MAPPER,
  },
  {
    name: "orphaned tool_result dropped",
    payload: payload([user([{ type: "tool_result", tool_use_id: "missing", content: "orphan" }]), user("follow up")]),
    ctx: NO_MAPPER,
    didWork: (s) => s.orphanedToolResultCount > 0 || s.totalBlocksRemoved > 0,
  },
  {
    name: "orphaned tool_use dropped",
    payload: payload([user("q"), assistant([{ type: "tool_use", id: "t1", name: "Read", input: {} }]), assistant("no matching result")]),
    ctx: NO_MAPPER,
    didWork: (s) => s.orphanedToolUseCount > 0 || s.totalBlocksRemoved > 0,
  },
  {
    name: "corrupt (unsigned empty) thinking block stripped",
    setup: () => setStateForTests({ thinkingBlockSanitizeCheck: "all_empty" }),
    payload: payload([
      assistant([
        { type: "thinking", thinking: "", signature: "" },
        { type: "text", text: "ok" },
      ]),
      user("next"),
    ]),
    ctx: NO_MAPPER,
    didWork: (s) => s.emptyThinkingBlocksRemoved > 0,
  },
  {
    name: "prior-turn server-tool blocks (empty encrypted_content) downgraded by the always-on fallback then validated",
    payload: payload([
      assistant([
        { type: "server_tool_use", id: "srv1", name: "web_search", input: { query: "x" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "srv1",
          content: [{ type: "web_search_result", title: "R", url: "https://e.com", encrypted_content: "", page_age: null }],
        },
      ]),
      user("continue"),
    ]),
    ctx: NO_MAPPER,
  },
  {
    name: "inline system message converted to user",
    setup: () => setStateForTests({ systemDefaultMode: "as_user" }),
    payload: payload([{ role: "system", content: "inline sys" } as unknown as MessageParam, user("q")]),
    ctx: NO_MAPPER,
    didWork: (s) => s.inlineSystemConverted > 0,
  },
  {
    name: "tool-name sanitize applied (mapper present)",
    setup: () => setStateForTests({ sanitizeToolNames: true }),
    payload: payload([user("use a tool")], {
      tools: [{ name: "weird tool name!", description: "d", input_schema: { type: "object", properties: {} } }] as unknown as Array<Tool>,
    }),
    ctx: { toolNameMapper: buildAnthropicToolNameMapper([{ name: "weird tool name!" }] as unknown as Array<Tool>, "claude-opus-4.8", "Anthropic") },
  },
  {
    // Composite: tool-name rename + inline-system convert + orphan cleanup all
    // fire in one request — the strongest order-sensitivity assertion (the
    // intermediate payload must thread correctly through all three modules).
    name: "composite — tool-name + inline-system + orphan cleanup together",
    setup: () => setStateForTests({ sanitizeToolNames: true, systemDefaultMode: "as_user" }),
    payload: payload(
      [
        { role: "system", content: "inline sys" } as unknown as MessageParam,
        user([{ type: "tool_result", tool_use_id: "missing", content: "orphan" }]),
        user("real question"),
      ],
      { tools: [{ name: "weird tool name!", description: "d", input_schema: { type: "object", properties: {} } }] as unknown as Array<Tool> },
    ),
    ctx: { toolNameMapper: buildAnthropicToolNameMapper([{ name: "weird tool name!" }] as unknown as Array<Tool>, "claude-opus-4.8", "Anthropic") },
    didWork: (s) => s.inlineSystemConverted > 0 || s.orphanedToolResultCount > 0 || s.totalBlocksRemoved > 0,
  },
]

describe("Anthropic request-rewrite registry — byte-equivalence with prior composition", () => {
  for (const s of scenarios) {
    test(s.name, () => {
      s.setup?.()
      const expected = oracle(s.payload, s.ctx)
      const actual = runAnthropicPayloadRewrites(s.payload, s.ctx)

      // Final payload and the canonical SanitizeResult are byte-identical to the oracle.
      expect(actual.sanitizeResult).toEqual(expected)
      expect(actual.payload).toEqual(expected.payload)

      if (s.didWork) {
        expect(s.didWork(actual.sanitizeResult.stats as unknown as Record<string, number>)).toBe(true)
      }
    })
  }

  test("tool-name module is skipped (not applied as no-op) when mapper is null — still byte-identical", () => {
    const p = payload([user("q")], { tools: [{ name: "Read", description: "d", input_schema: { type: "object", properties: {} } }] as unknown as Array<Tool> })
    const expected = oracle(p, NO_MAPPER)
    const actual = runAnthropicPayloadRewrites(p, NO_MAPPER)
    expect(actual.sanitizeResult).toEqual(expected)
  })
})
