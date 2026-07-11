import {
  //
  useEffect,
  useState,
} from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  //
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useConfigYaml } from "@/hooks/useConfigYaml"
import { cn } from "@/lib/utils"

const EDITOR_ID = "config-yaml-editor"

/**
 * fork B · Config 页元素(shadcn 页壳,P6 完整版)。
 *
 * 与 legacy(`ConfigLegacy`)读**同一数据源**(`useConfigYaml`,A 数据 hook,两树共用),
 * 编辑 / 解析 / 保存逻辑同构(JSON 序列化编辑 → parse → `save.mutate`),仅呈现层不同:
 *  - 页壳用 shadcn `Card` + `Button` + 中性语义 token(`text-foreground`/`bg-card`/`border-input`),
 *    圆角随 `--radius`。
 *  - 保存态反馈用中性信号色(`--signal-fail`/`--signal-ok`)——解析错误 / 保存失败 / 已保存。
 *  - 编辑器是原生 `<textarea>`(JSON 多行编辑本质),用 `<label htmlFor>` 关联可访问名(jsx-a11y),
 *    neutral token 描边同 `Input` primitive 皮肤。
 * `data-testid=config-shadcn` 供 fork B 互斥挂载守卫(loading 态亦保留,便于守卫恒可定位)。
 */
export function ConfigShadcn() {
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

  return (
    <div
      data-testid="config-shadcn"
      className="flex h-full flex-col p-1 text-foreground"
    >
      {query.isLoading ?
        <div className="p-4 text-sm text-muted-foreground">loading…</div>
      : <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="flex-row items-center gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle>Config (JSON)</CardTitle>
              <CardDescription>
                后端配置的 JSON 视图,编辑后保存写回 <span className="font-mono">/api/config/yaml</span>。
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={onSave}
              disabled={save.isPending}
            >
              {save.isPending ? "saving…" : "save"}
            </Button>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex min-h-5 flex-wrap items-center gap-2">
              {parseError ?
                <Badge
                  variant="destructive"
                  className="max-w-full"
                >
                  <span className="truncate">解析错误：{parseError}</span>
                </Badge>
              : null}
              {save.isError ?
                <Badge
                  variant="destructive"
                  className="max-w-full"
                >
                  <span className="truncate">保存失败：{save.error instanceof Error ? save.error.message : ""}</span>
                </Badge>
              : null}
              {save.isSuccess ?
                <Badge
                  variant="outline"
                  className="border-[var(--signal-ok)] text-[var(--signal-ok)]"
                >
                  已保存
                </Badge>
              : null}
            </div>
            <label
              htmlFor={EDITOR_ID}
              className="text-[11px] tracking-wider text-muted-foreground uppercase"
            >
              Config document
            </label>
            <textarea
              id={EDITOR_ID}
              className={cn(
                "min-h-0 flex-1 resize-none rounded-lg border border-input bg-input/30 p-2 font-mono text-xs text-foreground",
                "outline-none transition-colors placeholder:text-muted-foreground",
                "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              )}
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
            />
          </CardContent>
        </Card>
      }
    </div>
  )
}
