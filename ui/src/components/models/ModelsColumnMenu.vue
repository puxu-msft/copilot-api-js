<script setup lang="ts">
import type { UseModelColumnsReturn } from "@/composables/useModelColumns"

const props = defineProps<{ columns: UseModelColumnsReturn }>()
</script>

<template>
  <v-menu :close-on-content-click="false">
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        variant="outlined"
        size="small"
        prepend-icon="mdi-view-column"
      >
        Columns
      </v-btn>
    </template>

    <div class="column-menu">
      <div class="menu-head">
        <span class="menu-title">Columns</span>
        <button
          type="button"
          data-testid="columns-reset"
          class="reset-btn"
          @click="props.columns.reset()"
        >
          Reset
        </button>
      </div>
      <label
        v-for="col in props.columns.ALL_COLUMNS"
        :key="col.key"
        class="menu-row"
      >
        <input
          type="checkbox"
          :data-col="col.key"
          :checked="props.columns.isVisible(col.key)"
          @change="props.columns.toggle(col.key)"
        />
        <span>{{ col.label }}</span>
      </label>
    </div>
  </v-menu>
</template>

<style scoped>
.column-menu {
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-surface-variant));
  padding: 10px 12px;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.menu-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 6px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  margin-bottom: 4px;
}

.menu-title {
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
  font-weight: 700;
}

.reset-btn {
  font-size: 0.72rem;
  color: rgb(var(--v-theme-primary));
  cursor: pointer;
}

.menu-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.83rem;
  cursor: pointer;
}
</style>
