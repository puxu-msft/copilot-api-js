---
name: choosing-test-type
description: 当在 copilot-api-js 里要**为一个行为选测试类型**、或**审计一条已有测试是否放错了层**时使用——client-e2e vs golden/.http vs unit/property vs .it 集成 vs history。触发症状：「这个该不该用 e2e / 真 SDK」「这条 e2e 是不是冗余、能删吗」「这个断言该放哪一层」「测试类型错配」「真相在客户端还是在我方字节/落盘/纯函数」；或想批量审计一套测试的类型归属、清理「借真客户端之名的集成测试」。核心判据：**每种测试类型有唯一的「真相域」，一条测试只有当它断言的真相恰好落在该类型的真相域时才配用该类型**；否则是错配（blind/weak/redundant/misdirected）。区别于 `client-proxy-e2e-testing`（那个讲**怎么搭** e2e 骨架、本 skill 讲**该不该用** e2e、放错了怎么归位）与 `test-isolation`/`debugging-test-pollution`（那些讲隔离/污染、本 skill 讲类型选择）。
---

# 选测试类型 / 识别 e2e 错配（真相域归位）

一条测试值不值得用某个类型，唯一判据是：**它断言的「真相」是否恰好落在该类型的真相域**。放错层不是「多一层保险」，而是**用更贵、oracle 更弱、还可能假绿的方式重复覆盖**，并误导后人照它扩错配。

## 各测试类型的唯一真相域（一句话锚点）

| 类型 | 真相域（只有落在这里才配用） | 本项目入口 |
|---|---|---|
| **client-e2e**（真 `@anthropic-ai/sdk`/`claude` 当 oracle） | **真实客户端库/agent-loop 拿到 wire 后的反应**——parse/拼装、throws 的**具体类型**、静默丢帧、对畸形/index-gap/空块的**宽容度或崩溃/fold-vs-surface**、`.finalMessage()` 深等（跑完整 SSEDecoder+partial_json 拼接+JSON.parse）、agent stall/重试次数。**golden 逐字节证不了** | `tests/e2e-client/*.it.test.ts`，见 skill `client-proxy-e2e-testing` |
| **golden / .http**（`app.request()` + 断言转发字节 + 数 upstream 调用次数） | **我方转发的确切字节**（帧序、index densify、字段改写/剥离、合成帧）+ **重试透明**（upstream callCount）+ status。代理的 **OUTPUT** | `tests/**/*.http.test.ts`、`*-golden.http.test.ts` |
| **unit / property** | **纯函数逻辑**：canHandle/handle、repair、matcher、mapper、阈值/窗口检测 | `tests/**/*.unit.test.ts` |
| **.it 集成** | **多模块经真 driver/handler 的接线** + 真 oracle（`getEntry`/history 往返）——某 strategy 真的**被注册**、其 hints 真的**被应用**，而非孤立 canHandle | `tests/**/*.it.test.ts` |
| **history**（`getEntry`/`getHistory`） | **落盘了什么**：`state`（failed≠aborted）、upstreamRequest/Response 双腿、attempts——**客户端看不见** | `tests/history/*.it.test.ts` |

## 试金石（判 e2e 是否错配的唯一动作）

> **把这个断言换成一条 golden 逐字节断言（`app.request()` + 断言转发的 SSE bytes + `callCount`），会损失什么客户端信息？**
> - 损失「SDK 会不会 parse / throw 某类 / 累积 / choke / fold」→ **GENUINE**，留 e2e。
> - 只损失「SDK 把字节原样透传」，而正确字节被 SDK 拼装是**平凡的**（baseline 已覆盖）→ **REDUNDANT**，golden∘baseline 无新信息。

### 错配四型
- **oracle-blind**：真相客户端根本看不到（出站请求改写、落盘 history）→ golden/unit/history。
- **oracle-weak**：客户端只弱信号、真相在别处（history state/计费）→ history+计时。
- **oracle-redundant**：客户端行为 = 转发字节的**平凡映射**，真 SDK 无独立增量（只原样 surface 字段、无 parse/throw/累积/fold）→ golden 更直接。
- **oracle-misdirected**：名义 e2e，实际断言我方字节或纯函数。

### redundant 的精确判定：golden ∘ baseline
一条 e2e 若 = `golden(输出字节正确) ∘ baseline(SDK 拼装 clean 流)`，则 redundant。**识别信号**：断言的 SDK 行为是「拿到一个正常 dense/valid 流后正确拼装」——这由 streaming baseline（`streaming: SDK .finalMessage() assembles a coherent turn`）平凡覆盖，reactive-retry/过滤/字段改写只要输出字节对，SDK 那步不提供增量。

