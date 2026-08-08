---
name: test-isolation
description: 当写/调 copilot-api-js 后端测试遇隔离问题时使用——bun 单进程跨文件单例泄漏、mock.module 无 teardown、测试污染真实 $HOME/~/.claude、Cannot use closed database、network guard、新增 module-global 单例。含 useIsolatedRuntime/RESETTERS/sandbox-paths preload/后缀分层与脚本速查。
---

# 测试隔离速查

后端测试两维度：功能域目录镜像 `src/lib/`，隔离后缀控速度。脚本走 `bun run`（非 npm）：`test:backend`=unit+it+http、`test:unit/it/http` 按后缀、`test:e2e*/ui` 单列。

## 选用

| 测试类型 | 用 | 给出 |
|---|---|---|
| `.unit`（纯函数） | `autoRestoreState()` / `autoRestoreFetch()` | 轻量快照还原 |
| `.it`/`.http`（起 runtime/app） | `tests/helpers/isolated-fixture.ts` 的 `useIsolatedRuntime()` | history `:memory:` + state 快照 + afterEach reset RESETTERS + 未 mock 上游即 reject |

**别**同文件叠加 `autoRestoreState()` 与 `useIsolatedRuntime()`（快照时机互覆盖）。

## 铁律

- 用 DI/fetch-mock，**不用 `mock.module`**（进程级无 teardown）。
- fs I/O 用注入临时目录，**绝不写真实 $HOME/~/.claude/~/.local/share/copilot-api**。**Bun `os.homedir()` 忽略 `process.env.HOME` mutation**（运行时返回真实 `/home/xp`）——只能 DI `options.home`/paths 或 preload 沙箱隔离，绝不靠 env mutation、绝不把 `mock.module("node:os")` 当接缝（"修复/移除" mock 前先问它是否还承担 fs/网络封闭）。两次真实事故：把 `mock.module("node:os")` 换成 `process.env.HOME=tempDir` → `writeClaudeCodeConfig()` 覆盖真实 `~/.claude.json`；13 个 negotiation 测试里 9 个没沙箱 `PATHS.NEGOTIATION_STATES`、`resetAnthropicFeatureNegotiationForTesting()` 把空 map 持久化 → 每次 `bun test` 擦盖真实 `negotiation-states.json`、用户重启重学 beta（诊断靠 history 探针 + 未沙箱测试看真实文件 mtime，见 skill `empirical-verification`「记录消失」；paper-analysis 曾误判"无问题"被实测推翻）。**任何"test reset/teardown 助手持久化到磁盘"都是危险信号**：它写 `PATHS.X`、未沙箱即真实文件。
- 新增 module-global 单例 → 提供 `reset*ForTests` 并登记 `RESETTERS`，否则 `resetters-complete.unit.test.ts` 守卫 fail。

## 地板防线

`bunfig.toml` `[test].preload`（`tests/helpers/sandbox-paths.ts`）把 `XDG_DATA_HOME`+`CODEX_HOME` 重定向临时目录，兜住 APP_DIR 派生持久化（仅 bun test）。双守卫 sandbox-paths.unit + real-state-guard.it。完整设计 docs/spec/test-env-isolation.md（权威落地态）、DESIGN「测试组织」。相关经验 [[feedback_tests_never_touch_real_env]]、[[methodology-sync-to-async-persistence-refactor-invariants]]。

## config 隔离与 state 隔离是**两根正交的轴**

上面那张选用表管的是 **state 轴**（进程内 module-global 的快照/还原）。它管不住 **config 轴**：请求处理过程中会调 `applyConfigToState()`，**把「生效 config」里显式出现的键重新写回 state**，而这个覆盖发生在请求级 policy 冻结**之前**。于是 full-app / route 层的测试里，`beforeEach` 里的 `setStateForTests({ <config-managed 键> })` **可能是彻底的空操作**——测试实际全程跑在生效 config 的值上。

**「生效 config」= bundled + 用户/测试两层合并后的结果，不是仓库根那一份 `config.yaml`。** 这个区分是本节所有判据的地基，别在任何一步把它缩回「仓库根 config.yaml」。

**识别指纹**：同一个 policy 对象里**一半字段听测试、一半字段听配置文件**——生效 config 里有的那些被覆盖，没有的那些保留了测试值。看到这种不对称，立刻怀疑本条。

**这个坑最恶心的地方在 mutation control**：拿「翻状态」当 mutation 会**永远不变红**，而「没变红」有两种相反解释（测试没咬住 vs mutation 根本没生效），你会把它读成前者。判据见 [[methodology-verify-the-mutation-actually-applied]]。

### 先查：你打的这条路径到底会不会热加载

**顺序是「先判 harness，再判 route/codec」。跳过第一步会把生产路径判反。**

**① harness 层**——`src/server.ts:132-142` 是一条**生产 middleware**：除 liveness 外**每请求无条件**先 `await applyConfigToState()`（`:139`）。所以：

