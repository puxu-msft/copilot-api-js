import {
  //
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable"
import { useQueryClient } from "@tanstack/react-query"
import {
  //
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnSizingState,
  type Header,
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
  type CSSProperties,
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

import { SessionPaletteSelectShadcn } from "@/components/requests/SessionPaletteSelectShadcn"
import { Button } from "@/components/ui/button"
import {
  //
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
 * 与 legacy `HistoryList.entryToGatingSummary` 单源同构(逐字复用后端纯函数 `resolveResponseModel`)。
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

/** shadcn/neutral 行外壳:中性语义 token(不用 amber 命名空间/裸 hex,neutral-surface 守卫强制)。 */
const ROW_CLASS = "mono cursor-pointer border-b border-border text-left text-[13px]"

function selectionClass(selected: boolean): string {
  return selected ? "border-l-2 border-l-primary bg-accent text-accent-foreground" : "text-muted-foreground"
}

/** 键盘焦点游标的行高亮:outline 描边,视觉上区别于 `at` 选中(左边框 + 背景)与 flash(瞬态)。 */
function focusClass(focused: boolean): string {
  return focused ? " outline outline-1 -outline-offset-1 outline-ring" : ""
}

/** 焦点是否落在可输入元素上(避免在筛选输入框内按方向键/回车误触列表导航)。取事件 target,守卫在途输入。 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable
}

// ── Virtuoso 子组件(模块级、稳定引用,避免 inline 定义导致每帧重挂)。动态数据经 `context` 注入。 ──

/** `<table>` 外壳:必须透传 Virtuoso 注入的 `style`(布局);table-fixed + 列宽决定列宽。 */
const TableShell: NonNullable<TableComponents<HistoryRowModel, RowContext>["Table"]> = ({ style, ...props }) => (
  <table
    {...props}
    className="mono w-full table-fixed border-collapse"
    style={style}
  />
)

/** 每行 `<tr>`:选中/flash/焦点/roving tabindex + 点击/Enter/Space 走 `context.onSelect`(与 legacy HistoryList 行为逐字同构,仅中性化配色)。 */
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
  const dim = selecting && !selectedThisSession && !selected
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
      tabIndex={isTabStop ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      style={bg ? { backgroundColor: bg } : undefined}
      onClick={() => context.onSelect(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          e.stopPropagation()
          context.onSelect(id)
        }
      }}
      className={`${ROW_CLASS} ${selectionClass(selected)}${flashing ? " toc-flash" : ""}${focusClass(focused)}${dim ? " opacity-40" : ""}`}
    />
  )
}

const TABLE_COMPONENTS: TableComponents<HistoryRowModel, RowContext> = {
  Table: TableShell,
  TableRow,
}

/**
 * 可拖拽重排的表头单元——非 session 列的 `<th>`。经 `useSortable` 接入 `SortableContext` + 上层 `DndContext`
 * (RequestsListShadcn)。与 legacy `SortableHeaderCell` 逐字同构(HIGH-2 手柄 stopPropagation 分区),仅中性化配色。
 */
function SortableHeaderCell({ header }: { header: Header<EntrySummary, unknown> }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: header.column.id })
  const isFixed = header.column.columnDef.enableResizing !== false
  const style: CSSProperties = {
    ...(isFixed ? { width: header.getSize() } : {}),
    transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.6 : undefined,
    cursor: "grab",
  }
  return (
    <th
      ref={setNodeRef}
      style={style}
      className="relative px-2 py-1 text-left font-normal"
      {...attributes}
      {...listeners}
    >
      {flexRender(header.column.columnDef.header, header.getContext())}
      {header.column.getCanResize() && (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <span
          data-resize-handle
          onMouseDown={header.getResizeHandler()}
          onTouchStart={header.getResizeHandler()}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute inset-y-0 right-0 w-1 cursor-col-resize select-none hover:bg-primary"
        />
      )}
    </th>
  )
}

interface HistoryListShadcnProps {
  filters: RequestFilters
  columnVisibility?: VisibilityState
  onColumnVisibilityChange?: OnChangeFn<VisibilityState>
  columnSizing?: ColumnSizingState
  onColumnSizingChange?: OnChangeFn<ColumnSizingState>
  columnOrder?: Array<string>
  onColumnOrderChange?: OnChangeFn<Array<string>>
  onClearFilters?: () => void
}

/**
 * History (shadcn 侧) —— TanStack Table 列模型 + react-virtuoso 虚拟渲染。**虚拟化容器 fork 决策:选 A**
 * (保 `TableVirtuoso`,只换呈现为中性 token + shadcn `Dialog`),故 legacy 的 `FakeTableVirtuoso` 契约可沿用。
 * 复用**共用数据层**:`useHistoryInfinite` / `REQUEST_COLUMNS`(已中性化)/ `computeSessionRuns` / list-store。
 * legacy `HistoryList` 冻结不动(Z1 才删),本文件是其中性化孪生(双轨在迁移期是合理对照)。
 */
