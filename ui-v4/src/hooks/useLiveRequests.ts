import { useMemo } from "react"

import type {
  //
  ActiveRequestChangedInfo,
  ConnectedInfo,
} from "@/types/ws"

import { useWs } from "@/hooks/useWs"
import { useLiveStore } from "@/stores/live-store"

/** 订阅 WS active/connected,把在飞请求维护进 live-store。挂在工作台一次。 */
export function useLiveRequests(): void {
  const apply = useLiveStore((s) => s.apply)
  const setSnapshot = useLiveStore((s) => s.setSnapshot)
  const callbacks = useMemo(
    () => ({
      onActiveRequestChanged: (info: ActiveRequestChangedInfo) => apply(info),
      onConnected: (info: ConnectedInfo) => setSnapshot(info.activeRequests),
    }),
    [apply, setSnapshot],
  )
  useWs(callbacks)
}
