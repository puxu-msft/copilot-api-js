import { ref, onMounted, onUnmounted } from 'vue'

export function useTheme() {
  const isDark = ref(true)

  let mql: MediaQueryList | null = null

  function update() {
    if (mql) {
      isDark.value = mql.matches
    }
  }

  onMounted(() => {
    mql = window.matchMedia('(prefers-color-scheme: dark)')
    isDark.value = mql.matches
    mql.addEventListener('change', update)
  })

  onUnmounted(() => {
    mql?.removeEventListener('change', update)
  })

  return { isDark }
}
