export interface ReminderRewriteRule {
  from: string
  to: string
  method?: "line" | "regex"
}

export interface PromptOverrideRule extends ReminderRewriteRule {
  model?: string
}

export interface ConfigYamlResponse {
  proxy?: string
  model_overrides?: Record<string, string>
  stream_idle_timeout?: number
  fetch_timeout?: number
  stale_request_max_age?: number
  model_refresh_interval?: number
  shutdown?: {
    graceful_wait?: number
    abort_wait?: number
  }
  history?: {
    limit?: number
    min_entries?: number
  }
  anthropic?: {
    strip_server_tools?: boolean
    dedup_tool_calls?: boolean | "input" | "result"
    immutable_thinking_messages?: boolean
    strip_read_tool_result_tags?: boolean
    context_editing?: "off" | "clear-thinking" | "clear-tooluse" | "clear-both"
    context_editing_trigger?: number
    context_editing_keep_tools?: number
    context_editing_keep_thinking?: number
    tool_search?: boolean
    auto_cache_control?: boolean
    non_deferred_tools?: Array<string>
    rewrite_system_reminders?: boolean | Array<ReminderRewriteRule>
  }
  "openai-responses"?: {
    normalize_call_ids?: boolean
    upstream_websocket?: boolean
  }
  rate_limiter?: {
    retry_interval?: number
    request_interval?: number
    recovery_timeout?: number
    consecutive_successes?: number
  }
  compress_tool_results_before_truncate?: boolean
  system_prompt_overrides?: Array<PromptOverrideRule>
  system_prompt_prepend?: string
  system_prompt_append?: string
}

export interface EditableConfig {
  proxy?: string | null
  model_overrides?: Record<string, string> | null
  stream_idle_timeout?: number | null
  fetch_timeout?: number | null
  stale_request_max_age?: number | null
  model_refresh_interval?: number | null
  shutdown?: {
    graceful_wait?: number | null
    abort_wait?: number | null
  } | null
  history?: {
    limit?: number | null
    min_entries?: number | null
  } | null
  anthropic?: {
    strip_server_tools?: boolean | null
    dedup_tool_calls?: boolean | "input" | "result" | null
    immutable_thinking_messages?: boolean | null
    strip_read_tool_result_tags?: boolean | null
    context_editing?: "off" | "clear-thinking" | "clear-tooluse" | "clear-both" | null
    context_editing_trigger?: number | null
    context_editing_keep_tools?: number | null
    context_editing_keep_thinking?: number | null
    tool_search?: boolean | null
    auto_cache_control?: boolean | null
    non_deferred_tools?: Array<string> | null
    rewrite_system_reminders?: boolean | Array<ReminderRewriteRule> | null
  } | null
  "openai-responses"?: {
    normalize_call_ids?: boolean | null
    upstream_websocket?: boolean | null
  } | null
  rate_limiter?: {
    retry_interval?: number | null
    request_interval?: number | null
    recovery_timeout?: number | null
    consecutive_successes?: number | null
  } | null
  compress_tool_results_before_truncate?: boolean | null
  system_prompt_overrides?: Array<PromptOverrideRule> | null
  system_prompt_prepend?: string | null
  system_prompt_append?: string | null
}

export interface ConfigValidationError {
  error: string
  details: Array<{
    field: string
    message: string
    value?: unknown
  }>
}

export interface KeyValueEntry {
  key: string
  value: string
}
