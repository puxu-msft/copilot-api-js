import { SessionsLegacy } from "@/components/sessions/SessionsLegacy"
import { SessionsShadcn } from "@/components/sessions/SessionsShadcn"
import { DesignFork } from "@/components/shell/DesignFork"

/**
 * fork B · Sessions 列表 RoutePage。经 `DesignFork` 原语按设计版本(design version)互斥挂载
 * legacy(`SessionsLegacy`,Terminal Amber,冻结)/ shadcn(`SessionsShadcn`,重设计)页元素。
 * 本文件不含 store 字段标识符(唯一读取者是 DesignFork)→ sessions/ 域 grep 守卫零命中。
 */
export function SessionsPage() {
  return (
    <DesignFork
      legacy={<SessionsLegacy />}
      shadcn={<SessionsShadcn />}
    />
  )
}
