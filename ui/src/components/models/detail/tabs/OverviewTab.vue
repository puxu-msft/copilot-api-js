<script setup lang="ts">
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import { computed } from "vue"

import { getEffectiveEndpoints } from "@/utils/model-endpoints"

import DetailKeyValueList from "../DetailKeyValueList.vue"
import DetailSection from "../DetailSection.vue"

const props = defineProps<{ model: Model; caps: DerivedCapabilities }>()

const rows = computed<Array<[string, string | null]>>(() => [
  ["Name", props.model.name ?? null],
  ["Vendor", props.model.vendor ?? null],
  ["Version", props.model.version ?? null],
  ["Family", props.model.capabilities?.family ?? null],
  ["Tokenizer", props.model.capabilities?.tokenizer ?? null],
  ["Type", props.model.capabilities?.type ?? null],
  ["Object", props.model.capabilities?.object ?? null],
  ["Category", props.model.model_picker_category ?? null],
  ["Picker enabled", String(props.model.model_picker_enabled)],
  ["Chat default", String(props.model.is_chat_default)],
  ["Chat fallback", String(props.model.is_chat_fallback)],
  ["Preview", String(props.model.preview)],
])

const endpoints = computed(() => getEffectiveEndpoints(props.model))
const isInferred = computed(() => !props.model.supported_endpoints)
</script>

<template>
  <div>
    <DetailSection title="Overview">
      <DetailKeyValueList :rows="rows" />
    </DetailSection>
    <DetailSection title="Endpoints">
      <div
        v-if="endpoints.length === 0"
        class="text-medium-emphasis text-caption"
      >
        —
      </div>
      <div
        v-else
        class="endpoint-chips"
      >
        <v-chip
          v-for="ep in endpoints"
          :key="ep"
          size="x-small"
          variant="tonal"
        >
          {{ ep
          }}<span
            v-if="isInferred"
            class="inferred"
          >
            (inferred)</span
          >
        </v-chip>
      </div>
    </DetailSection>
  </div>
</template>

<style scoped>
.endpoint-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.inferred {
  opacity: 0.6;
  font-style: italic;
}
</style>
