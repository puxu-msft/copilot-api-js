# TDD 重构方案审查发现

日期：2026-03-26

本文记录对 `docs/tdd/` 下整体 TDD 重构方案的审查发现，重点关注方案与当前仓库实现是否一致、是否可执行，以及是否会在后续落地时引入新的测试基础设施风险。

## 结论摘要

整体方向是正确的：

- 先统一 TDD 规范，再补基础设施，再系统补覆盖率，这个顺序合理
- 引入 HTTP 层测试、state 隔离 helper、fixture/factory 扩充，都是当前仓库确实需要的能力
- 将后续工作按 P0/P1/P2 排优先级，也有利于逐步推进

但这套方案当前还存在若干关键偏差，尤其集中在：

- HTTP 测试入口定义与真实 server 装配方式不一致
- WebSocket 测试被错误纳入 HTTP 测试模型
- 新测试运行所需的运行时 bootstrap 未写入方案
- state 隔离方案未覆盖完整状态形态
- 覆盖率基线和现状描述已有漂移

如果不先修正这些问题，后续按文档推进时很容易出现“文档看起来可行，但第一批测试就跑不起来”或“测出来的不是生产真实路径”的情况。

## 发现 1：`createTestApp()` 与 M1/M2 要验证的对象不一致

严重级别：高

### 问题

方案在 `docs/tdd/02-infrastructure.md` 中定义的 `createTestApp()` 只做两件事：

- 创建一个新的 `Hono` app
- 调用 `registerRoutes(app)`

但阶段 3 的覆盖计划明确要求测试：

- `GET /`
- `GET /health`
- `GET /favicon.ico`
- 404 not found
- 全局错误处理

这些行为并不在 `registerRoutes()` 中，而是在 `src/server.ts` 里定义。

这意味着：

- 按文档实现出来的 `createTestApp()` 无法覆盖 `basic-routes.test.ts` 计划中的关键场景
- 文档中的阶段 1 helper 和阶段 3 测试计划天然不兼容
- 后续团队成员会误以为自己在测“真实 HTTP 层”，实际上只测到了子路由注册

### 依据

- `docs/tdd/02-infrastructure.md` 中的 `createTestApp()` 仅调用 `registerRoutes(app)`
- `docs/tdd/04-coverage-plan.md` 的 `basic-routes.test.ts` 要求覆盖根路由、health、favicon、404、全局错误
- `src/server.ts` 中实际定义了 `onError`、`notFound`、`/`、`/health`
- `src/routes/index.ts` 只负责 API 路由挂载，不包含这些基础行为

### 建议

应明确拆分两个 helper：

- 一个“真实 server 装配版” helper，尽可能复用 `server.ts` 的行为
- 一个“最小路由测试版” helper，只用于隔离 handler/route 子树

否则文档中的 `createTestApp()` 这个名称会误导后续实现和测试设计。

## 发现 2：`routes/responses/ws.ts` 不应直接归入 `tests/http/`

严重级别：高

### 问题

方案把 `routes/responses/ws.ts` 列为 HTTP 测试对象，并放在 `tests/http/` 这一层里。但当前仓库中的 Responses WebSocket 路由不是通过 `registerRoutes()` 注册的，而是在启动流程中：

1. 创建共享 WebSocket adapter
2. 再通过 `initResponsesWebSocket(server, upgradeWs)` 挂到根 app

这与普通 `app.request()` 的 HTTP 测试入口是两条不同链路。

因此当前方案存在两个直接问题：

- 按 `createTestApp().request()` 的思路无法覆盖真实的 WS 注册路径
- 即使模拟 `Upgrade: websocket` 请求，也不能替代共享 upgrade adapter、WS 生命周期和消息收发逻辑的验证

### 依据

- `docs/tdd/04-coverage-plan.md` 将 `routes/responses/ws.ts` 标记为 HTTP 测试
- `src/start.ts` 中通过 `createWebSocketAdapter(server)` 后调用 `initResponsesWebSocket(server, wsAdapter.upgradeWebSocket)`
- `src/routes/responses/ws.ts` 明确是根 app 上的 GET WebSocket 升级路由
- `src/routes/index.ts` 并未注册该 WebSocket 路由

