<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    name: string
    size?: number
  }>(),
  {
    size: 14,
  },
)

const icons: Record<string, string> = {
  search:
    '<path d="M221.09 64a157.09 157.09 0 10157.09 157.09A157.1 157.1 0 00221.09 64z"/><path d="M338.29 338.29L448 448"/>',
  refresh: '<path d="M320 146s24.36-12-64-12a160 160 0 10160 160" /><polyline points="256 58 336 138 256 218"/>',
  download:
    '<path d="M336 176h40a40 40 0 0140 40v208a40 40 0 01-40 40H136a40 40 0 01-40-40V216a40 40 0 0140-40h40"/><polyline points="176 272 256 352 336 272"/><line x1="256" y1="48" x2="256" y2="336"/>',
  trash:
    '<path d="M112 112l20 320c.95 18.49 14.4 32 32 32h184c17.67 0 30.87-13.51 32-32l20-320"/><line x1="80" y1="112" x2="432" y2="112"/><path d="M192 112V72h0a23.93 23.93 0 0124-24h80a23.93 23.93 0 0124 24h0v40" stroke-linecap="round"/>',
  close: '<path d="M368 368L144 144"/><path d="M368 144L144 368"/>',
  expand:
    '<polyline points="432 368 432 432 368 432"/><line x1="432" y1="432" x2="336" y2="336"/><polyline points="80 144 80 80 144 80"/><line x1="80" y1="80" x2="176" y2="176"/><polyline points="368 80 432 80 432 144"/><line x1="432" y1="80" x2="336" y2="176"/><polyline points="144 432 80 432 80 368"/><line x1="80" y1="432" x2="176" y2="336"/>',
  contract:
    '<polyline points="336 368 336 432 400 432"/><line x1="336" y1="432" x2="432" y2="336"/><polyline points="176 144 176 80 112 80"/><line x1="176" y1="80" x2="80" y2="176"/><polyline points="400 80 336 80 336 144"/><line x1="336" y1="80" x2="432" y2="176"/><polyline points="112 432 176 432 176 368"/><line x1="176" y1="432" x2="80" y2="336"/>',
  copy: '<rect x="128" y="128" width="336" height="336" rx="57" ry="57"/><path d="M383.5 128l.5-24a56.16 56.16 0 00-56-56H112a64.19 64.19 0 00-64 64v216a56.16 56.16 0 0056 56h24" stroke-linecap="round"/>',
  code: '<path d="M160 368L32 256l128-112"/><path d="M352 368l128-112-128-112"/><path d="M304 96l-96 320"/>',
  "chevron-down": '<polyline points="112 184 256 328 400 184"/>',
  "chevron-up": '<polyline points="112 328 256 184 400 328"/>',
  "chevron-right": '<polyline points="184 112 328 256 184 400"/>',
}

const iconContent = icons[props.name] || ""
</script>

<template>
  <svg
    class="icon-svg"
    :width="size"
    :height="size"
    viewBox="0 0 512 512"
    fill="none"
    stroke="currentColor"
    stroke-width="32"
    stroke-linecap="round"
    stroke-linejoin="round"
    v-html="iconContent"
  />
</template>

<style scoped>
.icon-svg {
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
}
</style>
