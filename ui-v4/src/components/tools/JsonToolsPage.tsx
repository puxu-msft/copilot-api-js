import {
  //
  useMemo,
  useState,
} from "react"

import { CodeBlock } from "@/components/detail/CodeBlock"
import { JsonTreeView } from "@/components/tools/JsonTreeView"
import {
  //
  parseJson,
  unescapeJsonString,
} from "@/lib/json-tools"

type TreeMode = "tree" | "source"

const SECTION = "flex min-h-0 flex-1 flex-col gap-2 border border-[var(--color-border)] bg-[#111014] p-2"
const LABEL = "text-[11px] uppercase tracking-wider text-[var(--color-muted)]"
const TEXTAREA = "min-h-[96px] flex-1 resize-none border border-[var(--color-border)] bg-[#0f0f12] p-2 text-[12px] text-[#cdb]"
const BTN = "border border-[var(--color-primary)] px-2 py-0.5 text-[11px] text-[var(--color-primary)] disabled:opacity-40"

/**
 * "JSON decode" tools page — two independent text tools that share this page's
 * state so the top tool can hand its output to the bottom one:
 *
 * 1. Unescape JSON in string: single-level unescape of an escaped JSON string
 *    (e.g. `tool_call` arguments copied out of a request).
 * 2. JSON tree: parse pasted JSON and view it as a collapsible tree or as
 *    pretty-printed, syntax-highlighted source.
 */
export function JsonToolsPage() {
  const [escInput, setEscInput] = useState("")
  const [treeInput, setTreeInput] = useState("")
  const [treeMode, setTreeMode] = useState<TreeMode>("tree")

  const escResult = useMemo(() => unescapeJsonString(escInput), [escInput])
  const treeResult = useMemo(() => parseJson(treeInput), [treeInput])
  const treeSource = useMemo(() => (treeResult.ok ? JSON.stringify(treeResult.value, null, 2) : ""), [treeResult])

  const escHasInput = escInput.trim() !== ""
  const treeHasInput = treeInput.trim() !== ""

  function renderTreePanel() {
    if (!treeHasInput) return <div className="p-1 text-[12px] text-[var(--color-muted)]">等待输入…</div>
    if (!treeResult.ok) return <div className="p-1 text-[12px] text-[var(--color-fail)]">{treeResult.error}</div>
    if (treeMode === "tree") {
      return (
        <div className="p-1">
          {/* Remount on a new parsed value so per-node collapse state resets to
              its depth default (e.g. after the "→ 传入 Tree" handoff). */}
          <JsonTreeView
            key={treeSource}
            value={treeResult.value}
          />
        </div>
      )
    }
    return (
      <CodeBlock
        code={treeSource}
        lang="json"
      />
    )
  }

  return (
    <div className="mono flex h-full flex-col gap-2 p-2 text-[13px]">
      {/* ── Tool 1: unescape ─────────────────────────────────────────── */}
      <section className={SECTION}>
        <div className={LABEL}>unescape JSON in string</div>
        <textarea
          className={TEXTAREA}
          value={escInput}
          onChange={(e) => setEscInput(e.target.value)}
          spellCheck={false}
          placeholder={String.raw`从请求里拷出的转义 JSON，如 {\"name\":\"foo\"}`}
        />
        <div className="flex items-center gap-2">
          <div className={LABEL}>输出（单层解码）</div>
          <button
            type="button"
            className={`${BTN} ml-auto`}
            disabled={!escResult.ok}
            onClick={() => {
              if (escResult.ok) {
                setTreeInput(escResult.value)
                setTreeMode("tree")
              }
            }}
          >
            → 传入 Tree
          </button>
        </div>
        {escHasInput && !escResult.ok ?
          <div className="border border-[var(--color-border)] bg-[#0f0f12] p-2 text-[12px] text-[var(--color-fail)]">{escResult.error}</div>
        : <textarea
            className={`${TEXTAREA} text-[var(--color-ok)]`}
            value={escResult.ok ? escResult.value : ""}
            readOnly
            spellCheck={false}
          />
        }
      </section>

      {/* ── Tool 2: JSON tree ────────────────────────────────────────── */}
      <section className={SECTION}>
        <div className={LABEL}>JSON tree</div>
        <textarea
          className={TEXTAREA}
          value={treeInput}
          onChange={(e) => setTreeInput(e.target.value)}
          spellCheck={false}
          placeholder={'粘贴 JSON，如 {"a":[1,2],"b":null}'}
        />
        <div className="flex border-b border-[var(--color-border)]">
          {(["tree", "source"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`-mb-px border-b-2 px-3 py-1 text-[11px] ${
                treeMode === m ?
                  "border-[var(--color-primary)] text-[var(--color-primary)]"
                : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]"
              }`}
              onClick={() => setTreeMode(m)}
            >
              {m === "tree" ? "树" : "原文"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto border border-[var(--color-border)] border-t-0 bg-[#0f0f12] p-1">{renderTreePanel()}</div>
      </section>
    </div>
  )
}
