import { provide, inject, type Ref, type InjectionKey } from 'vue'
import type { ContentBlock } from '@/types'

export interface ContentContext {
  searchQuery: Ref<string>
  filterType: Ref<string>
  aggregateTools: Ref<boolean>
  toolResultMap: Ref<Record<string, ContentBlock>>
  toolUseNameMap: Ref<Record<string, string>>
  scrollToResult: (toolUseId: string) => void
  scrollToCall: (toolUseId: string) => void
}

export const CONTENT_CONTEXT_KEY: InjectionKey<ContentContext> = Symbol('contentContext')

export function provideContentContext(ctx: ContentContext) {
  provide(CONTENT_CONTEXT_KEY, ctx)
}

export function useContentContext(): ContentContext {
  const ctx = inject(CONTENT_CONTEXT_KEY)
  if (!ctx) {
    throw new Error('useContentContext() called outside of ContentContext provider')
  }
  return ctx
}
