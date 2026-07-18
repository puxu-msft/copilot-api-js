# Kick-off — 上游传输 config 三轴重组（transport-config-reorg）

> **本轮执行范围（D，2026-07-14 主会话裁决）**：本轮只执行 **P1**（config schema 三轴重组），**P2/P3/P4/P5 暂缓**，不在本轮派发执行 kick-off。原因：P1 是全部下游阶段的唯一前置依赖（见下方 DAG），本轮的重点是先把 P1 的 config schema/state/兼容迁移这一层落地并跑通全量回归，P2 起的连接层真实接线、PUT 迁移、热重载 reconcile、status/diagnostics 接入待 P1 落地并复核后再排期，避免多阶段并行执行时互相踩踏同一批"跨阶段共享接口清单"里尚未定案的签名（本文档「待主会话裁决」小节列出的分叉，多数已在 P1 尚未开工前通过 review+用户裁决收敛，但收敛结果需要先在 P1 真实代码上验证一遍再放行下游）。P2-P5 的 kick-off 提示词仍然完整保留在下方，供 P1 完成并经复核后按序派发，不需要届时重写。

本文档是 `docs/plan/2026-07-14-transport-config-reorg/` 计划集的执行入口：汇总各阶段的**可直接复制的开启提示词**，以及全部 5 份 plan 文档在撰写过程中沉淀下来的、**需要主会话裁决**的分叉与待办清单（不含各 plan 正文里已经自行判定、无需上呈的普通设计取舍——那些留在各自的 Self-Review 小节，这里只收敛真正需要主会话拍板的条目）。

权威输入：`docs/spec/2026-07-14-upstream-transport-config-reorg.md`（spec）、`docs/decisions/2026-07-14-transport-config-three-axis-organization.md`（ADR）、`docs/decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md`（上游 ADR）、`docs/plan/2026-07-14-transport-config-reorg/README.md`（跨阶段共享接口清单 + 全局约束 9 条，逐字锁定，任何阶段不得擅自改名）。

## 阶段依赖图（DAG）

```
P1（config schema 三轴重组）
 ├─→ P2（新旋钮真实接线）
 │    ├─→ P4（热重载 reconcile）
 │    │    └─→ P5（status/diagnostics + ui-v4）
 │
 └─→ P3（PUT 迁移）
```

- P1 是所有阶段的前置依赖，必须最先完成。
- P1 完成后，P2 与 P3 相互独立，**可并行**执行（不同文件、不同关注面：P2 改连接层读取函数，P3 改 config PUT 写回路径）。
- P4 依赖 P2（读取 P2 新增的 `getSessionConnectTimeoutMs`/`getPooledConnectionIdleTimeoutMs`），不依赖 P3。
- P5 依赖 P4（README 锁定："P5 依赖 P4，因为状态面板要展示 reconcile 观测量"），也间接读取 P2 的两个函数。P5 不依赖 P3。
- 由谁在哪个会话/subagent 执行、是否真的并行调度，由主会话按当时的并行度与上下文预算裁决；本文档只标注技术上的可并行性，不代主会话做编排决定。

## 各阶段 Kick-off 提示词

以下每段提示词假定执行者是一个新会话或 subagent，对本次改动**没有任何先验上下文**，因此每条都重复了必要的背景，可直接复制使用。

---

### P1 — config schema 三轴重组

