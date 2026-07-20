import { DesignFork } from "@/components/shell/DesignFork"
import { JsonToolsLegacy } from "@/components/tools/JsonToolsLegacy"
import { JsonToolsShadcn } from "@/components/tools/JsonToolsShadcn"

/**
 * fork B · JSON decode 工具 RoutePage。经 `DesignFork` 原语按设计版本(design version)互斥挂载
 * legacy(`JsonToolsLegacy`,Terminal Amber,冻结)/ shadcn(`JsonToolsShadcn`,重设计)页元素。
 * 本文件不含 store 字段标识符(唯一读取者是 DesignFork)→ tools/ 域 grep 守卫零命中。
 */
export function JsonToolsPage() {
  return (
    <DesignFork
      legacy={<JsonToolsLegacy />}
      shadcn={<JsonToolsShadcn />}
    />
  )
}
