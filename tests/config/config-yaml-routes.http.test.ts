import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  applyConfigToState,
  resetApplyState,
  resetConfigCache,
  setBundledConfigForTests,
} from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import { initHistory } from "~/lib/history"
import {
  //
  DEFAULT_MODEL_MAPPINGS,
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
  state,
  type StateSnapshot,
} from "~/lib/state"

import { createFullTestApp } from "../helpers/test-app"

const app = createFullTestApp()

let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string
let snapshot: StateSnapshot

async function writeConfig(content: string): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
}

async function readConfig(): Promise<string> {
  return fs.readFile(PATHS.CONFIG_YAML, "utf8")
}

beforeEach(async () => {
  snapshot = snapshotStateForTests()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-yaml-route-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests({})
  await initHistory(true, 200)
})

afterEach(async () => {
  restoreStateForTests(snapshot)
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests(null)
})

describe("config yaml routes", () => {
  test("GET /api/config/yaml returns {} when config file is missing", async () => {
    const res = await app.request("/api/config/yaml")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  test("GET /api/config/yaml returns structured config from file", async () => {
    await writeConfig(`
timeouts:
  response_header: 600
history:
  raw_capture:
    enabled: false
anthropic:
  tool_strip_read_result_tags: true
`)

    const res = await app.request("/api/config/yaml")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      timeouts: { response_header: 600 },
      history: { raw_capture: { enabled: false } },
      anthropic: { tool_strip_read_result_tags: true },
    })
  })

  test("GET /api/config/yaml returns all known config fields", async () => {
    await writeConfig(`
proxy: "http://127.0.0.1:7890"
model_mappings:
  sonnet: claude-sonnet-4.7
timeouts:
  stream_idle: 301
  response_header: 600
  stale_request_max_age: 900
model_refresh_interval: 0
shutdown:
  graceful_wait: 12
  abort_wait: 34
history:
  raw_capture:
    enabled: false
    max_object_bytes: 1048576
anthropic:
  tool_strip_read_result_tags: true
  tool_dedup_calls: result
  thinking_block_message_policy: preserve
  context_editing: clear-both
  context_editing_trigger: 200000
  context_editing_keep_tools: 4
  context_editing_keep_thinking: 2
  tool_search: false
  cache_control: disabled
  tool_search_non_deferred:
    - custom_tool
    - second_tool
  system_rewrite_reminders:
    - from: '(?i)warning'
      to: ''
      method: regex
openai_responses:
  normalize_call_ids: false
  upstream_ws: true
rate_limiter:
  retry_interval: 15
  request_interval: 30
  recovery_interval: 60
  consecutive_successes: 3
retry:
  max_reactive_retries: 3
system_prompt_overrides:
  - from: danger
    to: safe
    model: claude-.*
    method: regex
system_prompt_prepend: "prepend"
system_prompt_append: "append"
`)

    const res = await app.request("/api/config/yaml")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      proxy: "http://127.0.0.1:7890",
      model_mappings: {
        sonnet: "claude-sonnet-4.7",
      },
      timeouts: {
        stream_idle: 301,
        response_header: 600,
        stale_request_max_age: 900,
      },
      model_refresh_interval: 0,
      shutdown: {
        graceful_wait: 12,
        abort_wait: 34,
      },
      history: {
        raw_capture: { enabled: false, max_object_bytes: 1048576 },
      },
      anthropic: {
        tool_strip_read_result_tags: true,
        tool_dedup_calls: "result",
        thinking_block_message_policy: "preserve",
        context_editing: "clear-both",
        context_editing_trigger: 200000,
        context_editing_keep_tools: 4,
        context_editing_keep_thinking: 2,
        tool_search: false,
        cache_control: "disabled",
        tool_search_non_deferred: ["custom_tool", "second_tool"],
        system_rewrite_reminders: [
          {
            from: "(?i)warning",
            to: "",
            method: "regex",
          },
        ],
      },
      openai_responses: {
        normalize_call_ids: false,
        upstream_ws: true,
      },
      rate_limiter: {
        retry_interval: 15,
        request_interval: 30,
        recovery_interval: 60,
        consecutive_successes: 3,
      },
      retry: {
        max_reactive_retries: 3,
      },
      system_prompt_overrides: [
        {
          from: "danger",
          to: "safe",
          model: "claude-.*",
          method: "regex",
        },
      ],
      system_prompt_prepend: "prepend",
      system_prompt_append: "append",
    })
  })

  test("GET /api/config/yaml returns structured error details for invalid YAML", async () => {
    await writeConfig("model_refresh_interval: [\n")

    const res = await app.request("/api/config/yaml")

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: "Failed to read config.yaml",
      details: [
        {
          field: "$",
          message: expect.stringContaining("Flow sequence in block collection"),
        },
      ],
    })
  })

  test("PUT /api/config/yaml rejects invalid enum values with field details", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: {
          context_editing: "invalid",
        },
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Config validation failed",
      details: [
        {
          field: "anthropic.context_editing",
          message: "Must be one of: off, clear-thinking, clear-tooluse, clear-both",
          value: "invalid",
        },
      ],
    })
  })

  test("PUT /api/config/yaml updates scalar fields while preserving surrounding comments", async () => {
    await writeConfig(`
# refresh comment
model_refresh_interval: 600

shutdown:
  graceful_wait: 30
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_refresh_interval: 300,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      model_refresh_interval: 300,
      shutdown: {
        graceful_wait: 30,
      },
    })

    const written = await readConfig()
    expect(written).toContain("# refresh comment")
    expect(written).toContain("model_refresh_interval: 300")
    expect(written).toContain("shutdown:")
    expect(written).toContain("graceful_wait: 30")
  })

  test("PUT /api/config/yaml writes unknown_endpoint_logging (regression: was silently dropped by mergeConfigIntoDocument)", async () => {
    await writeConfig("model_refresh_interval: 600\n")

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unknown_endpoint_logging: { not_found: "error", method_not_allowed: "silent" } }),
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { unknown_endpoint_logging?: unknown }).unknown_endpoint_logging).toEqual({
      not_found: "error",
      method_not_allowed: "silent",
    })

    // The bug: schema validated the field but mergeConfigIntoDocument never wrote it → 200 but no-op on disk.
    const written = await readConfig()
    expect(written).toContain("unknown_endpoint_logging:")
    expect(written).toContain("not_found: error")
    expect(written).toContain("method_not_allowed: silent")
  })

  test("PUT /api/config/yaml deletes a single unknown_endpoint_logging key with null (nullish contract through PUT)", async () => {
    await writeConfig("unknown_endpoint_logging:\n  not_found: error\n  method_not_allowed: warn\n")

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unknown_endpoint_logging: { not_found: null } }),
    })

    expect(res.status).toBe(200)
    const written = await readConfig()
    expect(written).not.toContain("not_found:")
    expect(written).toContain("method_not_allowed: warn")
  })

  test("PUT /api/config/yaml deletes optional scalar keys instead of writing null", async () => {
    await writeConfig(`
proxy: "http://127.0.0.1:7890"
model_refresh_interval: 600
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proxy: null,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      model_refresh_interval: 600,
    })

    const written = await readConfig()
    expect(written).not.toContain("proxy:")
    expect(written).not.toContain("null")
  })

  test("PUT /api/config/yaml creates the config file when it does not exist", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_refresh_interval: 90,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      model_refresh_interval: 90,
    })
    expect(await readConfig()).toContain("model_refresh_interval: 90")
  })

  test("PUT /api/config/yaml resets deleted runtime fields to defaults before reload", async () => {
    await writeConfig("model_refresh_interval: 123\n")
    await applyConfigToState()
    expect(state.modelRefreshInterval).toBe(123)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_refresh_interval: null,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    expect(state.modelRefreshInterval).toBe(600)
  })

  test("PUT /api/config/yaml bypasses loadConfig debounce by resetting cache before reload", async () => {
    const first = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_refresh_interval: 111,
      }),
    })
    expect(first.status).toBe(200)
    expect(state.modelRefreshInterval).toBe(111)

    const second = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_refresh_interval: 222,
      }),
    })
    expect(second.status).toBe(200)
    expect(state.modelRefreshInterval).toBe(222)
  })

  test("PUT /api/config/yaml accepts valid inline-flag regex rules", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_prompt_overrides: [
          {
            from: "(?i)danger",
            to: "safe",
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      system_prompt_overrides: [
        {
          from: "(?i)danger",
          to: "safe",
        },
      ],
    })
  })

  test("PUT /api/config/yaml rejects invalid rewrite rule regex patterns", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_prompt_overrides: [
          {
            from: "(?P<invalid",
            to: "safe",
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Config validation failed",
      details: [
        {
          field: "system_prompt_overrides.0.from",
          message: "Invalid rewrite rule regex",
          value: "(?P<invalid",
        },
      ],
    })
  })

  test("PUT /api/config/yaml accepts a valid full config payload", async () => {
    const payload = {
      proxy: "http://127.0.0.1:7890",
      model_mappings: {
        sonnet: "claude-sonnet-4.7",
        custom: "gpt-4.1",
      },
      timeouts: {
        stream_idle: 301,
        response_header: 600,
        stale_request_max_age: 900,
      },
      model_refresh_interval: 0,
      shutdown: {
        graceful_wait: 12,
        abort_wait: 34,
      },
      history: {
        raw_capture: { enabled: false, max_object_bytes: 1048576 },
      },
      anthropic: {
        tool_strip_read_result_tags: true,
        tool_dedup_calls: "result",
        thinking_block_message_policy: "preserve",
        context_editing: "clear-both",
        context_editing_trigger: 200000,
        context_editing_keep_tools: 4,
        context_editing_keep_thinking: 2,
        tool_search: false,
        cache_control: "disabled",
        tool_search_non_deferred: ["custom_tool", "second_tool"],
        system_rewrite_reminders: [
          {
            from: "(?i)warning",
            to: "",
            method: "regex",
          },
        ],
      },
      openai_responses: {
        normalize_call_ids: false,
        upstream_ws: true,
      },
      rate_limiter: {
        retry_interval: 15,
        request_interval: 30,
        recovery_interval: 60,
        consecutive_successes: 3,
      },
      retry: {
        max_reactive_retries: 3,
      },
      system_prompt_overrides: [
        {
          from: "danger",
          to: "safe",
          model: "claude-.*",
          method: "regex",
        },
      ],
      system_prompt_prepend: "prepend",
      system_prompt_append: "append",
    }

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(payload)

    const written = await readConfig()
    expect(written).toContain("proxy: http://127.0.0.1:7890")
    expect(written).toContain("model_mappings:")
    expect(written).toContain("stream_idle: 301")
    expect(written).toContain("response_header: 600")
    expect(written).toContain("stale_request_max_age: 900")
    expect(written).toContain("model_refresh_interval: 0")
    expect(written).toContain("shutdown:")
    expect(written).toContain("history:")
    expect(written).toContain("anthropic:")
    expect(written).toContain("context_editing_trigger: 200000")
    expect(written).toContain("tool_search: false")
    expect(written).toContain("tool_search_non_deferred:")
    expect(written).toContain("openai_responses:")
    expect(written).toContain("rate_limiter:")
    expect(written).toContain("system_prompt_overrides:")

    expect(state.responseHeaderTimeout).toBe(600)
    expect(state.streamIdleTimeout).toBe(301)
    expect(state.staleRequestMaxAge).toBe(900)
    expect(state.modelRefreshInterval).toBe(0)
    expect(state.shutdownGracefulWait).toBe(12)
    expect(state.shutdownAbortWait).toBe(34)
    expect(state.historyRawCaptureEnabled).toBe(false)
    expect(state.historyRawCaptureMaxObjectBytes).toBe(1048576)
    expect(state.stripReadToolResultTags).toBe(true)
    expect(state.contextEditingMode).toBe("clear-both")
    expect(state.contextEditingTrigger).toBe(200000)
    expect(state.contextEditingKeepTools).toBe(4)
    expect(state.contextEditingKeepThinking).toBe(2)
    expect(state.toolSearchEnabled).toBe(false)
    expect(state.cacheControlMode).toBe("disabled")
    expect(state.nonDeferredTools).toEqual(["custom_tool", "second_tool"])
    expect(state.normalizeResponsesCallIds).toBe(false)
    expect(state.upstreamWebSocket).toBe(true)
  })

  test("PUT /api/config/yaml rejects invalid anthropic tuning fields", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: {
          context_editing_trigger: -1,
          tool_search: "yes",
          tool_search_non_deferred: ["valid", 123],
        },
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Config validation failed",
      details: [
        {
          field: "anthropic.context_editing_trigger",
          message: "Must be a non-negative integer or null",
          value: -1,
        },
        {
          field: "anthropic.tool_search",
          message: "Must be a boolean or null",
          value: "yes",
        },
        {
          field: "anthropic.tool_search_non_deferred.1",
          message: "Must be a non-empty string",
          value: 123,
        },
      ],
    })
  })

  test("PUT /api/config/yaml rejects unsupported proxy schemes", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proxy: "ftp://example.com",
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Config validation failed",
      details: [
        {
          field: "proxy",
          message: "Proxy must use http, https, socks5, or socks5h scheme",
          value: "ftp://example.com",
        },
      ],
    })
  })

  test("PUT /api/config/yaml rejects negative model_refresh_interval", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_refresh_interval: -1,
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Config validation failed",
      details: [
        {
          field: "model_refresh_interval",
          message: "Must be a non-negative integer or null",
          value: -1,
        },
      ],
    })
  })

  test("PUT /api/config/yaml deletes an entire nested scalar section when sent as null", async () => {
    await writeConfig(`
shutdown:
  graceful_wait: 30
  abort_wait: 90
`)
    setStateForTests({ shutdownGracefulWait: 30, shutdownAbortWait: 90 })

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shutdown: null,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    expect(state.shutdownGracefulWait).toBe(60)
    expect(state.shutdownAbortWait).toBe(120)
  })

  test("PUT /api/config/yaml keeps file unchanged when deleting an absent optional scalar", async () => {
    const original = "# keep comment\nmodel_refresh_interval: 600\n"
    await writeConfig(original)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proxy: null,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      model_refresh_interval: 600,
    })
    expect(await readConfig()).toBe(original)
  })

  test("PUT /api/config/yaml updates nested scalar children while preserving siblings and comments", async () => {
    await writeConfig(`
anthropic:
  # keep this comment
  tool_strip_read_result_tags: false
  context_editing: clear-thinking
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: {
          tool_strip_read_result_tags: true,
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      anthropic: {
        tool_strip_read_result_tags: true,
        context_editing: "clear-thinking",
      },
    })

    const written = await readConfig()
    expect(written).toContain("# keep this comment")
    expect(written).toContain("tool_strip_read_result_tags: true")
    expect(written).toContain("context_editing: clear-thinking")
  })

  test("PUT /api/config/yaml deletes nested scalar child keys while preserving the container", async () => {
    await writeConfig(`
shutdown:
  graceful_wait: 30
  abort_wait: 90
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shutdown: {
          graceful_wait: null,
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      shutdown: {
        abort_wait: 90,
      },
    })

    const written = await readConfig()
    expect(written).toContain("shutdown:")
    expect(written).toContain("abort_wait: 90")
    expect(written).not.toContain("graceful_wait:")
  })

  test("PUT /api/config/yaml persists a hooks section instead of silently discarding it", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hooks: {
          enabled: true,
          upstream_module: "./exp/my-hook.ts",
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      hooks: {
        enabled: true,
        upstream_module: "./exp/my-hook.ts",
      },
    })

    const written = await readConfig()
    expect(written).toContain("hooks:")
    expect(written).toContain("enabled: true")
    expect(written).toContain("upstream_module: ./exp/my-hook.ts")

    expect(state.hooksEnabled).toBe(true)
    expect(state.hooksUpstreamModule).toBe("./exp/my-hook.ts")
  })

  test("PUT /api/config/yaml preserves untouched anthropic sibling keys during partial updates", async () => {
    await writeConfig(`
anthropic:
  tool_strip_read_result_tags: true
  context_editing: clear-thinking
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: {
          system_rewrite_reminders: [
            {
              from: "system reminder",
              to: "",
            },
          ],
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      anthropic: {
        tool_strip_read_result_tags: true,
        context_editing: "clear-thinking",
        system_rewrite_reminders: [
          {
            from: "system reminder",
            to: "",
          },
        ],
      },
    })

    const written = await readConfig()
    expect(written).toContain("tool_strip_read_result_tags: true")
    expect(written).toContain("context_editing: clear-thinking")
    expect(written).toContain("system_rewrite_reminders:")
  })

  test("PUT /api/config/yaml preserves untouched rate_limiter sibling keys during partial updates", async () => {
    await writeConfig(`
rate_limiter:
  retry_interval: 15
  request_interval: 30
  recovery_interval: 60
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rate_limiter: {
          request_interval: 45,
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      rate_limiter: {
        retry_interval: 15,
        request_interval: 45,
        recovery_interval: 60,
      },
    })

    const written = await readConfig()
    expect(written).toContain("retry_interval: 15")
    expect(written).toContain("request_interval: 45")
    expect(written).toContain("recovery_interval: 60")
  })

  test("PUT /api/config/yaml replaces model_mappings collections instead of merging old keys", async () => {
    await writeConfig(`
model_mappings:
  sonnet: claude-sonnet-4.7
  haiku: claude-haiku-4.6
  custom: gpt-4.1
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_mappings: {
          sonnet: "claude-sonnet-4.8",
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      model_mappings: {
        sonnet: "claude-sonnet-4.8",
      },
    })

    const written = await readConfig()
    expect(written).toContain("model_mappings:")
    expect(written).toContain("sonnet: claude-sonnet-4.8")
    expect(written).not.toContain("haiku:")
    expect(written).not.toContain("custom:")
    expect(state.modelMappings).toEqual({
      ...DEFAULT_MODEL_MAPPINGS,
      sonnet: "claude-sonnet-4.8",
    })
  })

  test("PUT /api/config/yaml replaces existing rewrite rule arrays instead of merging old rules", async () => {
    await writeConfig(`
anthropic:
  system_rewrite_reminders:
    - from: warning
      to: old
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: {
          system_rewrite_reminders: [
            {
              from: "notice",
              to: "new",
            },
          ],
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      anthropic: {
        system_rewrite_reminders: [
          {
            from: "notice",
            to: "new",
          },
        ],
      },
    })

    const written = await readConfig()
    expect(written).toContain("from: notice")
    expect(written).toContain("to: new")
    expect(written).not.toContain("from: warning")
    expect(written).not.toContain("to: old")
  })

  test("PUT /api/config/yaml with empty body keeps config semantics and comment structure intact", async () => {
    await writeConfig(`
# keep comment
model_refresh_interval: 600
history:
  raw_capture:
    enabled: false
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      model_refresh_interval: 600,
      history: {
        raw_capture: { enabled: false },
      },
    })

    const written = await readConfig()
    expect(written).toContain("# keep comment")
    expect(written).toContain("model_refresh_interval: 600")
    expect(written).toContain("history:")
    expect(written).toContain("enabled: false")
  })

  test("PUT /api/config/yaml rejects negative nested timeout values", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        timeouts: {
          response_header: -1,
        },
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Config validation failed",
      details: [
        {
          field: "timeouts.response_header",
          message: "Must be a non-negative integer or null",
          value: -1,
        },
      ],
    })
  })

  test("PUT /api/config/yaml rejects empty model override keys", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_mappings: {
          "": "claude-sonnet-4.6",
        },
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Config validation failed",
      details: [
        {
          field: "model_mappings.",
          message: "Override key must be a non-empty string",
          value: "",
        },
      ],
    })
  })

  test("PUT /api/config/yaml deleting anthropic.tool_strip_read_result_tags resets runtime state to default", async () => {
    await writeConfig(`
anthropic:
  tool_strip_read_result_tags: true
  context_editing: clear-thinking
`)
    await applyConfigToState()
    expect(state.stripReadToolResultTags).toBe(true)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: {
          tool_strip_read_result_tags: null,
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      anthropic: {
        context_editing: "clear-thinking",
      },
    })
    expect(state.stripReadToolResultTags).toBe(false)
    expect(state.contextEditingMode).toBe("clear-thinking")
  })

  test("PUT /api/config/yaml deleting model_mappings resets runtime state to defaults", async () => {
    await writeConfig(`
model_mappings:
  sonnet: claude-sonnet-4.7
  custom: gpt-4.1
`)
    await applyConfigToState()
    expect(state.modelMappings).toEqual({
      ...DEFAULT_MODEL_MAPPINGS,
      sonnet: "claude-sonnet-4.7",
      custom: "gpt-4.1",
    })

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_mappings: null,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    expect(state.modelMappings).toEqual(DEFAULT_MODEL_MAPPINGS)
    expect(await readConfig()).not.toContain("model_mappings:")
  })

  test("PUT /api/config/yaml deleting system_prompt_overrides resets runtime state to empty array", async () => {
    await writeConfig(`
system_prompt_overrides:
  - from: danger
    to: safe
`)
    await applyConfigToState()
    expect(state.systemPromptOverrides).toHaveLength(1)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_prompt_overrides: null,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    expect(state.systemPromptOverrides).toEqual([])
    expect(await readConfig()).not.toContain("system_prompt_overrides:")
  })

  test("PUT /api/config/yaml deletes a legacy top-level key from disk after migrating it", async () => {
    await writeConfig(`
fetch_timeout: 45
model_refresh_interval: 600
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model_refresh_interval: 601 }),
    })

    expect(res.status).toBe(200)
    const written = await readConfig()
    expect(written).not.toContain("fetch_timeout")
    expect(written).toContain("response_header: 45")
    expect(written).toContain("model_refresh_interval: 601")
  })

  test("PUT /api/config/yaml prunes a legacy section that becomes empty after its only key is removed", async () => {
    await writeConfig(`
timeouts:
  upstream_keepalive: 0
  stream_idle: 300
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const written = await readConfig()
    expect(written).not.toContain("upstream_keepalive")
    expect(written).toContain("stream_idle: 300")
  })

  test("PUT /api/config/yaml deleting the last legacy key inside openai_responses removes the section but keeps siblings", async () => {
    await writeConfig(`
openai_responses:
  client_ws_keep_open: true
  max_ws_frame_bytes: 0
  max_client_ws_connections: 128
  max_upstream_ws_connections: 64
  upstream_ws: false
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const written = await readConfig()
    expect(written).not.toContain("client_ws_keep_open")
    expect(written).not.toContain("max_ws_frame_bytes")
    expect(written).not.toContain("max_client_ws_connections")
    expect(written).not.toContain("max_upstream_ws_connections")
    expect(written).toContain("openai_responses:")
    expect(written).toContain("upstream_ws: false")
  })

  test("PUT /api/config/yaml writes upstream_transport and server sections when present in the body", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        upstream_transport: { tcp_keepalive_probe_delay: 20, http2: { ping_interval: 25, session_connect_timeout: 8 } },
        server: { responses_ws: { keep_open: true, max_frame_bytes: 65536, max_connections: 64 } },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      upstream_transport: { tcp_keepalive_probe_delay: 20, http2: { ping_interval: 25, session_connect_timeout: 8 } },
      server: { responses_ws: { keep_open: true, max_frame_bytes: 65536, max_connections: 64 } },
    })

    const written = await readConfig()
    expect(written).toContain("upstream_transport:")
    expect(written).toContain("tcp_keepalive_probe_delay: 20")
    expect(written).toContain("session_connect_timeout: 8")
    expect(written).toContain("server:")
    expect(written).toContain("keep_open: true")
  })

  test("PUT /api/config/yaml migrating a legacy key into upstream_transport does not clobber an already-written sibling", async () => {
    await writeConfig(`
upstream_transport:
  http2:
    session_connect_timeout: 8
timeouts:
  upstream_h2_ping: 40
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const written = await readConfig()
    expect(written).not.toContain("upstream_h2_ping")
    expect(written).toContain("ping_interval: 40")
  })

  test("PUT /api/config/yaml in-place value migration (thinking_block_sanitize) does not touch legacy-path deletion machinery", async () => {
    await writeConfig(`
anthropic:
  thinking_block_sanitize: empty_thinking
  tool_dedup_calls: result
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const written = await readConfig()
    expect(written).toContain("thinking_block_sanitize: all_empty")
    expect(written).toContain("tool_dedup_calls: result")
  })

  test("PUT /api/config/yaml deep-merges upstream_transport.http2 instead of whole-replacing the section (B9)", async () => {
    await writeConfig(`
upstream_transport:
  http2:
    ping_interval: 30
    session_connect_timeout: 5
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        upstream_transport: { http2: { session_connect_timeout: 8 } },
      }),
    })

    expect(res.status).toBe(200)
    const written = await readConfig()
    expect(written).toContain("ping_interval: 30")
    expect(written).toContain("session_connect_timeout: 8")
  })

  test("PUT /api/config/yaml null-deletes a single leaf inside upstream_transport.http2 while preserving its sibling (B9)", async () => {
    await writeConfig(`
upstream_transport:
  http2:
    ping_interval: 30
    session_connect_timeout: 5
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        upstream_transport: { http2: { ping_interval: null } },
      }),
    })

    expect(res.status).toBe(200)
    const written = await readConfig()
    expect(written).not.toContain("ping_interval")
    expect(written).toContain("session_connect_timeout: 5")
  })

  test("PUT /api/config/yaml anthropic.buffered_retry deep-merges instead of whole-replacing (B9, existing field switched to new semantics)", async () => {
    await writeConfig(`
anthropic:
  buffered_retry:
    max_retries: 5
    heartbeat_sec: 20
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: { buffered_retry: { max_retries: 9 } },
      }),
    })

    expect(res.status).toBe(200)
    const written = await readConfig()
    expect(written).toContain("heartbeat_sec: 20")
    expect(written).toContain("max_retries: 9")
  })

  test("PUT /api/config/yaml sending null for a whole nested sub-object still deletes it entirely (regression, any depth)", async () => {
    await writeConfig(`
anthropic:
  buffered_retry:
    max_retries: 5
    heartbeat_sec: 20
  tool_strip_read_result_tags: true
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: { buffered_retry: null },
      }),
    })

    expect(res.status).toBe(200)
    const written = await readConfig()
    expect(written).not.toContain("buffered_retry")
    expect(written).not.toContain("max_retries")
    expect(written).not.toContain("heartbeat_sec")
    expect(written).toContain("tool_strip_read_result_tags: true")
  })

  test("PUT /api/config/yaml with an empty body migrates a disk-only legacy key WITHOUT relocating an untouched collection (scoped-patch regression guard)", async () => {
    // This is the ONLY reason the disk-only migration fix (extractDiskOnlyMigrationPatch,
    // see plan-3-put-migration.md "偏离与根因") returns a SPARSE patch instead of the full
    // migrated disk payload: a naive full-payload merge would hand model_mappings back to
    // mergeConfigIntoDocument even though the PUT body never mentioned it, and
    // replaceCollection (deleteIn + setIn) would silently relocate it to the END of the
    // document, destroying its original position and comment. The empty `{}` body here is
    // deliberate — it proves the disk-only legacy key (timeouts.upstream_keepalive) still
    // gets migrated even when nothing in the request body triggers it.
    // NOTE: uses model_mappings (the current canonical collection name post the master
    // model_overrides→model_mappings rename) so the collection under test is itself NOT a
    // migratable legacy key — otherwise it would legitimately relocate on migration.
    const original = `# model mappings comment
model_mappings:
  sonnet: claude-sonnet-4.7
  haiku: claude-haiku-4.6
timeouts:
  upstream_keepalive: 30
  stream_idle: 300
`
    await writeConfig(original)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const written = await readConfig()

    // The legacy key was migrated (disk-only — the PUT body never touched it).
    expect(written).not.toContain("upstream_keepalive")
    expect(written).toContain("tcp_keepalive_probe_delay: 30")

    // The untouched collection's comment, keys, and — crucially — its ORIGINAL POSITION
    // (before `timeouts`, not moved to the end after the newly-appended
    // `upstream_transport` section) are preserved byte-for-byte.
    const modelMappingsLines = written
      .split("\n")
      .slice(
        0,
        written.split("\n").findIndex((line) => line.startsWith("timeouts:")),
      )
      .join("\n")
    expect(modelMappingsLines).toBe(`# model mappings comment
model_mappings:
  sonnet: claude-sonnet-4.7
  haiku: claude-haiku-4.6`)

    // Sanity: upstream_transport (the newly-migrated section) was appended AFTER
    // timeouts/model_mappings, not interleaved with or ahead of them.
    const modelOverridesIndex = written.indexOf("model_mappings:")
    const timeoutsIndex = written.indexOf("timeouts:")
    const upstreamTransportIndex = written.indexOf("upstream_transport:")
    expect(modelOverridesIndex).toBeGreaterThanOrEqual(0)
    expect(timeoutsIndex).toBeGreaterThan(modelOverridesIndex)
    expect(upstreamTransportIndex).toBeGreaterThan(timeoutsIndex)
  })
})