```
你要执行 docs/plan/2026-07-14-transport-config-reorg/plan-1-config-reorg.md 这份 TDD 实施计划。

背景：本项目（copilot-api-js）正在把上游传输相关的 config 项按"请求生命周期 watchdog / 上游出向连接 / 客户端面向入向"三轴重新组织。权威 spec 在
docs/spec/2026-07-14-upstream-transport-config-reorg.md，ADR 在
docs/decisions/2026-07-14-transport-config-three-axis-organization.md。执行前请先通读这两份文档，
再通读同目录的 README.md（尤其"全局约束"9 条与"跨阶段共享接口清单"——本阶段是这些接口的产出方之一）。

约束：
- 逐 Task 走 TDD（先写失败测试，再实现，再转绿）；每个 Task 完成后立即用显式 pathspec
  （git add -- <精确路径>、git commit -F <msgfile> -- <精确路径>）提交，conventional commits，不加模型署名。
- 计划文档里给出的每一段代码都是可直接落地的完整实现，不是伪代码，照抄即可，但仍需你自己跑测试/typecheck 验证。
- 测试隔离：一律走本项目既有 DI/临时目录/state 快照机制（snapshotStateForTests/restoreStateForTests/setStateForTests），
  绝不触碰真实 $HOME 或 4141 端口的主服务器。
- 计划正文中若出现"待主会话裁决"字样的分叉点，不要自行决定——照最保守/最小改动的默认路径执行，
  并在完成后原样列出，交回主会话（不要压缩、不要替主会话做决定）。

完成后：跑一次全量回归（bun run typecheck && bun run test:backend），确认全绿；
然后向调用方（主会话）汇报：本阶段涉及的文件绝对路径列表、每个 Task 的提交 hash、
以及计划文档"自审记录"末尾"已知的跨阶段遗留"小节的原文内容。
```

---

### P2 — 新旋钮真实接线

```
你要执行 docs/plan/2026-07-14-transport-config-reorg/plan-2-new-knobs-wiring.md 这份 TDD 实施计划。

前置条件：docs/plan/2026-07-14-transport-config-reorg/plan-1-config-reorg.md（P1）必须已经落地——
即 src/lib/state.ts 上已存在 sessionConnectTimeout / pooledConnectionIdleTimeout /
softMaxUpstreamWsConnections 三个字段，src/lib/config/schema.ts 上已存在 upstream_transport 三段 schema。
执行前用 grep 核实这些符号存在；若不存在，说明 P1 尚未完成，应先回去完成 P1，不要在本计划里顺手补 P1 的活。

背景：本项目正在把上游传输 config 按三轴重组，权威 spec 在
docs/spec/2026-07-14-upstream-transport-config-reorg.md，ADR 在
docs/decisions/2026-07-14-transport-config-three-axis-organization.md。执行前请先通读这两份文档，
再通读同目录的 README.md（全局约束 9 条 + 跨阶段共享接口清单——本阶段消费 P1 产出的 state 字段，
产出 getSessionConnectTimeoutMs/getPooledConnectionIdleTimeoutMs 两个函数供 P4/P5 消费，不可改名）。

约束（与 P1 相同）：TDD、每 Task 独立提交（显式 pathspec + conventional commits）、
测试隔离走既有 DI 机制、"独立 oracle"是硬性要求——任何声称"新旋钮生效"的测试必须观察真实连接行为
变化（真实 socket 超时/真实定时器/真实 undici Options 断言），不能只断言 state 字段被赋值。
计划正文中的"待主会话裁决"分叉点不要自行决定，按计划给出的默认路径执行并原样列出交回。

完成后：跑 bun run typecheck && bun run test:backend 全绿；
向主会话汇报文件路径 + 提交 hash + 计划文档"发现的缺口 / 需主会话裁决的分叉"小节原文
（尤其第 1 条：proxy-connect.ts 是否应该正式补入 README 的 P2 文件枚举）。
```

---

### P3 — PUT 迁移

