# Kickoff:上游 Transport middleware(ad-hoc hook 机制)

> **⚠️ 已被取代(SUPERSEDED,2026-07-12)。** 本 kickoff 描述的是 SDD 开始前的调研锚点;特性已完整实施并合并 master(`118a9c33`)。**实际设计偏离本文档**:采用 driver 编排的三挂载点(非本文档设想的 HookedTransport decorator)。权威现状看:spec [2026-07-12-upstream-hook-middleware.md](../spec/2026-07-12-upstream-hook-middleware.md) + ADR [decisions/2026-07-12-driver-orchestrated-upstream-hooks.md](../decisions/2026-07-12-driver-orchestrated-upstream-hooks.md) + [README.md](2026-07-12-upstream-hook-middleware/README.md)(阶段 DAG) + 用法 skill `upstream-hook-mocking`。本文档仅存作历史调研快照,勿据此重新实施。

> **本文档是新会话的启动起点。** 这是一个已调研出方向、未开始 SDD 的中大型新特性。新会话应从 `superpowers:brainstorming` 开始,敲定下方「未决设计问题」后再写 spec → plan → 执行。本文档提供已完成的调研锚点,免于重建。

**源起**:2026-07-12 cache_control 子字段剥离特性的实测中,发现「验证代理行为不得不真发 GHC」(消耗 Copilot 额度、依赖网络、且无法构造特定上游响应如 400 来测 reactive 学习腿)。用户提出需要一个 hook 机制:既用本 proxy 的完整处理管线,又能给出 mock 上游交互。

## 用户已确认的范围(2026-07-12 AskUserQuestion)

- **核心用途(全选)**:① Mock 上游响应 ② 拦截/改写请求响应 ③ 录制-回放 ④ 注入故障/延迟
- **挂载方式**:config 声明 + 可选指向一个 ad-hoc JS/TS hook 文件(runtime code),测试时挂载、生产默认不加载

## 统一抽象:Transport middleware(decorator)

关键调研发现——所有上游交互经过一个窄接口:

- **`Transport.send(wire: PreparedRequest, env: RequestEnvelope): Promise<UpstreamStream>`**([src/lib/pipeline/types.ts:108](../../src/lib/pipeline/types.ts#L108))—— 唯一的上游边界
- driver 在 retry 循环里每 attempt 调一次:[src/lib/pipeline/driver.ts:310](../../src/lib/pipeline/driver.ts#L310) `await deps.transport.send(wire, current)`
- 多个 transport 实现都满足此契约:`http-transport.ts`(CC/Anthropic)、`responses-transport.ts`(Responses)

一个 `HookedTransport`(包裹真实 transport,实现同一 `Transport` 接口)即可统一四个用途,hook 签名 `(wire, env, next) => Promise<UpstreamStream>`:

| 用途 | hook 行为 |
|---|---|
| Mock 上游响应 | 不调 `next`,返回合成 `UpstreamStream`(离线/零额度) |
| 拦截/改写 | 调 `next` 前改 `wire`,或调 `next` 后改返回 stream |
| 录制-回放 | 录制:调 `next` 存档;回放:返回存档 stream 不调 `next` |
| 注入故障/延迟 | 返回 error/延迟/断流的 `UpstreamStream` |

**天然优势**:hook 只在最末端上游边界介入,前面的 sanitize / cache_control 剥离 / 格式翻译 / retry 腿全是**真实处理**——复用代理完整管线,只 mock 上游那一段。

## 挂载(config + ad-hoc 文件)

config 声明 hook 文件路径 → 启动时动态 `import()` → 若配置了就用 `HookedTransport` 包裹真实 transport,否则透明直通(生产默认不加载、零开销)。对齐现有 config 声明式 + 可选 code 的模式。

## 未决设计问题(brainstorming 敲定)

1. **`UpstreamStream` 合成契约**:它是流式 SSE 帧接口。mock 要能构造合法帧序列。给 hook 高层 helper(如 `mockAnthropicResponse(text)` 自动生成帧)?还是让 hook 直接产 raw 帧?两者都要?
2. **hook 粒度**:单个全局 hook,还是可注册多个(chain)?是否按 model/endpoint 条件匹配?
3. **录制格式**:复用现有 `history.db` 的 `sseEvents`(已存完整上游帧,回放可能直接读 history!),还是独立存档文件?—— 这条可能大幅简化录制-回放,值得优先探。
4. **安全**:ad-hoc code 执行 = 任意代码。按项目 `internal-tool-security-posture`(开发工具、内部使用)可接受,但设计上要 config 显式启用 + 建议仅测试环境。

## 已排除/注意

- `UpstreamStream` 结构见 [types.ts:63](../../src/lib/pipeline/types.ts#L63)——合成 mock 须满足此契约(headers + 帧迭代 + 终止)。
- 现有「hook」只有 config 层 rewrite rules(system_rewrite / payload_rewrites),作用在请求体,**不是**上游 mock——本特性是新层。
- 现有测试用 mock codec/transport(driver 单测),但那是测试脚手架,非用户可挂载的 runtime hook。

## 新会话启动指令(复制用)

```
读 docs/plan/2026-07-12-upstream-hook-middleware-KICKOFF.md(已完成的调研锚点)+ 项目 CLAUDE.md。
这是一个上游 Transport middleware(ad-hoc hook)新特性,用户已确认范围(四用途全选 + config+ad-hoc 文件挂载)。
从 superpowers:brainstorming 开始,优先敲定 kickoff 里的四个「未决设计问题」(尤其 #3 录制复用 history.sseEvents 可能大幅简化),再走 spec → plan → 执行。
纪律:spec-driven、subagent 对抗评审、protect-user-main-server(可在非 4141 端口起隔离实例实测)。
```
