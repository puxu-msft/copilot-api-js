/**
 * Phase 5 (RFC 2026-07-14 §4.1) — four-format `client.inbound` rewrite helpers. Each format lays its
 * turns / system text out differently; the helpers dispatch on `env.clientFormat`. These assert the
 * client-native strip works for ALL FOUR inbound formats (Phase 3 made each native at client.inbound)
 * and that rewrites are immutable (new body, original untouched).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"

import {
  //
  stripMessageBlock,
  stripSystemText,
} from "~/lib/pipeline/hooks/client-rewrite"

const TODO = /The TodoWrite tool hasn't been used recently\.( Consider using it\.)?/
const REMINDER = "The TodoWrite tool hasn't been used recently. Consider using it."

/** Minimal env stub: clientFormat + body + immutable `with`. */
function env(clientFormat: string, body: unknown): RequestEnvelope {
  return { clientFormat, body, with(patch: Partial<RequestEnvelope>) { return { ...this, ...patch } as RequestEnvelope } } as unknown as RequestEnvelope
}

describe("client-rewrite — stripMessageBlock (conversation-turn formats)", () => {
  test("anthropic: drops a role:system TodoWrite message turn, keeps the rest, immutable", () => {
    const body = { messages: [{ role: "system", content: REMINDER }, { role: "user", content: "hi" }] }
    const out = stripMessageBlock(env("anthropic", body), (t) => t.role === "system" && TODO.test(t.text))
    expect((out.body as typeof body).messages).toEqual([{ role: "user", content: "hi" }])
    expect(body.messages).toHaveLength(2) // original untouched (immutable)
    expect(out).not.toBe(env("anthropic", body)) // new env
  })

  test("openai-cc: drops a role:system TodoWrite turn (array-content text projection)", () => {
    const body = { messages: [{ role: "system", content: [{ type: "text", text: REMINDER }] }, { role: "user", content: "hi" }] }
    const out = stripMessageBlock(env("openai-cc", body), (t) => t.role === "system" && TODO.test(t.text))
    expect((out.body as typeof body).messages).toHaveLength(1)
    expect((out.body as typeof body).messages[0].role).toBe("user")
  })

  test("openai-responses: drops a matching input message item (input list, not messages)", () => {
    const body = { instructions: "be terse", input: [{ type: "message", role: "system", content: [{ type: "input_text", text: REMINDER }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }
    // responses text projection reads `content` array {type,text}; input_text has no `text` under our
    // messageText (type!=="text"), so match on role for this shape.
    const out = stripMessageBlock(env("openai-responses", body), (t) => t.role === "system")
    expect((out.body as typeof body).input).toHaveLength(1)
    expect((out.body as typeof body).input[0].role).toBe("user")
  })

  test("gemini: drops a matching contents turn (contents list + parts text projection)", () => {
    const body = { contents: [{ role: "user", parts: [{ text: REMINDER }] }, { role: "user", parts: [{ text: "real" }] }] }
    const out = stripMessageBlock(env("gemini", body), (t) => TODO.test(t.text))
    expect((out.body as typeof body).contents).toEqual([{ role: "user", parts: [{ text: "real" }] }])
  })

  test("no match → same env unchanged (identity)", () => {
    const e = env("anthropic", { messages: [{ role: "user", content: "hi" }] })
    expect(stripMessageBlock(e, () => false)).toBe(e)
  })
})

describe("client-rewrite — stripSystemText (out-of-band system carriers)", () => {
  test("anthropic top-level string system: strips the reminder text", () => {
    const out = stripSystemText(env("anthropic", { system: `You are helpful. ${REMINDER}`, messages: [] }), TODO)
    expect((out.body as { system: string }).system).toBe("You are helpful.")
  })

  test("anthropic system becoming empty → carrier removed", () => {
    const out = stripSystemText(env("anthropic", { system: REMINDER, messages: [] }), TODO)
    expect("system" in (out.body as object)).toBe(false)
  })

  test("openai-responses instructions: strips the reminder text", () => {
    const out = stripSystemText(env("openai-responses", { instructions: `Be terse. ${REMINDER}`, input: [] }), TODO)
    expect((out.body as { instructions: string }).instructions).toBe("Be terse.")
  })

  test("gemini systemInstruction.parts: strips the reminder text", () => {
    const out = stripSystemText(env("gemini", { systemInstruction: { parts: [{ text: REMINDER }] }, contents: [] }), TODO)
    expect("systemInstruction" in (out.body as object)).toBe(false) // parts emptied → carrier removed
  })

  test("openai-cc has no out-of-band system carrier → unchanged", () => {
    const e = env("openai-cc", { messages: [] })
    expect(stripSystemText(e, TODO)).toBe(e)
  })
})