```
你要执行 docs/plan/2026-07-14-transport-config-reorg/plan-3-put-migration.md 这份 TDD 实施计划。

前置条件：docs/plan/2026-07-14-transport-config-reorg/plan-1-config-reorg.md（P1）必须已经落地——
新 schema 段（upstream_transport.http2/websocket、server.responses_ws）与 compat.ts 的 6 条迁移规则
均已存在。执行前用 grep 核实；若不存在，先回去完成 P1。

本阶段与 P2（plan-2-new-knobs-wiring.md）相互独立，可与 P2 并行执行（不同文件：本阶段改
src/lib/config/compat.ts / validation.ts / routes 里的 PUT handler，不碰连接层代码）。

背景：本项目正在把上游传输 config 按三轴重组，权威 spec/ADR 见
docs/spec/2026-07-14-upstream-transport-config-reorg.md /
docs/decisions/2026-07-14-transport-config-three-axis-organization.md。执行前请先通读，
再通读同目录 README.md（全局约束第 6 条"PUT 迁移绝不静默丢字段"是本阶段的核心验收标准）。

约束：TDD、每 Task 独立提交、测试隔离走既有机制。特别注意计划文档强调的"in-place 值迁移"
与"路径迁移"的区别（legacyPathsRemoved 必须排除同路径值迁移，否则会把 YAML 位置和注释一起删掉）——
这是本阶段最容易踩的坑，计划正文 Task 1 已给出判定标记 isInPlaceValueMigration 与对应测试，照抄即可。

完成后：跑 bun run typecheck && bun run test:backend 全绿；
向主会话汇报文件路径 + 提交 hash + 计划文档"待本阶段自身记录、汇总进 plan-kickoff.md『待主会话裁决』
的条目"小节原文（嵌套 section PUT 部分更新是整体替换而非深度合并，影响面在本阶段被放大到三个新旋钮段）。
```

---

### P4 — 热重载 reconcile

```
你要执行 docs/plan/2026-07-14-transport-config-reorg/plan-4-hot-reload-reconcile.md 这份 TDD 实施计划。

前置条件：docs/plan/2026-07-14-transport-config-reorg/plan-2-new-knobs-wiring.md（P2）必须已经落地——
即 src/lib/transport/http2-client.ts 上的 getSessionConnectTimeoutMs、
src/lib/openai/upstream-ws.ts 上的 getPooledConnectionIdleTimeoutMs（已导出）均已存在且真实接线到
连接建立路径。执行前用 grep 核实；若不存在，先回去完成 P2。本阶段不依赖 P3，可以在 P3 完成前开始。

背景：本项目正在把上游传输 config 按三轴重组，权威 spec/ADR 见
docs/spec/2026-07-14-upstream-transport-config-reorg.md /
docs/decisions/2026-07-14-transport-config-three-axis-organization.md。执行前请先通读，
再通读同目录 README.md ——本阶段是"跨阶段共享接口清单"两组签名
（H2SessionStatusRow/getH2SessionStatusSnapshot/getH2ReconcileStatus 与
UpstreamWsStatusRow/getUpstreamWsStatusSnapshot）的**产出方**，P5 会逐字消费这些签名，
**不可改名、不可改变字段形状**，如果实现中发现这些签名有问题，停下来交回主会话，不要私自改。

承重不变量（全局约束 2/3/4，必须严格遵守，测试必须真实覆盖）：
1. 新旋钮热更新时，已存在连接走 generation-based retire-and-replace，不是 drain-then-replace
   （新会话/新连接立即用新配置服务新请求，旧的继续存活直到自然 drain 完，不强制打断在飞流）。
2. 每会话 active-stream 计数必须恰好递减一次（exactly-once，不多不少）。
3. 正在 retire 的会话的 PING/keepalive 定时器必须存活到 drain 完成（不能因为进入 retiring 状态就
   提前停掉自己的保活定时器，否则会话会在还有在飞流时被上游误判空闲断开）。

约束：TDD、每 Task 独立提交、测试隔离走既有机制、独立 oracle（不能只断言内部状态被赋值,
要观察真实的重试/丢弃/驱逐行为）。计划正文中的"待主会话裁决"分叉点按给定默认路径执行,原样列出交回。

完成后：跑 bun run typecheck && bun run test:backend 全绿;
向主会话汇报文件路径 + 提交 hash + 计划文档 Task 3 Step 3"Self-Review:发现的缺口/待裁决分叉"
小节原文(尤其第 2 条 UpstreamWsStatusRow.state 三值映射的命名不对称性)。
```

---

