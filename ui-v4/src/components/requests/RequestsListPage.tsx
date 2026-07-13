import { DesignFork } from "@/components/shell/DesignFork"

import { RequestsListLegacy } from "./RequestsListLegacy"
import { RequestsListShadcn } from "./RequestsListShadcn"

/**
 * fork B · Requests 列表 RoutePage。经 `DesignFork` 原语按设计版本(design version)互斥挂载
 * legacy(`RequestsListLegacy`,Terminal Amber,冻结)/ shadcn(`RequestsListShadcn`,重设计)页元素。
 * 本文件不含 store 字段标识符(唯一读取者是 DesignFork)→ requests/ 域 grep 守卫零命中。
 */
export function RequestsListPage() {
  return (
    <DesignFork
      legacy={<RequestsListLegacy />}
      shadcn={<RequestsListShadcn />}
    />
  )
}
