<script setup lang="ts">
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import { computed } from "vue"

import DetailKeyValueList from "../DetailKeyValueList.vue"
import DetailSection from "../DetailSection.vue"

const props = defineProps<{ model: Model; caps: DerivedCapabilities }>()

const billingRows = computed<Array<[string, string | null]>>(() => [
  ["Multiplier", props.model.billing?.multiplier !== undefined ? String(props.model.billing.multiplier) : null],
  ["Premium", props.model.billing?.is_premium !== undefined ? String(props.model.billing.is_premium) : null],
])

const restrictedTo = computed(() => props.model.billing?.restricted_to ?? [])

const policyRows = computed<Array<[string, string | null]>>(() => [
  ["State", props.model.policy?.state ?? null],
  ["Terms", props.model.policy?.terms ?? null],
])
</script>

<template>
  <div>
    <DetailSection title="Billing">
      <DetailKeyValueList :rows="billingRows" />
      <div
        v-if="restrictedTo.length > 0"
        class="restricted"
      >
        <span class="restricted-label">Restricted to</span>
        <div class="plan-chips">
          <v-chip
            v-for="plan in restrictedTo"
            :key="plan"
            size="x-small"
            variant="tonal"
          >
            {{ plan }}
          </v-chip>
        </div>
      </div>
    </DetailSection>
    <DetailSection title="Policy">
      <DetailKeyValueList :rows="policyRows" />
    </DetailSection>
  </div>
</template>

<style scoped>
.restricted {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.restricted-label {
  font-size: 0.74rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
}

.plan-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
