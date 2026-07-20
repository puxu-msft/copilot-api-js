<script setup lang="ts">
import { computed } from "vue"

import type { SseEventRecord } from "@/types"

import SectionBlock from "./SectionBlock.vue"

const props = defineProps<{
  events: Array<SseEventRecord>
  title?: string
}>()

/** Format offset as seconds with ms precision */
function formatOffset(ms: number): string {
  if (ms < 1000) return `+${ms}ms`
  return `+${(ms / 1000).toFixed(1)}s`
}

/** Extract a short summary from the event data for collapsed view */
function eventSummary(event: SseEventRecord): string {
  // `raw` is the verbatim upstream `data:` payload. Parse on demand; keepalive /
  // unparseable / legacy rows (no `raw`) fall back to a raw snippet.
  const raw = event.raw ?? ""
  let d: Record<string, unknown>
  try {
    d = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return raw.slice(0, 80)
  }
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
    case "content_block_delta": {
      const delta = d.delta as Record<string, unknown> | undefined
      const prefix = `index=${d.index}`
      switch (delta?.type) {
        case "input_json_delta": {
          // Tool-call argument fragment — the most diagnostically valuable delta
          return `${prefix} input_json: ${String(delta.partial_json ?? "")}`
        }
        case "text_delta": {
          return `${prefix} text: ${String(delta.text ?? "")}`
        }
        case "thinking_delta": {
          return `${prefix} thinking: ${String(delta.thinking ?? "")}`
        }
        case "signature_delta": {
          return `${prefix} signature(${String(delta.signature ?? "").length} chars)`
        }
        default: {
          return delta?.type ? `${prefix} ${String(delta.type)}` : prefix
        }
      }
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
    case "content_block_delta": {
      // Low-key color: deltas are numerous, keep them visually quiet
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

const keepaliveCount = computed(() => props.events.filter((e) => e.synthetic === "keepalive").length)
const badge = computed(() => (keepaliveCount.value > 0 ? `${props.events.length} events · ${keepaliveCount.value} keepalive` : `${props.events.length} events`))
</script>

<template>
  <SectionBlock
    :title="props.title ?? 'SSE Events'"
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
        :class="{ 'sse-event-keepalive': event.synthetic === 'keepalive' }"
      >
        <span class="sse-offset">{{ formatOffset(event.offsetMs) }}</span>
        <span
          class="sse-type"
          :class="'sse-type-' + eventColor(event.type)"
          >{{ event.type }}</span
        >
        <span
          v-if="event.synthetic === 'keepalive'"
          class="sse-keepalive-tag"
          title="Proxy-synthesized keepalive — not real upstream content"
          >keepalive</span
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

/* Synthetic keepalive rows are dimmed + tagged so a stalled-upstream heartbeat stream is never
   mistaken for real content (an empty content_delta is otherwise indistinguishable from a real frame). */
.sse-event-keepalive {
  opacity: 0.5;
}

.sse-keepalive-tag {
  flex-shrink: 0;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-dim);
  border: 1px solid var(--border);
  padding: 0 4px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
</style>
