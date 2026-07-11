import { ConfigLegacy } from "@/components/config/ConfigLegacy"
import { ConfigShadcn } from "@/components/config/ConfigShadcn"
import { DesignFork } from "@/components/shell/DesignFork"

/**
 * fork B · Config RoutePage。经 `DesignFork` 原语按设计版本(design version)互斥挂载
 * legacy(`ConfigLegacy`,Terminal Amber,冻结)/ shadcn(`ConfigShadcn`,重设计)页元素。
 * 本文件不含 store 字段标识符(唯一读取者是 DesignFork)→ config/ 域 grep 守卫零命中。
 */
export function ConfigPage() {
  return (
    <DesignFork
      legacy={<ConfigLegacy />}
      shadcn={<ConfigShadcn />}
    />
  )
}
