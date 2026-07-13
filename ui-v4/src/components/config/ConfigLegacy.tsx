import {
  //
  useEffect,
  useState,
} from "react"

import { useConfigYaml } from "@/hooks/useConfigYaml"

/**
 * fork B · Config 页元素(legacy,Terminal Amber,P6 前逐字冻结)。
 * 原 `ConfigPage` body 逐字搬来,Z1 收尾才删。共用 A 数据 hook `useConfigYaml`(两树共用)。
 */
export function ConfigLegacy() {
  const { query, save } = useConfigYaml()
  const [text, setText] = useState("")
  const [parseError, setParseError] = useState<string | null>(null)
  useEffect(() => {
    if (query.data) setText(JSON.stringify(query.data, null, 2))
  }, [query.data])

  function onSave() {
    setParseError(null)
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      save.mutate(parsed)
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "parse error")
    }
  }

  if (query.isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  return (
    <div className="mono flex h-full flex-col gap-2 p-2 text-[13px]">
      <div className="flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">config (JSON)</div>
        <button
          type="button"
          className="ml-auto border border-[var(--color-primary)] px-3 py-0.5 text-[12px] text-[var(--color-primary)] disabled:opacity-50"
          onClick={onSave}
          disabled={save.isPending}
        >
          {save.isPending ? "saving…" : "save"}
        </button>
      </div>
      {parseError ?
        <div className="text-[12px] text-[var(--color-fail)]">解析错误：{parseError}</div>
      : null}
      {save.isError ?
        <div className="text-[12px] text-[var(--color-fail)]">保存失败：{save.error instanceof Error ? save.error.message : ""}</div>
      : null}
      {save.isSuccess ?
        <div className="text-[12px] text-[var(--color-ok)]">已保存</div>
      : null}
      <textarea
        className="min-h-0 flex-1 resize-none border border-[var(--color-border)] bg-[#0f0f12] p-2 text-[12px] text-[#cdb]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
    </div>
  )
}
