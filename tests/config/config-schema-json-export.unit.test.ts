import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { z } from "zod"

import { ConfigSchema } from "~/lib/config/schema"

const toJsonSchema = () => z.toJSONSchema(ConfigSchema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as Record<string, unknown>

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
    for (const key of ["proxy", "anthropic", "history", "shutdown", "rate_limiter", "openai_responses", "model_mappings", "timeouts", "retry"]) {
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
    const modelMappings = pickObjectSchema((json.properties as Record<string, unknown>).model_mappings)
    expect(modelMappings.type).toBe("object")
    expect(modelMappings.additionalProperties).toBeDefined()
    // user-defined keys allowed
    expect(modelMappings.additionalProperties).not.toBe(false)
  })

  test("upstream_transport section: http2 + websocket sub-sections with expected leaf keys", () => {
    const json = toJsonSchema()
    const upstreamTransport = pickObjectSchema((json.properties as Record<string, unknown>).upstream_transport)
    const utProps = upstreamTransport.properties as Record<string, unknown>
    expect(utProps.tcp_keepalive_probe_delay).toBeDefined()

    const http2 = pickObjectSchema(utProps.http2)
    const http2Props = http2.properties as Record<string, unknown>
    expect(http2Props.favor).toBeDefined()
    expect(http2Props.ping_interval).toBeDefined()
    expect(http2Props.session_connect_timeout).toBeDefined()

    const websocket = pickObjectSchema(utProps.websocket)
    const wsProps = websocket.properties as Record<string, unknown>
    expect(wsProps.pooled_connection_idle_timeout).toBeDefined()
    expect(wsProps.soft_max_connections).toBeDefined()
  })

  test("server.responses_ws section holds the migrated client-facing WS ingress limits", () => {
    const json = toJsonSchema()
    const server = pickObjectSchema((json.properties as Record<string, unknown>).server)
    const serverProps = server.properties as Record<string, unknown>
    const responsesWs = pickObjectSchema(serverProps.responses_ws)
    const rwsProps = responsesWs.properties as Record<string, unknown>
    expect(rwsProps.keep_open).toBeDefined()
    expect(rwsProps.max_frame_bytes).toBeDefined()
    expect(rwsProps.max_connections).toBeDefined()
  })

  test("timeouts section no longer carries upstream_keepalive / upstream_h2_ping (moved to upstream_transport)", () => {
    const json = toJsonSchema()
    const timeouts = pickObjectSchema((json.properties as Record<string, unknown>).timeouts)
    const timeoutsProps = timeouts.properties as Record<string, unknown>
    expect(timeoutsProps.upstream_keepalive).toBeUndefined()
    expect(timeoutsProps.upstream_h2_ping).toBeUndefined()
  })

  test("openai_responses no longer carries the WS ingress / upstream-ws-cap fields (moved out)", () => {
    const json = toJsonSchema()
    const responses = pickObjectSchema((json.properties as Record<string, unknown>).openai_responses)
    const responsesProps = responses.properties as Record<string, unknown>
    expect(responsesProps.client_ws_keep_open).toBeUndefined()
    expect(responsesProps.max_ws_frame_bytes).toBeUndefined()
    expect(responsesProps.max_client_ws_connections).toBeUndefined()
    expect(responsesProps.max_upstream_ws_connections).toBeUndefined()
  })
})
