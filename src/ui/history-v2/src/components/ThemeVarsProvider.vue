<script setup lang="ts">
import { useThemeVars } from 'naive-ui'
import { computed } from 'vue'

const themeVars = useThemeVars()

function toRgba(color: string, alpha: number): string {
  // Handle hex colors
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const r = Number.parseInt(hex.slice(0, 2), 16)
    const g = Number.parseInt(hex.slice(2, 4), 16)
    const b = Number.parseInt(hex.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  // Handle rgb() colors - add alpha
  if (color.startsWith('rgb(')) {
    return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`)
  }
  // Handle rgba() - replace alpha
  if (color.startsWith('rgba(')) {
    return color.replace(/,\s*[\d.]+\)$/, `, ${alpha})`)
  }
  return color
}

const cssVars = computed(() => ({
  '--n-border-color': themeVars.value.borderColor,
  '--n-divider-color': themeVars.value.dividerColor,
  '--n-color': themeVars.value.bodyColor,
  '--n-color-embedded': themeVars.value.cardColor,
  '--n-color-embedded-modal': themeVars.value.modalColor,
  '--n-color-embedded-popover': themeVars.value.popoverColor,
  '--n-color-target': toRgba(themeVars.value.primaryColor, 0.1),
  '--n-base-color': themeVars.value.baseColor,
  '--n-text-color': themeVars.value.textColor2,
  '--n-text-color-3': themeVars.value.textColor3,
  '--n-primary-color': themeVars.value.primaryColor,
  '--n-success-color': themeVars.value.successColor,
  '--n-success-color-suppl': toRgba(themeVars.value.successColor, 0.12),
  '--n-error-color': themeVars.value.errorColor,
  '--n-error-color-suppl': toRgba(themeVars.value.errorColor, 0.12),
  '--n-info-color': themeVars.value.infoColor,
  '--n-warning-color': themeVars.value.warningColor,
  '--n-hover-color': themeVars.value.hoverColor,
}))
</script>

<template>
  <div class="theme-vars-provider" :style="cssVars">
    <slot />
  </div>
</template>

<style scoped>
.theme-vars-provider {
  height: 100%;
  display: flex;
  flex-direction: column;
}
</style>