| 你跑的是 | 结论 |
|---|---|
| 真实 `createServer()` / 生产实例 | **无条件热加载**，下面第②步整个不用看 |
| `createFullTestApp()`（默认，不传 `preMiddleware`） | **没有这一层**（`tests/helpers/test-app.ts:54` 只在显式传入时装），才轮到第②步 |
| `createFullTestApp({ preMiddleware })` | 看你自己装了什么 |

**这一格最容易错**：同一个 Responses / Messages payload，在 `createServer` 下必 reload，在默认 `createFullTestApp` 下才由 route/codec 条件决定。**别拿测试 harness 下的观察去推断生产行为，反过来也不行。**

**② route / codec 层**（仅当 harness 没有那条 middleware 时才决定成败）——判据不是「route 文件里有没有 `applyConfigToState`」，而是「沿真实入口走到 policy 冻结点为止，这条路径上有没有任何一处调它」。有**两类**调用点，只看第一类会把 Responses / Gemini 误判成安全：

| 类别 | 位置 | 条件 |
|---|---|---|
| **route-level 直接调** | `src/routes/chat-completions/handler-v4.ts:179` | 无条件 |
| | `src/routes/messages/handler-v4.ts:669` | **仅当 `payload.system` 存在** |
| | `src/routes/config/route.ts:159` | 写配置之后 |
| **经 system-prompt override 间接调** | `src/lib/system-prompt/override.ts:81`（`processSystemPromptText`）、`:109`（`processAnthropicSystem`）、`:133`（`processOpenAIMessages`） | 进到这三个函数就调 |
| | Responses HTTP：codec `translateInbound` → `applyInboundSystemPrompt`（`src/lib/codec/openai-responses/codec.ts:325`）→ `src/lib/system-prompt/inbound.ts:40` `processResponsesInstructions` | 视 payload 有无 `instructions`（无则早退，不调） |
| | Responses WS：`src/routes/responses/ws.ts:291` | 独立入口，别忘了它 |
| | Gemini：`src/lib/codec/gemini/codec.ts:241` → `processOpenAIMessages` | codec 路径上无条件 |

**所以 `src/routes/responses/handler-v4.ts` 与 `src/routes/gemini/handler-v4.ts` 里那两行「本路由不加 route-level `applyConfigToState`」的注释，说的是「不在这里直接调」，不是「这条路径不热加载」。** 把注释读成后者，就会给 Responses / Gemini 的 full-app 测试放行一个其实存在的覆盖。

⚠️ **但「会 reload」推不出「你那个键钉不住」——判定必须落到目标键的时序上。** driver 的顺序是 **S1a `parse`（同步）→ S1b `translateInbound`（异步）**（`src/lib/pipeline/driver.ts:586-593`），而 Responses / Gemini 的间接 apply 发生在 **S1b**。于是**在 parse 期就被消费的键，reload 来得太晚、根本盖不住它**——例如 `state.normalizeResponsesCallIds`（`src/lib/codec/openai-responses/codec.ts:467`）、image-tool filter（`:426`）、tool-name mapper（`:471-473`）都在 parse 里读 state，这些键上 `setStateForTests` **本请求确实生效**。

**逐键画一条时序，只有三点齐了才判「钉不住」**：

```
最后一次测试写入 state  →  config apply  →  该键的第一个消费点 / 快照点
```

**apply 落在「测试写入」与「该键首个消费点」之间**，才是覆盖；apply 在首个消费点**之后**（如上面那几个 parse-time 键），测试值照样被采信。上面那张表给的是「这条路径会不会 reload」这个**事实**，**不是**「所有 config-managed 键都被覆盖」这个结论——别跳这一步。

**③ 这个键在不在生效 config 里**——**别用 `rg <key> config.yaml`**：那只看了 `PATHS.BUNDLED_CONFIG_YAML`（仓库根那份）。生效 config 是 `loadConfig()` 把 **bundled + 用户/测试 `PATHS.CONFIG_YAML`** 合并的结果（`src/lib/config/config.ts:586-607`），而测试还可能用 `setBundledConfigForTests` 整个换掉 bundled 那层。三种 false-green 都真实存在：键只在 sandbox 的 user config 里、键只在 synthetic bundled 对象里、用户层把 bundled 的值覆盖掉了。
**可执行的判据只有一个：在本测试的实际环境里把 raw 生效 config 读出来**——装好 seam（`PATHS` 沙箱 + synthetic bundled）并 `resetConfigCache()` 之后，在 app 启动前的 async `beforeEach` 里 `await loadConfig()`，看那个 **snake_case** 键在不在、值是什么。