### 建议

应把这部分从“HTTP 测试”中拆出来，单独定义为：

- `WS transport tests`
- 或 `WebSocket protocol / transport tests`

并分别覆盖：

- upgrade 注册是否存在
- `response.create` 消息解析
- 非法 JSON / 非法消息的错误帧
- 事件转发与终止事件
- 关闭与错误路径

否则当前测试分层会把不同技术边界混在一起。

## 发现 3：HTTP 测试缺少必要的运行时 bootstrap

严重级别：高

### 问题

文档中为 HTTP 测试强调了 mock 上游 API client，但没有纳入一个更基础的前置条件：当前几个核心 handler 在进入主流程时都依赖已初始化的全局运行时单例。

最典型的是：

- `handleMessages()` 调用 `getRequestContextManager()`
- `handleChatCompletion()` 调用 `getRequestContextManager()`
- `handleResponses()` 调用 `getRequestContextManager()`

而 `getRequestContextManager()` 在未初始化时会直接抛错。

也就是说，即使上游 client 全部 mock 好了，只要没有在测试 setup 中先初始化 request context manager，HTTP happy-path 测试仍然会在真正逻辑开始前就失败。

### 依据

- `docs/tdd/03-test-layers.md` 只讨论 mock 上游 API
- `src/lib/context/manager.ts` 中 `getRequestContextManager()` 未初始化会抛错
- 三个核心 handler 都直接依赖该单例

### 建议

阶段 1 文档中应明确补充“HTTP 测试运行时初始化”能力，例如：

- 初始化 request context manager
- 视场景决定是否注册 context consumers
- 清理 TUI logger、shutdown 状态、rate limiter 等全局单例

否则“新测试可直接用 `createTestApp().request()`”这个验收标准并不成立。

## 发现 4：`withTestState()` 设计还不足以实现完整 state 隔离

严重级别：中

### 问题

文档中 proposed 的 `withTestState()` / `useTestState()` 采用浅拷贝快照，仅额外恢复了：

- `modelIndex`
- `modelIds`
- `modelOverrides`

但当前 `state` 里还有不少对象型或数组型字段，例如：

- `adaptiveRateLimitConfig`
- `rewriteSystemReminders`
- `systemPromptOverrides`
- `tokenInfo`
- `copilotTokenInfo`
- `models`

这些字段若在测试中被原地修改，浅拷贝方案会发生引用泄漏。

另外还有两个一致性问题：

- `useTestState()` 比 `withTestState()` 还少恢复了 `modelOverrides`
- 如果测试中覆盖了 `state.models`，但没有同步重建索引，则 `modelIndex` / `modelIds` 可能与 `models` 不一致

### 依据

- `docs/tdd/02-infrastructure.md` 给出的 helper 代码只恢复了部分字段
- `src/lib/state.ts` 中 `State` 包含多个对象/数组型字段
- `src/lib/state.ts` 提供了 `rebuildModelIndex()`，说明 `models` 与索引是派生关系，不是天然同步的

### 建议

文档应升级这部分设计，至少明确：

- 哪些字段要做结构化克隆或专门恢复
- 当测试修改 `state.models` 时必须同步调用 `rebuildModelIndex()`
- 除 `state` 外，还需要单独清理哪些模块级单例

如果不修，后续引入 helper 后仍会持续出现测试污染，只是污染方式更隐蔽。

## 发现 5：覆盖率基线与现状描述已经漂移

严重级别：中

### 问题

文档里用于推动里程碑的若干数字已经不一致：

- `README.md` 写“~1,200 个测试用例”
- `docs/archive/test-coverage-audit.md` 写“~948”
- 审计文档写测试文件总数 54，但当前仓库实际已有更多 `.test.ts`
- `README.md` 说 `bun run test:ci` 输出覆盖率报告，但当前 `package.json` 里的 `test:ci` 并没有带 `--coverage`
- `bunfig.toml` 目前也还没有覆盖率配置，只配置了 `root`

