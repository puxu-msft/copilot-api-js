# TDD 编码规范

> 目标：统一测试编写风格，确保所有开发者遵循一致的 TDD 工作流。

## 1. Red → Green → Refactor 工作流

### 1.1 流程

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│   RED    │ ──→ │  GREEN   │ ──→ │ REFACTOR │ ──→ 下一个 test
│ 写测试   │     │ 写最小   │     │ 清理代码  │
│ 确认失败 │     │ 实现让   │     │ 保持通过  │
│          │     │ 测试通过 │     │          │
└──────────┘     └──────────┘     └──────────┘
```

### 1.2 规则

1. **先写测试**：新特性和 bug 修复都从测试开始
2. **确认红色**：写完测试后运行，确认确实失败（避免写了不验证任何东西的测试）
3. **最小实现**：只写让测试通过的最少代码，不多写
4. **重构保绿**：重构时测试必须持续通过
5. **小步迭代**：每次只添加一个 `test()`，通过后再写下一个

### 1.3 Bug 修复的 TDD

```
1. 复现 bug → 写一个失败的测试精确描述 bug
2. 运行测试 → 确认红色
3. 修复 bug → 测试变绿
4. 检查回归 → 所有测试通过
```

这确保 bug 不会再次出现——回归测试永远在。

### 1.4 新特性的 TDD

```
1. 列出测试用例描述（先不写断言）
2. Review 用例完整性
3. 逐个实现：
   a. 写第一个 test() → RED
   b. 写实现 → GREEN
   c. 写第二个 test() → 可能 RED
   d. 扩展实现 → GREEN
   e. ...重复直到所有用例通过
4. Refactor
```

## 2. 测试文件结构

### 2.1 标准模板

```typescript
/**
 * [Unit/Component/...] tests for <module-name>.
 *
 * Covers:
 * - <功能点 1>
 * - <功能点 2>
 * - <边界条件>
 */

import { describe, expect, test } from "bun:test"

// 导入被测模块
import { targetFunction } from "~/lib/target-module"

// 导入 helpers（如需要）
import { mockAnthropicPayload } from "../helpers/factories"

// ============================================================================
// <Section 1>
// ============================================================================

describe("targetFunction", () => {
  // 正常路径
  describe("success path", () => {
    test("should handle basic input", () => {
      // Arrange
      const input = mockAnthropicPayload()

      // Act
      const result = targetFunction(input)

      // Assert
      expect(result.status).toBe("ok")
    })
  })

  // 边界条件
  describe("edge cases", () => {
    test("should handle empty input", () => { ... })
    test("should handle maximum size input", () => { ... })
  })

  // 错误路径
  describe("error handling", () => {
    test("should throw for invalid input", () => { ... })
  })
})
```

### 2.2 结构规范

- **文件顶部注释**：说明测试类型和覆盖范围
- **import 分组**：bun:test → 被测模块 → helpers
- **分隔线**：用 `// ====` 分隔逻辑块
- **describe 嵌套**：被测函数/类 → 路径类别（success/edge/error）
- **Arrange-Act-Assert**：每个 test 内清晰分三段

### 2.3 禁止事项

- 不在 `describe()` 外写 `test()`
- 不在 test 内调用另一个 test
- 不共享 test 间的可变状态（每个 test 独立 setup）
- 不在 test 中使用 `console.log`（调试完记得删）

## 3. 测试命名规范

### 3.1 describe 命名

```typescript
// 函数名
describe("classifyError", () => { ... })

// 类名
describe("AdaptiveRateLimiter", () => { ... })

// 功能区域
describe("Anthropic Orphan Filter", () => { ... })

// HTTP 路由
describe("POST /v1/messages", () => { ... })
```

### 3.2 test 命名

使用 **"should + 动词"** 句式，描述期望行为：

```typescript
// GOOD: 描述行为
test("should return rate_limited for 429 responses", () => { ... })
test("should remove orphaned tool_result blocks", () => { ... })
test("should retry once with refreshed token on 401", () => { ... })
test("should preserve matched server_tool_use / web_search_tool_result pair", () => { ... })

// BAD: 描述实现
test("calls classifyError then checks type", () => { ... })
test("sets isShuttingDown to true", () => { ... })

// BAD: 过于模糊
test("works correctly", () => { ... })
test("handles error", () => { ... })
```

### 3.3 错误路径命名

```typescript
// 明确说明触发条件和期望行为
test("should throw HTTPError for non-JSON response body", () => { ... })
test("should fall back to empty object for invalid JSON in tool_use.input", () => { ... })
test("should return 503 during shutdown", () => { ... })
```

## 4. 现有测试反模式 & 修正

### 4.1 反模式：弱断言

```typescript
// BAD
expect(response).toBeDefined()
expect(response.id).toBeDefined()

// GOOD
expect(response.id).toMatch(/^msg_/)
expect(response.model).toBe("claude-sonnet-4")
```

### 4.2 反模式：try/catch 不保证 throw

```typescript
// BAD: 如果不 throw，测试也通过
try {
  await operation()
} catch (error) {
  expect(error).toBeDefined()
}

// GOOD: 必须 throw 才通过
await expect(operation()).rejects.toThrow(HTTPError)
await expect(operation()).rejects.toThrow(/Too large/)
```

### 4.3 反模式：if 守卫跳过断言

```typescript
// BAD: content 是 string 时，断言被静默跳过
if (typeof content !== "string") {
  expect(content).toHaveLength(3)
}

// GOOD: 先断言类型，确保不被跳过
expect(Array.isArray(content)).toBe(true)
expect(content).toHaveLength(3)
```