⚠️ **别拿 `GET /api/config` 当这一步的 oracle。** 它调 `buildEffectiveConfig()`，读的是**已 apply 之后的 camelCase `state` 投影**（`src/routes/config/route.ts:191-193`），不是 bundled+user 合并后的 snake_case `Config`。按 snake_case 键去查它的响应会判成 absent；而在 synthetic/user config 还没被 apply 过时，读到的是旧 state。（它是**另一个问题**的正确 oracle——「这个进程此刻持有的运行态值是多少」——那属于事后归因，见 skill `debugging-claude-client-connection`。）

**注入合同因此多一条**：user-config 层（`PATHS.CONFIG_YAML`，被 sandbox preload 重定向）必须是空的、或由本 suite 明确拥有——否则你只控制了 bundled 一半。

**三步都要做**：漏①会把生产路径判反；漏②会漏掉 Responses/Gemini 的间接覆盖、或反过来把 parse-time 键误判成被覆盖；漏③会漏掉「路径确实 reload，但这个键根本不在生效 config 里」（那种情况 state seam 仍然有效）。**②与③是两个独立的否决点：任一为否，`setStateForTests` 就仍然有效。**

### 怎么修

- **正解是从 config 层注入，但注入本身不够——必须同时清 effective config 缓存**：`setBundledConfigForTests(<对象>)` 只改 `cachedBundledConfig`（`src/lib/config/config.ts:641`），而 `loadConfig()` 在 debounce 窗口内或 mtime 未变时**直接返回旧的 `cachedConfig`**（`:590-598`），你注入的东西根本轮不到参与 merge。所以合同是：

  ```
  注入：setBundledConfigForTests(obj) → resetConfigCache()      // 后者清 cachedConfig（:629）
  还原：setBundledConfigForTests(null) → resetConfigCache()      // 不清 = 把合成 config 泄漏给后续测试
  ```

  必要时再 `resetApplyState()`（`:1222`）让「首次 apply」的一次性分支重新武装；`resetBundledConfigCacheForTests()`（`:636`）只清 bundled 那一层，用途是让真实 bundled 文件被重读。
  **活例里也有没清 effective cache 的写法**（`tests/openai/chat-completions-v4.http.test.ts:207,212`），**别照抄那一处**；`tests/config/config-yaml-routes.http.test.ts:58,69`、`tests/observability/unknown-endpoint-server.it.test.ts:62,79` 可作参考，但同样要自己确认缓存被清过。
- **合成的 bundled config 只声明本 suite 明确拥有的键。** 整包复制一份 `config.yaml` 会**无意启用不归本 suite 管的行为**，制造出比原问题更难查的耦合。
- **「缺席」与「显式赋默认值」是两种不同语义，别混**：`applyConfigToState()` 只对**生效 config 里 `!== undefined`** 的字段写回 state，缺席的字段保留 live state；而 `mergeBySchema()` 在 user 侧缺席时会保留 **bundled** 的值（`src/lib/config/config.ts:535-578`）。所以「让某键缺席以保留 state seam」要求它在**生效 config**（bundled+user 合并后）里缺席，不只是在你的合成对象里缺席。
- **想在这一层做 mutation control，去破坏生产代码**（例如把某 rewrite 的 `appliesTo` 改成 `() => false`），别翻状态。
- **退一层也是正解**：断言不经路由的单测层；或者在 full-app 层只刻画**默认值**——默认值恰好就是生效配置里那个，所以它是这一层唯一可靠的断言对象。

资源型 module-global 单例（Worker/timer/socket/DB）的 reset 有它自己的一套 async 生命周期合同，**不在本 skill**——见 skill `owned-singleton-lifecycle`。

**本节是这个问题的当前操作合同（canonical）。** 记忆 [[reference-config-yaml-overwrites-setstatefortests-per-request]] 保留 2026-07-28 那次的事故证据与指纹，口径以本节为准。

## 流式 / 时序测试（heartbeat 等异步注入）

测流式 handler 的异步注入(sink heartbeat、延迟-commit)用 `FakeClock`(tests/helpers/fake-clock.ts:拦 setTimeout/Date.now,`advance(ms)` 逐 due-timer fire + drain 2 microtask 让 await settle)。**mid-stream 场景**(上游发部分帧后静默):mock fetch 返回 `Response(ReadableStream)`、**test 持有 controller** 精确控帧——`ctrl.enqueue(block_start)` + `await Promise.resolve()×N` drain microtask 让 pump 消费到(内部状态如 openBlock 更新)、再 `clock.advance` 触发 timer、再 `ctrl.enqueue(rest)` + `close`。**坑**:注入的心跳帧落在预期 block **之前** = drain 步数不够(pump 还没 write 到那帧)、**非 bug**;分步 drain 修(生产中静默发生在 block 已 write 之后)。ReadableStream pull 走 microtask(FakeClock 不拦)故 drain 有效;但依赖 drain 步数本质**脆弱**,连跑 10 次确认确定性(见 user-level `verifying-authoritative-claims` flaky)。活案例 tests/anthropic/keepalive-e2e.http、stream-immediate-keepalive.http。证明「改的代码真被执行」的活路径/分层验证见 skill `empirical-verification`。