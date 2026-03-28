<script setup lang="ts">
defineProps<{
  filteredCount: number
}>()

const viewSwitch = defineModel<number>("viewSwitch", { required: true })
</script>

<template>
  <v-toolbar
    flat
    density="compact"
    color="surface"
  >
    <v-toolbar-title class="text-body-1 font-weight-bold">
      Models
      <span class="text-caption text-medium-emphasis ml-2">{{ filteredCount }}</span>
    </v-toolbar-title>
    <v-spacer />
    <v-btn-toggle
      v-model="viewSwitch"
      mandatory
      density="compact"
      variant="outlined"
      class="mr-2"
    >
      <v-btn
        :value="0"
        size="small"
        >Cards</v-btn
      >
      <v-btn
        :value="1"
        size="small"
        >Raw</v-btn
      >
    </v-btn-toggle>
  </v-toolbar>
</template>
