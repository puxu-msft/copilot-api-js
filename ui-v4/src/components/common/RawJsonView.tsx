import {
  //
  useMemo,
  useState,
} from "react"

import { CodeBlock } from "@/components/detail/CodeBlock"
import { JsonTreeView } from "@/components/tools/JsonTreeView"

type Mode = "tree" | "source"

/**
 * 全站共享的 raw JSON 双视图:一个「原文 / 树」tab 切换,复用增强版
 * `CodeBlock`(source,带 toolbar:copy / wrap / 行级搜索)与 `JsonTreeView`
 * (tree,带 toolbar:expand-all / collapse-all / 搜索)。
 *
 * 视图态是 per-instance 的本地 ephemeral state(`useState`),默认 `"source"`——
 * 刻意不写 localStorage / 全局偏好键:不同挂载点各自独立,切换互不影响。
 *
 * 语义上只接**结构化 JSON**(object / array)。它不特判非 JSON 字符串——迁移各面
 * (Tasks 4-7)自行决定用 RawJsonView(结构化)还是保留 `<pre>`(非 JSON)。
 *
 * 树视图用 `key={source}` 挂载:value 变更(序列化串变)时整棵树重挂载,折叠态回到
 * 深度默认,而不是残留上一个 value 的手动展开/折叠状态。
 */
export function RawJsonView({ value, defaultMode = "source", label, className }: { value: unknown; defaultMode?: Mode; label?: string; className?: string }) {
  const [mode, setMode] = useState<Mode>(defaultMode)
  const source = useMemo(() => JSON.stringify(value, null, 2), [value])

  return (
    <div className={`mono flex min-h-0 flex-1 flex-col ${className ?? ""}`}>
      <div className="flex items-center gap-2 border-b border-[var(--color-border)]">
        {label ?
          <span className="px-2 text-[11px] uppercase text-[var(--color-muted)]">{label}</span>
        : null}
        {(["source", "tree"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            type="button"
            className={`-mb-px border-b-2 px-3 py-1 text-[11px] ${
              mode === m ?
                "border-[var(--color-primary)] text-[var(--color-primary)]"
              : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
            onClick={() => setMode(m)}
          >
            {m === "source" ? "原文" : "树"}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "source" ?
          <CodeBlock
            code={source}
            toolbar
          />
        : <JsonTreeView
            key={source}
            value={value}
            toolbar
          />
        }
      </div>
    </div>
  )
}
