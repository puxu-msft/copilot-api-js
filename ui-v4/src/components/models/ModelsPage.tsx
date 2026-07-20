import { ModelsLegacy } from "@/components/models/ModelsLegacy"
import { ModelsShadcn } from "@/components/models/ModelsShadcn"
import { DesignFork } from "@/components/shell/DesignFork"

/**
 * fork B · Models 全屏页 RoutePage。经 `DesignFork` 原语按设计版本(design version)互斥挂载
 * legacy(`ModelsLegacy`,Terminal Amber,竖排 ModelDetailSubRail 抽屉,冻结)/ shadcn(`ModelsShadcn`,
 * 详情抽屉 + 水平 Tabs 重设计)页元素。本文件不含 store 字段标识符(唯一读取者是 DesignFork)→
 * models/ 域 grep 守卫零命中。
 */
export function ModelsPage() {
  return (
    <DesignFork
      legacy={<ModelsLegacy />}
      shadcn={<ModelsShadcn />}
    />
  )
}
