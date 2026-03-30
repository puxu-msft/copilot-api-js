# TDD 重构方案复查发现（第二轮）

日期：2026-03-27

本文记录对 `docs/tdd/` 第二轮修订后的复查结果，重点确认上一轮提出的关键问题是否已修正，并指出当前仍然存在的剩余偏差。

## 总体结论

这轮修订相比上一版已经有明显进步，尤其是以下几个关键点已经朝正确方向收敛：

- 已将 WebSocket 从 HTTP 测试层中拆分出来
- 已将 `createFullTestApp()` / `createMinimalApp()` 区分为两级 HTTP helper
- 已将 `bootstrapTestRuntime()` 明确纳入方案，补上 handler 运行前的初始化前提
- 已修正部分“现状描述过于绝对”的问题

也就是说，文档已经从“存在明显执行阻塞”进展到了“主体方向基本正确”。

但当前仍有一些重要问题没有完全闭环，主要集中在：

- 测试运行时 reset/cleanup 设计仍然偏弱
- state 隔离方案还没有覆盖所有可能泄漏的对象字段
- WS 层在不同文档中的定位仍有轻微摇摆
- scripts / CI 口径仍有局部不一致

这些问题不至于推翻当前方案，但如果不继续修正，后续真正开始大规模补测试时，仍可能出现 flaky test、测试污染或文档理解不一致的问题。

## 发现 1：`resetTestRuntime()` 的清理范围仍不足以支撑真实测试隔离

严重级别：高

### 问题

当前方案在 `docs/tdd/02-infrastructure.md` 中定义：

- `bootstrapTestRuntime()` 负责初始化运行时单例
- `resetTestRuntime()` 只调用 `_resetShutdownState()`

但这与实际初始化内容不匹配。因为 bootstrap 过程中初始化了：

- `RequestContextManager`
- History Store
- Context Consumers

而一旦 HTTP 测试真正跑过 handler，还会涉及更多全局状态：

- history 数据
- TUI logger 中的 active/completed requests
- rate limiter 单例
- WebSocket 客户端集合

当前的 `resetTestRuntime()` 只清 shutdown 状态，显然不足以保证 case 间真正隔离。

### 依据

- `docs/tdd/02-infrastructure.md` 中 `bootstrapTestRuntime()` 初始化 history、context manager、context consumers
- 同文档中的 `resetTestRuntime()` 只调用 `_resetShutdownState()`
- 当前代码库已有：
  - `clearHistory()`
  - `tuiLogger.clear()`
  - `resetAdaptiveRateLimiter()`

这些都说明测试间清理实际上需要更完整的 reset 方案。

### 风险

如果后续按当前文档落地：

- 前一个测试写入的 history 可能污染下一个测试
- TUI logger 的请求状态可能跨测试残留
- rate limiter 的状态可能影响后续行为
- 某些测试会“单独跑通过，整组跑失败”

这会直接伤害 TDD 工作流，因为测试会失去“每次都可重复验证”的可靠性。

### 建议

应将 `resetTestRuntime()` 扩展为统一清理入口，至少明确纳入：

- `_resetShutdownState()`
- `clearHistory()`
- `tuiLogger.clear()`
- `resetAdaptiveRateLimiter()`

如果未来 `tests/ws/` 启用真实连接，还应补上 WS client 清理策略。

## 发现 2：`withTestState()` 还没有真正覆盖完整对象型状态

严重级别：中高

### 问题

这一轮文档已经修复了上一版最明显的问题：

- `withTestState()` 和 `useTestState()` 共用同一套快照/恢复逻辑
- `models` 覆盖后会自动重建索引
- 新增了 `structuredClone` 处理部分嵌套对象字段

这是明显改进。

但目前“需要深拷贝的字段”仍然只覆盖了：

- `systemPromptOverrides`
- `rewriteSystemReminders`
- `adaptiveRateLimitConfig`

而当前 `State` 中仍然存在其他对象型字段，例如：

- `models`
- `tokenInfo`
- `copilotTokenInfo`

如果测试对这些字段做原地修改，浅拷贝的 `shallow: { ...state }` 仍会保留共享引用，造成泄漏。

另外，文档当前强调的是“当测试覆盖 `state.models` 时自动调用 `rebuildModelIndex()`”，但如果测试对 `state.models.data` 做原地 push/splice，这种一致性仍然不能自动保证。

### 依据

- `docs/tdd/02-infrastructure.md` 的 `deepSnapshotState()` 当前仅处理部分对象字段
- `src/lib/state.ts` 中 `State` 仍包含多个对象型字段

### 风险

这类问题非常隐蔽：

- 测试看似用了 `withTestState()`，但仍然会泄漏嵌套引用
- 团队成员会误以为 helper 已经“兜底”
- 结果是污染从显式 save/restore 变成更难排查的结构性泄漏

