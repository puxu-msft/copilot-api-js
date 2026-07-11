import {
  //
  useEffect,
  useState,
} from "react"

import { useConfigYaml } from "@/hooks/useConfigYaml"

/**
 * Config 编辑编排 hook(A 层,design-agnostic)。
 *
 * 抽出 legacy 与 shadcn 页元素**曾各持一份逐字副本**的有状态编辑编排——text↔query.data 同步、
 * JSON parse、`save.mutate`、parseError 处理——为单一共享 primitive(P5 `groupByAgent` 抽取范式的对等
 * 形状,采纳 P6 subagent review MAJOR)。shadcn 侧 `ConfigShadcn` 导入之只做呈现;legacy `ConfigLegacy`
 * 保留内联冻结副本到 Z1 删文件(单向抽取,不碰冻结体)。
 *
 * 语义与 legacy 同构:`query.data` 引用变化时 effect 用规范态覆盖本地 text(既有行为,保存后 refetch
 * 会重置为服务器值)。返回富上下文(`save` 全对象)交呈现层裁剪,不预先过滤。
 */
export function useConfigEditor() {
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

  return {
    //
    text,
    setText,
    parseError,
    onSave,
    isLoading: query.isLoading,
    save,
  }
}
