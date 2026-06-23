import { useQuery } from "@tanstack/react-query"

import type { HistoryEntry } from "@/types"

import { api } from "@/lib/api"

/** 按 ID 独立拉取详情(spec §4.1:不依赖行在不在列表窗口;在飞也返回数据;404=已淘汰)。 */
export function useEntry(id: string | undefined) {
  return useQuery({
    queryKey: ["entry", id],
    queryFn: () => api.get<HistoryEntry>(`/history/api/entries/${String(id)}`),
    enabled: Boolean(id),
  })
}
