---
name: methodology-reasoned-safe-not-tested-producer-wire-oracle
description: 「推理上安全」不等于「已测」——即便能干 reviewer 亲手推理也会错；client-facing wire 缺陷须 producer wire-oracle 断言全序（非仅计数）+ 执行真实产出路径（非回放理想 fixture）
metadata:
  node_type: memory
  type: feedback
  originSessionId: ebe4a147-09a1-4d7e-8522-d207df456a23
---

**block 级缓冲重试 P1（Anthropic）接线时，同一类「客户端可观测 wire 形状」缺陷被绿测反复放过，且一次「reasoned-safe」结论被证伪**——这是 `empirical-verification` 的高价值实例，教训可迁移到任何「代理产出的 wire 是否被客户端接受」的验证。

**四连缺陷都在 keepalive wire 形状、都被绿测掩盖**（一行接线 `commitBoundaries: anthropicCommitBoundaries` 引爆）：
1. anchor 在**首个** block flush 就 close（`firstFlush` 门是为 whole-response 写的、first==terminal），多块块间静默退化裸 ping → 撞 CC 300s no-real-content 看门狗。
2. 修 1 后 anchor close-off 排到 `message_stop` **之后**（`anthropicCommitBoundaries` 把 message_stop 当边界→尾部 in-loop 先 flush）。违反 §4.3 终态序。修法=从谓词**移除 message_stop**，尾部缓冲到终态 drain-flush（终态由独立 `sawMessageStop` 信号判，非谓词）。
3. 同类反演潜伏在 **H2 error 终态**（`error, stop@0` 序反）——修 2 时顺手一并修（`errorIsTerminal = sawUpstreamError()`，`fix-all-comparison-sites` 本能）。
4. defect-(a) 的 `everOpenedRealBlock` 守卫对 **`enveloped_ping` 模式零防护**——`trackOpenBlock = heartbeatOn && typeof pingFrame === "function"`，而 enveloped_ping 的 pingFrame 是**固定对象非函数** → 守卫全程 dead → 重复 message_start。

**Why（承重、可迁移）:**
- **绿测为何全瞎**：① 既有 e2e 只**回放手工 ideal fixture**（stop@0 在前）验「客户端接受性」(criterion ②)，从不驱动 driver **真实产出**验「代理可产出」(criterion ①)——两者必须都测；② 新加的 producer oracle 一开始只断言**计数**（一个 stop@0、无 ping），**没断言终态相对顺序**，故畸形序照过。缺陷 2 正是这条缝隙漏的。
- **reasoned-safe ≠ tested（最尖锐）**：opus capstone reviewer 对 enveloped_ping **推理**判「shared guard、无索引碰撞、safe but untested」，我把它当近定论上报用户。补写 golden **证伪了它**——守卫因 `trackOpenBlock` 短路对该模式结构性失效。**能干的 reviewer 的推理结论也会错；唯有执行真实路径的测试能逮**。executor/reviewer/文档/记忆都可能错（见 CLAUDE.md `empirical-verification`）。

**How to apply:**
- 验「代理产出的 client-facing wire 是否正确」时，**producer wire-oracle**（fake-timer 驱动真实产出路径、dump 全帧）是必需，且必须断言**完整帧序**（含终态 close-off→message_delta→message_stop 的相对位置），不能只断言计数/存在性。
- 「客户端接受」PoC 若回放**理想 fixture** 而非 driver 真实产出，会给「默认 on」假信心——PoC/oracle 必须喂 driver 实产。
- 任一 reviewer/自己的「推理上安全、无需测」结论，凡落在可执行路径上，**写个会因 bug 变红的测试去证**，别把推理当已验证上报用户。变体/兄弟模式（empty_text vs enveloped_ping、success vs H2-error 终态）逐个测，别从一个推广到全部。
- gate 门（`firstFlush`/`trackOpenBlock` 这类布尔）改语义时，先问「这个门是为哪个旧场景写的、新场景是否让它的前提失效」——`firstFlush`（whole-response first==terminal）、`trackOpenBlock`（仅 provider 模式）都是**旧场景正确、新场景失效**的门。

**Related:** [[feedback-pass-null-clean-not-self-validating]]（通过/自洽不自证簇）、[[feedback-fix-all-comparison-sites]]（H2 反演同类兄弟一并修）、[[methodology-new-strategy-shadowed-by-broader-first-match]]（门/matcher 前提失效）、[[project-block-level-buffered-retry-execution]]（本特性执行指针）。
