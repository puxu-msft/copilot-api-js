# 客户端无 open block 窗口的 >300s keepalive carrier 对比设计

- 状态：**已裁决：采用方案 A**（用户 2026-07-27）；实施计划见 [`docs/plan/2026-07-27-inter-block-anchor-allocator/`](../plan/2026-07-27-inter-block-anchor-allocator/)
- 日期：2026-07-27
- 关联根因：[client↔proxy keepalive 300s](../todo/2026-07-22-client-proxy-keepalive-300s.md)
- 关联 ADR：[续写重试 + 顺序输出](../decisions/2026-07-22-continuation-retry-sequential-anchor.md)
- 关联记账 SSOT：[Q5 三方叠加计划](../plan/2026-07-22-max-tokens-continuation/plan-Q5-three-way-overlap.md)
- 评审记录：[GPT 代码评审](../todo/keepalive-300s-fix-review-gpt.md) · [Claude 设计评审](2026-07-27-inter-block-keepalive-carrier-review-claude.md)

## 1. 判据与冻结前提

1. **长远正确 + 完整**：覆盖 pre-content、客户端已有 open block、客户端无 open block 三种合法静默，不以“少见”代替协议正确。
2. **块级 buffered 是既定终态**：不接受 live 流式，也不接受整响应缓冲。
3. **客户端轨是保活判据**：carrier是否合法，只看客户端已收到的帧；不能拿上游 open block代替客户端 open block。
4. **架构健康 > 回归风险**：正确方案需要完成既有未接线原语时，不因改动面大而降级。
5. **暂缓项完整文档化**：若先以 C 解阻，必须记录解除条件——方案 A 必须在 Anthropic 块级 buffered 默认翻转前落地。
6. **独立 oracle**：producer 全序、真实 `@anthropic-ai/sdk` 累积、真 Claude Code >300s 缺一不可。

## 2. 事实、证据等级与目标制度

### 2.1 自测实证

- CC 2.1.220：ping 不重置 300s event-idle；空 `text_delta` / `thinking_delta` / `input_json_delta` 可重置。
- commits `131ea3b2` / `faaa37e7`：两处 response rewrite 的空 delta吞帧已修；mutation会使对应测试转红。
- 默认 `ping + 200s content deadline` 的 live/open-block探针：真 CC 三次约315.5s PASS，最终文本无痕。
- 短请求 `escalate=0/200`：1675 bytes，SHA-256 均为 `8691db71ca3b692468ae91dfc2df108871c8f5f684acc73f3832975d60f2a6a0`。

这些实证发生在今天的 **live** 路径；它们证明 carrier 与计时机制，不证明块级 buffered 终态的客户端轨有 open block。

### 2.2 reviewer 实证，经代码复核后采信

- 块级 buffered producer探针：客户端在上游 `content_block_stop` 之前一帧都收不到；start+deltas+stop在边界原子 flush。
- 重复 completed index probe：`real@0 → anchor@0 → real@1` 被真实 SDK累积为 `first, second, empty-anchor`，不是无害结构异常。
- CC 2.1.207 打包源码：`content_block_stop` 时立刻 yield该块，随后 `addTool → processQueue → executeTool`；工具是 **eager per-block** 执行，不等完整 assistant turn。
- 8000条真实 Anthropic History（2.5天，live制度）按客户端轨最大事件间隔分类：

| 最大间隔发生时客户端轨状态 | 条数 |
|---|---:|
| pre-content | 17 |
| open-block | 16 |
| 真 inter-block | 2 |

阈值分布：>300s 12条、>200s 35条、>150s 68条。两条约300s open-block请求均 aborted。迁到块级 buffered 后，这16条 open-block样本会全部变成**客户端无 open block**；其中首块尚未提交的部分归入 pre-content，C仍覆盖，真正失守的是**首块提交后的长生成**。

### 2.3 静态推导

- B 的实现改动面与 continuation/ledger冲突来自读码，尚未做 pending-stop行为PoC。
- A 的多轮历史回传风险、continuation具体撞车、心跳/flush并发缝来自控制流推导，必须列为实施期强制 oracle。

## 3. 目标问题的精确定义

在块级 buffered 终态，正在生成的上游块不会在客户端轨保持 open：driver只把帧放进 buffer，直到 `content_block_stop` 才一次性写 start+deltas+stop。因此：

- 首块提交前的所有长生成，在客户端看来都是 pre-content。
- 首块提交后，后续任一未闭合块的长生成，在客户端看来都是“无 open block 窗口”。
- 现有 `contentFrame(openBlock)` 原-index分支在块级 buffered 终态不可达；它只对历史 live腿有意义，不能冒充终态覆盖。

本设计选择的是：如何在客户端**无 open block**时合法产生一个可重置CC watchdog的content delta。

