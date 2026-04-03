import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { applyConfigToState, resetApplyState, resetConfigCache } from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import { initHistory } from "~/lib/history"
import {
  DEFAULT_MODEL_OVERRIDES,
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
  initHistory(true, 200)
})

afterEach(async () => {
  restoreStateForTests(snapshot)
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
})

describe("config yaml routes", () => {
  test("GET /api/config/yaml returns {} when config file is missing", async () => {
    const res = await app.request("/api/config/yaml")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  test("GET /api/config/yaml returns structured config from file", async () => {
    await writeConfig(`
fetch_timeout: 600
history:
  limit: 20
anthropic:
  strip_server_tools: true
`)

    const res = await app.request("/api/config/yaml")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      fetch_timeout: 600,
      history: { limit: 20 },
      anthropic: { strip_server_tools: true },
    })
  })

  test("GET /api/config/yaml returns all known config fields", async () => {
    await writeConfig(`
proxy: "http://127.0.0.1:7890"
model_overrides:
  sonnet: claude-sonnet-4.7
stream_idle_timeout: 301
fetch_timeout: 600
stale_request_max_age: 900
model_refresh_interval: 0
shutdown:
  graceful_wait: 12
  abort_wait: 34
history:
  limit: 20
  min_entries: 10
anthropic:
  strip_server_tools: true
  dedup_tool_calls: result
  immutable_thinking_messages: true
  strip_read_tool_result_tags: true
  context_editing: clear-both
  context_editing_trigger: 200000
  context_editing_keep_tools: 4
  context_editing_keep_thinking: 2
  tool_search: false
  auto_cache_control: false
  non_deferred_tools:
    - custom_tool
    - second_tool
  rewrite_system_reminders:
    - from: '(?i)warning'
      to: ''
      method: regex
openai-responses:
  normalize_call_ids: false
rate_limiter:
  retry_interval: 15
  request_interval: 30
  recovery_timeout: 60
  consecutive_successes: 3
compress_tool_results_before_truncate: false
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
      model_overrides: {
        sonnet: "claude-sonnet-4.7",
      },
      stream_idle_timeout: 301,
      fetch_timeout: 600,
      stale_request_max_age: 900,
      model_refresh_interval: 0,
      shutdown: {
        graceful_wait: 12,
        abort_wait: 34,
      },
      history: {
        limit: 20,
        min_entries: 10,
      },
      anthropic: {
        strip_server_tools: true,
        dedup_tool_calls: "result",
        immutable_thinking_messages: true,
        strip_read_tool_result_tags: true,
        context_editing: "clear-both",
        context_editing_trigger: 200000,
        context_editing_keep_tools: 4,
        context_editing_keep_thinking: 2,
        tool_search: false,
        auto_cache_control: false,
        non_deferred_tools: ["custom_tool", "second_tool"],
        rewrite_system_reminders: [
          {
            from: "(?i)warning",
            to: "",
            method: "regex",
          },
        ],
      },
      "openai-responses": {
        normalize_call_ids: false,
      },
      rate_limiter: {
        retry_interval: 15,
        request_interval: 30,
        recovery_timeout: 60,
        consecutive_successes: 3,
      },
      compress_tool_results_before_truncate: false,
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
    await writeConfig("fetch_timeout: [\n")

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
# timeout comment
fetch_timeout: 600

shutdown:
  graceful_wait: 30
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fetch_timeout: 300,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      fetch_timeout: 300,
      shutdown: {
        graceful_wait: 30,
      },
    })

    const written = await readConfig()
    expect(written).toContain("# timeout comment")
    expect(written).toContain("fetch_timeout: 300")
    expect(written).toContain("shutdown:")
    expect(written).toContain("graceful_wait: 30")
  })

  test("PUT /api/config/yaml deletes optional scalar keys instead of writing null", async () => {
    await writeConfig(`
proxy: "http://127.0.0.1:7890"
fetch_timeout: 600
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
      fetch_timeout: 600,
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
        fetch_timeout: 90,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      fetch_timeout: 90,
    })
    expect(await readConfig()).toContain("fetch_timeout: 90")
  })

  test("PUT /api/config/yaml resets deleted runtime fields to defaults before reload", async () => {
    await writeConfig("fetch_timeout: 123\n")
    await applyConfigToState()
    expect(state.fetchTimeout).toBe(123)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fetch_timeout: null,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    expect(state.fetchTimeout).toBe(300)
  })

  test("PUT /api/config/yaml bypasses loadConfig debounce by resetting cache before reload", async () => {
    const first = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fetch_timeout: 111,
      }),
    })
    expect(first.status).toBe(200)
    expect(state.fetchTimeout).toBe(111)

    const second = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fetch_timeout: 222,
      }),
    })
    expect(second.status).toBe(200)
    expect(state.fetchTimeout).toBe(222)
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
      model_overrides: {
        sonnet: "claude-sonnet-4.7",
        custom: "gpt-4.1",
      },
      stream_idle_timeout: 301,
      fetch_timeout: 600,
      stale_request_max_age: 900,
      model_refresh_interval: 0,
      shutdown: {
        graceful_wait: 12,
        abort_wait: 34,
      },
      history: {
        limit: 20,
        min_entries: 10,
      },
      anthropic: {
        strip_server_tools: true,
        dedup_tool_calls: "result",
        immutable_thinking_messages: true,
        strip_read_tool_result_tags: true,
        context_editing: "clear-both",
        context_editing_trigger: 200000,
        context_editing_keep_tools: 4,
        context_editing_keep_thinking: 2,
        tool_search: false,
        auto_cache_control: false,
        non_deferred_tools: ["custom_tool", "second_tool"],
        rewrite_system_reminders: [
          {
            from: "(?i)warning",
            to: "",
            method: "regex",
          },
        ],
      },
      "openai-responses": {
        normalize_call_ids: false,
      },
      rate_limiter: {
        retry_interval: 15,
        request_interval: 30,
        recovery_timeout: 60,
        consecutive_successes: 3,
      },
      compress_tool_results_before_truncate: false,
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
    expect(written).toContain("model_overrides:")
    expect(written).toContain("stream_idle_timeout: 301")
    expect(written).toContain("fetch_timeout: 600")
    expect(written).toContain("stale_request_max_age: 900")
    expect(written).toContain("model_refresh_interval: 0")
    expect(written).toContain("shutdown:")
    expect(written).toContain("history:")
    expect(written).toContain("anthropic:")
    expect(written).toContain("context_editing_trigger: 200000")
    expect(written).toContain("tool_search: false")
    expect(written).toContain("non_deferred_tools:")
    expect(written).toContain("openai-responses:")
    expect(written).toContain("rate_limiter:")
    expect(written).toContain("system_prompt_overrides:")

    expect(state.fetchTimeout).toBe(600)
    expect(state.streamIdleTimeout).toBe(301)
    expect(state.staleRequestMaxAge).toBe(900)
    expect(state.modelRefreshInterval).toBe(0)
    expect(state.shutdownGracefulWait).toBe(12)
    expect(state.shutdownAbortWait).toBe(34)
    expect(state.historyLimit).toBe(20)
    expect(state.historyMinEntries).toBe(10)
    expect(state.stripServerTools).toBe(true)
    expect(state.contextEditingMode).toBe("clear-both")
    expect(state.contextEditingTrigger).toBe(200000)
    expect(state.contextEditingKeepTools).toBe(4)
    expect(state.contextEditingKeepThinking).toBe(2)
    expect(state.toolSearchEnabled).toBe(false)
    expect(state.autoCacheControl).toBe(false)
    expect(state.nonDeferredTools).toEqual(["custom_tool", "second_tool"])
    expect(state.normalizeResponsesCallIds).toBe(false)
  })

  test("PUT /api/config/yaml rejects invalid anthropic tuning fields", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: {
          context_editing_trigger: -1,
          tool_search: "yes",
          non_deferred_tools: ["valid", 123],
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
          field: "anthropic.non_deferred_tools.1",
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
    const original = "# keep comment\nfetch_timeout: 600\n"
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
      fetch_timeout: 600,
    })
    expect(await readConfig()).toBe(original)
  })

  test("PUT /api/config/yaml updates nested scalar children while preserving siblings and comments", async () => {
    await writeConfig(`
anthropic:
  # keep this comment
  strip_server_tools: false
  context_editing: clear-thinking
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: {
          strip_server_tools: true,
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      anthropic: {
        strip_server_tools: true,
        context_editing: "clear-thinking",
      },
    })

    const written = await readConfig()
    expect(written).toContain("# keep this comment")
    expect(written).toContain("strip_server_tools: true")
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

  test("PUT /api/config/yaml preserves untouched anthropic sibling keys during partial updates", async () => {
    await writeConfig(`
anthropic:
  strip_server_tools: true
  context_editing: clear-thinking
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: {
          rewrite_system_reminders: [
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
        strip_server_tools: true,
        context_editing: "clear-thinking",
        rewrite_system_reminders: [
          {
            from: "system reminder",
            to: "",
          },
        ],
      },
    })

    const written = await readConfig()
    expect(written).toContain("strip_server_tools: true")
    expect(written).toContain("context_editing: clear-thinking")
    expect(written).toContain("rewrite_system_reminders:")
  })

  test("PUT /api/config/yaml preserves untouched rate_limiter sibling keys during partial updates", async () => {
    await writeConfig(`
rate_limiter:
  retry_interval: 15
  request_interval: 30
  recovery_timeout: 60
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
        recovery_timeout: 60,
      },
    })

    const written = await readConfig()
    expect(written).toContain("retry_interval: 15")
    expect(written).toContain("request_interval: 45")
    expect(written).toContain("recovery_timeout: 60")
  })

  test("PUT /api/config/yaml replaces model_overrides collections instead of merging old keys", async () => {
    await writeConfig(`
model_overrides:
  sonnet: claude-sonnet-4.7
  haiku: claude-haiku-4.6
  custom: gpt-4.1
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_overrides: {
          sonnet: "claude-sonnet-4.8",
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      model_overrides: {
        sonnet: "claude-sonnet-4.8",
      },
    })

    const written = await readConfig()
    expect(written).toContain("model_overrides:")
    expect(written).toContain("sonnet: claude-sonnet-4.8")
    expect(written).not.toContain("haiku:")
    expect(written).not.toContain("custom:")
    expect(state.modelOverrides).toEqual({
      ...DEFAULT_MODEL_OVERRIDES,
      sonnet: "claude-sonnet-4.8",
    })
  })

  test("PUT /api/config/yaml replaces existing rewrite rule arrays instead of merging old rules", async () => {
    await writeConfig(`
anthropic:
  rewrite_system_reminders:
    - from: warning
      to: old
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: {
          rewrite_system_reminders: [
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
        rewrite_system_reminders: [
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
fetch_timeout: 600
history:
  limit: 20
`)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      fetch_timeout: 600,
      history: {
        limit: 20,
      },
    })

    const written = await readConfig()
    expect(written).toContain("# keep comment")
    expect(written).toContain("fetch_timeout: 600")
    expect(written).toContain("history:")
    expect(written).toContain("limit: 20")
  })

  test("PUT /api/config/yaml rejects negative timeout values", async () => {
    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fetch_timeout: -1,
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Config validation failed",
      details: [
        {
          field: "fetch_timeout",
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
        model_overrides: {
          "": "claude-sonnet-4.6",
        },
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "Config validation failed",
      details: [
        {
          field: "model_overrides.",
          message: "Override key must be a non-empty string",
          value: "",
        },
      ],
    })
  })

  test("PUT /api/config/yaml deleting anthropic.strip_server_tools resets runtime state to default", async () => {
    await writeConfig(`
anthropic:
  strip_server_tools: true
  context_editing: clear-thinking
`)
    await applyConfigToState()
    expect(state.stripServerTools).toBe(true)

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anthropic: {
          strip_server_tools: null,
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      anthropic: {
        context_editing: "clear-thinking",
      },
    })
    expect(state.stripServerTools).toBe(false)
    expect(state.contextEditingMode).toBe("clear-thinking")
  })

  test("PUT /api/config/yaml deleting model_overrides resets runtime state to defaults", async () => {
    await writeConfig(`
model_overrides:
  sonnet: claude-sonnet-4.7
  custom: gpt-4.1
`)
    await applyConfigToState()
    expect(state.modelOverrides).toEqual({
      ...DEFAULT_MODEL_OVERRIDES,
      sonnet: "claude-sonnet-4.7",
      custom: "gpt-4.1",
    })

    const res = await app.request("/api/config/yaml", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model_overrides: null,
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
    expect(state.modelOverrides).toEqual(DEFAULT_MODEL_OVERRIDES)
    expect(await readConfig()).not.toContain("model_overrides:")
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
})
