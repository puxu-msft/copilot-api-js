import { SessionDetailLegacy } from "@/components/sessions/SessionDetailLegacy"
import { SessionDetailShadcn } from "@/components/sessions/SessionDetailShadcn"
import { DesignFork } from "@/components/shell/DesignFork"

/**
 * fork B · Session 详情 RoutePage。经 `DesignFork` 原语按设计版本(design version)互斥挂载
 * legacy(`SessionDetailLegacy`,Terminal Amber,冻结)/ shadcn(`SessionDetailShadcn`,重设计)页元素。
 * 本文件不含 store 字段标识符(唯一读取者是 DesignFork)→ sessions/ 域 grep 守卫零命中。
 */
export function SessionDetailPage() {
  return (
    <DesignFork
      legacy={<SessionDetailLegacy />}
      shadcn={<SessionDetailShadcn />}
    />
  )
}
