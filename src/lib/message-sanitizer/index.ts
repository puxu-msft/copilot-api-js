/**
 * Message sanitizer module — barrel re-exports.
 *
 * Provides unified sanitization for both Anthropic and OpenAI message formats:
 * - Removes system-reminder tags from message content
 * - Filters orphaned tool_result and tool_use blocks
 * - Ensures API compatibility (message ordering, empty block removal)
 *
 * External consumers import from `~/lib/message-sanitizer` — this index
 * preserves that path by re-exporting from the split sub-modules.
 */

// Anthropic orphan filtering
export {
  ensureAnthropicStartsWithUser,
  filterAnthropicOrphanedToolResults,
  filterAnthropicOrphanedToolUse,
  getAnthropicToolResultIds,
  getAnthropicToolUseIds,
} from "./orphan-filter-anthropic"

// OpenAI orphan filtering
export {
  ensureOpenAIStartsWithUser,
  extractOpenAISystemMessages,
  filterOpenAIOrphanedToolResults,
  filterOpenAIOrphanedToolUse,
  getOpenAIToolCallIds,
  getOpenAIToolResultIds,
} from "./orphan-filter-openai"

// Anthropic sanitization
export { removeAnthropicSystemReminders, sanitizeAnthropicMessages } from "./sanitize-anthropic"

// OpenAI sanitization
export { removeOpenAISystemReminders, sanitizeOpenAIMessages } from "./sanitize-openai"

// System reminder tag detection, filtering, and removal
export {
  CLOSE_TAG,
  configureSystemReminderFilters,
  extractLeadingSystemReminderTags,
  extractTrailingSystemReminderTags,
  getEnabledFilters,
  OPEN_TAG,
  type ParsedSystemReminderTag,
  removeSystemReminderTags,
  SYSTEM_REMINDER_FILTERS,
  type SystemReminderFilter,
} from "./system-reminder"
