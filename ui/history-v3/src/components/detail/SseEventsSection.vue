<script setup lang="ts">
import { computed } from "vue"

import type { SseEventRecord } from "@/types"

import SectionBlock from "./SectionBlock.vue"

const props = defineProps<{
  events: Array<SseEventRecord>
}>()

/** Format offset as seconds with ms precision */
function formatOffset(ms: number): string {
  if (ms < 1000) return `+${ms}ms`
  return `+${(ms / 1000).toFixed(1)}s`
}

/** Extract a short summary from the event data for collapsed view */
function eventSummary(event: SseEventRecord): string {
  const d = event.data as Record<string, unknown>
  switch (event.type) {
    case "message_start": {
      const msg = d.message as Record<string, unknown> | undefined
      return msg?.model ? `model=${msg.model}` : ""
    }
    case "content_block_start": {
      const cb = d.content_block as Record<string, unknown> | undefined
      const parts = [`index=${d.index}`]
      if (cb?.type) parts.push(`type=${cb.type}`)
      if (cb?.name) parts.push(`name=${cb.name}`)
      return parts.join(" ")
    }
    case "content_block_stop": {
      return `index=${d.index}`
    }
    case "message_delta": {
      const delta = d.delta as Record<string, unknown> | undefined
      const parts: Array<string> = []
      if (delta?.stop_reason) parts.push(`stop=${delta.stop_reason}`)
      const usage = d.usage as Record<string, unknown> | undefined
      if (usage?.output_tokens) parts.push(`out=${usage.output_tokens}`)
      return parts.join(" ")
    }
    case "error": {
      const err = d.error as Record<string, unknown> | undefined
      return err?.message ? String(err.message).slice(0, 80) : ""
    }
    default: {
      return ""
    }
  }
}

/** Color for event type label */
function eventColor(type: string): string {
  switch (type) {
    case "message_start": {
      return "green"
    }
    case "message_delta": {
      return "blue"
    }
    case "message_stop": {
      return "dim"
    }
    case "content_block_start": {
      return "cyan"
    }
    case "content_block_stop": {
      return "dim"
    }
    case "error": {
      return "red"
    }
    default: {
      return "default"
    }
  }
}

const badge = computed(() => `${props.events.length} events`)
</script>

<template>
  <SectionBlock
    title="SSE Events"
    :badge="badge"
    :default-collapsed="true"
    :raw-data="events"
    raw-title="Raw — SSE Events"
  >
    <div class="sse-timeline">
      <div
        v-for="(event, i) in events"
        :key="i"
        class="sse-event"
      >
        <span class="sse-offset">{{ formatOffset(event.offsetMs) }}</span>
        <span
          class="sse-type"
          :class="'sse-type-' + eventColor(event.type)"
          >{{ event.type }}</span
        >
        <span
          v-if="eventSummary(event)"
          class="sse-summary"
          >{{ eventSummary(event) }}</span
        >
      </div>
    </div>
  </SectionBlock>
</template>

<style scoped>
.sse-timeline {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

.sse-event {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
  padding: 2px 0;
  border-bottom: 1px solid var(--border-light);
}

.sse-event:last-child {
  border-bottom: none;
}

.sse-offset {
  flex-shrink: 0;
  width: 64px;
  text-align: right;
  color: var(--text-dim);
}

.sse-type {
  flex-shrink: 0;
  min-width: 160px;
  font-weight: 500;
}

.sse-type-green {
  color: var(--success);
}
.sse-type-blue {
  color: var(--info);
}
.sse-type-cyan {
  color: var(--primary);
}
.sse-type-red {
  color: var(--error);
}
.sse-type-dim {
  color: var(--text-dim);
}
.sse-type-default {
  color: var(--text);
}

.sse-summary {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
