<script setup lang="ts">
defineProps<{
  title: string
  description?: string
  requiresRestart?: boolean
}>()
</script>

<template>
  <v-card>
    <v-card-title class="d-flex align-center ga-3">
      <div class="flex-grow-1">
        <div class="text-subtitle-1 font-weight-bold">{{ title }}</div>
        <div
          v-if="description"
          class="text-body-2 text-medium-emphasis mt-1"
        >
          {{ description }}
        </div>
      </div>

      <v-tooltip v-if="requiresRestart">
        <template #activator="{ props: tooltipProps }">
          <v-chip
            color="warning"
            size="small"
            variant="tonal"
            v-bind="tooltipProps"
          >
            <v-icon
              start
              size="x-small"
              icon="mdi-alert-outline"
            />
            Requires restart
          </v-chip>
        </template>
        Requires restart to take effect
      </v-tooltip>
    </v-card-title>

    <v-divider />

    <v-card-text class="d-flex flex-column ga-4">
      <slot />
    </v-card-text>
  </v-card>
</template>