### P5 — status/diagnostics 接入 + ui-v4

```
你要执行 docs/plan/2026-07-14-transport-config-reorg/plan-5-status-diagnostics.md 这份 TDD 实施计划。

前置条件：docs/plan/2026-07-14-transport-config-reorg/plan-4-hot-reload-reconcile.md（P4）必须已经落地——
即 src/lib/transport/http2-client.ts 上的 getH2SessionStatusSnapshot/getH2ReconcileStatus、
src/lib/openai/upstream-ws.ts 上的 getUpstreamWsStatusSnapshot 均已存在（严格按
docs/plan/2026-07-14-transport-config-reorg/README.md 锁定的签名）。执行前用 grep 核实全部六个符号
（含 P2 的 getSessionConnectTimeoutMs/getPooledConnectionIdleTimeoutMs）；若任一缺失，先回去完成对应阶段。

背景：本项目正在把上游传输 config 按三轴重组，权威 spec/ADR 见
docs/spec/2026-07-14-upstream-transport-config-reorg.md（§4 HIGH-7 是本阶段的核心验收依据，
"禁止只返回一个 generation 数字就形式满足"）/
docs/decisions/2026-07-14-transport-config-three-axis-organization.md。执行前请先通读，
再通读同目录 README.md 全局约束第 5 条（SSOT-types：新类型只在后端定义一次，ui-v4 经 ~backend/*
re-export 消费，本阶段是全计划**唯一**新增跨端类型的阶段，必须跑 bun run typecheck:ui-v4
**和** bun run build:ui-v4 双重验证——前者证类型对，后者证没有意外的值导入把后端运行时依赖
打进前端 bundle，只跑 typecheck 不够）。

约束：TDD（Task 3 是纯类型 re-export，无独立单测，改用 typecheck+build 验证，这是本项目
TDD 约定里"不可测试项改用构建/人工可复现验证"的合理例外，不是偷懒）；每 Task 独立提交；
测试隔离走既有机制（后端复用已注册进 tests/helpers/isolated-fixture.ts RESETTERS 表的
resetUpstreamWsManagerForTests/setUpstreamWsConnectionFactoryForTests/setHttp2SessionFactoryForTests，
不需要手写额外清理；ui-v4 侧沿用既有 vi.mock("@/hooks/useStatus", ...) 惯例）。
计划正文中的"待主会话裁决"分叉点按给定默认路径执行，原样列出交回。

完成后：跑 bun run typecheck && bun run typecheck:ui-v4 && bun run test:backend &&
bun run test:ui-v4 && bun run build:ui-v4 全绿；
向主会话汇报文件路径 + 提交 hash + 计划文档 Task 5 Step 3"Self-Review"小节全部 5 条原文。
```

---

## 待主会话裁决（跨全部 5 份 plan 汇总，按阶段分组，去重后保留原始措辞要点）

### 来自 plan-1（config schema 三轴重组）

1. **`sessionConnectTimeout`/`pooledConnectionIdleTimeout` 两个新 state 字段在 P1 结束时暂时是"孤儿"**（未被任何连接代码读取，纯粹是 P2 的前置铺垫）——这是 README 明文批准的阶段边界（全局约束 2），非缺陷，仅供主会话知悉执行中间态是预期的。
2. **`config.yaml` 新增的 `upstream_transport`/`server` 段落写成注释掉的占位示例**，不取消注释、不改变默认行为——延续既有 `config.yaml` 的"示例默认注释"风格，非遗漏。若主会话希望这次顺带把整份 `config.yaml` 的示例注释风格做一次统一审视，这是一个独立于本次三轴重组的范围，建议另开任务，不建议塞进本轮。

### 来自 plan-2（新旋钮真实接线）

