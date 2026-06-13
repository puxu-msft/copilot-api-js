<script setup lang="ts">
import { computed } from "vue"

import SectionBlock from "./SectionBlock.vue"

const props = withDefaults(
  defineProps<{
    /** Client → Proxy request headers */
    inboundRequest?: Record<string, string>
    /** Proxy → Upstream request headers */
    outboundRequest?: Record<string, string>
    /** Upstream → Proxy response headers */
    outboundResponse?: Record<string, string>
    /** Collapsed by default. False when shown inside a selected stage (headers are core there). */
    defaultCollapsed?: boolean
  }>(),
  { defaultCollapsed: false },
)

interface HeaderRow {
  name: string
  inbound?: string
  outbound?: string
  diff: boolean
}

const requestRows = computed<Array<HeaderRow>>(() => mergeHeaders(props.inboundRequest, props.outboundRequest))

const responseRows = computed<Array<HeaderRow>>(() => {
  // Response only has outbound (upstream → proxy) for now
  if (!props.outboundResponse) return []
  return Object.entries(props.outboundResponse)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, outbound: value, diff: false }))
})

const hasRequest = computed(() => props.inboundRequest || props.outboundRequest)
const hasResponse = computed(() => Boolean(props.outboundResponse))
// Per-stage usage passes a single leg → render only the present columns (avoids
// a comparison table with one permanently-empty "—" column).
const showInbound = computed(() => Boolean(props.inboundRequest))
const showOutbound = computed(() => Boolean(props.outboundRequest))

/** Merge two header sets, sorted by name, with diff flags */
function mergeHeaders(left?: Record<string, string>, right?: Record<string, string>): Array<HeaderRow> {
  const allKeys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])
  return [...allKeys].sort().map((name) => {
    const inbound = left?.[name]
    const outbound = right?.[name]
    return { name, inbound, outbound, diff: inbound !== outbound }
  })
}
</script>

<template>
  <SectionBlock
    v-if="hasRequest || hasResponse"
    title="HTTP Headers"
    anchor="httpHeaders"
    :default-collapsed="defaultCollapsed"
  >
    <!-- Request headers comparison -->
    <div
      v-if="hasRequest"
      id="httpHeaders.request"
      class="headers-group"
    >
      <div class="group-title">Request Headers</div>
      <div class="headers-table">
        <div class="headers-thead">
          <span class="col-name">Header</span>
          <span
            v-if="showInbound"
            class="col-value"
            >Client → Proxy</span
          >
          <span
            v-if="showOutbound"
            class="col-value"
            >Proxy → Upstream</span
          >
        </div>
        <div
          v-for="row in requestRows"
          :key="row.name"
          class="headers-row"
          :class="{ diff: row.diff }"
        >
          <span class="col-name">{{ row.name }}</span>
          <span
            v-if="showInbound"
            class="col-value"
            >{{ row.inbound ?? "—" }}</span
          >
          <span
            v-if="showOutbound"
            class="col-value"
            >{{ row.outbound ?? "—" }}</span
          >
        </div>
      </div>
    </div>

    <!-- Response headers -->
    <div
      v-if="hasResponse"
      id="httpHeaders.response"
      class="headers-group"
    >
      <div class="group-title">Response Headers (Upstream → Proxy)</div>
      <div class="headers-table">
        <div class="headers-thead">
          <span class="col-name">Header</span>
          <span class="col-value">Value</span>
        </div>
        <div
          v-for="row in responseRows"
          :key="row.name"
          class="headers-row"
        >
          <span class="col-name">{{ row.name }}</span>
          <span class="col-value">{{ row.outbound }}</span>
        </div>
      </div>
    </div>
  </SectionBlock>
</template>

<style scoped>
.headers-group {
  margin-bottom: var(--spacing-md);
}

.headers-group:last-child {
  margin-bottom: 0;
}

.group-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding-bottom: var(--spacing-xs);
  margin-bottom: var(--spacing-xs);
  border-bottom: 1px solid var(--border-light);
}

.headers-table {
  display: flex;
  flex-direction: column;
}

.headers-thead {
  display: flex;
  gap: var(--spacing-sm);
  padding: 2px 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--border);
}

.headers-row {
  display: flex;
  gap: var(--spacing-sm);
  padding: 2px 0;
  font-size: 10px;
  border-bottom: 1px solid var(--border-light);
}

.headers-row.diff {
  background: var(--warning-muted);
}

.col-name {
  flex: 0 0 180px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  word-break: break-all;
}

.col-value {
  flex: 1;
  color: var(--text-muted);
  font-family: var(--font-mono);
  word-break: break-all;
}
</style>
