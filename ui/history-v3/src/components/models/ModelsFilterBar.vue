<script setup lang="ts">
interface FeatureOption {
  title: string
  value: string
}

function formatBillingRate(value: number): string {
  return `${Math.round(value)}x`
}

defineProps<{
  vendorOptions: Array<string>
  endpointOptions: Array<string>
  featureOptions: Array<FeatureOption>
  typeOptions: Array<string>
  billingBounds: { min: number, max: number }
  activeFilterCount: number
}>()

const searchQuery = defineModel<string>("searchQuery", { required: true })
const vendorFilter = defineModel<string | null>("vendorFilter", { required: true })
const endpointFilter = defineModel<string | null>("endpointFilter", { required: true })
const featureFilter = defineModel<string | null>("featureFilter", { required: true })
const typeFilter = defineModel<string | null>("typeFilter", { required: true })
const billingRange = defineModel<[number, number]>("billingRange", { required: true })
</script>

<template>
  <div class="filter-panel">
    <div class="panel-head">
      <div>
        <div class="panel-title">Filters</div>
      </div>
      <v-chip
        size="x-small"
        variant="tonal"
      >
        {{ activeFilterCount }} active
      </v-chip>
    </div>

    <div class="filter-stack">
      <v-text-field
        v-model="searchQuery"
        placeholder="Search model id or name"
        prepend-inner-icon="mdi-magnify"
        clearable
      />
      <v-select
        v-model="vendorFilter"
        :items="vendorOptions"
        placeholder="All vendors"
        clearable
        label="Vendor"
      />
      <v-select
        v-model="endpointFilter"
        :items="endpointOptions"
        placeholder="All endpoints"
        clearable
        label="Endpoint"
      />
      <v-select
        v-model="featureFilter"
        :items="featureOptions"
        placeholder="All features"
        clearable
        label="Capability"
      />
      <v-select
        v-model="typeFilter"
        :items="typeOptions"
        placeholder="All types"
        clearable
        label="Type"
      />

      <div class="billing-field">
        <div class="billing-head">
          <span class="billing-label">Billing Rate</span>
          <span class="billing-value">
            {{ formatBillingRate(billingRange[0]) }} - {{ formatBillingRate(billingRange[1]) }}
          </span>
        </div>
        <v-range-slider
          v-model="billingRange"
          :min="billingBounds.min"
          :max="billingBounds.max"
          :step="1"
          color="primary"
          strict
          hide-details
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.panel-title {
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.filter-stack {
  display: grid;
  grid-template-columns: minmax(240px, 1.5fr) repeat(4, minmax(150px, 1fr)) minmax(220px, 1.2fr);
  gap: 12px;
  align-items: start;
}

.billing-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px 4px;
  min-height: 56px;
}

.billing-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.billing-label {
  font-size: 0.74rem;
  line-height: 1.2;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
}

.billing-value {
  font-size: 0.83rem;
  line-height: 1.2;
  font-weight: 600;
  color: rgb(var(--v-theme-on-surface));
  font-variant-numeric: tabular-nums;
}

@media (max-width: 960px) {
  .filter-stack {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 700px) {
  .filter-stack {
    grid-template-columns: 1fr;
  }
}
</style>