### 4.4 反模式：手动 state save/restore

```typescript
// BAD: state 字段为 readonly，直接赋值编译报错；即使绕过也容易遗漏恢复
const original = state.autoTruncate
state.autoTruncate = false  // TS error: readonly
afterEach(() => { state.autoTruncate = original })

// GOOD: 使用内置 test API（snapshot + restore 自动深拷贝）
let snap: StateSnapshot
beforeEach(() => { snap = snapshotStateForTests() })
afterEach(() => { restoreStateForTests(snap) })

test("...", () => {
  setStateForTests({ autoTruncate: false })
  // 测试代码
})
```

### 4.5 反模式：测试依赖执行顺序

```typescript
// BAD: test B 依赖 test A 的副作用
test("A: creates resource", () => {
  resource = createResource()
})
test("B: uses resource", () => {
  expect(resource.status).toBe("ready")  // 依赖 A 先执行
})

// GOOD: 每个 test 独立
test("B: uses resource", () => {
  const resource = createResource()  // 自己创建
  expect(resource.status).toBe("ready")
})
```

### 4.6 反模式：过度 mock

```typescript
// BAD: mock 太多，测试不验证任何真实逻辑
const mockSanitize = mock(() => ({ payload, blocksRemoved: 0 }))
const mockPipeline = mock(async () => ({ response: "ok" }))
const mockRecording = mock(() => {})
// 这只在测试 mock 是否被调用，不测试业务逻辑

// GOOD: 只 mock 边界，让核心逻辑走真实路径
const adapter = createMockAdapter({
  execute: mock(async () => ({ result: realResponse, queueWaitMs: 10 })),
})
// sanitize、pipeline 逻辑都是真实的
```

## 5. 测试数据构造

### 5.1 使用 Factory

```typescript
// GOOD: factory + overrides
const payload = mockAnthropicPayload({
  model: "claude-opus-4.6",
  max_tokens: 100,
})

// BAD: 每个测试手写完整对象
const payload = {
  model: "claude-opus-4.6",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 100,
  // ...20 个字段
}
```

### 5.2 最小数据原则

只指定**与当前测试相关**的字段，其余用 factory 默认值：

```typescript
// GOOD: 只关心 model 字段
test("should resolve model alias", () => {
  const result = resolveModelName("opus")
  expect(result).toBe("claude-opus-4.6")
})

// BAD: 构造了完整 payload 但只测 model
test("should resolve model alias", () => {
  const payload = {
    model: "opus",
    messages: [...],  // 与测试无关
    max_tokens: 1024, // 与测试无关
    tools: [...],     // 与测试无关
  }
  // ...
})
```

### 5.3 Fixture 用于 Contract 和 Integration

```typescript
// Contract: 验证真实 API 数据结构
const { response } = loadFixturePair("anthropic-messages", "simple")
expect(response.type).toBe("message")

// Integration: 使用真实数据驱动多模块流程
const { request } = loadFixturePair("anthropic-messages", "tool-use")
const sanitized = sanitizeAnthropicMessages(request)
```

## 6. Code Review 测试 Checklist

PR reviewer 在审查测试时使用：

### 覆盖性

- [ ] 新增/修改的代码有对应测试
- [ ] 正常路径有测试
- [ ] 至少一个错误路径有测试
- [ ] 边界条件有测试（空值、零值、最大值）

### 质量

- [ ] 无 `toBeDefined()` 弱断言
- [ ] 无 `try/catch + expect(error)` 模式
- [ ] 无 `if` 守卫跳过断言
- [ ] 每个 test 有 2-5 个有意义的断言

### 隔离性

- [ ] 使用 `snapshotStateForTests()` / `restoreStateForTests()` 隔离全局 state
- [ ] mock 在 afterEach 中清理
- [ ] test 之间无共享可变状态
- [ ] test 不依赖执行顺序

### 命名

- [ ] describe 使用被测函数/类名
- [ ] test 使用 "should + 动词" 句式
- [ ] 测试文件放在正确的层级目录

### 结构

- [ ] 文件顶部有覆盖范围注释
- [ ] Arrange-Act-Assert 结构清晰
- [ ] 适当使用 factory 和 fixture
- [ ] 不过度 mock（只 mock 边界）

## 7. 测试运行指南

```bash
# 运行所有单元测试（最快反馈）
bun test tests/unit/

# 运行单个文件
bun test tests/unit/error.test.ts

# 运行匹配名称的测试
bun test --test-name-pattern "should return rate_limited"

# 运行所有 CI 测试（不含 E2E）
bun run test:ci

# 运行覆盖率报告
bun run test:cov

# 运行 HTTP 层测试
bun run test:http

# 运行 E2E（需要 GITHUB_TOKEN）
GITHUB_TOKEN=ghp_xxx bun run test:e2e

# Watch 模式（开发时持续运行）
bun test --watch tests/unit/error.test.ts
```

## 8. 与 CLAUDE.md 的关系

本规范是 CLAUDE.md 原则的测试领域具体化：

| CLAUDE.md 原则 | 测试规范体现 |
|---------------|------------|
| 原则 3：数据最丰富形式流动 | factory 提供完整默认数据，测试 overrides 只指定关心的字段 |
| 原则 4：最优方案 | 修复根因而非症状 → bug fix 必须先写回归测试 |
| 原则 6：不忽视已有错误 | 所有测试失败必须修复，不跳过 |
| 原则 9：只修改代码时运行验证 | 修改 `.ts` 时运行 test，修改 `.md` 时不运行 |
