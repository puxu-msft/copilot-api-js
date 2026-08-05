# WebSearch 最终代码独立评审

> **转录件。** Reviewer 报告写在其隔离树，以下由主会话从完整返回值转录。评审基线 `d530cbda03e6586558caa8bde927e035ac3279ce`；焦点测试 148 pass / 0 fail，typecheck 通过。

## Round 1

- Verdict：修复 major 后可进入下一阶段，不可合并。
- Blocker：0。
- Major：4。

### MAJOR-1 — Responses custom choice 在 CC fallback 丢失

`ResponsesToolChoice` 未表示合法 `{type:"custom",name}`；Responses custom tool 已降级成 CC function tool，但强制 choice 被删除，实际语义从 forced 变 auto。须补 union、custom-only/mixed/named-custom 正样本，并沿同一降级映射保留 choice。

### MAJOR-2 — Anthropic→CC fallback 仍留悬空 choice

Typed web_search 在 Anthropic→CC `translateTools` 被剥离后，named choice 仍变 function choice，`any` 仍变 required。须基于翻译后存活工具过滤 named/required，补 builtin/function/missing/zero-tools 矩阵。

### MAJOR-3 — action optional 类型放宽过度

实测只证明 incomplete `web_search_call` 可缺 action；当前类型把 action 对全部 status 设 optional，错误接受 completed-missing-action。Renderer 可继续宽容，但类型应为 discriminated union，只对 incomplete 变体放宽，并补 completed/incomplete 类型与运行时正反样本。

### MAJOR-4 — 降级文本丢失 opaque id

流式/非流式共享 formatter 只保留 query/status，丢弃 incomplete call 唯一可关联的 `id`。须把 id 写入共享 formatter，两腿测试断言相同 id 可见。

### 结构建议

长期把各 request translator 的“translated tools 决定 choice”抽成窄共享 primitive，或至少建立跨腿表驱动矩阵。本轮至少关闭 Anthropic→CC 与 custom 漏点。

## 主会话处置

- **MAJOR-1：采纳（C）**。`ResponsesToolChoice` 增加 named custom；Responses→CC custom choice 与已降级 function tool 同名存活时转成 CC function choice。先写 custom forced RED，旧实现收到 undefined；修后 GREEN，并用精确回退 mutation 再次变红。
- **MAJOR-2：采纳（C）**。Anthropic→CC choice 改为读取 translated tools；typed server tool 全被剥时省略 named/required，missing named function 也省略；合法 function/auto/none 正样本保留。三条新测试旧实现均 RED。
- **MAJOR-3：采纳（C）**。WebSearch call 类型拆为常规状态（action 必填）与 GHC `status:"incomplete"`（action 可缺）两 variant；renderer 仍 optional-chain 防御无类型 wire。`@ts-expect-error` 锁 completed-missing-action 不得类型通过，同时运行时越界样本不崩。
- **MAJOR-4：采纳（C）**。共享 `webSearchCallToText` 增加 opaque id，流式与非流式断言同一格式并覆盖 incomplete id。
- **结构建议：部分采纳（C）**。本轮补齐跨腿矩阵测试并收窄 `ResponsesNamedToolChoice` 内部类型；未抽跨协议共享 primitive，因为三个目标协议的工具声明形状不同，错误更适合由各腿 translated-tools gate + 表驱动测试约束。

## Round 2

待原 reviewer 复审。
