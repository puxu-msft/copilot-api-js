<script setup lang="ts">
import { computed, onMounted } from "vue"

import type { EditableConfig, KeyValueEntry, PromptOverrideRule, ReminderRewriteRule } from "@/types/config"

import ConfigEnum from "@/components/config/ConfigEnum.vue"
import ConfigKeyValueList from "@/components/config/ConfigKeyValueList.vue"
import ConfigNumber from "@/components/config/ConfigNumber.vue"
import ConfigRewriteRules from "@/components/config/ConfigRewriteRules.vue"
import ConfigSection from "@/components/config/ConfigSection.vue"
import ConfigStringList from "@/components/config/ConfigStringList.vue"
import ConfigText from "@/components/config/ConfigText.vue"
import ConfigToggle from "@/components/config/ConfigToggle.vue"
import { useConfigEditor } from "@/composables/useConfigEditor"

const editor = useConfigEditor()

const loading = computed(() => editor.loading.value)
const saving = computed(() => editor.saving.value)
const isDirty = computed(() => editor.isDirty.value)
const error = computed(() => editor.error.value)

const dedupOptions = [
  { value: false, label: "Off" },
  { value: "input", label: "Input" },
  { value: "result", label: "Result" },
] as const

const contextEditingOptions = [
  { value: "off", label: "Off" },
  { value: "clear-thinking", label: "Thinking" },
  { value: "clear-tooluse", label: "Tool use" },
  { value: "clear-both", label: "Both" },
] as const

onMounted(() => {
  void editor.load()
})

const proxy = topLevelField("proxy", null)
const compressToolResultsBeforeTruncate = topLevelField("compress_tool_results_before_truncate", false)
const fetchTimeout = topLevelField("fetch_timeout", null)
const streamIdleTimeout = topLevelField("stream_idle_timeout", null)
const staleRequestMaxAge = topLevelField("stale_request_max_age", null)
const modelRefreshInterval = topLevelField("model_refresh_interval", null)
const systemPromptPrepend = topLevelField("system_prompt_prepend", null)
const systemPromptAppend = topLevelField("system_prompt_append", null)

const stripServerTools = nestedField("anthropic", "strip_server_tools", false)
const immutableThinkingMessages = nestedField("anthropic", "immutable_thinking_messages", false)
const dedupToolCalls = nestedField("anthropic", "dedup_tool_calls", false)
const stripReadToolResultTags = nestedField("anthropic", "strip_read_tool_result_tags", false)
const contextEditingMode = nestedField("anthropic", "context_editing", "off")
const contextEditingTrigger = nestedField("anthropic", "context_editing_trigger", 100000)
const contextEditingKeepTools = nestedField("anthropic", "context_editing_keep_tools", 3)
const contextEditingKeepThinking = nestedField("anthropic", "context_editing_keep_thinking", 1)
const toolSearchEnabled = nestedField("anthropic", "tool_search", true)
const autoCacheControl = nestedField("anthropic", "auto_cache_control", true)

const normalizeCallIds = nestedField("openai-responses", "normalize_call_ids", true)
const upstreamWebSocket = nestedField("openai-responses", "upstream_websocket", false)

const shutdownGracefulWait = nestedField("shutdown", "graceful_wait", null)
const shutdownAbortWait = nestedField("shutdown", "abort_wait", null)

const historyLimit = nestedField("history", "limit", null)
const historyMinEntries = nestedField("history", "min_entries", null)

const rateLimiterRetryInterval = nestedField("rate_limiter", "retry_interval", null)
const rateLimiterRequestInterval = nestedField("rate_limiter", "request_interval", null)
const rateLimiterRecoveryTimeout = nestedField("rate_limiter", "recovery_timeout", null)
const rateLimiterConsecutiveSuccesses = nestedField("rate_limiter", "consecutive_successes", null)

