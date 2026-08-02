<script setup lang="ts">
import {
  //
  tryDecodeJsonString,
} from "~backend/lib/anthropic/decode-tool-input-core"
import { computed } from "vue"
import VueJsonPretty from "vue-json-pretty"

import type {
  //
  ToolUseContentBlock,
  ToolResultContentBlock,
} from "@/types"

import { useContentContext } from "@/composables/useContentContext"

import ContentBlockWrapper from "./ContentBlockWrapper.vue"
import "vue-json-pretty/lib/styles.css"

import ToolResultBlock from "./ToolResultBlock.vue"

const props = defineProps<{
  block: ToolUseContentBlock
}>()

const { aggregateTools, toolResultMap, scrollToResult } = useContentContext()

/**
 * Raw unparsed tool input text, or null when the input is structured.
 *
 * Upstream streams tool_use input as JSON; when the stream is truncated or the
 * JSON is malformed the accumulated string cannot be parsed. The backend keeps
 * that raw string as-is (faithful to upstream), so a string-typed `input` means
 * "unparsed raw fragment". We also tolerate two legacy marker shapes still found
 * in older stored entries / other paths: the Anthropic `{ _parseError, _rawInput }`
 * marker and the OpenAI `{ _raw }` marker — all funnel to the same raw rendering.
 */
const rawUnparsed = computed<string | null>(() => {
  const input = props.block.input
  if (typeof input === "string") return input
  if (input !== null && typeof input === "object") {
    const marker = input as { _parseError?: unknown; _rawInput?: unknown; _raw?: unknown }
    if (marker._parseError === true && typeof marker._rawInput === "string") return marker._rawInput
    if (typeof marker._raw === "string") return marker._raw
  }
  return null
})

const inputJson = computed(() => {
  if (rawUnparsed.value !== null) return rawUnparsed.value
  try {
    return JSON.stringify(props.block.input, null, 2)
  } catch {
    return String(props.block.input)
  }
})

/**
 * Display-only decode: upstream may serialize a tool_use input field (e.g.
 * AskUserQuestion `questions`) into a JSON string. For readability we decode
 * ALL top-level string fields back to structured form for the JSON tree, while
 * leaving the store data and the copy text (`inputJson`) on the original form —
 * history stays faithful, only the rendering is friendlier. The raw-unparsed
 * branch is short-circuited so a truncated fragment is never decoded.
 *
 * Implemented here rather than via the backend's `decodeToolUseInput`: that
 * helper's decode-every-field mode (`DecodeToolInputConfig.all`) was removed
 * from the backend in `c9a22b9b` as "no live consumer" — this view WAS the
 * consumer. Only the `tryDecodeJsonString` primitive is borrowed; the semantics
 * below are the removed `all: true` path verbatim (decode each top-level string
 * field that parses to an object/array, keep every other value as-is, and
 * return the ORIGINAL reference when nothing changed).
 */
function decodeAllStringFields(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input

  const obj = input as Record<string, unknown>
  let result: Record<string, unknown> | undefined
  for (const field of Object.keys(obj)) {
    const value = obj[field]
    if (typeof value !== "string") continue
    const decoded = tryDecodeJsonString(value)
    if (decoded === undefined) continue
    if (!result) result = { ...obj }
    result[field] = decoded
  }
  return result ?? input
}

const displayInput = computed(() => {
  if (rawUnparsed.value !== null) return props.block.input
  return decodeAllStringFields(props.block.input)
})

const isObjectInput = computed(() => {
  if (rawUnparsed.value !== null) return false
  return displayInput.value !== null && typeof displayInput.value === "object"
})

const resultBlock = computed(() => {
  if (!toolResultMap.value) return null
  return (toolResultMap.value[props.block.id] as ToolResultContentBlock) ?? null
})

const hasResult = computed(() => Boolean(resultBlock.value))
</script>

<template>
  <ContentBlockWrapper
    label="TOOL USE"
    label-color="cyan"
    :summary="block.name"
    :block-id="'tool-use-' + block.id"
    :copy-text="inputJson"
    :raw-data="block"
    :raw-title="'Raw — tool_use: ' + block.name"
  >
    <template #header-extra>
      <span class="tool-name">{{ block.name }}</span>
      <span class="tool-id">{{ block.id }}</span>
    </template>

    <VueJsonPretty
      v-if="isObjectInput"
      :data="displayInput as any"
      :deep="3"
      :show-icon="true"
      :show-line-number="true"
      :collapsed-on-click-brackets="true"
    />
    <template v-else-if="rawUnparsed !== null">
      <div class="parse-error-banner">⚠ Failed to parse tool input as JSON — showing raw streamed text (may be truncated)</div>
      <pre class="tool-input parse-error-raw">{{ rawUnparsed }}</pre>
    </template>
    <pre
      v-else
      class="tool-input"
      >{{ inputJson }}</pre
    >

    <!-- Result section: mount once if result exists, toggle visibility -->
    <template v-if="hasResult">
      <div
        v-show="aggregateTools"
        class="tool-aggregate-result"
      >
        <ToolResultBlock
          :block="resultBlock as ToolResultContentBlock"
          :tool-name="block.name"
          :embedded="true"
        />
      </div>
      <div
        v-show="!aggregateTools"
        class="tool-jump"
      >
        <a
          class="jump-link"
          @click.prevent="scrollToResult(block.id)"
        >
          → Jump to result
        </a>
      </div>
    </template>
  </ContentBlockWrapper>
</template>

<style scoped>
.tool-name {
  font-size: var(--font-size-sm);
  color: var(--primary);
  font-weight: 600;
  font-family: var(--font-mono);
}

.tool-id {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.tool-input {
  font-size: var(--font-size-sm);
  color: var(--text);
}

.parse-error-banner {
  font-size: var(--font-size-xs);
  color: var(--warning);
  background: var(--warning-muted);
  border-left: 3px solid var(--warning);
  padding: var(--spacing-xs) var(--spacing-sm);
  margin-bottom: var(--spacing-xs);
  font-family: var(--font-mono);
}

.parse-error-raw {
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-aggregate-result {
  border-top: 1px solid var(--border);
  margin-top: var(--spacing-sm);
}

.tool-jump {
  padding-top: var(--spacing-xs);
  border-top: 1px solid var(--border-light);
  margin-top: var(--spacing-sm);
  margin-left: calc(-1 * var(--spacing-sm));
  margin-right: calc(-1 * var(--spacing-sm));
  margin-bottom: calc(-1 * var(--spacing-sm));
  padding-left: var(--spacing-sm);
  padding-bottom: var(--spacing-xs);
}

.jump-link {
  font-size: var(--font-size-xs);
  color: var(--primary);
  cursor: pointer;
}

.jump-link:hover {
  text-decoration: underline;
}
</style>
