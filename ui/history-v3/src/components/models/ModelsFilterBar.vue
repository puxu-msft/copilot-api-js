<script setup lang="ts">
interface FeatureOption {
  title: string
  value: string
}

defineProps<{
  vendorOptions: Array<string>
  endpointOptions: Array<string>
  featureOptions: Array<FeatureOption>
}>()

const searchQuery = defineModel<string>("searchQuery", { required: true })
const vendorFilter = defineModel<string | null>("vendorFilter", { required: true })
const endpointFilter = defineModel<string | null>("endpointFilter", { required: true })
const featureFilter = defineModel<string | null>("featureFilter", { required: true })
</script>

<template>
  <div class="filter-bar d-flex align-center flex-wrap ga-2 px-4 py-2">
    <v-text-field
      v-model="searchQuery"
      placeholder="Search models..."
      prepend-inner-icon="mdi-magnify"
      clearable
      style="max-width: 280px; min-width: 180px"
    />
    <v-select
      v-model="vendorFilter"
      :items="vendorOptions"
      placeholder="All vendors"
      clearable
      style="max-width: 180px; min-width: 140px"
    />
    <v-select
      v-model="endpointFilter"
      :items="endpointOptions"
      placeholder="All endpoints"
      clearable
      style="max-width: 220px; min-width: 160px"
    />
    <v-select
      v-model="featureFilter"
      :items="featureOptions"
      placeholder="All features"
      clearable
      style="max-width: 200px; min-width: 140px"
    />
  </div>
</template>

<style scoped>
.filter-bar {
  background: rgb(var(--v-theme-surface-variant));
}
</style>