### 建议

文档最好补充一条明确规则：

- **测试中不要原地修改 `state.models`、`tokenInfo` 等嵌套对象**
- 或进一步升级 helper，覆盖这些对象型字段的快照/恢复

另外可以把 `models` 相关规则写得更强一些：

- 推荐直接整体替换 `state.models`
- 不鼓励原地修改 `state.models.data`

## 发现 3：WS 测试层的定位在不同文档之间仍有轻微摇摆

严重级别：中

### 问题

目前文档已经把 WS 单独分层，这一点是正确的。

但不同文档中的表述还没有完全统一：

### 在 `02-infrastructure.md` 中

WebSocket 传输层被描述为：

- 需要真实 WebSocket 连接
- 属于 Integration / E2E 级别

### 在 `03-test-layers.md` 中

又单独建立了 `WS` 层，并规定：

- `tests/ws/`
- 每次提交执行
- 可用“真实 HTTP server + WebSocket client”或“mock WSContext”

这两套描述叠在一起后，后续实现者可能会出现理解分歧：

- `tests/ws/` 是独立层吗？
- 它其实是 integration 的一种吗？
- 能不能使用 mock WSContext？
- 如果能 mock，那它还是“真实传输层”吗？

### 风险

如果这层边界不统一，后续很容易出现：

- 一个 PR 用真实 WS 连接测试
- 另一个 PR 用 mock WSContext 自称是 WS 层测试
- 评审时大家对“是否满足文档要求”理解不一致

### 建议

建议在文档中统一成一种清晰表述，例如二选一：

#### 方案 A：WS 是独立测试层

- `tests/ws/` 是独立于 HTTP / Integration 的层
- 必须走真实连接
- 不使用 mock WSContext

#### 方案 B：WS 是 integration 的专项子类

- `tests/ws/` 只是按协议归类的 integration tests
- 可以在目录上单独分组，但性质归 integration

无论选哪种，都应在三份文档里保持一致。

## 发现 4：scripts / CI 口径还有一个小的不一致点

严重级别：中低

### 问题

`docs/tdd/02-infrastructure.md` 的 scripts 示例里，目前新增的是：

- `test:cov`
- `test:cov:report`
- `test:http`

但同一文档的实施检查清单中又写了：

- 需要新增 `test:ws`

与此同时，`03-test-layers.md` 又把 WS 设成“每次提交执行”的测试层。

也就是说，文档总体意图已经把 WS 纳入常规测试体系，但具体 scripts 示例并没有同步体现出来。

### 风险

这类问题虽然不大，但会直接影响落地时的决策：

- CI 是否单独跑 `test:ws`？
- `test:ci` 是否最终应纳入 `tests/ws/`？
- 本地是否要提供 `bun run test:ws`？

### 建议

统一以下三处口径：

1. `package.json scripts` 示例
2. CI 命令段
3. 测试分层的执行策略表

如果 WS 层要“每次提交执行”，那文档中最好明确提供对应 script。

## 发现 5：当前版本已经不再有上一轮的关键阻塞问题

严重级别：正向结论

### 已确认修复的关键点

以下问题相比上一轮已经得到实质性改善：

1. **HTTP app helper 与 `server.ts` 的关系已理顺**
   - 现在不再把 `registerRoutes()` 等同于完整 server 装配
   - 已明确区分 `createFullTestApp()` 与 `createMinimalApp()`

2. **运行时 bootstrap 已纳入方案**
   - 不再假设 handler 可以在零初始化条件下直接运行
   - 已显式说明需要初始化 RequestContextManager / History / Consumers

3. **WS 不再错误地塞进 HTTP 测试**
   - 已意识到 `routes/responses/ws.ts` 不通过 `registerRoutes()` 注册
   - 已将其拆到 `tests/ws/` 的独立策略中

4. **现状描述比上一轮更准确**
   - 不再使用“路由层零覆盖”这种过度绝对化表述
   - 已承认已有 middleware / protocol 级辅助测试存在

### 结论

这说明方案已经从“需要大修方向”进入“需要补足细节闭环”的阶段。

## 建议的下一步修订顺序

建议按下面顺序继续完善：

1. 先补完整 `resetTestRuntime()` 设计
2. 明确 `withTestState()` 对对象型字段的边界与使用约束
3. 统一 WS 层在各文档中的层级定义
4. 统一 `test:ws` / CI / 分层执行口径

## 总评

这轮修订是有效的，而且是实质性的，不是表面补字。

当前方案的主要问题已经不再是方向错误，而是：

- 测试隔离的闭环还没完全补齐
- 某些边界定义还没有 100% 统一

如果继续沿着这次修订的思路收口，这套 TDD 重构方案很快就能成为一份真正可以驱动实施的工程文档。
