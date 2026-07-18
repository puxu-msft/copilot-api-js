import {
  //
  expect,
  test,
} from "bun:test"

import { start } from "../../src/start"

test("start 命令声明 --restart 布尔 flag（默认 false）", () => {
  // `start.args` 的 citty 类型是 `Resolvable<T>`（含 `T | Promise<T> | (() => T)` 联合），
  // 但实际定义是字面量对象，不是 Promise/函数 —— 用类型断言剥掉这层不适用的联合分支。
  const args = start.args as unknown as Record<string, { type?: string; default?: unknown }>
  expect(args.restart).toMatchObject({ type: "boolean", default: false })
})
