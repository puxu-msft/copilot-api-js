import { useMemo } from "react"
import { Outlet } from "react-router-dom"

import { NavRail } from "@/components/shell/NavRail"
import { TopBar } from "@/components/shell/TopBar"
import { useWs } from "@/hooks/useWs"
import { useUiStore } from "@/stores/ui-store"

export function AppShell() {
  const setWsConnected = useUiStore((s) => s.setWsConnected)
  const callbacks = useMemo(() => ({ onStatusChange: (c: boolean) => setWsConnected(c) }), [setWsConnected])
  useWs(callbacks)
  return (
    <div className="flex h-full">
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-auto p-2">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
