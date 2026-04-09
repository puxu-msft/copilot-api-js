/**
 * Shared ResizeObserver — single instance for the entire detail panel.
 *
 * Instead of each ContentBlockWrapper and MessageBlock creating its own
 * ResizeObserver (~200 instances in a large entry), this composable provides
 * a single observer via Vue provide/inject. Child components call
 * observe(el, callback) / unobserve(el) through the shared instance.
 *
 * The observer coalesces callbacks via requestAnimationFrame to avoid
 * redundant layout thrashing from multiple simultaneous resize events.
 */

import { provide, inject, onUnmounted, type InjectionKey } from "vue"

// ─── Public API ───

export interface SharedResizeObserverAPI {
  observe: (el: HTMLElement, callback: () => void) => void
  unobserve: (el: HTMLElement) => void
}

const RESIZE_OBSERVER_KEY: InjectionKey<SharedResizeObserverAPI> = Symbol("sharedResizeObserver")

/** Call in the provider component (DetailPanel) to set up shared ResizeObserver */
export function provideSharedResizeObserver(): SharedResizeObserverAPI {
  const callbacks = new Map<Element, () => void>()
  const pendingTargets = new Set<Element>()
  let rafId: number | null = null

  const observer = new ResizeObserver((entries) => {
    // Accumulate targets — multiple observer callbacks can fire before rAF
    for (const entry of entries) {
      pendingTargets.add(entry.target)
    }
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      for (const target of pendingTargets) {
        callbacks.get(target)?.()
      }
      pendingTargets.clear()
    })
  })

  function observe(el: HTMLElement, callback: () => void) {
    callbacks.set(el, callback)
    observer.observe(el)
  }

  function unobserve(el: HTMLElement) {
    callbacks.delete(el)
    observer.unobserve(el)
  }

  onUnmounted(() => {
    observer.disconnect()
    callbacks.clear()
    pendingTargets.clear()
    if (rafId !== null) cancelAnimationFrame(rafId)
  })

  const api: SharedResizeObserverAPI = { observe, unobserve }
  provide(RESIZE_OBSERVER_KEY, api)
  return api
}

/** Call in consumer components to get the shared ResizeObserver API */
export function useSharedResizeObserver(): SharedResizeObserverAPI {
  const api = inject(RESIZE_OBSERVER_KEY)
  if (!api) throw new Error("useSharedResizeObserver() called outside of provider")
  return api
}