3. **`proxy-connect.ts` 被本阶段纳入了 P2 的实际改动范围，但 README 原始的 P2 文件枚举没有列出它**——原因是 D5"`0` 语义全面一致"要在 HTTP CONNECT 代理隧道路径下真正成立，必须修正该文件里一个更隐蔽的、与 keepalive 无关但同属"0 语义反转"的连带缺陷（JS 计时器 `setTimeout(fn, 0)` 是"几乎立即触发"而非"禁用"）。本计划判断这是"完整实现已批准的 D5"所必须、不算范围蔓延，已在 plan-2 Task 1 处理并给出了回填 README 的收尾步骤，**但主会话若认为改动 README 文件枚举之外的文件应该先过一次 spec 层面确认，请在执行 P2 Task 1 之前叫停**，否则默认按 plan-2 既定方案执行。
   - **【已裁决 2026-07-14｜接受纳入 P2】** gpt reviewer 亲验 `proxy-connect.ts:143` 无条件 `setTimeout(fn, opts.timeoutMs)`、`0` 与禁用相反，bug 真实。纳入 P2 同一 0 归一化正确（fix-all-comparison-sites），HTTP CONNECT 路 `<=0` 不 arm timer（真禁用）。已回写 spec §6.7 + ADR（commit 0e3926ab）。SOCKS 路无法真禁用另裁——见下方新增裁决项 16。
4. **`getPooledConnectionIdleTimeoutMs` 是否应该导出（而非模块私有）**——本计划默认导出，是为了让 P4/P5 能够复用（P4 用于热重载读取当前配置值、P5 用于聚合展示）。若主会话坚持"P2 严格只做 README 列出的最小契约、导出面留给 P4 自己决定"，只需在 P4 执行前把这一行改回私有 `function`，波及面为零（P4/P5 计划文档已经假定它是导出的，若改为私有，P4/P5 需要相应改为自己重新导出或改变调用方式，这会是一个小的连锁改动，建议尽早拍板）。
   - **【已裁决 2026-07-14｜定为导出】** P4/P5 已依赖导出，直接定为导出并补入 README 冻结契约表（A7，commit `7bceb508`）。本项关闭。

### 来自 plan-3（PUT 迁移）

5. **嵌套 section 的 PUT 部分更新是"整体替换"而非"深度合并"，本阶段把这个既有行为模式的影响面从 1 处（`anthropic.buffered_retry`）扩大到 4 处**（`upstream_transport.http2`/`upstream_transport.websocket`/`server.responses_ws` 三个新段 + 原有的一处）——用户若只 PUT 部分字段（如只给 `session_connect_timeout`），磁盘上整个 `http2` 子节点会被替换，此前设置的 `ping_interval` 等其他同节点字段会被抹掉，除非调用方把所有字段都带上。这是既有代码库的一致行为模式，非本阶段引入的新缺陷，但用户可感知的影响面确实变大了。**是否需要把 `setNestedScalarContainer` 升级为对嵌套子对象做逐字段深度合并**——spec/ADR 均未讨论这一点，需要主会话与用户确认是否值得在本轮或未来某阶段补做。
   - **【已裁决 2026-07-14｜升级为递归深合并 + null 删除】** 用户裁决：`setNestedScalarContainer` 升级为逐字段递归 merge（部分 PUT 只改给出字段、保同段其他字段），`null` 显式删除该字段；既有 `anthropic.buffered_retry` 一并切新语义。已回写 spec §5 + plan-3（B9，commit `fc617dfa`）。本项关闭。

### 来自 plan-4（热重载 reconcile）