const modelOverridesEntries = computed<Array<KeyValueEntry>>({
  get: () =>
    Object.entries(editor.config.value?.model_overrides ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value })),
  set: (entries) => {
    const next = Object.fromEntries(
      entries
        .map((entry) => ({ key: entry.key.trim(), value: entry.value.trim() }))
        .filter((entry) => entry.key.length > 0 && entry.value.length > 0)
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((entry) => [entry.key, entry.value]),
    )
    setTopLevel("model_overrides", next)
  },
})

const rewriteSystemReminders = computed<boolean | Array<ReminderRewriteRule>>({
  get: () => editor.config.value?.anthropic?.rewrite_system_reminders ?? false,
  set: (value) => setNested("anthropic", "rewrite_system_reminders", value),
})

const systemPromptOverrides = computed<Array<PromptOverrideRule>>({
  get: () => editor.config.value?.system_prompt_overrides ?? [],
  set: (value) => setTopLevel("system_prompt_overrides", value),
})

const nonDeferredTools = computed<Array<string>>({
  get: () => editor.config.value?.anthropic?.non_deferred_tools ?? [],
  set: (value) =>
    setNested(
      "anthropic",
      "non_deferred_tools",
      value
        .map((entry) => entry.trim())
        .filter((entry, index, entries) => entry.length > 0 && entries.indexOf(entry) === index),
    ),
})

async function save(): Promise<void> {
  await editor.save()
}

function discard(): void {
  editor.discard()
}

function ensureConfig(): EditableConfig {
  if (!editor.config.value) {
    editor.config.value = {}
  }
  return editor.config.value
}

function setTopLevel<K extends keyof EditableConfig>(key: K, value: EditableConfig[K]): void {
  const config = ensureConfig()
  editor.config.value = {
    ...config,
    [key]: value,
  }
}

function setNested<
  P extends keyof Pick<EditableConfig, "anthropic" | "shutdown" | "history" | "openai-responses" | "rate_limiter">,
  K extends keyof NonNullable<EditableConfig[P]>,
>(parent: P, key: K, value: NonNullable<EditableConfig[P]>[K]): void {
  const config = ensureConfig()
  const current = config[parent]
  const section = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {}

  ;(section as Record<string, unknown>)[key as string] = value
  editor.config.value = {
    ...config,
    [parent]: section as EditableConfig[P],
  }
}

function topLevelField<K extends keyof EditableConfig>(key: K, fallback: NonNullable<EditableConfig[K]> | null) {
  return computed({
    get: () => (editor.config.value?.[key] ?? fallback) as EditableConfig[K],
    set: (value: EditableConfig[K]) => setTopLevel(key, value),
  })
}

function nestedField<
  P extends keyof Pick<EditableConfig, "anthropic" | "shutdown" | "history" | "openai-responses" | "rate_limiter">,
  K extends keyof NonNullable<EditableConfig[P]>,
>(parent: P, key: K, fallback: NonNullable<EditableConfig[P]>[K]) {
  return computed({
    get: () => (editor.config.value?.[parent] as NonNullable<EditableConfig[P]> | null)?.[key] ?? fallback,
    set: (value: NonNullable<EditableConfig[P]>[K]) => setNested(parent, key, value),
  })
}
</script>

