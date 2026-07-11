import {
  //
  useMemo,
  useState,
} from "react"

import { RawJsonView } from "@/components/common/RawJsonView"
import { Button } from "@/components/ui/button"
import {
  //
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  //
  parseJson,
  unescapeJsonString,
} from "@/lib/json-tools"
import { cn } from "@/lib/utils"

/** 中性 token 描边的多行编辑区,皮肤同 `Input` primitive(与 ConfigShadcn textarea 一致)。 */
const TEXTAREA = cn(
  "min-h-[96px] flex-1 resize-none rounded-md border border-input bg-input/30 p-2 font-mono text-xs text-foreground",
  "outline-none transition-colors placeholder:text-muted-foreground",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
)

/**
 * fork B · JSON decode 工具页元素(shadcn 页壳,P8 完整版)。
 *
 * 与 legacy(`JsonToolsLegacy`)共用 **A 层纯逻辑** `unescapeJsonString`/`parseJson`(`lib/json-tools`,
 * 两树共用,不复制算法)+ **B 内容体** `RawJsonView`(`common/`,已 C3 中性化;内部即 `JsonTreeView`
 * 树视图 + 原文/树 tab,逐字复用——legacy 树面板正是渲染它)。本组件只负责呈现层:
 *  - 两个共享状态的独立文本工具(上工具输出可 "→ 传入 Tree" 交给下工具),同 legacy 交互语义。
 *  - 页壳用 shadcn `Card` + `Button` + 中性语义 token(`text-foreground`/`bg-card`/`border-input`/
 *    `--signal-fail`/`--signal-ok`),圆角随 `--radius`;绝不回流 amber 命名空间。
 *  - 三个 textarea 带 `aria-label` 可访问名(jsx-a11y);树面板带 `data-testid` 便于定位。
 * `data-testid=json-tools-shadcn` 供 fork B 互斥挂载守卫。
 */
export function JsonToolsShadcn() {
  const [escInput, setEscInput] = useState("")
  const [treeInput, setTreeInput] = useState("")

  const escResult = useMemo(() => unescapeJsonString(escInput), [escInput])
  const treeResult = useMemo(() => parseJson(treeInput), [treeInput])

  const escHasInput = escInput.trim() !== ""
  const treeHasInput = treeInput.trim() !== ""

  function renderTreePanel() {
    if (!treeHasInput) return <div className="p-1 text-xs text-muted-foreground">等待输入…</div>
    if (!treeResult.ok) return <div className="p-1 text-xs text-[var(--signal-fail)]">{treeResult.error}</div>
    // RawJsonView 自持 树/原文 toggle、per-view copy,并在 value 变更时(key={source})重挂树 —
    // 所以 "→ 传入 Tree" 交接会把折叠态复位到深度默认。
    return <RawJsonView value={treeResult.value} />
  }

  return (
    <div
      data-testid="json-tools-shadcn"
      className="flex h-full flex-col gap-2 p-2 text-foreground"
    >
      {/* ── Tool 1: unescape ─────────────────────────────────────────── */}
      <Card className="min-h-0 flex-1 gap-2 py-2">
        <CardHeader className="px-2">
          <CardTitle className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">unescape JSON in string</CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-2 px-2">
          <textarea
            aria-label="unescape 输入"
            className={TEXTAREA}
            value={escInput}
            onChange={(e) => setEscInput(e.target.value)}
            spellCheck={false}
            placeholder={String.raw`从请求里拷出的转义 JSON，如 {\"name\":\"foo\"}`}
          />
          <div className="flex items-center gap-2">
            <div className="text-[11px] tracking-wider text-muted-foreground uppercase">输出（单层解码）</div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="ml-auto"
              disabled={!escResult.ok}
              onClick={() => {
                if (escResult.ok) {
                  setTreeInput(escResult.value)
                }
              }}
            >
              → 传入 Tree
            </Button>
          </div>
          {escHasInput && !escResult.ok ?
            <div className="rounded-md border border-input bg-input/30 p-2 text-xs text-[var(--signal-fail)]">{escResult.error}</div>
          : <textarea
              aria-label="unescape 输出"
              className={cn(TEXTAREA, "text-[var(--signal-ok)]")}
              value={escResult.ok ? escResult.value : ""}
              readOnly
              spellCheck={false}
            />
          }
        </CardContent>
      </Card>

      {/* ── Tool 2: JSON tree ────────────────────────────────────────── */}
      <Card className="min-h-0 flex-1 gap-2 py-2">
        <CardHeader className="px-2">
          <CardTitle className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">JSON tree</CardTitle>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-2 px-2">
          <textarea
            aria-label="JSON tree 输入"
            className={TEXTAREA}
            value={treeInput}
            onChange={(e) => setTreeInput(e.target.value)}
            spellCheck={false}
            placeholder={'粘贴 JSON，如 {"a":[1,2],"b":null}'}
          />
          <div
            data-testid="json-tools-tree-panel"
            className="flex min-h-0 flex-1 flex-col overflow-auto rounded-md border border-input bg-input/30 p-1"
          >
            {renderTreePanel()}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