## 审计流程（批量清错配）

1. **对每条 e2e 套试金石**，初判 GENUINE / MISFIT-四型。
2. **疑似 redundant → grep 找等价覆盖**，但**区分「话题相邻」vs「真等价」**：读 file:line 确认 fixture 形状 + 断言一致。**陷阱：stream 与 non-stream 常是两条独立生产路径**（本项目 tool-name restore 流式 `server-tool-filter.ts:126` vs 非流式 `:193`），non-streaming golden **不覆盖** streaming——误判等价会误删唯一覆盖。
3. **跨模型对抗审计，别自我背书**（尤其审自己刚写的测试）：派**异模型** reviewer（`gpt-souls:reviewer` 审 Claude 写的，或反之），给**显式唯一判据 + 试金石**。reviewer 的「已覆盖/可删」绝对断言**亲自读它引用的每个 file:line 复核**（→ `verifying-authoritative-claims`）。**实战教训**：本次两个 reviewer 都逮到我把 non-streaming golden 误当 streaming 覆盖、险些误删唯一流式覆盖；GPT 还逮到一条 oracle 缺陷（标题声称 typed subclass、实际只断言基类）。
4. **oracle 缺陷单独查**：断言必须真触达标题/注释声称的 claim（声称 `BadRequestError` 就得 `toBeInstanceOf(BadRequestError)`，不能只 `APIError`+status）。

## 修复取向（零覆盖损失，删 vs 迁移 vs 先补再删）

**先补/迁替代覆盖，再删 e2e——任何时刻不留覆盖缺口。**

| 情形 | 动作 |
|---|---|
| 已有**等价** golden/.it/unit 覆盖 | 直接删 e2e（先读 file:line 坐实等价，非话题相邻） |
| 仅 **unit 覆盖**（canHandle/handle），缺**端到端 driver-wiring**（strategy 是否被注册+hints 是否被应用） | **迁到 `.http`/`.it`**：保 `app.request`+callCount+wire 断言、剥掉多余 SDK 层。unit 绿 ≠ driver 接线对 |
| **无任何覆盖**（如某条 streaming 独立路径） | **先补 golden 再删**（补流式 byte-golden 断言转发帧的字段） |

**迁移/新增的 golden 必须变异验证有牙**（关掉被测源码行为→只该测试红）：用**假绿 golden 换掉真 e2e** 比不动更糟。

## 本项目实例锚点（file:line，直接引用）

- **redundant，删**：server-tool filter → `tests/anthropic/response-rewrite-golden.http.test.ts:585`（S1 streaming suppress+densify）；tool-call recovery → 同文件 `:610`（S3a）。
- **仅 unit→迁 .http**：cache_control-subfield / unsupported-beta / poisoned-thinking 三腿 → 新建 `tests/anthropic/reactive-retry-legs-wiring.http.test.ts`（400→真 driver 匹配+retry→callCount===2）。tool-field/server-tool/buffered 三腿已有 `reactive-retry-leg.it` / `server-tool-rejection.http:149` / `streaming-l2-buffered.http:161`，直接删。
- **stream≠non-stream 陷阱**：tool-name restore——`tool-name-sanitize.http` 原只有 `stream:false`（非流式路径），补了流式 case 才敢删 e2e。
- **oracle 缺陷**：HTTP-400 e2e 标题「TYPED BadRequestError」却只断言 `APIError`——任何 400 都过，改断言 `BadRequestError`。

## backlog 归位速查（这些**别当 e2e** 去做）

| 场景 | 为何非 e2e | 正确归属（本项目已存在） |
|---|---|---|
| B22 cache_control 剥离透明 | 出站请求改写、客户端看不到 | `cache-control-subfield-strip.unit` / `.http` 断出站字节 |
| B5 非流式语义截断 | 有趣的 fail 在落盘侧 | `non-stream-truncation.http` + history 断言 |
| B17 reaper/header-timeout 中止分类 | 三类中止客户端抛同一字面量 | `client-response-status.it`（history state 600 vs 300）+ 真计时 |
| B20 repetition-detector 终止 | 阈值/窗口是纯函数 | `repetition-detector.unit` |

## 收敛后的 e2e 该长什么样

留下的 client-e2e 应是**纯 SDK-behavior 集**：throws-类型（`APIUserAbortError`/`RateLimitError`/`BadRequestError`）、静默丢帧（eventless）、fold-vs-surface（空 delta / anchor 空块）、深等累积（tool_use.input / thinking.signature）、accept-set 宽容（event≠type）、vendor-neutral（第二个真 SDK）。**每条都能通过试金石**：换成 golden 会损失一个 golden 证不了的客户端反应。
