// PoC gate — TableVirtuoso(react-virtuoso) + @tanstack/react-table(flexRender) + jsdom vitest。
// 目的：进 Phase 3 全量重写 HistoryList 前,实测三库组合在 jsdom 下能真跑绿,并留下确切的
// 尺寸/ResizeObserver stub 方案供 Task 3.2 正式测试复用。不接生产路由,仅取证。
//
// jsdom 核心坑:Virtuoso 靠 layout(元素尺寸)+ ResizeObserver 决定渲染多少行;jsdom 无 layout、
// 不实现 ResizeObserver → 默认渲染 0 行。实测有效 stub(见文件尾 + exp/CONCLUSION.md):
// global ResizeObserver stub(tests/setup.ts 已有)+ TableVirtuoso `initialItemCount` prop。

import {
  //
  getCoreRowModel,
  useReactTable,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table"
import {
  //
  render,
  screen,
} from "@testing-library/react"
import {
  //
  forwardRef,
  useRef,
} from "react"
import {
  //
  TableVirtuoso,
  type VirtuosoHandle,
} from "react-virtuoso"
import {
  //
  expect,
  test,
} from "vitest"

// ---- 最小行模型(2-3 列) ----
interface Row {
  id: string
  model: string
  status: string
}

const COLUMNS: Array<ColumnDef<Row>> = [
  { id: "id", header: "ID", accessorFn: (r) => r.id, cell: (ctx) => ctx.getValue<string>() },
  { id: "model", header: "Model", accessorFn: (r) => r.model, cell: (ctx) => ctx.getValue<string>() },
  { id: "status", header: "Status", accessorFn: (r) => r.status, cell: (ctx) => ctx.getValue<string>() },
]

function makeRows(n: number): Array<Row> {
  return Array.from({ length: n }, (_, i) => ({
    id: `req-${i}`,
    model: i % 2 === 0 ? "gpt-4o" : "claude-sonnet",
    status: i % 3 === 0 ? "error" : "ok",
  }))
}

// ---- PoC 组件:TanStack headless 行模型 → TableVirtuoso 虚拟渲染 ----
// forwardRef 暴露 VirtuosoHandle,供测试调 scrollToIndex。
const PocTable = forwardRef<VirtuosoHandle, { data: Array<Row> }>(function PocTable({ data }, ref) {
  const table = useReactTable({ data, columns: COLUMNS, getCoreRowModel: getCoreRowModel() })
  const rows = table.getRowModel().rows
  return (
    <div style={{ height: 800 }}>
      <TableVirtuoso
        ref={ref}
        style={{ height: 800 }}
        data={rows}
        // initialItemCount:jsdom 下无 layout,强制首屏渲染 N 行(react-virtuoso 文档的测试建议)。
        initialItemCount={Math.min(data.length, 20)}
        components={{
          Table: ({ style, ...props }) => (
            <table
              {...props}
              style={{ ...style, width: "100%", tableLayout: "fixed" }}
            />
          ),
          TableRow: (props) => (
            <tr
              data-testid="poc-row"
              {...props}
            />
          ),
        }}
        fixedHeaderContent={() =>
          table.getHeaderGroups().map((hg) => (
            <tr
              key={hg.id}
              data-testid="poc-header"
              style={{ position: "sticky", top: 0 }}
            >
              {hg.headers.map((header) => (
                <th key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>
              ))}
            </tr>
          ))
        }
        itemContent={(_index, row) => row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
      />
    </div>
  )
})

// ---- jsdom stub:载荷分析(实测) ----
// 实测结论(见 exp/requests-virtuoso-poc/CONCLUSION.md):react-virtuoso@4.18.10 下,
// 真正载荷的组合是 ①global ResizeObserver stub(已在 tests/setup.ts,不 stub 则 Virtuoso 构造即 throw)
// + ②TableVirtuoso 的 `initialItemCount` prop(jsdom 无 layout,靠它强制首屏渲染 N 行)。
// 尺寸 stub(offsetHeight=800 / getBoundingClientRect)单独加**不足以**让它渲染出行(实测 0 行),
// 故此处不需要;仅在未来遇到依赖真实测量的断言时作为可选后备。

test("TableVirtuoso + TanStack 在 jsdom 下渲染 ≥1 行 + sticky header 存在", () => {
  render(<PocTable data={makeRows(50)} />)
  // 断言:至少渲染出 1 行数据(jsdom 无 layout 时 0 行是失败模式)。
  const dataRows = screen.getAllByTestId("poc-row")
  expect(dataRows.length).toBeGreaterThanOrEqual(1)
  // 断言:accessorFn/flexRender 真跑通,单元格内容出现。
  expect(screen.getAllByText("gpt-4o").length).toBeGreaterThanOrEqual(1)
  // 断言:fixedHeader(sticky)存在,且是真 sticky。
  const header = screen.getByTestId("poc-header")
  expect(header).toBeTruthy()
  expect(header.style.position).toBe("sticky")
  // 断言:表头单元格来自 TanStack headerGroups。
  expect(screen.getByText("Model")).toBeTruthy()
})

test("scrollToIndex 不抛(VirtuosoHandle imperative API 可达)", () => {
  function Harness() {
    const ref = useRef<VirtuosoHandle>(null)
    return (
      <>
        <button
          type="button"
          data-testid="scroll-btn"
          onClick={() => ref.current?.scrollToIndex({ index: 10, align: "center" })}
        >
          scroll
        </button>
        <PocTable
          ref={ref}
          data={makeRows(50)}
        />
      </>
    )
  }
  render(<Harness />)
  const btn = screen.getByTestId("scroll-btn")
  // 直接调 scrollToIndex 不应 throw(即使 jsdom 无实际滚动)。
  expect(() => btn.click()).not.toThrow()
})