export function HistoryListShadcn({
  filters,
  columnVisibility: controlledVisibility,
  onColumnVisibilityChange,
  columnSizing,
  onColumnSizingChange,
  columnOrder,
  onColumnOrderChange,
  onClearFilters,
}: HistoryListShadcnProps) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const at = searchParams.get("at")
  const { entries, total, isLoading, isError, error, refetch, hasNextPage, fetchNextPage } = useHistoryInfinite(filters)
  const tailOn = useListStore((s) => s.tailOn)
  const dispatch = useListStore((s) => s.dispatch)
  const queryClient = useQueryClient()

  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const confirmClear = useCallback(async () => {
    setClearing(true)
    try {
      const qs = toQueryString(filters)
      const res = await api.delete<{ success: boolean; deleted?: number }>(`/history/api/entries${qs ? `?${qs}` : ""}`)
      if (res.deleted !== undefined) console.info(`[HistoryListShadcn] 已删除 ${res.deleted} 条历史`)
      await queryClient.invalidateQueries({ queryKey: ["history-infinite"] })
      setClearOpen(false)
    } catch (err) {
      // 删除失败不吞:曝光错误(内部工具可观测性优先),保持 Dialog 开着供重试。
      console.error("[HistoryListShadcn] 清空历史失败:", err)
    } finally {
      setClearing(false)
    }
  }, [filters, queryClient])

  const [internalVisibility, setInternalVisibility] = useState<VisibilityState>(DEFAULT_COLUMN_VISIBILITY)
  const columnVisibility = controlledVisibility ?? internalVisibility
  const setColumnVisibility = onColumnVisibilityChange ?? setInternalVisibility

  const table = useReactTable({
    data: entries,
    columns: REQUEST_COLUMNS,
    state: {
      columnVisibility,
      ...(columnSizing !== undefined ? { columnSizing } : {}),
      ...(columnOrder !== undefined ? { columnOrder } : {}),
    },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange,
    onColumnOrderChange,
    defaultColumn: { minSize: 40 },
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
  })
  const rows = table.getRowModel().rows

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
    if (!sid) return
    setSelectedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(sid)) next.delete(sid)
      else next.add(sid)
      return next
    })
  }, [])

  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const locateRef = useRef<{ at: string | null; pages: number; done: boolean }>({ at: null, pages: 0, done: false })

  const [flashId, setFlashId] = useState<string | null>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const scrollerRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    const id = focusRequestRef.current
    if (id === null) return
    focusRequestRef.current = null
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
    const raf = requestAnimationFrame(focusRow)
    return () => cancelAnimationFrame(raf)
  }, [focusedIndex])

  const [membership, setMembership] = useState<{ at: string; sig: string; member: boolean } | null>(null)
  const checkRef = useRef<{ at: string; sig: string } | null>(null)
  const filterSig = toQueryString({ ...filters, search: "" })
  const membershipCurrent = at !== null && membership?.at === at && membership.sig === filterSig ? membership : null
  const outOfFilter = membershipCurrent !== null && !membershipCurrent.member

  useEffect(() => {
    if (at) dispatch({ kind: "locate" })
  }, [at, dispatch])

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

    if (membershipCurrent === null) {
      if (checkRef.current?.at === at && checkRef.current.sig === filterSig) return
      const sig = filterSig
      checkRef.current = { at, sig }
      void api
        .get<HistoryEntry>(`/history/api/entries/${at}`)
        .then((entry) => {
          if (checkRef.current?.at === at && checkRef.current.sig === sig) {
            setMembership({ at, sig, member: matchesGating(entryToGatingSummary(entry), filters) })
            checkRef.current = null
          }
        })
        .catch((err: unknown) => {
          if (checkRef.current?.at === at && checkRef.current.sig === sig) {
            console.error(`[HistoryListShadcn] 归属判定查询失败 at=${at}:`, err)
            setMembership({ at, sig, member: true })
            checkRef.current = null
          }
        })
      return
    }
    if (!membershipCurrent.member) return

    if (hasNextPage && locateRef.current.pages < LOCATE_PAGE_CAP) {
      locateRef.current.pages += 1
      void fetchNextPage()
    }
  }, [at, entries, hasNextPage, fetchNextPage, filters, filterSig, membershipCurrent, flashRow])

  const selectRow = useCallback(
    (rowId: string) => {
      dispatch({ kind: "locate" })
      void navigate(`/requests/${rowId}`)
    },
    [dispatch, navigate],
  )
  const rowContext = useMemo<RowContext>(() => {
    const focused = focusedIndex >= 0 && focusedIndex < rows.length ? rows[focusedIndex] : undefined
    const focusedId = focused ? focused.original.id : null
    const firstId = rows.length > 0 ? rows[0].original.id : null
    const tabStopId = focusedId ?? firstId
    return { at, flashId, focusedId, tabStopId, onSelect: selectRow, runs, selectedSessions, onToggleSession }
  }, [at, flashId, focusedIndex, rows, selectRow, runs, selectedSessions, onToggleSession])

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
          virtuosoRef.current?.scrollToIndex({ index: next, align: "end" })
          break
        }
        case "ArrowUp": {
          e.preventDefault()
          const next = focusedIndex < 0 ? 0 : Math.max(focusedIndex - 1, 0)
          setFocusedIndex(next)
          focusRequestRef.current = rows[next]?.original.id ?? null
          virtuosoRef.current?.scrollToIndex({ index: next, align: "start" })
          break
        }
        case "Escape": {
          focusRequestRef.current = null
          setFocusedIndex(-1)
          if (e.target instanceof HTMLElement) e.target.blur()
          setSelectedSessions(new Set())
          break
        }
        case "f": {
          e.preventDefault()
          const row = focusedIndex >= 0 && focusedIndex < rows.length ? rows[focusedIndex] : undefined
          if (row) onToggleSession(row.original.sessionId)
          break
        }
        default: {
          break
        }
      }
    },
    [rows, focusedIndex, onToggleSession],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mono flex items-center gap-2 border-b border-border px-2 py-1 text-[12px] uppercase tracking-wider text-muted-foreground">
        <span>History · {total} total</span>
        <SessionPaletteSelectShadcn
          value={paletteName}
          onChange={setPalette}
        />
        <button
          type="button"
          className="ml-auto text-primary"
          onClick={() => setClearOpen(true)}
        >
          清空
        </button>
      </div>
      {outOfFilter && (
        <div className="mono flex items-center justify-center gap-2 border-b border-border bg-muted py-1 text-center text-[13px] text-foreground">
          <span>该条目不在当前筛选内</span>
          <span className="text-muted-foreground">·</span>
          <button
            type="button"
            className="text-primary underline-offset-2 hover:underline"
            onClick={() => onClearFilters?.()}
          >
            清除筛选并定位
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {isError && (
          <div className="mono flex flex-col items-center gap-2 p-4 text-center text-[13px] text-destructive">
            <span>⚠ 加载失败</span>
            <span className="text-destructive/80">{String(error)}</span>
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => void refetch()}
            >
              重试
            </button>
          </div>
        )}
        {!isError && isLoading && <div className="mono p-2 text-muted-foreground">loading…</div>}
        {!isError && !isLoading && (
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
              initialItemCount={Math.min(rows.length, INITIAL_ITEM_COUNT)}
              components={TABLE_COMPONENTS}
              endReached={() => {
                if (hasNextPage) void fetchNextPage()
              }}
              atTopStateChange={(atTop) => {
                if (!atTop && tailOn) dispatch({ kind: "scroll-up" })
              }}
              fixedHeaderContent={() =>
                table.getHeaderGroups().map((hg) => {
                  const sortableIds = hg.headers.filter((h) => h.column.id !== "session").map((h) => h.column.id)
                  return (
                    <tr
                      key={hg.id}
                      className="mono border-b border-border bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground"
                    >
                      <SortableContext
                        items={sortableIds}
                        strategy={horizontalListSortingStrategy}
                      >
                        {hg.headers.map((header) => {
                          if (header.column.id === "session") {
                            return (
                              <th
                                key={header.id}
                                className="p-0 w-[10px] text-left font-normal"
                              />
                            )
                          }
                          return (
                            <SortableHeaderCell
                              key={header.id}
                              header={header}
                            />
                          )
                        })}
                      </SortableContext>
                    </tr>
                  )
                })
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
                  const indented = cell.column.id === "status" && context.runs.get(row.original.id)?.indent
                  const padX = indented ? "pr-2 pl-3" : "px-2"
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
            {entries.length === 0 && (
              <div className="mono absolute inset-x-0 top-10 flex flex-col items-center gap-2 p-4 text-center text-[13px] text-muted-foreground">
                <span>无匹配请求</span>
                {hasAnyFilter(filters) && (
                  <button
                    type="button"
                    className="text-primary underline-offset-2 hover:underline"
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
      <Dialog
        open={clearOpen}
        onOpenChange={setClearOpen}
      >
        <DialogContent className="mono max-w-sm">
          <DialogHeader>
            <DialogTitle>清空历史</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 text-[13px] text-foreground">
            <p>{hasAnyFilter(filters) ? `删除当前筛选命中的 ${total} 条？` : `清空全部 ${total} 条？`}</p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setClearOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={clearing}
                onClick={() => void confirmClear()}
              >
                确认
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