## 4. 方案 A：generation-scoped 单调 wire-index allocator

### 4.1 机制

所有 synthetic anchor、真实块、continuation块共享一个单调 wire frontier：

```text
pre-anchor@0 → real@1 → gap-anchor@2 → real@3 → continuation-real@4 → ...
```

无 open block窗口达到阈值时，gap anchor占下一个未用index；下一真实块前先关anchor，再从同一frontier分配真实块index。任一时刻至多一个block open。

### 4.2 改动面

- `keepalive-anchor.ts`：复用 `createAnchorIndexAllocator`；固定index-0三帧改为factory；分开pre-content/gap injector。
- `pipeline/types.ts`：allocator挂入`AnchorState`；`AnchorHooks`改frame factory。
- `delivery/{session,types}.ts`：envelope/content独立latch，content按gap重新武装；分配和写入同临界区。
- `client-sink.ts`：delivery与allocator frontier统一，无anchor结构性旁路remap。
- `driver.ts`：buffered flush、retreat改runtime frontier；recovery/continuation不重复记账。
- `live-reconcile.ts`：迁移期同步runtime offset。
- `handler-v4.ts`：创建generation allocator并线程化。

### 4.3 既有设计复用

姊妹plan Task 1.1–1.3大部分可复用：allocator已有测试；plan已枚举per-gap latch、buffered flush、retreat、live-reconcile三个remap站点和目标全序。新增工作是接入当前generation delivery owner，并取代后来形成的continuation双偏移。

### 4.4 高风险约束

1. **每请求热路径**：今天remap被三重门挡住；A会让每请求参与index记账。漏调/重复调会静默损坏普通短请求。
2. **结构性短路**：必须提供`anchorsOpened===0`旁路，未开anchor时不进入动态remap。
3. **continuation具体撞车**：序列`anchor@0 → real@1(upstream0) → gap-anchor@2 → real@3(upstream1)`后，续写腿上游index从0重启。若旧mapping先映到wire1，再加`wireDeliveredBlocks=2`，得到已占用的wire3。Q5 SSOT中的`wireIndex = i + anchorShift + continuationOffset`必须作废；唯一权威改为frontier，不能叠偏移。
4. **分配并发缝**：heartbeat anchor与driver flush并发。`suspendHeartbeat`不等待在飞injector；分配必须在delivery serializer内，或首await前同步分配+提交，配tick卡flush await的oracle。
5. **ADR修订**：D2第3点的论域扩为“真实+合成块由单一frontier严格顺序分配”。
6. **多轮回传**：空anchor会进入客户端历史；现有真CC均`numTurns=1`。必须做`numTurns≥2`，若上游拒空text block，入站清洗或替代载体属于A必要范围。
7. **已排除担忧**：anchor绕过buffer，不进入continuation合成assistant前缀。

### 4.5 客户端影响

普通短请求由无anchor结构短路保持不变；deadline窗口新增合法顺序空text block；tool_use stop不被推迟，保留eager执行时机。A的主要负面是remap错误可静默重排内容，必须用强oracle降低风险。

### 4.6 测试/oracle

- producer单调全序、`maxOpen===1`、多anchor/real交替。
- buffered/retreat/live/recovery/continuation各自mutation。
- 无anchor正样本：结构性旁路、原frame引用/bytes不变。
- tick与flush并发分配。
- continuation上游index重启后仍从frontier分配。
- 重捕所有anchor结构golden。
- 真SDK累积顺序与wire一致。
- 真CC inter-block >300s、`numTurns≥2`历史回传、短请求SHA。

### 4.7 失效条件

任一producer绕过allocator；不同腿重建allocator；分配/写入不同步；客户端回传空anchor被上游拒绝。

## 5. 方案 B：延迟 `content_block_stop`

### 5.1 机制与改动面

boundary时写块内容但扣住stop，使客户端block保持open；下一block或终局前补stop。需要扩展commit boundary表达力、拆driver flush、generation pending-stop fence、重定义`committedAny`/continuation ledger，并覆盖handler error。若迁移期保留live，还需在live-reconcile/旧stream pump实现同一fence；终态不含live时必须明确声明不计。

### 5.2 tool执行代价：确定事实

CC是 eager per-block：`app.pretty.js:298301-298310`在每个`content_block_stop`就yield该块，`:293787`立即`addTool`，`:291016,291022-291028`随即`processQueue → executeTool`。因此B扣stop会确定性推迟工具执行整个长窗口。仅对text/thinking启用会让tool_use生成期在块级buffered终态同样处于无-open窗口，覆盖缺口与C同量级。

### 5.3 B的真实优点

1. 不生成synthetic content block，不触碰D2空text形状判据，也没有anchor历史回传风险。
2. 漏fence通常表现为悬挂open block，结构异常可检测；A漏remap可能静默重排内容，更严重、更隐蔽。
3. 若未来CC取消eager tool执行，或A落地后只想给text/thinking加更干净载体，B值得重估。

