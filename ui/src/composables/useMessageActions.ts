import {
  //
  inject,
  provide,
  type InjectionKey,
} from "vue"

import type { MessageContent } from "@/types"

/**
 * Actions a MessageBlock can trigger on the surrounding detail context, without
 * prop-drilling through DetailRequestSection/stages:
 *  - openDiff: open the rich diff modal for a message's original vs effective.
 *  - jumpToCounterpart: switch to the other request stage (inbound ↔ effective)
 *    and scroll to the same message index.
 */
export interface MessageActions {
  openDiff: (original: MessageContent, effective: MessageContent, label: string) => void
  jumpToCounterpart: (index: number) => void
}

const KEY: InjectionKey<MessageActions> = Symbol("messageActions")

export function provideMessageActions(actions: MessageActions): void {
  provide(KEY, actions)
}

export function useMessageActions(): MessageActions {
  return inject(KEY, { openDiff: () => {}, jumpToCounterpart: () => {} })
}
