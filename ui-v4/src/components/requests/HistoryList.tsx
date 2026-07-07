import {
  //
  flexRender,
  getCoreRowModel,
  useReactTable,
  type OnChangeFn,
  type Row,
  type VisibilityState,
} from "@tanstack/react-table"
import {
  //
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import type { EntrySummary } from "@/types"

import { useHistoryInfinite } from "@/hooks/useHistoryInfinite"
import {
  //
  DEFAULT_COLUMN_VISIBILITY,
  REQUEST_COLUMNS,
} from "@/lib/request-columns"
import { useListStore } from "@/stores/list-store"

/** load-until-found 翻页上限:防止 `at` 指向不存在/已淘汰 id 时无限拉取(Task 3.3 会加归属判定)。 */
const LOCATE_PAGE_CAP = 20
/**
 * 首屏强制渲染的行数上限。jsdom(测试)无 layout,react-virtuoso 靠它决定首屏渲染多少行
 * (见 exp/requests-virtuoso-poc/CONCLUSION.md);生产环境首帧即可见前 N 行,随后交给虚拟化测量。
 */
const INITIAL_ITEM_COUNT = 20

/** TableVirtuoso 的行数据 = TanStack 行对象(`row.original` 即 EntrySummary)。 */
type HistoryRowModel = Row<EntrySummary>

/** 传给 Virtuoso 各子组件的上下文:定位真值(`at`)+ 行点击回调。用 context 而非闭包,组件得以稳定不重挂。 */
interface RowContext {
  at: string | null
  onSelect: (id: string) => void
}

const ROW_CLASS = "mono cursor-pointer border-b border-[#222] text-left text-[13px]"

function selectionClass(selected: boolean): string {
  return selected ? "border-l-2 border-l-[var(--color-primary)] bg-[#3a2f1a] text-[#f0d8a8]" : "text-[#aaa]"
}

// ── Virtuoso 子组件(模块级、稳定引用,避免 inline 定义导致每帧重挂)。动态数据经 `context` 注入。 ──

/** `<table>` 外壳:必须透传 Virtuoso 注入的 `style`(布局);table-fixed + 列宽(th/td meta.width)决定列宽。 */
const TableShell: NonNullable<TableComponents<HistoryRowModel, RowContext>["Table"]> = ({ style, ...props }) => (
  <table
    {...props}
    className="mono w-full table-fixed border-collapse"
    style={style}
  />
)

/** 每行 `<tr>`:`item` 即 TanStack 行,`context.at` 决定选中高亮,点击走 `context.onSelect`(单元格 td 由 itemContent 注入 children)。 */
const TableRow: NonNullable<TableComponents<HistoryRowModel, RowContext>["TableRow"]> = ({ item, context, ...props }) => {
  const selected = item.original.id === context.at
  return (
    <tr
      {...props}
      data-entry-id={item.original.id}
      onClick={() => context.onSelect(item.original.id)}
      className={`${ROW_CLASS} ${selectionClass(selected)}`}
    />
  )
}

const TABLE_COMPONENTS: TableComponents<HistoryRowModel, RowContext> = {
  Table: TableShell,
  TableRow,
}

interface HistoryListProps {
  filters: RequestFilters
  /** 列可见性(受控);缺省则组件自持内部 state(全显)。Task 3.4 由 RequestsListPage 提升 + localStorage 持久化。 */
  columnVisibility?: VisibilityState
  onColumnVisibilityChange?: OnChangeFn<VisibilityState>
}

/**
 * History —— TanStack Table 列模型 + react-virtuoso 虚拟渲染(spec §4.2)。
 * 保留 tail 跟随 / 缓冲横幅 / `?at=` 定位 / goLive;渲染层换为 `TableVirtuoso`,
 * `endReached` 触底加载旧页取代旧 onScroll 阈值翻页,离顶(`atTopStateChange`)暂停 tail。
 */
export function HistoryList({ filters, columnVisibility: controlledVisibility, onColumnVisibilityChange }: HistoryListProps) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const at = searchParams.get("at")
  const { entries, total, isLoading, hasNextPage, fetchNextPage } = useHistoryInfinite(filters)
  const bufferedIds = useListStore((s) => s.bufferedIds)
  const tailOn = useListStore((s) => s.tailOn)
  const dispatch = useListStore((s) => s.dispatch)

  // 列可见性:受控优先,否则内部 state。留好 Task 3.4 的受控接口(菜单 + localStorage 持久化)。
  const [internalVisibility, setInternalVisibility] = useState<VisibilityState>(DEFAULT_COLUMN_VISIBILITY)
  const columnVisibility = controlledVisibility ?? internalVisibility
  const setColumnVisibility = onColumnVisibilityChange ?? setInternalVisibility

  const table = useReactTable({
    data: entries,
    columns: REQUEST_COLUMNS,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
  })
  const rows = table.getRowModel().rows

  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // 每个 `at` 的定位进度:done 命中后不再重滚(WS invalidate 会换 entries 引用,否则抖动);
  // pages 记 load-until-found 已翻页数(上限保护)。at 变化时重置。
  const locateRef = useRef<{ at: string | null; pages: number; done: boolean }>({ at: null, pages: 0, done: false })

  // URL 带 `?at=` → 该条目为定位真值:落地时暂停 tail(避免新条目把定位行挤走)。
  // 只在 `at` 变化时触发(edge-triggered,deps 不含 tailOn):否则 resume 把 tailOn 转 true
  // 会立刻被本 effect 再次暂停,使 resume 在定位态下永久失效。显式 go-live 会清掉 `at`(见 goLive)。
  useEffect(() => {
    if (at) dispatch({ kind: "locate" })
  }, [at, dispatch])

  // 定位:`at` 在已加载集内 → scrollToIndex 居中;不在则逐页 load-until-found(上限保护)。
  // 依赖 entries:每次 fetchNextPage 揭示新页 → 重跑 → 再尝试命中。
  // TODO(Task 3.3):补 at×筛选归属判定(matchesGating)+ flash 高亮;本 task 先做最简 index 定位。
  useEffect(() => {
    if (!at) {
      locateRef.current = { at: null, pages: 0, done: false }
      return
    }
    if (locateRef.current.at !== at) locateRef.current = { at, pages: 0, done: false }
    if (locateRef.current.done) return

    const index = entries.findIndex((e) => e.id === at)
    if (index !== -1) {
      virtuosoRef.current?.scrollToIndex({ index, align: "center" })
      locateRef.current.done = true
      return
    }
    // 未在窗口内:翻下一页直到命中或耗尽(上限保护)。
    if (hasNextPage && locateRef.current.pages < LOCATE_PAGE_CAP) {
      locateRef.current.pages += 1
      void fetchNextPage()
    }
  }, [at, entries, hasNextPage, fetchNextPage])

  const selectRow = useCallback(
    (rowId: string) => {
      dispatch({ kind: "locate" }) // 暂停 tail;选中真值由目标 URL(/requests/:id)承载
      void navigate(`/requests/${rowId}`)
    },
    [dispatch, navigate],
  )
  const rowContext = useMemo<RowContext>(() => ({ at, onSelect: selectRow }), [at, selectRow])

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
      <div className="min-h-0 flex-1">
        {isLoading ?
          <div className="mono p-2 text-[#888]">loading…</div>
        : <TableVirtuoso<HistoryRowModel, RowContext>
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
                  {hg.headers.map((header) => (
                    <th
                      key={header.id}
                      className={`${header.column.columnDef.meta?.width ?? ""} px-2 py-1 text-left font-normal`}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))
            }
            itemContent={(_index, row) =>
              row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  className={`${cell.column.columnDef.meta?.width ?? ""} overflow-hidden px-2 py-1 align-middle`}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))
            }
          />
        }
      </div>
    </div>
  )
}