### 5.4 顺序、客户端影响与失效条件

B零新index、零remap，任一时刻至多一个block open；但block完成与tool执行变晚，并让“wire未闭合”与“ledger已提交”分裂。任一新block/terminal/error绕过fence即失败。

### 5.5 测试/oracle

三类pending stop；new block/error/terminal/abort/retreat/recovery/continuation fence；真SDK长期open block；真CC time-to-tool-execution；短请求wire时序差异。

## 6. 方案 C：只覆盖 pre-content，首块后暂不覆盖

### 6.1 机制

仅客户端轨尚未完成任何真实block时允许单anchor@0 + 固定+1 remap。首块提交后，无open窗口一律只ping，不复用index0。live-only原-index空delta分支可保留，但必须注明块级buffered终态不可达。

### 6.2 终态暴露面

- 首块提交前的长生成全部是pre-content，C覆盖。
- 首块提交后，后续上游thinking/text/tool_use块在闭合前对客户端不可见，C全部失守。
- C的真实性质是**首块后覆盖率随块数下降**：单块响应安全，多块长响应逐块失守。

8000条live History只作迁移校准：17 pre-content、16 open-block、2真inter-block；>300s 12条、>200s 35条、>150s 68条。16条live open-block迁buffered后会变成无-open窗口；首块前的归pre-content，首块后的长生成失守。两条约300s样本已经被CC掐断，不能用live下“真inter-block仅2条”低估终态风险。

### 6.3 临时解阻与 backlog

当前分支可先把scaffold门收窄为`openBlocks.length===0 && semanticBlockCount===0`，并分离envelope/content latch，禁止首块后anchor@0重用。这只解除协议损坏，不闭合>300s门。

backlog必须记录：根因、当前pre-content-only行为、A frontier理想架构、原子接线范围、以及**解除条件：A必须在Anthropic块级buffered默认翻转前完成**。

### 6.4 失效条件

首块提交后的任一客户端无-open窗口超过300s即失败。

## 7. 已考察但未采纳的其它载体

- **D. 早发真实 `content_block_start`**：违反D2客户端只见完整顺序块；tool_use不完整时补stop会触发空input eager执行；thinking有签名约束。否决。
- **J. 长text块idle分块**：把已缓冲文本先commit为完整真实块；仍需A的allocator，是A落地后的下游收益，不是替代。
- **K. 对closed index发空delta**：协议外；tool_use闭合后input已对象化，后续input-json delta可能抛错。否决。
- **L. 合成 `message_delta`**：会合并usage、覆盖stop_reason，污染计费与终局。否决。

## 8. 横向对比

| 维度 | A. 单调frontier | B. 延迟stop | C. 仅pre-content |
|---|---|---|---|
| 块级buffered完整覆盖 | 是 | 理论是，但tool代价不可接受 | 否；首块后逐块失守 |
| 短请求wire | 可结构短路保持不变 | stop位置改变 | 可保持不变 |
| tool执行 | 不推迟 | 确定性推迟整个窗口 | 不推迟，但长请求可能断 |
| 合成block/D2形状 | deadline时有 | 无，B的结构优势 | pre-content至多一次 |
| 失败模式 | remap漏点可静默重排 | 漏fence多为可见悬挂block | 明确300s断流 |
| 可检测性 | 最低，需强oracle | 较高 | 高 |
| committed/continuation | 统一为frontier | wire与ledger分裂 | 现状 |
| 既有设计复用 | 高 | 低 | 高 |
| 长远正确 + 完整 | 最符合 | 被eager tool执行否决 | 不符合，只可临时解阻 |
| 证据 | allocator unit+短PoC；全接线未测 | 静态推导+CC eager源码 | 单anchor实测+8000条live迁移校准 |

## 9. 裁决与落地顺序

**方案 A 已选定并进入实施。** wire index属于generation，A是唯一把分散常量、anchorShift和continuationOffset收敛为单一权威frontier的方案；它同时使能合法gap anchor、continuation接续和未来J分块。B虽无合成块且失败更可见，但确定性推迟eager tool执行，并破坏closed-block commit SSOT；C在块级buffered终态首块后不完整。

落地顺序：

1. 既有分支已先收窄为C形状解阻：禁止首块后anchor@0；分离envelope/content latch；该门不是终态。
2. 方案A按独立TDD plan实施，覆盖continuation撞车、serializer并发、多轮回传、无anchor结构短路、ADR D2措辞修订和Q5公式作废。
3. **硬门**：A必须在Anthropic块级buffered默认翻转前落地；C不能作为终态。
4. 最终验收：producer单调全序→真SDK累积顺序→真CC`numTurns≥2` >300s +短请求SHA。
