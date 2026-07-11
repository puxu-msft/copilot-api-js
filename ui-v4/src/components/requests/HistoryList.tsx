import { useQueryClient } from "@tanstack/react-query"
import {
  //
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnSizingState,
  type OnChangeFn,
  type Row,
  type VisibilityState,
} from "@tanstack/react-table"
import { resolveResponseModel } from "~backend/lib/history/entry-view"
import {
  //
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import {
  //
  useNavigate,
  useSearchParams,
} from "react-router-dom"
import {
  //
  TableVirtuoso,
  type TableComponents,
  type VirtuosoHandle,
} from "react-virtuoso"

import type { RequestFilters } from "@/lib/request-filters"
import type {
  //
  EntrySummary,
  HistoryEntry,
} from "@/types"

import { SessionPaletteSelect } from "@/components/requests/SessionPaletteSelect"
import { Modal } from "@/components/shared/Modal"
import { useHistoryInfinite } from "@/hooks/useHistoryInfinite"
import { api } from "@/lib/api"
import {
  //
  DEFAULT_COLUMN_VISIBILITY,
  REQUEST_COLUMNS,
} from "@/lib/request-columns"
import {
  //
  matchesGating,
  hasAnyFilter,
  toQueryString,
} from "@/lib/request-filters"
import {
  //
  computeSessionRuns,
  DEFAULT_PALETTE_NAME,
  PALETTE_STORAGE_KEY,
  SESSION_PALETTES,
  type RunInfo,
} from "@/lib/session-color"
import { useListStore } from "@/stores/list-store"

/** load-until-found 翻页上限:防止 `at` 指向不存在/已淘汰 id 时无限拉取(仅在归属判定为「属于」时才翻页)。导出供测试断言 CAP 终止。 */
export const LOCATE_PAGE_CAP = 20
/**
 * 首屏强制渲染的行数上限。jsdom(测试)无 layout,react-virtuoso 靠它决定首屏渲染多少行
 * (见 exp/requests-virtuoso-poc/CONCLUSION.md);生产环境首帧即可见前 N 行,随后交给虚拟化测量。
 */
const INITIAL_ITEM_COUNT = 20
/** 命中行瞬态高亮(`toc-flash`)存留时长(ms),与 useAnchorScroll 的 TOC flash 对齐。 */
const FLASH_MS = 1200

/** TableVirtuoso 的行数据 = TanStack 行对象(`row.original` 即 EntrySummary)。 */
type HistoryRowModel = Row<EntrySummary>

/** 传给 Virtuoso 各子组件的上下文:定位真值(`at`)+ 命中 flash(`flashId`)+ 键盘焦点游标(`focusedId`)+ roving tab 停靠(`tabStopId`)+ 行点击回调。用 context 而非闭包,组件得以稳定不重挂。 */
interface RowContext {
  at: string | null
  flashId: string | null
  /** 键盘导航焦点游标所在行的 id(区别于 `at` 选中真值);命中行加焦点视觉标记 + DOM 焦点跟随(roving)。 */
  focusedId: string | null
  /** roving tabindex 的唯一 tab 停靠行 id:等于焦点行;无焦点(初始/Esc 清空后)回退首行作为入口。同一时刻仅此行 `tabIndex=0`,余行 `-1`。 */
  tabStopId: string | null
  onSelect: (id: string) => void
  /** 每行 run 元信息(色带色/段帽/缩进/tint);无 sessionId 行不在 map。 */
  runs: Map<string, RunInfo>
  /** 当前处于对比高亮选择集里的 sessionId 集合;空集 = 默认态(全部淡 tint)。 */
  selectedSessions: Set<string>
  /** 切换某会话的对比高亮(点色带 / 键盘 f);undefined(无 sessionId 行)时 no-op。 */
  onToggleSession: (sid: string | undefined) => void
}

/**
 * `GET /history/api/entries/:id` 返回完整 `HistoryEntry`,而 `matchesGating` 吃 `EntrySummary` 形状。
 * 投影出归属判定所需字段:model/pid 在 HistoryEntry 里是嵌套的(clientRequest.model /
 * resolveResponseModel(attempts) / process.pid),顶层 sessionId/endpoint/startedAt/state 直接透传。
 * 与后端 `toEntrySummary`(`src/lib/history/in-flight.ts`)投影**单源同构**——responseModel 复用后端纯函数
 * `resolveResponseModel`(经 `~backend/*` re-export),而非手写副本。携带原 entry 全字段(richest-data-flow),
 * 只补齐 EntrySummary 必填占位。
 */
function entryToGatingSummary(e: HistoryEntry): EntrySummary {
  return {
    ...e,
    pid: e.process?.pid,
    requestModel: e.clientRequest?.model,
    responseModel: resolveResponseModel(e),
    messageCount: e.clientRequest?.messages?.length ?? 0,
    previewText: "",
    responsePreviewText: "",
  } as EntrySummary
}

const ROW_CLASS = "mono cursor-pointer border-b border-[#222] text-left text-[13px]"

function selectionClass(selected: boolean): string {
  return selected ? "border-l-2 border-l-[var(--color-primary)] bg-[#3a2f1a] text-[#f0d8a8]" : "text-[#aaa]"
}

/** 键盘焦点游标的行高亮:outline 描边,视觉上区别于 `at` 选中(左边框 + 背景)与 flash(瞬态)。 */
function focusClass(focused: boolean): string {
  return focused ? " outline outline-1 -outline-offset-1 outline-[var(--color-primary)]" : ""
}

/** 焦点是否落在可输入元素上(避免在筛选输入框内按方向键/回车误触列表导航)。取事件 target,守卫在途输入。 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable
}

// ── Virtuoso 子组件(模块级、稳定引用,避免 inline 定义导致每帧重挂)。动态数据经 `context` 注入。 ──

/** `<table>` 外壳:必须透传 Virtuoso 注入的 `style`(布局);table-fixed + 列宽(固定列 th/td inline width=ColumnDef.size,弹性列自适应)决定列宽。 */
const TableShell: NonNullable<TableComponents<HistoryRowModel, RowContext>["Table"]> = ({ style, ...props }) => (
  <table
    {...props}
    className="mono w-full table-fixed border-collapse"
    style={style}
  />
)

/** 每行 `<tr>`:`item` 即 TanStack 行,`context.at` 决定选中高亮(+aria-current)、`context.flashId` 决定命中瞬态 flash、`context.focusedId` 决定键盘焦点游标描边、`context.tabStopId` 决定 roving tabindex(唯一 tab 停靠行 `tabIndex=0`,余行 `-1`),点击/Enter/Space 走 `context.onSelect`(单元格 td 由 itemContent 注入 children)。行本身即键盘焦点与激活单元:方向键 keydown 从聚焦行冒泡到容器移动游标(容器同步把 DOM 焦点移到目标行),Enter/Space 由 DOM 聚焦行(即游标行)激活 —— 焦点与游标恒同步,语义统一。 */
const TableRow: NonNullable<TableComponents<HistoryRowModel, RowContext>["TableRow"]> = ({ item, context, ...props }) => {
  const id = item.original.id
  const selected = id === context.at
  const flashing = id === context.flashId
  const focused = id === context.focusedId
  const isTabStop = id === context.tabStopId
  const info = context.runs.get(id)
  const sid = item.original.sessionId
  const selecting = context.selectedSessions.size > 0
  const selectedThisSession = sid !== undefined && context.selectedSessions.has(sid)
  // 对比态里非选中会话(且非 `at` 选中行)变灰:仅用 opacity-40,不叠 muted 文字类。
  const dim = selecting && !selectedThisSession && !selected
  // §3 单值背景优先级:`at` 选中→类背景(不设 inline);对比态选中会话→强 tint;
  // 对比态非选中→无 tint(靠 dim);默认态→淡 tint;无 sessionId→无。
  let bg: string | undefined
  if (!selected) {
    if (selecting) bg = selectedThisSession ? info?.strongTint : undefined
    else bg = info?.faintTint
  }
  return (
    <tr
      {...props}
      data-entry-id={id}
      data-focused={focused ? "true" : undefined}
      role="button"
      // roving tabindex:同一时刻仅 tab 停靠行可 Tab 聚焦(`0`),余行 `-1`(仅脚本/方向键可聚焦)。
      // 保证列表整体只占一个 Tab 停靠点,方向键在行间移动 DOM 焦点(见容器 onKeyDown + focus effect)。
      tabIndex={isTabStop ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      style={bg ? { backgroundColor: bg } : undefined}
      onClick={() => context.onSelect(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          // 行级激活:Enter/Space 由 DOM 聚焦行激活。roving 保证聚焦行 === 游标行,故激活的恒是游标行。
          // stopPropagation 防止冒泡到容器(容器已不含激活分支,此为纵深防御 + 语义显式:激活只在行级)。
          e.preventDefault()
          e.stopPropagation()
          context.onSelect(id)
        }
        // 方向键不在此处理:放行冒泡到容器 onKeyDown 统一移动游标 + DOM 焦点(roving)。
      }}
      className={`${ROW_CLASS} ${selectionClass(selected)}${flashing ? " toc-flash" : ""}${focusClass(focused)}${dim ? " opacity-40" : ""}`}
    />
  )
}

const TABLE_COMPONENTS: TableComponents<HistoryRowModel, RowContext> = {
  Table: TableShell,
  TableRow,
}

interface HistoryListProps {
  filters: RequestFilters
  /** 列可见性(受控);缺省则组件自持内部 state(用默认可见性)。RequestsListPage 经 useColumnState 提升 + localStorage 持久化。 */
  columnVisibility?: VisibilityState
  onColumnVisibilityChange?: OnChangeFn<VisibilityState>
  /** 列宽(受控,px);缺省 → TanStack 内部默认(列定义 size)。Task 2 加 resize 手柄写回。 */
  columnSizing?: ColumnSizingState
  onColumnSizingChange?: OnChangeFn<ColumnSizingState>
  /** 列序(受控);缺省 → 列定义序。Task 3 加 dnd 重排写回。 */
  columnOrder?: Array<string>
  onColumnOrderChange?: OnChangeFn<Array<string>>
  /** 清除全部筛选(保留 `?at=`)。定位目标不属于当前筛选集时,行内提示的「清除筛选并定位」按钮调用它。 */
  onClearFilters?: () => void
}

/**
 * History —— TanStack Table 列模型 + react-virtuoso 虚拟渲染(spec §4.2)。
 * 保留 tail 跟随 / `?at=` 定位 / goLive(缓冲合入 CTA 已上移 LiveDock 状态栏);渲染层换为 `TableVirtuoso`,
 * `endReached` 触底加载旧页取代旧 onScroll 阈值翻页,离顶(`atTopStateChange`)暂停 tail。
 */
export function HistoryList({
  filters,
  columnVisibility: controlledVisibility,
  onColumnVisibilityChange,
  columnSizing,
  onColumnSizingChange,
  columnOrder,
  onColumnOrderChange,
  onClearFilters,
}: HistoryListProps) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const at = searchParams.get("at")
  const { entries, total, isLoading, isError, error, refetch, hasNextPage, fetchNextPage } = useHistoryInfinite(filters)
  const tailOn = useListStore((s) => s.tailOn)
  const dispatch = useListStore((s) => s.dispatch)
  const queryClient = useQueryClient()

  // 清空历史确认 Modal:开合 + 删除在途(防重复提交)。筛选感知——有筛选走 scoped delete、无筛选走 clear-all。
  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const confirmClear = useCallback(async () => {
    setClearing(true)
    try {
      // 有筛选 → scoped delete(带 query);无筛选 → clear-all(无 query)。后端按 query 有无分流(Phase 0)。
      const qs = toQueryString(filters)
      const res = await api.delete<{ success: boolean; deleted?: number }>(`/history/api/entries${qs ? `?${qs}` : ""}`)
      if (res.deleted !== undefined) console.info(`[HistoryList] 已删除 ${res.deleted} 条历史`)
      // queryKey 形如 ["history-infinite", filterSig];前缀匹配 invalidate 命中所有 filter 变体。
      await queryClient.invalidateQueries({ queryKey: ["history-infinite"] })
      setClearOpen(false)
    } catch (err) {
      // 删除失败不吞:曝光错误(内部工具可观测性优先),保持 Modal 开着供重试。
      console.error("[HistoryList] 清空历史失败:", err)
    } finally {
      setClearing(false)
    }
  }, [filters, queryClient])

  // 列可见性:受控优先,否则内部 state。留好 Task 3.4 的受控接口(菜单 + localStorage 持久化)。
  const [internalVisibility, setInternalVisibility] = useState<VisibilityState>(DEFAULT_COLUMN_VISIBILITY)
  const columnVisibility = controlledVisibility ?? internalVisibility
  const setColumnVisibility = onColumnVisibilityChange ?? setInternalVisibility

  const table = useReactTable({
    data: entries,
    columns: REQUEST_COLUMNS,
    // 仅在受控时把 sizing/order 放进 state:传 `columnSizing: undefined` 会覆盖 TanStack 内部
    // 默认 `{}`、令 getSize() 崩(读 undefined[id])。缺省(HistoryList 独立渲染/测试)时省略键，
    // 交给 TanStack 内部默认(列定义 size + 定义序)。
    state: {
      columnVisibility,
      ...(columnSizing !== undefined ? { columnSizing } : {}),
      ...(columnOrder !== undefined ? { columnOrder } : {}),
    },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange,
    onColumnOrderChange,
    defaultColumn: { minSize: 40 },
    getCoreRowModel: getCoreRowModel(),
  })
  const rows = table.getRowModel().rows

  // session 色带的 run 元信息(色/段帽/缩进/tint):跑在已加载全部页拼接的 entries 上(非虚拟化窗口)。
  // 色板态:localStorage 持久化 + 头部 SessionPaletteSelect 切换;未知名回退首套。
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(() => new Set())
  const [paletteName, setPaletteName] = useState<string>(() => {
    try {
      return localStorage.getItem(PALETTE_STORAGE_KEY) ?? DEFAULT_PALETTE_NAME
    } catch {
      return DEFAULT_PALETTE_NAME
    }
  })
  const activePalette = SESSION_PALETTES.find((p) => p.name === paletteName) ?? SESSION_PALETTES[0]
  const runs = useMemo(() => computeSessionRuns(entries, activePalette), [entries, activePalette])
  const setPalette = useCallback((name: string) => {
    setPaletteName(name)
    try {
      localStorage.setItem(PALETTE_STORAGE_KEY, name)
    } catch {
      // localStorage 不可用(隐私模式/配额)时静默降级:仅本会话生效,不阻塞。
    }
  }, [])
  const onToggleSession = useCallback((sid: string | undefined) => {
    if (!sid) return // H1:无 sessionId 行 no-op
    setSelectedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(sid)) next.delete(sid)
      else next.add(sid)
      return next
    })
  }, [])

  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // 每个 `at` 的定位进度:done 命中后不再重滚(WS invalidate 会换 entries 引用,否则抖动);
  // pages 记 load-until-found 已翻页数(上限保护)。at 变化时重置。
  const locateRef = useRef<{ at: string | null; pages: number; done: boolean }>({ at: null, pages: 0, done: false })

  // 命中行瞬态 flash:命中 id 加到 RowContext,虚拟化下命中行渲染时带 `toc-flash` 类(行可能不在 DOM,
  // 故不用 imperative classList,交给 itemContent/TableRow 渲染)。FLASH_MS 后清空。
  const [flashId, setFlashId] = useState<string | null>(null)
  // 键盘导航焦点游标:index 指向 rows 中的位置(初始 0,与「列表默认有个顶部游标」一致);
  // ↑/↓ 移动、Enter 激活(由行级 DOM 焦点承担)、Esc 清空。区别于 `at` 选中真值(由 URL 承载)。
  const [focusedIndex, setFocusedIndex] = useState(0)
  // 滚动容器 DOM 引用:focus effect 据此按 data-entry-id 查目标行节点并 .focus()(roving)。
  const scrollerRef = useRef<HTMLDivElement>(null)
  // 待移焦请求:方向键导航时置为目标行 id,渲染提交后由 focus effect 消费并把 DOM 焦点移到该行。
  // 用 id 而非 bool:仅键盘导航置位(初始挂载/数据刷新不夺焦点),消费后清空,避免背景数据更新误抢焦点。
  const focusRequestRef = useRef<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const flashRow = useCallback((id: string) => {
    if (flashTimerRef.current !== undefined) clearTimeout(flashTimerRef.current)
    setFlashId(id)
    flashTimerRef.current = setTimeout(() => {
      setFlashId(null)
      flashTimerRef.current = undefined
    }, FLASH_MS)
  }, [])
  useEffect(
    () => () => {
      if (flashTimerRef.current !== undefined) clearTimeout(flashTimerRef.current)
    },
    [],
  )

  // roving DOM 焦点:方向键移动游标后(focusedIndex 变化)把 DOM 焦点移到目标行,使聚焦行 === 游标行。
  // 虚拟化下目标行经 scrollToIndex 滚入可见后才渲染,故在渲染提交后(effect,含一次 rAF 补偿异步渲染)
  // 按 data-entry-id 查节点 .focus()。仅当 focusRequestRef 有待移焦请求(键盘导航发起)才移焦 —— 初始挂载、
  // 数据刷新(rows 变)不夺用户焦点。deps 仅 focusedIndex:游标未变(如 ArrowUp 触底 clamp)则焦点本就正确、无需重跑。
  useEffect(() => {
    const id = focusRequestRef.current
    if (id === null) return
    focusRequestRef.current = null
    // 按 dataset 匹配(而非 CSS 选择器)以免 id 含特殊字符需转义,且不依赖 `CSS.escape`(测试 DOM 环境未必暴露)。
    const focusRow = () => {
      const nodes = scrollerRef.current?.querySelectorAll<HTMLElement>("[data-entry-id]")
      for (const node of nodes ?? []) {
        if (node.dataset.entryId === id) {
          node.focus()
          return
        }
      }
    }
    focusRow()
    // 真实 Virtuoso 下 scrollToIndex 触发的重渲染可能晚一帧:补一次 rAF 重试(测试的 fake Virtuoso 同步渲染,首次即命中)。
    const raf = requestAnimationFrame(focusRow)
    return () => cancelAnimationFrame(raf)
    // 以 focusedIndex 变化为触发闸:不把 rows 纳入 deps,避免数据刷新(rows 变引用)误抢用户焦点。
  }, [focusedIndex])

  // at×筛选归属判定(§10.1 分支 2/3):`at` 不在已加载集时,查单条 summary 判 matchesGating —
  // 属于则继续 load-until-found、不属于则提示不翻页。membership 按 (at, filterSig) 记忆:filterSig 变化
  // (含 clearAll,它保留 `?at`)即视作陈旧、需用新 filters 重判。checkRef 记在途查询的 (at, sig) 供去重 +
  // 代次守卫——filters/at 在途变更时,旧请求的迟到解析被丢弃、不覆盖新判定(避免陈旧 filters 竞态)。
  const [membership, setMembership] = useState<{ at: string; sig: string; member: boolean } | null>(null)
  const checkRef = useRef<{ at: string; sig: string } | null>(null)
  // 归属只受 gating 维度影响(matchesGating 不含 search),故 key 用去 search 的签名:search-only 编辑
  // 不失效 membership、不触发多余单条查询。此为 gating 维度的超集键,等号成立 ⟹ gating 结果相同。
  const filterSig = toQueryString({ ...filters, search: "" })
  // 仅当 membership 与当前 (at, filterSig) 一致才有效;否则(陈旧/未判)按未知处理。
  const membershipCurrent = at !== null && membership?.at === at && membership.sig === filterSig ? membership : null
  // 定位目标已判定为「不属于当前筛选」→ 渲染行内提示(而非盲翻页)。
  const outOfFilter = membershipCurrent !== null && !membershipCurrent.member

  // URL 带 `?at=` → 该条目为定位真值:落地时暂停 tail(避免新条目把定位行挤走)。
  // 只在 `at` 变化时触发(edge-triggered,deps 不含 tailOn):否则 resume 把 tailOn 转 true
  // 会立刻被本 effect 再次暂停,使 resume 在定位态下永久失效。显式 go-live 会清掉 `at`(见 goLive)。
  useEffect(() => {
    if (at) dispatch({ kind: "locate" })
  }, [at, dispatch])

  // 定位(§10.1):
  //   ① `at` 在已加载集 → scrollToIndex 居中 + flash 命中行。
  //   ② 不在集 → 先查单条 summary 判归属(每个 at 只查一次):
  //       · 属于 → load-until-found(翻页直到命中或 LOCATE_PAGE_CAP,命中后回到 ①)。
  //       · 不属于 → 提示态(outOfFilter),不翻页。
  // 依赖 entries:每次 fetchNextPage 揭示新页 → 重跑 → 再尝试命中。
  useEffect(() => {
    if (!at) {
      locateRef.current = { at: null, pages: 0, done: false }
      return
    }
    if (locateRef.current.at !== at) locateRef.current = { at, pages: 0, done: false }
    if (locateRef.current.done) return

    const index = entries.findIndex((e) => e.id === at)
    if (index !== -1) {
      locateRef.current.done = true
      virtuosoRef.current?.scrollToIndex({ index, align: "center" })
      flashRow(at)
      return
    }

    // 不在已加载集:先按 (at, filterSig) 判归属(每个 (at, sig) 只查一次)。
    if (membershipCurrent === null) {
      if (checkRef.current?.at === at && checkRef.current.sig === filterSig) return // 同 (at, sig) 查询在途
      const sig = filterSig
      checkRef.current = { at, sig }
      void api
        .get<HistoryEntry>(`/history/api/entries/${at}`)
        .then((entry) => {
          // 代次守卫:仅当本请求仍是当前在途者(at/sig 未被更新的请求取代)才落地,避免陈旧 filters 覆盖。
          if (checkRef.current?.at === at && checkRef.current.sig === sig) {
            setMembership({ at, sig, member: matchesGating(entryToGatingSummary(entry), filters) })
            checkRef.current = null
          }
        })
        .catch((err: unknown) => {
          if (checkRef.current?.at === at && checkRef.current.sig === sig) {
            // 取不到条目(404/网络)= 归属不确定:从宽当作「属于」回退 load-until-found。同时曝光错误
            // (含非预期的投影/gating 抛错)而非静默吞掉——内部工具可观测性优先(不阻塞定位)。
            console.error(`[HistoryList] 归属判定查询失败 at=${at}:`, err)
            setMembership({ at, sig, member: true })
            checkRef.current = null
          }
        })
      return
    }
    if (!membershipCurrent.member) return // 不属于当前筛选:提示态,不翻页

    // 属于但未在窗口内:翻下一页直到命中或耗尽(上限保护)。
    if (hasNextPage && locateRef.current.pages < LOCATE_PAGE_CAP) {
      locateRef.current.pages += 1
      void fetchNextPage()
    }
  }, [at, entries, hasNextPage, fetchNextPage, filters, filterSig, membershipCurrent, flashRow])

  const selectRow = useCallback(
    (rowId: string) => {
      dispatch({ kind: "locate" }) // 暂停 tail;选中真值由目标 URL(/requests/:id)承载
      void navigate(`/requests/${rowId}`)
    },
    [dispatch, navigate],
  )
  const rowContext = useMemo<RowContext>(() => {
    const focused = focusedIndex >= 0 && focusedIndex < rows.length ? rows[focusedIndex] : undefined
    const focusedId = focused ? focused.original.id : null
    // roving tab 停靠:焦点行即停靠行;无焦点(初始/Esc 清空)回退首行作为 Tab 入口,保证列表始终有且仅一个 Tab 停靠点。
    const firstId = rows.length > 0 ? rows[0].original.id : null
    const tabStopId = focusedId ?? firstId
    return { at, flashId, focusedId, tabStopId, onSelect: selectRow, runs, selectedSessions, onToggleSession }
  }, [at, flashId, focusedIndex, rows, selectRow, runs, selectedSessions, onToggleSession])

  // 容器级键盘导航(↑/↓/Esc):方向键从聚焦行冒泡到此,移动焦点游标 + 同步 DOM 焦点(roving)+ scrollToIndex 带入视口。
  // Enter/Space 激活不在此处理 —— 由 DOM 聚焦行(即游标行,roving 保证同步)的行级 onKeyDown 承担,语义统一到行级。
  // isTyping 守卫:焦点落在输入类元素内(如筛选栏)时不拦,避免方向键误触列表导航。
  // 副作用(scrollToIndex/移焦请求)在 setState updater 外执行 —— updater 须纯(StrictMode 双调用安全)。
  const onListKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isTyping(e.target)) return
      const len = rows.length
      if (len === 0) return
      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault()
          const next = focusedIndex < 0 ? 0 : Math.min(focusedIndex + 1, len - 1)
          setFocusedIndex(next)
          focusRequestRef.current = rows[next]?.original.id ?? null
          // 向下移动:游标行贴底显现(align "end",最小滚动露出目标;react-virtuoso 无 "auto",按方向取边)。
          virtuosoRef.current?.scrollToIndex({ index: next, align: "end" })
          break
        }
        case "ArrowUp": {
          e.preventDefault()
          const next = focusedIndex < 0 ? 0 : Math.max(focusedIndex - 1, 0)
          setFocusedIndex(next)
          focusRequestRef.current = rows[next]?.original.id ?? null
          // 向上移动:游标行贴顶显现(align "start")。
          virtuosoRef.current?.scrollToIndex({ index: next, align: "start" })
          break
        }
        case "Escape": {
          // 清游标:清掉待移焦请求(否则 focus effect 会因 focusedIndex 变 -1 而重新聚回旧行),并 blur 当前聚焦行。
          focusRequestRef.current = null
          setFocusedIndex(-1)
          if (e.target instanceof HTMLElement) e.target.blur()
          setSelectedSessions(new Set()) // 同时清空对比高亮选择集
          break
        }
        case "f": {
          // 把光标行所属会话切入/切出对比高亮集(点色带的键盘等价物)。
          e.preventDefault()
          // 光标可能为空(Esc 后 focusedIndex=-1)或越界:先 bounds-check 再取行(同 rowContext memo 的模式)。
          const row = focusedIndex >= 0 && focusedIndex < rows.length ? rows[focusedIndex] : undefined
          if (row) onToggleSession(row.original.sessionId)
          break
        }
        default: {
          // 其他键不处理(不 preventDefault,放行页面滚动等默认行为)。Enter/Space 由行级 onKeyDown 处理。
          break
        }
      }
    },
    [rows, focusedIndex, onToggleSession],
  )

  // 显式跟随实时流 / 暂停自动刷新的控制已上移到 LiveDock 状态栏(useGoLive + list-store pause);
  // HistoryList 只被动暂停 tail(locate / scroll-up),不再自持 resume 入口。

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mono flex items-center gap-2 border-b border-[#222] px-2 py-1 text-[12px] uppercase tracking-wider text-[var(--color-muted)]">
        <span>History · {total} total</span>
        <SessionPaletteSelect
          value={paletteName}
          onChange={setPalette}
        />
        {/* tail(自动刷新)状态 + 暂停/恢复控制已上移到底部 LiveDock 状态栏(见 LiveDock 的 ▶ live/⏸ paused 开关)。 */}
        <button
          type="button"
          className="ml-auto text-[var(--color-primary)]"
          onClick={() => setClearOpen(true)}
        >
          清空
        </button>
      </div>
      {outOfFilter && (
        <div className="mono flex items-center justify-center gap-2 border-b border-[#5a4a2a] bg-[#2a2418] py-1 text-center text-[13px] text-[#d8c088]">
          <span>该条目不在当前筛选内</span>
          <span className="text-[#6a5a3a]">·</span>
          <button
            type="button"
            className="text-[var(--color-primary)] underline-offset-2 hover:underline"
            onClick={() => onClearFilters?.()}
          >
            清除筛选并定位
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {isError && (
          <div className="mono flex flex-col items-center gap-2 p-4 text-center text-[13px] text-[#e0a0a0]">
            <span>⚠ 加载失败</span>
            <span className="text-[#c88]">{String(error)}</span>
            <button
              type="button"
              className="text-[var(--color-primary)] underline-offset-2 hover:underline"
              onClick={() => void refetch()}
            >
              重试
            </button>
          </div>
        )}
        {!isError && isLoading && <div className="mono p-2 text-[#888]">loading…</div>}
        {!isError && !isLoading && (
          // 容器级方向键导航(roving 表面):真正可交互 + 可聚焦的单元是内部 role=button 的行;方向键从聚焦行冒泡到此,
          // 容器移动游标并把 DOM 焦点同步到目标行(roving),Enter/Space 由聚焦行(即游标行)激活 —— 焦点与游标恒同步。
          // 不给本 div 自身 tabIndex(避免多余的非交互 tab stop);onKeyDown 触发 no-static-element-interactions,
          // 而给虚拟化 <table> 外壳强加 grid/listbox role 会扭曲语义、误导 AT,按项目约定禁用此规则而非扭曲代码。
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions
          <div
            ref={scrollerRef}
            className="relative h-full"
            data-testid="history-scroller"
            onKeyDown={onListKeyDown}
          >
            <TableVirtuoso<HistoryRowModel, RowContext>
              ref={virtuosoRef}
              style={{ height: "100%" }}
              data={rows}
              context={rowContext}
              // jsdom 无 layout,靠 initialItemCount 强制首屏渲染前 N 行(见 CONCLUSION.md)。
              initialItemCount={Math.min(rows.length, INITIAL_ITEM_COUNT)}
              components={TABLE_COMPONENTS}
              endReached={() => {
                if (hasNextPage) void fetchNextPage()
              }}
              // 离顶(用户上滚)→ 暂停 tail,避免新条目把当前浏览位置挤走(取代旧 onScroll 阈值判断)。
              atTopStateChange={(atTop) => {
                if (!atTop && tailOn) dispatch({ kind: "scroll-up" })
              }}
              fixedHeaderContent={() =>
                table.getHeaderGroups().map((hg) => (
                  <tr
                    key={hg.id}
                    className="mono border-b border-[#222] bg-[#111] text-[11px] uppercase tracking-wider text-[var(--color-muted)]"
                  >
                    {hg.headers.map((header) => {
                      // 仅固定列 emit inline width(getSize() 永不返 undefined,无 size 回退 150);
                      // 弹性列(preview/response,enableResizing:false)/session gutter 不设宽,自适应剩余/特判 10px。
                      const isFixed = header.column.columnDef.enableResizing !== false && header.column.id !== "session"
                      return (
                        <th
                          key={header.id}
                          // session 色列表头须镜像其 body td 的无水平 padding(p-0):table-fixed 下列宽由首行(表头)决定,
                          // 若 session th 带 px-2(16px)会在 w-[10px] 上被 padding 撑大、与 p-0 的 body 色列错位并挤占后续列宽。
                          className={`${header.column.id === "session" ? "p-0 w-[10px]" : "px-2 py-1"} text-left font-normal`}
                          style={isFixed ? { width: header.getSize() } : undefined}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </th>
                      )
                    })}
                  </tr>
                ))
              }
              itemContent={(_index, row, context) =>
                row.getVisibleCells().map((cell) => {
                  if (cell.column.id === "session") {
                    const info = context.runs.get(row.original.id)
                    return (
                      <td
                        key={cell.id}
                        className="relative w-[10px] p-0"
                      >
                        {info && (
                          <button
                            type="button"
                            aria-label="toggle session highlight"
                            tabIndex={-1}
                            onClick={(e) => {
                              // stopPropagation:切换对比高亮,不冒泡到行 onClick(否则会 navigate 到详情)。
                              e.stopPropagation()
                              context.onToggleSession(row.original.sessionId)
                            }}
                            className={`absolute inset-0 -bottom-px${info.isRunStart ? " session-cap-top" : ""}${info.isRunEnd ? " session-cap-bottom" : ""}`}
                            style={{ backgroundColor: info.indent ? info.shade : info.color }}
                          />
                        )}
                      </td>
                    )
                  }
                  // status 缩进用 `pr-2 pl-3`(而非 `px-2`+`pl-3` 叠同属性,避免依赖 Tailwind 生成序);其余列 `px-2`。
                  const indented = cell.column.id === "status" && context.runs.get(row.original.id)?.indent
                  const padX = indented ? "pr-2 pl-3" : "px-2"
                  // 仅固定列 emit inline width(镜像表头,table-fixed 下列宽由表头决定,body 补齐防抖动);
                  // 弹性列(preview/response)/session 不设宽。session 已在上面的特判分支提前返回。
                  const isFixed = cell.column.columnDef.enableResizing !== false && cell.column.id !== "session"
                  return (
                    <td
                      key={cell.id}
                      className={`overflow-hidden ${padX} py-1 align-middle`}
                      style={isFixed ? { width: cell.column.getSize() } : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  )
                })
              }
            />
            {/* 空态:保留表头(列可见性等外层结构),仅在表体区叠加「无匹配请求」提示(+ 有筛选时清除筛选)。 */}
            {entries.length === 0 && (
              <div className="mono absolute inset-x-0 top-10 flex flex-col items-center gap-2 p-4 text-center text-[13px] text-[#888]">
                <span>无匹配请求</span>
                {hasAnyFilter(filters) && (
                  <button
                    type="button"
                    className="text-[var(--color-primary)] underline-offset-2 hover:underline"
                    onClick={() => onClearFilters?.()}
                  >
                    清除筛选
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {clearOpen && (
        <Modal
          title="清空历史"
          onClose={() => setClearOpen(false)}
        >
          <div className="mono flex flex-col gap-4 text-[13px] text-[var(--color-text)]">
            <p>{hasAnyFilter(filters) ? `删除当前筛选命中的 ${total} 条？` : `清空全部 ${total} 条？`}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="border border-[var(--color-border)] px-3 py-1 text-[var(--color-muted)] hover:text-[var(--color-text)]"
                onClick={() => setClearOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={clearing}
                className="border border-[var(--color-primary)] px-3 py-1 text-[var(--color-primary)] disabled:opacity-50"
                onClick={() => void confirmClear()}
              >
                确认
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
