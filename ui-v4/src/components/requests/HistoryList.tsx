import {
  //
  useEffect,
  useRef,
} from "react"
import {
  //
  useNavigate,
  useSearchParams,
} from "react-router-dom"

import { RequestRow } from "@/components/requests/RequestRow"
import { useHistoryInfinite } from "@/hooks/useHistoryInfinite"
import { useListStore } from "@/stores/list-store"

/** 定位命中后的瞬态高亮类(与 useAnchorScroll 共用,见 styles/theme.css)。 */
const FLASH_CLASS = "toc-flash"
const FLASH_MS = 1200
/** load-until-found 翻页上限:防止 `at` 指向不存在/已淘汰 id 时无限拉取。 */
const LOCATE_PAGE_CAP = 20

/** 在滚动容器内按 data-entry-id 查找行;防御性转义 `"`/`\`(entry id 理论可含任意字符)。 */
function findRow(container: HTMLElement | null, id: string): HTMLElement | null {
  if (!container) return null
  const safe = id.replaceAll(/["\\]/g, String.raw`\$&`)
  return container.querySelector<HTMLElement>(`[data-entry-id="${safe}"]`)
}

/** History —— 游标分页 + 缓冲横幅 + tail 暂停 + URL(`?at=`)定位/高亮(spec §4.2)。 */
export function HistoryList() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const at = searchParams.get("at")
  const { entries, total, isLoading, hasNextPage, fetchNextPage } = useHistoryInfinite()
  const bufferedIds = useListStore((s) => s.bufferedIds)
  const tailOn = useListStore((s) => s.tailOn)
  const dispatch = useListStore((s) => s.dispatch)

  const scrollRef = useRef<HTMLDivElement>(null)
  // 每个 `at` 的定位进度:done 命中后不再重滚(WS invalidate 会换 entries 引用,否则抖动);
  // pages 记 load-until-found 已翻页数(上限保护)。at 变化时重置。
  const locateRef = useRef<{ at: string | null; pages: number; done: boolean }>({ at: null, pages: 0, done: false })
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // URL 带 `?at=` → 该条目为定位真值:落地时暂停 tail(避免新条目把定位行挤走)。
  // 只在 `at` 变化时触发(edge-triggered,deps 不含 tailOn):否则 resume 把 tailOn 转 true
  // 会立刻被本 effect 再次暂停,使 resume 在定位态下永久失效。显式 go-live 会清掉 `at`(见 goLive)。
  useEffect(() => {
    if (at) dispatch({ kind: "locate" })
  }, [at, dispatch])

  // 定位:滚动到 `at` 行 + 瞬态高亮;不在当前分页窗口则逐页 load-until-found(有上限)。
  // 依赖 entries:每次 fetchNextPage 揭示新页 → 重跑本 effect → 再尝试命中。
  useEffect(() => {
    if (!at) {
      locateRef.current = { at: null, pages: 0, done: false }
      return
    }
    if (locateRef.current.at !== at) locateRef.current = { at, pages: 0, done: false }
    if (locateRef.current.done) return

    const el = findRow(scrollRef.current, at)
    if (el) {
      el.scrollIntoView({ block: "center" })
      el.classList.add(FLASH_CLASS)
      if (flashTimerRef.current !== undefined) clearTimeout(flashTimerRef.current)
      flashTimerRef.current = setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_MS)
      locateRef.current.done = true
      return
    }
    // 未在窗口内:翻下一页直到命中或耗尽(上限保护)。
    if (hasNextPage && locateRef.current.pages < LOCATE_PAGE_CAP) {
      locateRef.current.pages += 1
      void fetchNextPage()
    }
  }, [at, entries, hasNextPage, fetchNextPage])

  // 卸载清理闪烁计时器。
  useEffect(
    () => () => {
      if (flashTimerRef.current !== undefined) clearTimeout(flashTimerRef.current)
    },
    [],
  )

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    if (e.currentTarget.scrollTop > 4 && tailOn) dispatch({ kind: "scroll-up" })
  }
  function selectRow(rowId: string) {
    dispatch({ kind: "locate" }) // 暂停 tail;选中真值由目标 URL(/requests/:id)承载
    void navigate(`/requests/${rowId}`)
  }
  // 显式跟随实时流:恢复 tail 并清掉 URL 的定位参数(URL-as-truth:tailing 态不该声明 locate)。
  function goLive(ev: "resume" | "flush") {
    dispatch({ kind: ev })
    if (at) void navigate("/requests", { replace: true })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mono flex items-center gap-2 border-b border-[#222] px-2 py-1 text-[12px] uppercase tracking-wider text-[var(--color-muted)]">
        <span>History · {total} total</span>
        <span className="ml-auto">{tailOn ? "▶ live" : "⏸ paused"}</span>
        {!tailOn && (
          <button
            type="button"
            className="text-[var(--color-primary)]"
            onClick={() => goLive("resume")}
          >
            resume
          </button>
        )}
      </div>
      {bufferedIds.length > 0 && (
        <button
          type="button"
          className="mono border-b border-[#4a3a55] bg-[#2a2230] py-1 text-center text-[14px] text-[#caa6e0]"
          onClick={() => goLive("flush")}
        >
          ↓ {bufferedIds.length} 条新请求 —— 点此合入
        </button>
      )}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={onScroll}
      >
        {isLoading ?
          <div className="mono p-2 text-[#888]">loading…</div>
        : entries.map((e) => (
            <RequestRow
              key={e.id}
              entry={e}
              selected={e.id === at}
              onClick={() => selectRow(e.id)}
            />
          ))
        }
        {hasNextPage && (
          <button
            type="button"
            className="mono w-full py-2 text-[13px] text-[var(--color-primary)]"
            onClick={() => void fetchNextPage()}
          >
            加载更多
          </button>
        )}
      </div>
    </div>
  )
}
