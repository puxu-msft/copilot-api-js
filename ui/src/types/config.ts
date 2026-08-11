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
  timeouts?: {
    stream_idle?: number
    response_header?: number
    stale_request_max_age?: number
  }
  model_refresh_interval?: number
  history?: {
    success_limit?: number
    failure_limit?: number
    reaper_interval?: number
  }
  anthropic?: {
    strip_server_tools?: boolean
    dedup_tool_calls?: boolean | "input" | "result"
    thinking_block_message_policy?: "preserve" | "stripped"
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
  openai_responses?: {
    normalize_call_ids?: boolean
    upstream_ws?: boolean
  }
  rate_limiter?: {
    retry_interval?: number
    request_interval?: number
    recovery_interval?: number
    consecutive_successes?: number
  }
  system_prompt_overrides?: Array<PromptOverrideRule>
  system_prompt_prepend?: string
  system_prompt_append?: string
}

export interface EditableConfig {
  proxy?: string | null
  model_overrides?: Record<string, string> | null
  timeouts?: {
    stream_idle?: number | null
    response_header?: number | null
    stale_request_max_age?: number | null
  } | null
  model_refresh_interval?: number | null
  history?: {
    success_limit?: number | null
    failure_limit?: number | null
    reaper_interval?: number | null
  } | null
  anthropic?: {
    strip_server_tools?: boolean | null
    dedup_tool_calls?: boolean | "input" | "result" | null
    thinking_block_message_policy?: "preserve" | "stripped" | null
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
  openai_responses?: {
    normalize_call_ids?: boolean | null
    upstream_ws?: boolean | null
  } | null
  rate_limiter?: {
    retry_interval?: number | null
    request_interval?: number | null
    recovery_interval?: number | null
    consecutive_successes?: number | null
  } | null
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
