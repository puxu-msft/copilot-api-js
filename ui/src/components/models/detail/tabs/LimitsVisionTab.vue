<script setup lang="ts">
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import { computed } from "vue"

import { formatNumber } from "@/utils/formatters"

import DetailKeyValueList from "../DetailKeyValueList.vue"
import DetailSection from "../DetailSection.vue"

const props = defineProps<{ model: Model; caps: DerivedCapabilities }>()

const n = (v: number | undefined): string | null => (typeof v === "number" ? formatNumber(v) : null)

const limitRows = computed<Array<[string, string | null]>>(() => {
  const limits = props.model.capabilities?.limits
  return [
    ["Context window", n(limits?.max_context_window_tokens)],
    ["Max prompt", n(limits?.max_prompt_tokens)],
    ["Max output", n(limits?.max_output_tokens)],
    ["Non-stream output", n(limits?.max_non_streaming_output_tokens)],
    ["Max inputs", n(limits?.max_inputs)],
  ]
})

const vision = computed(() => props.model.capabilities?.limits?.vision ?? null)
const visionRows = computed<Array<[string, string | null]>>(() => {
  const v = vision.value
  if (!v) return []
  return [
    ["Max images", n(v.max_prompt_images)],
    ["Max image size", n(v.max_prompt_image_size)],
    ["Media types", v.supported_media_types?.length ? v.supported_media_types.join(", ") : null],
  ]
})
</script>

<template>
  <div>
    <DetailSection title="Limits">
      <DetailKeyValueList :rows="limitRows" />
    </DetailSection>
    <DetailSection
      v-if="vision"
      title="Vision"
    >
      <DetailKeyValueList :rows="visionRows" />
    </DetailSection>
  </div>
</template>
