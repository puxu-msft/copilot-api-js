import { useIntervalFn } from "@vueuse/core"
import {
  //
  shallowRef,
  type Ref,
} from "vue"

export interface UsePollingReturn<T> {
  data: Ref<T | null>
  loading: Ref<boolean>
  error: Ref<string | null>
  refresh: () => Promise<void>
}

/** Generic polling composable: fetches data on mount, then at intervalMs */
export function usePolling<T>(fetchFn: () => Promise<T>, intervalMs: number): UsePollingReturn<T> {
  const data = shallowRef<T | null>(null) as Ref<T | null>
  const loading = shallowRef(true)
  const error = shallowRef<string | null>(null)

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

  // Fetch immediately, then poll at interval (auto-cleans up on unmount)
  void refresh()
  useIntervalFn(() => void refresh(), intervalMs)

  return { data, loading, error, refresh }
}
