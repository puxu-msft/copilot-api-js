import { computed, ref, toRaw, type ComputedRef, type Ref } from "vue"

import type { PromptOverrideRule, ReminderRewriteRule } from "@/types/config"

import { api, ApiError, type ConfigValidationError, type ConfigYamlResponse, type EditableConfig } from "@/api/http"
import { useToast } from "@/composables/useToast"

export interface UseConfigEditor {
  config: Ref<EditableConfig | null>
  original: Ref<EditableConfig | null>
  loading: Ref<boolean>
  saving: Ref<boolean>
  error: Ref<string | null>
  isDirty: ComputedRef<boolean>
  hasRestartFields: ComputedRef<boolean>
  load: () => Promise<void>
  save: () => Promise<boolean>
  discard: () => void
}

export function normalizeConfigForEditor(
  input: ConfigYamlResponse | EditableConfig | null | undefined,
): EditableConfig {
  if (!input) return {}

  return {
    ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
    ...(input.model_overrides !== undefined ? { model_overrides: normalizeStringMap(input.model_overrides) } : {}),
    ...(input.stream_idle_timeout !== undefined ? { stream_idle_timeout: input.stream_idle_timeout } : {}),
    ...(input.fetch_timeout !== undefined ? { fetch_timeout: input.fetch_timeout } : {}),
    ...(input.stale_request_max_age !== undefined ? { stale_request_max_age: input.stale_request_max_age } : {}),
    ...(input.shutdown !== undefined ?
      { shutdown: normalizeScalarSection(input.shutdown, ["graceful_wait", "abort_wait"]) }
    : {}),
    ...(input.history !== undefined ?
      { history: normalizeScalarSection(input.history, ["limit", "min_entries"]) }
    : {}),
    ...(input.anthropic !== undefined ? { anthropic: normalizeAnthropic(input.anthropic) } : {}),
    ...(input["openai-responses"] !== undefined ?
      { "openai-responses": normalizeScalarSection(input["openai-responses"], ["normalize_call_ids"]) }
    : {}),
    ...(input.rate_limiter !== undefined ?
      {
        rate_limiter: normalizeScalarSection(input.rate_limiter, [
          "retry_interval",
          "request_interval",
          "recovery_timeout",
          "consecutive_successes",
        ]),
      }
    : {}),
    ...(input.compress_tool_results_before_truncate !== undefined ?
      {
        compress_tool_results_before_truncate: input.compress_tool_results_before_truncate,
      }
    : {}),
    ...(input.system_prompt_overrides !== undefined ?
      { system_prompt_overrides: normalizePromptOverrideRules(input.system_prompt_overrides) }
    : {}),
    ...(input.system_prompt_prepend !== undefined ? { system_prompt_prepend: input.system_prompt_prepend } : {}),
    ...(input.system_prompt_append !== undefined ? { system_prompt_append: input.system_prompt_append } : {}),
  }
}

export function serializeEditableConfig(input: EditableConfig | null | undefined): EditableConfig {
  return normalizeConfigForEditor(input)
}

export function stableConfigStringify(input: EditableConfig | null | undefined): string {
  return JSON.stringify(serializeEditableConfig(input))
}

export function formatConfigErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.bodyText) as ConfigValidationError
      if (parsed.details.length > 0) {
        return parsed.details.map((detail) => `${detail.field}: ${detail.message}`).join("; ")
      }
      if (parsed.error) return parsed.error
    } catch {
      return error.message
    }
    return error.message
  }

  if (error instanceof Error) return error.message
  return "Unknown error"
}

export function useConfigEditor(): UseConfigEditor {
  const { show } = useToast()
  const config = ref<EditableConfig | null>(null)
  const original = ref<EditableConfig | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  const isDirty = computed(() => stableConfigStringify(config.value) !== stableConfigStringify(original.value))

  const hasRestartFields = computed(() => {
    if (!config.value || !original.value) return false
    const current = serializeEditableConfig(config.value)
    const base = serializeEditableConfig(original.value)
    return (
      JSON.stringify(current.proxy) !== JSON.stringify(base.proxy)
      || JSON.stringify(current.rate_limiter) !== JSON.stringify(base.rate_limiter)
    )
  })

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const response = await api.fetchConfigYaml()
      const normalized = normalizeConfigForEditor(response)
      config.value = deepClone(normalized)
      original.value = deepClone(normalized)
    } catch (err) {
      error.value = formatConfigErrorMessage(err)
      show(error.value, "error")
    } finally {
      loading.value = false
    }
  }

  async function save(): Promise<boolean> {
    if (!config.value || saving.value) return false

    saving.value = true
    error.value = null
    const requiresRestart = hasRestartFields.value

    try {
      const payload = serializeEditableConfig(config.value)
      const response = await api.saveConfigYaml(payload)
      const normalized = normalizeConfigForEditor(response)
      config.value = deepClone(normalized)
      original.value = deepClone(normalized)
      show(requiresRestart ? "Config saved. Some changes require a restart." : "Config saved", "success")
      return true
    } catch (err) {
      error.value = formatConfigErrorMessage(err)
      show(error.value, "error")
      return false
    } finally {
      saving.value = false
    }
  }

  function discard(): void {
    if (!original.value) return
    config.value = deepClone(original.value)
    error.value = null
  }

  return {
    config,
    original,
    loading,
    saving,
    error,
    isDirty,
    hasRestartFields,
    load,
    save,
    discard,
  }
}