6. **`UpstreamWsManager` 新增的 `reconcileForConfigChange`/`statusSnapshot` 两个方法未被 README 逐字锁定**——是本阶段为了让 README 锁定的自由函数 `getUpstreamWsStatusSnapshot(manager)` 有内部状态可读而必须新增的实现细节。风险很低（纯新增方法，不改动任何既有方法签名），但这类"计划范围内合理延伸未被 README 收录"的情况，主会话可以决定是否需要事后把它们补录进 README 的跨阶段契约清单，作为一个文档一致性问题，而非架构风险。
7. **`UpstreamWsStatusRow.state` 的三值映射存在命名不对称**：本阶段选定 `!isOpen→"active"` / `isOpen&&isBusy→"busy"` / `isOpen&&!isBusy→"idle"`——即"active"在 WS 侧的语义是"尚未建立连接"，而在 h2 侧 `H2SessionStatusRow.lifecycle` 的"active"语义恰恰相反，是"已建立且可路由"。README 只锁定了类型形状（`"active"|"busy"|"idle"`），未规定语义映射，本阶段的选择可能会在 P5 展示层造成读者困惑（两个相邻字段用同一个词表达相反含义）。**需要主会话确认是否接受这个命名，或要求改用更明确的三值（如 `"connecting"|"busy"|"idle"`）**——但后者需要先修改 README 锁定的类型字面量，属于会牵动 P5 已完成设计的改动，建议尽快拍板以免 P5 已落地实现需要返工。
   - **【已裁决 2026-07-14｜改字面量为 `"connecting"|"busy"|"idle"`】** 用户 + reviewer 一致：同词反义是命名 footgun。`!isOpen→"connecting"`。已改 README 冻结契约 + plan-4 实现/测试 + plan-5 mock/Badge/过滤/API 测试（commit `4fc309b6`）。plan 未执行、改的只是文档，零返工。本项关闭。
8. **`onUpstreamTransportChange` 是覆盖全部 5 个字段变化的单一粗粒度事件**——任何一个字段的变化（哪怕只改了与 h2 完全无关的 `softMaxUpstreamWsConnections`）都会触发 h2 侧全量 retire-and-replace，反之亦然。这是 P1 单一事件设计的既定代价，不是本阶段引入的新问题，会造成技术上不必要的连接重建（尤其 h2 侧：一次任意字段的 reconcile 都会让所有 origin 的活跃会话立即转入 retiring，下一个请求都要重新握手）。**是否值得在未来某阶段把该事件拆分为按字段分组的更细粒度事件**——当前判断"配置很少变化 + 重新握手成本对本项目场景可忽略、不值得为此增加 P1 复杂度"，但这是一个成本判断，应由主会话而非本计划单方面定案。

### 来自 plan-5（status/diagnostics 接入 + ui-v4）

9. **`transport.configured` 的 0/undefined→null 归一化是本阶段在 spec 字面要求之外的展示层加值设计**，不是 HIGH-7 强制的形状（spec 只要求"configured generation + values"存在，未规定统一编码）。纯新增文件内的局部决策，零副作用、可逆（若主会话认为 UI 应该直接处理五种不同的原始语义，删掉归一化这一层即可）。非阻断项，仅供知悉。
10. **本阶段没有创建真实 h2 session 来验证 `h2Sessions` 数组的真实取值**（只验证了默认空池场景与 WS 侧的委托正确性）——刻意的范围边界：h2 session 完整生命周期行为已由 P4 的 `http2-generation-reconcile.it.test.ts` 覆盖，本阶段的聚合器只是委托已验证过的函数，重复测一遍纯属重复劳动。若主会话认为聚合层也需要一个端到端真实 h2 session 场景作为独立 oracle，这是一个可追加的、成本可控的测试（可复用 P4 已建好的 harness），当前判断不必要。
11. **UI 深度视图（h2 会话/upstream WS 池逐行）只加在 shadcn 侧，legacy 侧只有 1 张摘要 StatCard**——延续既有先例（"Server info"深度卡片同理只在 shadcn），非技术限制。若主会话认为 legacy 用户群体仍是主要诊断消费者、需要同等深度，这是一个产品/UX 决策，需要澄清，技术上完全可行（legacy 缺的只是 Card/Badge 视觉承载，可用纯 div/dl 复刻）。
12. **`UpstreamWsStatusRow`（P4 已锁定形状）不携带"该连接自己当前生效的 idle 超时值"**——与 `H2SessionStatusRow` 不同（h2 侧逐会话携带 `effectivePingIntervalMs`/`effectiveKeepAliveMs`），WS 侧只有 `key`/`model`/`state`/`generation`。这意味着一次热重载进行中，某些连接仍带着旧 idle 超时、另一些已经 reschedule 到新值时，`transport.configured.pooledConnectionIdleTimeoutMs` 只能展示"当前配置值"，无法反映"这个具体连接实际在用哪个值"这层瞬时不一致。这是继承自 P4 已锁定契约的真实可观测性缺口，P5 阶段不能私自加字段修复它（会违反 README"逐字一致"约束）。**记录供主会话判断是否值得在未来某阶段重新打开 P4 契约来补上**。
13. **`transport` 顶层字段沿用既有 `z.record(z.string(), z.unknown())` open-object 惯例，而非给 zod 写一份逐字段镜像 schema**——与 `quota`/`rateLimiter`/`memory`/`upstream_ws` 等既有字段处理方式一致，非遗漏。但本阶段恰好是"给这个端点补类型精度"的阶段，值得摆出这个选项：若主会话认为诊断端点的 zod 契约也该做到字段级精确（换取 OpenAPI 文档/客户端生成精确度，代价是未来加字段需要同时改 TS 接口和 zod schema 两处），这是一个可选的加强，非本阶段默认路径。

