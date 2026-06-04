import { describe, expect, test } from "bun:test"
import { z } from "zod"

import { ConfigSchema } from "~/lib/config/schema"

const toJsonSchema = () =>
  z.toJSONSchema(ConfigSchema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >

/** Resolve a `nullable`-wrapped section to its object schema (peek into anyOf). */
function pickObjectSchema(node: unknown): Record<string, unknown> {
  if (node && typeof node === "object" && "anyOf" in node) {
    const anyOf = (node as { anyOf: Array<Record<string, unknown>> }).anyOf
    const objectNode = anyOf.find((n) => n.type === "object")
    if (objectNode) return objectNode
  }
  return node as Record<string, unknown>
}

describe("ConfigSchema → JSON Schema export", () => {
  test("z.toJSONSchema does not throw", () => {
    expect(() => toJsonSchema()).not.toThrow()
  })

  test("emitted schema is a valid object with type/properties/additionalProperties", () => {
    const json = toJsonSchema()
    expect(json.type).toBe("object")
    expect(json.properties).toBeDefined()
    // strict() → additionalProperties: false
    expect(json.additionalProperties).toBe(false)
  })

  test("known top-level keys are present in JSON Schema properties", () => {
    const json = toJsonSchema()
    const props = json.properties as Record<string, unknown>
    for (const key of [
      "proxy",
      "anthropic",
      "history",
      "shutdown",
      "rate_limiter",
      "openai-responses",
      "model_overrides",
      "stream_idle_timeout",
      "fetch_timeout",
    ]) {
      expect(props[key]).toBeDefined()
    }
  })

  test("removed deprecated keys are NOT in JSON Schema", () => {
    const json = toJsonSchema()
    const anthropic = pickObjectSchema((json.properties as Record<string, unknown>).anthropic)
    const anthropicProps = anthropic.properties as Record<string, unknown>
    expect(anthropicProps.immutable_thinking_messages).toBeUndefined()
    expect(anthropicProps.auto_cache_control).toBeUndefined()

    const history = pickObjectSchema((json.properties as Record<string, unknown>).history)
    const historyProps = history.properties as Record<string, unknown>
    expect(historyProps.min_entries).toBeUndefined()
  })

  test("enum constraints round-trip into JSON Schema", () => {
    const json = toJsonSchema()
    const anthropic = pickObjectSchema((json.properties as Record<string, unknown>).anthropic)
    const anthropicProps = anthropic.properties as Record<string, unknown>
    // cache_control is wrapped in anyOf [enum, null] because of .nullable() for HTTP PUT semantics
    const cacheControl = anthropicProps.cache_control as Record<string, unknown>
    const anyOf = cacheControl.anyOf as Array<Record<string, unknown>>
    const enumNode = anyOf.find((n) => Array.isArray(n.enum))
    expect(enumNode?.enum).toEqual(["disabled", "passthrough", "sanitize", "proxied"])
  })

  test("free-form records appear as additionalProperties: {schema}", () => {
    const json = toJsonSchema()
    const modelOverrides = pickObjectSchema((json.properties as Record<string, unknown>).model_overrides)
    expect(modelOverrides.type).toBe("object")
    expect(modelOverrides.additionalProperties).toBeDefined()
    // user-defined keys allowed
    expect(modelOverrides.additionalProperties).not.toBe(false)
  })
})
