# TDD 转型指南

## 背景

本项目经过大型重构，源文件从 ~80 增至 107（模块拆分），测试 71 个文件 ~2,600 断言。核心缺陷：

- **核心 handler 缺少直接覆盖**（messages/chat-completions/responses handler 无 HTTP 测试）
- **缺少以真实 server 装配路径为入口的 HTTP 层测试**（`app.request()` 级别）
- **WebSocket 传输层缺少覆盖**（WS 路由通过 `registerWsRoutes` 独立注册）
- **弱断言模式仍然存在**（`toBeDefined()`、try/catch 空断言等）
- **Factory/Fixture 不完整**（仅 4 个 OpenAI factory，缺 Anthropic、Responses、Auth）
- **无覆盖率基线**（未配置 `--coverage`，无法量化改进进度）

**已解决**（重构中完成）：
- ~~全局 state 耦合~~ → State readonly + `setStateForTests()`/`snapshotStateForTests()`/`restoreStateForTests()` API，18 个文件已迁移

## 前置：TDD 编码规范

在启动任何基础设施建设之前，团队必须先就**测试的编写标准**达成共识。规范是所有后续工作的基础——没有共识就没有一致性。

**内容**：Red → Green → Refactor 工作流、命名规范、文件结构、断言规范、反模式识别、Code Review checklist。

**详细方案** → [01-conventions.md](01-conventions.md)

## 三步路线图

```
阶段 1                    阶段 2                    阶段 3
测试基础设施        →     测试分层设计        →     覆盖率提升
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
覆盖率工具链               分层职责定义               按优先级补齐
Factory 体系               mock 使用规范              Handler 层测试
State 隔离方案             断言规范                   核心引擎测试
HTTP 测试框架              命名与目录约定             Client/Token 测试
Fixture 扩充                                         Contract 测试
CI 集成                                              → 80% 行覆盖率
```

### 阶段 1：测试基础设施

**目标**：让"写好测试"变得简单——工具链、helpers、隔离机制一应俱全。

**交付物**：
- 覆盖率配置（`bun test --coverage`、lcov 输出、阈值门禁）
- ~~`withTestState()` — state 隔离 helper~~ ✅ 已由 `state.ts` 内置 API 取代
- `createFullTestApp()` / `createMinimalApp()` — 两级 Hono HTTP 测试框架
- `bootstrapTestRuntime()` — 运行时单例初始化（RequestContextManager、History 等）
- Factory 体系扩展（Anthropic、Responses、Auth、Hono Context）
- Fixture 扩充（streaming、error、thinking、大 payload）
- `package.json` scripts 扩展

**验收标准**：
- `bun run test:cov` 输出覆盖率报告（计划新增的 script）
- ~~新测试可用 `withTestState()` 隔离全局状态~~ ✅ 已使用 `setStateForTests()` 等 API
- 新测试可用 `createFullTestApp().request()` 发起 HTTP 请求并通过 handler 主逻辑
- Factory 覆盖三种 API 格式 + Auth

**详细方案** → [02-infrastructure.md](02-infrastructure.md)

### 阶段 2：测试分层设计

**目标**：每个测试层有明确的职责边界和编写规范，新代码自然遵循 TDD 工作流。

**交付物**：
- 七层测试定义（Unit / Component / Contract / Integration / HTTP / WS / E2E）
- mock 使用规范
- 断言规范
- 测试命名与文件组织约定

**验收标准**：
- 新特性开发必须先写测试
- Code review 有测试 checklist
- 测试文件命名和位置有明确规则

**详细方案** → [03-test-layers.md](03-test-layers.md)

### 阶段 3：覆盖率提升

**目标**：系统性补齐现有代码的测试覆盖，达到 80% 行覆盖率。

**交付物**：
- 按 P0/P1/P2 优先级的模块覆盖计划
- 每个模块的具体测试策略
- 里程碑定义和跟踪

**验收标准**：
- 行覆盖率 ≥ 80%
- 分支覆盖率 ≥ 70%
- Handler 层 3 个核心 handler 有 HTTP 测试
- 无未测试的 P0 模块

**详细方案** → [04-coverage-plan.md](04-coverage-plan.md)

## 文档索引

| 文档 | 说明 |
|------|------|
| [01-conventions.md](01-conventions.md) | TDD 编码规范（前置，所有工作的基础） |
| [02-infrastructure.md](02-infrastructure.md) | 阶段 1：测试基础设施详细方案 |
| [03-test-layers.md](03-test-layers.md) | 阶段 2：测试分层设计 |
| [04-coverage-plan.md](04-coverage-plan.md) | 阶段 3：覆盖率提升计划 |