这会导致后续里程碑判断失真，例如：

- “M1 提升 5%”相对于哪个真实基线？
- “M2 到 65%”是否已被当前代码演进改变？
- “test:ci 输出覆盖率报告”到底是现状还是目标？

### 依据

- `docs/tdd/README.md`
- `docs/tdd/04-coverage-plan.md`
- `docs/archive/test-coverage-audit.md`
- `package.json`
- `bunfig.toml`

### 建议

在启动任何重构执行前，先刷新一次当前基线，并把以下信息统一：

- 当前测试文件数
- 当前测试用例数
- 当前 line / branch 覆盖率
- 哪些命令是现状，哪些命令是计划新增

否则文档的里程碑会逐步失去决策价值。

## 发现 6：“Handler/路由层零覆盖”的表述过于绝对

严重级别：中

### 问题

方案多处将现状概括为：

- Handler/路由层零覆盖
- HTTP 层测试为 0

这个方向上是对的，但表述有些过头。

当前仓库已经存在一些与路由/协议层直接相关的测试，例如：

- `tests/component/middleware-websocket.test.ts` 已经用 `Hono app.request()` 覆盖了 middleware 层的 HTTP/SSE/Upgrade 行为
- `tests/unit/responses-websocket.test.ts` 已经覆盖了一部分 Responses WebSocket 协议约束

这些测试当然不能替代“真实 server 装配入口的 HTTP/WS 测试”，但也不应被描述成完全为零，否则会影响后续优先级判断和重复劳动评估。

### 依据

- `tests/component/middleware-websocket.test.ts`
- `tests/unit/responses-websocket.test.ts`

### 建议

文档可以将现状表述修正为：

- “缺少以真实 server 装配路径为入口的 HTTP 层测试”
- “核心 handler 缺少直接覆盖”
- “WebSocket 真实注册与传输路径缺少覆盖”

这样更准确，也更利于制定补齐策略。

## 发现 7：方案中部分示例代码与当前仓库约定不完全贴合

严重级别：低

### 问题

文档里有一些示例虽然表达意图正确，但直接照抄进仓库会出现偏差，例如：

- contract 示例使用了 `toBeOneOf(...)`，但仓库里目前没有现成使用痕迹
- 部分 integration / contract 示例属性名与真实返回结构不完全一致，作为“方向示例”没问题，但不适合作为直接实现模板

这类问题单独看不严重，但如果团队成员把文档中的代码块视为“可直接落地样例”，会增加返工概率。

### 建议

文档中的代码块最好分成两类：

- “示意代码”
- “推荐直接实现模板”

对前者要明确说明是伪代码或结构示意，避免误用。

## 建议的修订优先顺序

建议先修文档，再开始阶段 1 实施，顺序如下：

1. 先重写 HTTP/WS 测试入口设计
2. 补充测试运行时 bootstrap 与全局单例清理策略
3. 升级 `withTestState()` 设计，明确 `state.models` 与索引同步规则
4. 刷新覆盖率基线与测试数量统计
5. 再细化 P0/P1/P2 里程碑

## 建议的文档结构调整

可以考虑把当前方案补成下面这种结构：

### 阶段 1

- 覆盖率工具链
- state 隔离
- 全局单例清理
- HTTP app 装配 helper
- WebSocket test harness
- factory / fixture 扩充

### 阶段 2

- Unit / Component / Integration / Contract / HTTP / WS / E2E 分层
- 每层的入口、边界、mock 规则

### 阶段 3

- 基于更新后基线重新排 P0/P1/P2
- 核心 handler 先补真实入口覆盖
- 再补 client / token / memory pressure

## 总评

这份方案已经具备不错的框架感，但还差最后一层“和当前仓库真实运行机制完全对齐”的校正。

目前最大的问题不是方向错，而是：

- 某些 helper 定义得过于理想化
- 某些测试层边界划分没有贴住当前实际装配路径
- 若直接执行，第一批测试就可能被基础设施缺口阻塞

在修正本文列出的高优先级问题后，这份 TDD 重构方案会更接近一份可以直接驱动实施的工程文档。
