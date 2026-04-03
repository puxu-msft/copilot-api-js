import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { useRoute, useRouter } from "vue-router"

import { useInjectedHistoryStore } from "@/composables/useInjectedHistoryStore"

export interface HistoryDetailRouteController {
  detailRouteId: ComputedRef<string>
  detailOpen: ComputedRef<boolean>
  detailLoading: Ref<boolean>
  detailMissingId: Ref<string | null>
  detailTitle: ComputedRef<string>
  openHistoryDetail: (id: string) => Promise<void>
  closeHistoryDetail: () => Promise<void>
}

export function useHistoryDetailRoute(): HistoryDetailRouteController {
  const route = useRoute()
  const router = useRouter()
  const store = useInjectedHistoryStore()
  const detailLoading = ref(false)
  const detailMissingId = ref<string | null>(null)
  const syncVersion = ref(0)

  const detailRouteId = computed(() => {
    const id = route.params.id
    return typeof id === "string" && route.path.startsWith("/v/history/") ? id : ""
  })

  const detailOpen = computed(() => Boolean(detailRouteId.value))

  const detailTitle = computed(() => {
    const entry = store.selectedEntry.value
    return entry?.response?.model || entry?.request.model || "Request"
  })

  async function syncHistoryDetail(id: string): Promise<void> {
    const currentSyncVersion = ++syncVersion.value

    if (!id) {
      detailLoading.value = false
      detailMissingId.value = null
      store.clearSelection()
      return
    }

    if (store.selectedEntry.value?.id === id) {
      detailLoading.value = false
      detailMissingId.value = null
      return
    }

    detailLoading.value = true
    detailMissingId.value = null
    store.clearSelection()

    try {
      await store.selectEntry(id)
      if (syncVersion.value !== currentSyncVersion || detailRouteId.value !== id) return
      if (store.selectedEntry.value?.id !== id) {
        detailMissingId.value = id
      }
    } finally {
      if (syncVersion.value === currentSyncVersion) {
        detailLoading.value = false
      }
    }
  }

  async function openHistoryDetail(id: string): Promise<void> {
    if (!id || detailRouteId.value === id) return
    await router.push(`/v/history/${id}`)
  }

  async function closeHistoryDetail(): Promise<void> {
    if (!detailRouteId.value) return
    await router.push("/v/activity")
  }

  watch(
    detailRouteId,
    (id) => {
      void syncHistoryDetail(id)
    },
    { immediate: true },
  )

  return {
    detailRouteId,
    detailOpen,
    detailLoading,
    detailMissingId,
    detailTitle,
    openHistoryDetail,
    closeHistoryDetail,
  }
}
