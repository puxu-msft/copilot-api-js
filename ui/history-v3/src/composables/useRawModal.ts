/**
 * Shared Raw JSON modal — single instance for the entire detail panel.
 *
 * Instead of each ContentBlockWrapper / MessageBlock / SectionBlock creating
 * its own RawJsonModal (150+ instances in a large entry), this composable
 * provides a single modal via Vue provide/inject. Child components call
 * openRawModal(data, title) and the provider renders the single shared modal.
 */

import { provide, inject, ref, shallowRef, type InjectionKey } from "vue"

// ─── Public API ───

export interface RawModalAPI {
  openRawModal: (data: unknown, title: string, rewrittenData?: unknown) => void
}

const RAW_MODAL_KEY: InjectionKey<RawModalAPI> = Symbol("rawModal")

/** Call in the provider component (DetailPanel) to set up shared raw JSON modal */
export function provideRawModal() {
  const visible = ref(false)
  // shallowRef: don't deep-observe the data (can be 1MB+ JSON)
  const data = shallowRef<unknown>(null)
  const rewrittenData = shallowRef<unknown>(null)
  const title = ref("")

  function openRawModal(d: unknown, t: string, rw?: unknown) {
    data.value = d
    rewrittenData.value = rw ?? null
    title.value = t
    visible.value = true
  }

  provide(RAW_MODAL_KEY, { openRawModal })

  return { visible, data, rewrittenData, title, openRawModal }
}

/** Call in consumer components to open the shared modal */
export function useRawModal(): RawModalAPI {
  const ctx = inject(RAW_MODAL_KEY)
  if (!ctx) throw new Error("useRawModal() called outside of RawModal provider")
  return ctx
}