<template>
  <div class="config-page v-page-root">
    <v-toolbar
      class="page-toolbar px-4"
      color="surface"
      density="comfortable"
      flat
    >
      <div>
        <div class="text-h6 font-weight-bold">Config</div>
        <div class="text-body-2 text-medium-emphasis">Edit `config.yaml` as structured fields.</div>
      </div>
      <v-spacer />
      <v-btn
        color="primary"
        :disabled="!isDirty || saving || loading"
        :loading="saving"
        variant="flat"
        @click="save"
      >
        Save
      </v-btn>
    </v-toolbar>

    <div
      v-if="loading && !editor.config.value"
      class="v-page-fill align-center justify-center"
    >
      <v-progress-circular
        indeterminate
        color="primary"
      />
    </div>

    <div
      v-else
      class="v-page-scroll"
    >
      <div class="config-shell px-4 py-4 mx-auto">
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          class="mb-4"
        >
          {{ error }}
        </v-alert>

        <div class="d-flex flex-column ga-4">
          <ConfigSection
            title="General"
            description="Top-level transport and prompt-compression settings."
            requires-restart
          >
            <ConfigText
              v-model="proxy"
              label="Proxy"
              description="Supports http://, https://, socks5://, socks5h://."
              placeholder="http://127.0.0.1:7890"
            />
            <ConfigToggle
              v-model="compressToolResultsBeforeTruncate"
              label="Compress Tool Results Before Truncate"
              description="Compress older tool_result content before dropping messages."
            />
          </ConfigSection>

          <ConfigSection
            title="Anthropic Pipeline"
            description="Server-side request sanitization, deduplication, and reminder rewriting."
          >
            <ConfigToggle
              v-model="stripServerTools"
              label="Strip Server Tools"
              description="Remove server-side tools before forwarding requests upstream."
            />
            <ConfigEnum
              v-model="dedupToolCalls"
              label="Dedup Tool Calls"
              description="Choose how repeated tool_use/tool_result pairs are matched."
              :options="[...dedupOptions]"
            />
            <ConfigEnum
              v-model="contextEditingMode"
              label="Context Editing"
              description="Enable server-side context trimming for supported Anthropic models."
              :options="[...contextEditingOptions]"
            />
            <ConfigNumber
              v-model="contextEditingTrigger"
              label="Context Editing Trigger"
              description="Input token threshold that triggers tool-use clearing."
              :min="0"
            />
            <ConfigNumber
              v-model="contextEditingKeepTools"
              label="Context Editing Keep Tools"
              description="How many recent tool-use pairs to retain after clearing."
              :min="0"
            />
            <ConfigNumber
              v-model="contextEditingKeepThinking"
              label="Context Editing Keep Thinking"
              description="How many recent thinking turns to retain after clearing."
              :min="0"
            />
            <ConfigToggle
              v-model="immutableThinkingMessages"
              label="Immutable Thinking Messages"
              description="Preserve assistant thinking/redacted_thinking blocks during rewrites."
            />
            <ConfigToggle
              v-model="stripReadToolResultTags"
              label="Strip Read Tool Result Tags"
              description="Remove injected system-reminder tags from Read tool results."
            />
            <ConfigToggle
              v-model="toolSearchEnabled"
              label="Tool Search"
              description="Inject Copilot tool_search helpers when the model supports them."
            />
            <ConfigToggle
              v-model="autoCacheControl"
              label="Auto Cache Control"
              description="Inject cache_control breakpoints on stable tools and system blocks."
            />
            <ConfigStringList
              v-model="nonDeferredTools"
              label="Non-Deferred Tools"
              description="Additional tool names that should stay eager when tool search is enabled."
              item-label="Tool name"
              empty-text="No extra non-deferred tools configured."
            />
            <ConfigRewriteRules
              v-model="rewriteSystemReminders"
              label="Rewrite System Reminders"
              description="Disable, remove all, or define ordered rewrite rules."
              allow-boolean-modes
            />
          </ConfigSection>

          <ConfigSection
            title="System Prompt"
            description="Prepend, append, or rewrite prompt text before requests leave the server."
          >
            <ConfigText
              v-model="systemPromptPrepend"
              label="System Prompt Prepend"
              description="Inserted before the original system prompt."
              multiline
            />
            <ConfigText
              v-model="systemPromptAppend"
              label="System Prompt Append"
              description="Inserted after the original system prompt."
              multiline
            />
            <ConfigRewriteRules
              v-model="systemPromptOverrides"
              label="System Prompt Overrides"
              description="Ordered rewrite rules with optional model filters."
              show-model-field
            />
          </ConfigSection>

          <ConfigSection
            title="OpenAI Responses"
            description="Compatibility options for the Responses API endpoint."
          >
            <ConfigToggle
              v-model="normalizeCallIds"
              label="Normalize Call IDs"
              description="Convert Chat Completions-style tool call IDs to Responses format."
            />
            <ConfigToggle
              v-model="upstreamWebSocket"
              label="Upstream WebSocket"
              description="Use upstream WebSocket transport for streaming /responses when the model supports it."
            />
          </ConfigSection>

          <ConfigSection
            title="Timeouts"
            description="Request, stream, and stale-request timing controls."
          >
            <ConfigNumber
              v-model="fetchTimeout"
              label="Fetch Timeout"
              description="Max time from request start to response headers."
              suffix="s"
              :min="0"
            />
            <ConfigNumber
              v-model="streamIdleTimeout"
              label="Stream Idle Timeout"
              description="Max gap between SSE events."
              suffix="s"
              :min="0"
            />
            <ConfigNumber
              v-model="staleRequestMaxAge"
              label="Stale Request Max Age"
              description="Force-fail active requests that outlive this threshold."
              suffix="s"
              :min="0"
            />
            <ConfigNumber
              v-model="modelRefreshInterval"
              label="Model Refresh Interval"
              description="Refresh the cached model list in the background. Set to 0 to disable."
              suffix="s"
              :min="0"
            />
          </ConfigSection>

          <ConfigSection
            title="Shutdown"
            description="Graceful shutdown timings for in-flight request handling."
          >
            <ConfigNumber
              v-model="shutdownGracefulWait"
              label="Graceful Wait"
              suffix="s"
              :min="0"
            />
            <ConfigNumber
              v-model="shutdownAbortWait"
              label="Abort Wait"
              suffix="s"
              :min="0"
            />
          </ConfigSection>

          <ConfigSection
            title="History"
            description="Retention limits for in-memory request history."
          >
            <ConfigNumber
              v-model="historyLimit"
              label="History Limit"
              :min="0"
            />
            <ConfigNumber
              v-model="historyMinEntries"
              label="History Min Entries"
              :min="0"
            />
          </ConfigSection>

          <ConfigSection
            title="Model Overrides"
            description="Map requested model names to specific target models."
          >
            <ConfigKeyValueList
              v-model="modelOverridesEntries"
              label="Overrides"
              description="Override keys must be unique; empty rows are ignored on save."
            />
          </ConfigSection>

          <ConfigSection
            title="Rate Limiter"
            description="Adaptive limiter parameters used at startup."
            requires-restart
          >
            <ConfigNumber
              v-model="rateLimiterRetryInterval"
              label="Retry Interval"
              suffix="s"
              :min="0"
            />
            <ConfigNumber
              v-model="rateLimiterRequestInterval"
              label="Request Interval"
              suffix="s"
              :min="0"
            />
            <ConfigNumber
              v-model="rateLimiterRecoveryTimeout"
              label="Recovery Timeout"
              suffix="min"
              :min="0"
            />
            <ConfigNumber
              v-model="rateLimiterConsecutiveSuccesses"
              label="Consecutive Successes"
              :min="0"
            />
          </ConfigSection>
        </div>
      </div>
    </div>

    <v-footer
      class="page-footer px-4"
      color="surface"
    >
      <div class="d-flex align-center ga-3 w-100 py-3">
        <div class="text-body-2 text-medium-emphasis">
          {{ isDirty ? "Unsaved changes" : "No pending changes" }}
        </div>
        <v-spacer />
        <v-btn
          :disabled="!isDirty || saving || loading"
          variant="outlined"
          @click="discard"
        >
          Discard
        </v-btn>
        <v-btn
          color="primary"
          :disabled="!isDirty || saving || loading"
          :loading="saving"
          variant="flat"
          @click="save"
        >
          Save
        </v-btn>
      </div>
    </v-footer>
  </div>
</template>

<style scoped>
.config-page {
  background: rgb(var(--v-theme-background));
}

.page-toolbar,
.page-footer {
  position: sticky;
  z-index: 2;
}

.page-toolbar {
  top: 0;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.page-footer {
  bottom: 0;
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
}

.config-shell {
  width: 100%;
  max-width: 980px;
}
</style>
