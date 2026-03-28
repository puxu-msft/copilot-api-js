import { ref, onMounted, onUnmounted, type Ref } from "vue"

export interface UsePollingReturn<T> {
  data: Ref<T | null>
  loading: Ref<boolean>
  error: Ref<string | null>
  refresh: () => Promise<void>
}

/** Generic polling composable: fetches data on mount, then at intervalMs */
export function usePolling<T>(fetchFn: () => Promise<T>, intervalMs: number): UsePollingReturn<T> {
  const data = ref<T | null>(null) as Ref<T | null>
  const loading = ref(true)
  const error = ref<string | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null

  async function refresh(): Promise<void> {
    try {
      const result = await fetchFn()
      data.value = result
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to fetch"
    } finally {
      loading.value = false
    }
  }

  onMounted(() => {
    void refresh()
    timer = setInterval(() => void refresh(), intervalMs)
  })

  onUnmounted(() => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  })

  return { data, loading, error, refresh }
}
