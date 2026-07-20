import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

/**
 * C6 守卫 ① · 结构隔离(INV-FIDELITY-1,round2-A1「结构强制 > 纪律」)。
 *
 * 持 `useWs`/`useLiveRequests` 的 AppShell L0 组件体**源码里零 `designVersion` 引用**——
 * 切换 designVersion 绝无可能触发 L0 重渲染 / 重挂 WS 订阅、丢一次性 connected 快照。
 * 三 fork 点的 designVersion 读取全部下沉:唯一读取者是 `DesignFork` 原语,其余(chrome / dock /
 * 页壳)只 render `<DesignFork/>`、不含 `designVersion` 标识符。这样连 B/A′ 域的页壳文件都天然
 * 不出现 `designVersion`(grep 守卫零命中)、L0 也天然隔离。
 *
 * 策略(verifying-authoritative-claims,正样本证检查触达):
 * - 正控:先断言 `DesignFork.tsx` 确实读 `designVersion`(否则这条守卫是空的 —— 没有 fork 点也会「通过」)。
 * - 否控:断言 `AppShell.tsx`(L0 本体)源码零 `designVersion`。
 * - useWs deps 保持为空(行为回归见 DesignVersionForks.vitest.test.tsx)。
 */

const shellDir = resolve(import.meta.dirname, "../src/components/shell")
const read = (rel: string): string => readFileSync(resolve(shellDir, rel), "utf8")

/**
 * 剥离注释后取**可执行代码**。不变量是「L0 代码里零 designVersion 引用」,而非「源文件里连注释都不许提」——
 * 隔离原理本就该在注释里讲清。剥 block/line 注释即可(源码守卫,不必处理字符串内 `//` 的极端情形)。
 */
const codeOnly = (src: string): string => src.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "")

describe("AppShell L0 结构隔离(designVersion 只在 DesignFork,不进 L0 本体)", () => {
  it("正控:DesignFork 原语确实读取 designVersion(fork 点存在)", () => {
    const src = codeOnly(read("DesignFork.tsx"))
    // 若 fork 原语不读 designVersion,下面的 L0 否控形同虚设 —— 先证 fork 点真的在。
    expect(src).toContain("designVersion")
  })

  it("否控:AppShell L0 本体可执行代码零 designVersion 引用(切换绝不重挂 L0)", () => {
    const src = codeOnly(read("AppShell.tsx"))
    // 大小写敏感:setDesignVersion(含大写 D)不算命中;这里断的是小写 designVersion 读取。
    expect(src).not.toContain("designVersion")
  })

  it("useWs effect deps 保持为空(L0 订阅不依赖任何随 designVersion 变的值)", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../src/hooks/useWs.ts"), "utf8")
    // deps=[] 是 INV-FIDELITY-1 的静态锚:即便 AppShell 误重渲染,effect 也不会重跑 acquire。
    expect(src).toMatch(/\}, \[\]\)/)
  })
})
