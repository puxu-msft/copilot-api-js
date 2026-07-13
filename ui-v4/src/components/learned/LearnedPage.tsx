import { LearnedLegacy } from "@/components/learned/LearnedLegacy"
import { LearnedShadcn } from "@/components/learned/LearnedShadcn"
import { DesignFork } from "@/components/shell/DesignFork"

/**
 * fork B · Learned RoutePage。经 `DesignFork` 原语按设计版本(design version)互斥挂载
 * legacy(`LearnedLegacy`,Terminal Amber,冻结)/ shadcn(`LearnedShadcn`,重设计)页元素。
 * 本文件不含 store 字段标识符(唯一读取者是 DesignFork)→ learned/ 域 grep 守卫零命中。
 */
export function LearnedPage() {
  return (
    <DesignFork
      legacy={<LearnedLegacy />}
      shadcn={<LearnedShadcn />}
    />
  )
}
