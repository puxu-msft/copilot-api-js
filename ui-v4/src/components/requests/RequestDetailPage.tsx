import { DesignFork } from "@/components/shell/DesignFork"

import { RequestDetailLegacy } from "./RequestDetailLegacy"
import { RequestDetailShadcn } from "./RequestDetailShadcn"

/**
 * fork B · Requests 详情全屏页 RoutePage。经 `DesignFork` 原语按设计版本(design version)互斥挂载
 * legacy(`RequestDetailLegacy`,Terminal Amber,竖排 sub-rail,冻结)/ shadcn(`RequestDetailShadcn`,
 * 水平 Tabs 重设计)页元素。本文件不含 store 字段标识符(唯一读取者是 DesignFork)→ requests/ 域 grep 守卫零命中。
 */
export function RequestDetailPage() {
  return (
    <DesignFork
      legacy={<RequestDetailLegacy />}
      shadcn={<RequestDetailShadcn />}
    />
  )
}