### 跨阶段的共性提醒（非某一阶段独有，值得主会话在启动执行前统一确认一次）

14. 第 3、7 条（P2 的 `proxy-connect.ts` 范围扩张、P4 的 WS state 三值命名不对称）**均已于 2026-07-14 由用户 + gpt reviewer 裁决收敛**（见各条内联「已裁决」标注）：#3 接受纳入 P2、#7 改字面量 `"connecting"`。#4/#5 亦已裁决关闭。派发下游阶段前无遗留高优先分叉。
15. 第 2、6、8、11、12、13 条为**非阻断记录型待办**，不影响执行；主会话将在 wrap-up 分流——本轮不做的转入 `docs/todo/deferred-backlog.md` 长期跟踪，可顺手做的在收尾处理，可直接接受的确认后不再跟踪。
16. **【新增裁决 2026-07-14｜SOCKS `session_connect_timeout=0` validation 拒绝】** gpt reviewer 亲验 `node_modules/socks` 源码 `this.options.timeout || 30_000`——SOCKS 路传 0/省略都回落库地板 30s、**无法真禁用**。用户裁决：配了 SOCKS 代理时 validation 层 fail-fast 拒绝 `session_connect_timeout: 0`（宁可报错也不静默套 30s 冒充禁用），诚实表达能力边界优先于语义整齐。已回写 spec §6.7/D3 + ADR D5（commit 0e3926ab）+ plan-2（B8，commit `f427c6c2`/`dc592c3a`）。direct/HTTP CONNECT 路 0 仍真禁用。

## 计划文档清单（全部已落盘、已提交）

| 文件 | 阶段 | 提交状态 |
|---|---|---|
| `docs/plan/2026-07-14-transport-config-reorg/README.md` | 跨阶段共享接口清单 + 全局约束 | 已落盘并提交 |
| `docs/plan/2026-07-14-transport-config-reorg/plan-1-config-reorg.md` | P1 | 已落盘并提交 |
| `docs/plan/2026-07-14-transport-config-reorg/plan-2-new-knobs-wiring.md` | P2 | 已落盘并提交（`ca1a86dd`） |
| `docs/plan/2026-07-14-transport-config-reorg/plan-3-put-migration.md` | P3 | 已落盘并提交（`397b9d2c`） |
| `docs/plan/2026-07-14-transport-config-reorg/plan-4-hot-reload-reconcile.md` | P4 | 已落盘并提交（`a3f7f1ef`） |
| `docs/plan/2026-07-14-transport-config-reorg/plan-5-status-diagnostics.md` | P5 | 已落盘并提交（`e94286d9`） |
| `docs/plan/2026-07-14-transport-config-reorg/plan-kickoff.md`（本文件） | 汇总 | 已落盘并提交 |