function normalizeAnthropic(
  value: EditableConfig["anthropic"] | ConfigYamlResponse["anthropic"],
): EditableConfig["anthropic"] {
  if (value === null) return null
  if (!value) return undefined

  const normalized = {
    ...(value.strip_server_tools !== undefined ? { strip_server_tools: value.strip_server_tools } : {}),
    ...(value.dedup_tool_calls !== undefined ? { dedup_tool_calls: value.dedup_tool_calls } : {}),
    ...(value.immutable_thinking_messages !== undefined ?
      { immutable_thinking_messages: value.immutable_thinking_messages }
    : {}),
    ...(value.strip_read_tool_result_tags !== undefined ?
      { strip_read_tool_result_tags: value.strip_read_tool_result_tags }
    : {}),
    ...(value.context_editing !== undefined ? { context_editing: value.context_editing } : {}),
    ...(value.rewrite_system_reminders !== undefined ?
      { rewrite_system_reminders: normalizeReminderSetting(value.rewrite_system_reminders) }
    : {}),
  }

  return normalizeEmptySection(normalized)
}

function normalizeReminderSetting(
  value: boolean | Array<ReminderRewriteRule> | null | undefined,
): boolean | Array<ReminderRewriteRule> | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === "boolean") return value
  if (value.length === 0) return false
  return value.map((rule) => normalizeReminderRule(rule))
}

function normalizePromptOverrideRules(
  value: EditableConfig["system_prompt_overrides"] | ConfigYamlResponse["system_prompt_overrides"],
): Array<PromptOverrideRule> | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return value.map((rule) => normalizePromptOverrideRule(rule))
}

function normalizePromptOverrideRule(rule: PromptOverrideRule): PromptOverrideRule {
  return {
    from: rule.from,
    to: rule.to,
    ...(rule.method ? { method: rule.method } : {}),
    ...(rule.model ? { model: rule.model } : {}),
  }
}

function normalizeReminderRule(rule: ReminderRewriteRule): ReminderRewriteRule {
  return {
    from: rule.from,
    to: rule.to,
    ...(rule.method ? { method: rule.method } : {}),
  }
}

function normalizeScalarSection<T extends Record<string, boolean | number | null | undefined>>(
  value: T | null | undefined,
  keys: Array<keyof T>,
): T | null | undefined {
  if (value === null) return null
  if (!value) return undefined

  const normalized: Partial<Record<keyof T, boolean | number | null>> = {}
  let sawExplicit = false
  let sawConcreteValue = false

  for (const key of keys) {
    const raw = value[key]
    if (raw === undefined) continue
    sawExplicit = true
    if (!Object.is(raw, null)) sawConcreteValue = true
    normalized[key] = raw
  }

  if (!sawExplicit) return undefined
  if (!sawConcreteValue) return null
  return normalized as T
}

function normalizeEmptySection<T extends Record<string, unknown>>(value: T): T | null | undefined {
  const entries = Object.values(value)
  if (entries.length === 0) return undefined
  if (entries.every((entry) => entry === null)) return null
  return value
}

function normalizeStringMap(value: Record<string, string> | null): Record<string, string> | null {
  if (value === null) return null
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}

function deepClone<T>(value: T): T {
  return structuredClone(stripReactiveWrappers(value))
}

function stripReactiveWrappers<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripReactiveWrappers(entry)) as T
  }

  if (value && typeof value === "object") {
    const rawValue = toRaw(value)
    return Object.fromEntries(Object.entries(rawValue).map(([key, entry]) => [key, stripReactiveWrappers(entry)])) as T
  }

  return value
}
