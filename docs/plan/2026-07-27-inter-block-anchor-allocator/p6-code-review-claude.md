# P6 心跳生命周期修复 —— 合并态代码审查（Claude reviewer，异模型交叉）

- 日期：2026-07-27
- 审查对象：worktree `/home/xp/src/copilot-api-js/.worktrees/p6-heartbeat`，分支 `fix/heartbeat-lifecycle`，HEAD `063f45f9`，base `5c84a1e0`（8 commit）
- 权威计划：`docs/plan/2026-07-27-inter-block-anchor-allocator/plan-6-heartbeat-lifecycle-fix.md` + `plan-0-baseline-and-guards.md`
- 裁判轴：长远正确 + 完整（非 ROI/YAGNI）；TDD + commit invariants
- 本报告所有事实性结论均为 reviewer **亲手实测**，不采信 implementer 自陈

## 总体 verdict

**存在 blocker —— 暂不可合并入 master。**

计数：**BLOCKER 1 · HIGH 1 · MEDIUM 4 · LOW 5**（主观建议另计 3 条）。

一句话：**心跳修复本身是正确、最小、根因级的，三条 mutation 正控我已亲自复现全部转红、防过头的负控也咬**；但 ① 新增的旗舰回归锁 `heartbeat-survives-boundary-commit.it.test.ts` 在项目标准档位 `bun scripts/parallel-test.ts unit it http` 下**确定性变红（4/4）**、单跑却 25/25 绿——这是测试自身的确定性缺陷，且失败症状与被修缺陷同形（0 keepalive），会持续误导后续相位；② P0 的 O-6 字节基线**实测证明是从另一个会话的 peer mock 进程抓来的**，不是本代理的 wire。两项都需修掉再合。

## 双视角覆盖证据

### 机械核对（扫描 / 对账 / 查证）

- `git diff 5c84a1e0..fix/heartbeat-lifecycle` 全量逐文件读（src 5 文件 / tests 7 文件 / exp 4 文件 / docs 5 文件 / `.gitattributes`）。
- 全仓 grep 五个生命周期入口的**全部**调用点：`rg -n "freezeHeartbeat|suspendHeartbeat|resumeHeartbeat|closeAnchorIfOpen|sink\.close" src/`，逐点读上下文。
- 全仓 grep sink 工厂消费者：`makeSseSink` / `makeDeliverySseSink` / `makeWsSink` / `makeDeliveryWsSink`，确认生产 5 条 HTTP/WS 路径全走 delivery sink、raw sink 在生产已无直接消费者。
- `bun run typecheck` → 0 error。
- `bunx eslint --no-cache <本分支改动的 14 个文件>` → 0 error（仅 1 条 exp 目录 ignore warning）。
- `bun run lint:all` → 390 error，**逐条核对全部落在 `ui/`（Vue 旧前端）**，本分支 diff 不含任何 `ui/` 文件 → 判定为既有债、非本分支引入。
- 字节基线交叉核验：`sha256sum` 逐 commit 比对 `pre-change-wire.sse` 四个 blob（1bf9bf89 / 1a1b1985 / 8fa79eed 均 733 字节、hash 与 README 声明不符；063f45f9 补回尾换行后才等于 README 的 `24eda6b8…` / 734）。
- 查证 `frame-origin.ts` 的 synthetic 标记实现（Symbol-keyed 属性；anchor 是靠 `writeAnchor` 方法而非帧上的标记来区分），据此判定 `wire-index-oracle.ts` 的 `isAnchorFrame` 恒 false。
- 核对 anchor 测试文件计数：`rg -ln "anchor" tests/ -g '*.test.ts'` = 51（README 自洽）；plan-0 正文展示的命令 `rg -ln "anchor" tests/` 实际 = 54。
- 核对 DESIGN.md 第 75 行插入点的句法完整性（逐字读插入前后的原句）。

### 第一人称执行（模拟走查 / 实跑分支）

- **以 driver 身份走完 buffered 全生命周期**：`suspend(1271) → flushBufferedFrames.freeze(1145) → resume(1273)`（retreat 腿）、`suspend(1295) → freeze → resume(1328)`（block boundary 腿）、`terminal-drain flush(1390)`（**无外层 suspend**）、`closeAnchorIfOpen(1105) → close()`（失败终局）、`finally sink.close?.()(1532)`。逐腿推演 `heartbeatSuspended` / `heartbeatStopped` / `timer` 三态组合。
- **以 handler 身份走完 8 个 `closeAnchorIfOpen(sink, hooks, state)` 调用点**（handler-v4.ts:667 / 1352 / 1450 / 1477 / 1530 / 1633 / 1671 / 1715），确认全部是 error/truncation 终局分支、其后只有 `writeSynthetic → recordForwarded → fail → finalize`。
- **mutation 实跑（3 次独立 mutation，每次跑完立即按 pathspec 还原并与备份 diff 校验一致）**：
  - M1 `freezeHeartbeat: stopHeartbeat` 改回 `closeHeartbeat`：3 条锁全红，raw-sink 正控仍绿。
  - M2 `close: closeHeartbeat` 改成 `stopHeartbeat`（模拟修过头）：负控 `close remains permanent` 转红。
  - M3 删掉 `closeAnchorIfOpen` 的 `await sink.writeAnchor?.(stopFrame)`：4 条既有 http 终局 close-off 测试转红 → 证明「`close()` 之后 `write` 仍须可用」这条新承重属性**已被现有测试锁住**。
- **实跑 gated 真 CLI e2e** `tests/e2e-client/anthropic-coexist-cli.e2e.test.ts`（本机 `claude` 与真 token 均在位、GATED=true）→ 1 pass，独立复现了 implementer 反转后的负向结论。
- **实跑 O-6 捕获脚本**（复制到 `/tmp` 改写 CAPTURE 路径，不动仓库文件）→ 复现出**逐字节相同**的 734 字节，但 `server.log` 显示本进程根本没起来（端口被占），`ss -ltnp` 加 `/proc/<pid>/cmdline` 定位到真正应答的是 peer 会话的 mock 进程。
- **确定性实测**：目标测试单跑 25 次（25/25 绿）；标准档位 `parallel-test.ts unit it http` 跑 4 次（4/4 红）；复算 LPT 分桶定位到同 shard 的 45 个文件并复现；临时插桩副本（跑后已删除、`git status` 已确认干净）拿到根因证据 `delays-before [1000]`。

---

## 一、修复是否根治且不过头（最高优先级）

**结论：根治，且没有过头。五个入口的全部调用点与状态组合已逐一走查，未发现「终局后心跳仍活」或「close 之后复活」的新缺陷。**

### 改动本体（`src/lib/pipeline/delivery/session.ts`）

唯一的功能性改动是 1 行：`freezeHeartbeat: closeHeartbeat` → `freezeHeartbeat: stopHeartbeat`（:205）。其余保持：

| 入口 | 实现 | `heartbeatStopped` | `timer` | 语义 |
|---|---|---|---|---|
| `freezeHeartbeat` (:205) | `stopHeartbeat` | 不动 | 清 | **可恢复** |
| `suspendHeartbeat` (:206) | 置 `heartbeatSuspended` + `stopHeartbeat` | 不动 | 清 | 可恢复 |
| `resumeHeartbeat` (:210) | 守卫 `!heartbeatSuspended \|\| state!=="open" \|\| heartbeatStopped` | 读 | 重排 | 只在 suspend 过后生效 |
| `close` (:216) | `closeHeartbeat` | **置 true** | 清 | **永久** |
| `session.terminate` (:249) | `closeHeartbeat` + 收尾 + `sink.close()` + `sink.finalize()` | **置 true** | 清 | **永久** |

### 「泄漏心跳」的三条可能通道，逐条排查

1. **freeze 后被重新 arm** —— `armHeartbeat`（:105-110）守卫含 `heartbeatSuspended || heartbeatStopped`。block-level 与 retreat 两条腿都有**外层 `suspendHeartbeat()`**，所以 freeze 期间任何在飞 tick 的 `.finally(() => armHeartbeat())` 都被 suspend 挡住；resume 之后才重排唯一 timer。**唯一例外见 MEDIUM-1（terminal-drain flush 无外层 suspend）**。
2. **close 后复活** —— `resumeHeartbeat` 守卫读 `heartbeatStopped`；raw sink 侧 `resumeHeartbeat` 也有 `if (stopped) return`（client-sink.ts:400）。负控 mutation M2 已证明这条守卫真咬。
3. **请求结束后 timer 残留** —— `runResponseBufferedSink` 的 `finally { sink.close?.() }`（driver.ts:1532）、`runResponseSink` 的 :883/:1007，以及 handler 的 `sink.finalize?.()` → `session.terminate()`，三路都置 `heartbeatStopped`。走查未发现能绕开全部三路的退出路径。

### 「终局 anchor close-off 改用 close()」是否覆盖所有终局路径

**覆盖了失败终局，但成功终局走的是另一条路（不是缺口，只是范围要说清）：**

- `src/lib/anthropic/keepalive-anchor.ts:181` 的 `closeAnchorIfOpen`（handler 侧）：`sink.close?.()` 在 anchor 守卫**内部**，8 个调用点全部是 error / truncation / 未预期 throw 的终局分支，其后紧跟 `writeSynthetic → recordForwarded → fail → finalize`。✅
- `src/lib/pipeline/driver.ts:1105` 的 `closeAnchorIfOpen`（driver 侧）：`sink.close?.()` 在守卫**外部**（无条件），2 个调用点 :1361（retreat 后截断）与 :1515（穷尽 / 不可重试）也都是终局 return。✅
- **成功终局**（`drained && sawMessageStop()` → terminal-drain flush → `return complete`）**不经过 `closeAnchorIfOpen`**，其永久停止来自 :1532 的 `finally sink.close?.()`。这在结果上正确，但把 C1 的「flush 期间绝不 tick」保证从「硬永久」降级成了「窗口有界」——见 MEDIUM-1。

### 「close() 之后 write 仍须可用」这条新承重属性

`closeAnchorIfOpen` 现在是 `close() → await writeAnchor(stopFrame)`。我逐一核实了三条 sink 的 `close()` 副作用：

- delivery session：`close = closeHeartbeat`，**不动 `state`、不关内层 sink、不 finalize** → `write` 全可用。
- raw `makeSseSink`：`close()` 只置 `stopped` 并清 timer；`stopped` 仅被 `tick` 与 `resumeHeartbeat` 读，**`write` / `writeAnchor` / `writeSse` 均不检查它** → `write` 全可用。
- `makeReconcilingSink`（live 腿装饰器）：`close` 透传内层。✅

plan Task 6.2 Step 5 要求「逐一核实两条 sink 的 `close()` 副作用不一致会不会导致契约分叉」——实测**没有分叉**，implementer 的裁决成立。且 M3 mutation 证明这条属性被 4 条既有 http 测试锁住（不是靠推理安全）。

---

## 二、回归锁是否真咬（自己复现的 mutation）

**结论：三条正控 + 一条负控全部真咬，implementer 自陈属实。但其中一条锁自身不确定（见 BLOCKER-1）。**

M1：把 `src/lib/pipeline/delivery/session.ts:205` 改回 `freezeHeartbeat: closeHeartbeat`，跑三个文件（17 tests）：

```
14 pass / 3 fail
(fail) Responses HTTP heartbeat after output-item commit > after the first response.output_item.done commit, an idle still emits keepalives
(fail) heartbeat after a real buffered boundary commit > after a real block-level commit on the production delivery sink, an inter-block idle emits keepalives
(fail) P3-T1 downstream delivery session > freezeHeartbeat is recoverable: resumeHeartbeat revives the timer
```

- 三条全红、且 raw-sink 正控 `positive control: the same harness on a raw sink emits keepalives` **保持绿** —— 正负样本对照成立，探针确实打在「delivery sink vs raw sink 的语义分歧」上，不是打在 harness 上。
- 还原后重跑：17 pass / 0 fail。

M2（防过头）：把 `close: closeHeartbeat` 改成 `close: stopHeartbeat`，`close remains permanent: resumeHeartbeat does not revive a closed heartbeat` 立刻转红。→ 「永久语义没有被一起放松」这一点有独立裁决力。

### Responses HTTP 那条（重点核）

`tests/responses/heartbeat-survives-item-commit.it.test.ts` 我逐行核实了它确实走**生产接线**，不是手工构造：

- sink：`makeDeliverySseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: … } })`（:171）—— 真生产工厂。
- driver：`createPipelineDriver(deps).runResponseBufferedSink(...)`（:178）—— 真 driver，不是模拟。
- 边界谓词：`commitBoundaries: isResponsesCommitBoundary`（:180），从 `~/lib/codec/openai-responses/commit-boundaries` 真实 import。
- 上游形状：真 `response.output_item.added / output_text.delta / output_item.done`（含 `sequence_number`、`output_index`、完整 item 结构），gated 双段，`response.output_item.done` 之后长静默。
- 断言：`written` 里 `response.output_item.done` 恰 1 条（证明确实发生了一次 commit），再断静默期 `response.ping` ≥ 1。

**唯一缺口**：它没有像 boundary 那条一样配 raw-sink 正控（见 LOW-3）；另外它没有锁「Responses HTTP handler 确实把 `isResponsesCommitBoundary` 传给了 driver」这段接线（`candidate-response-session.ts` 的 `transport === "http"` 分支），只锁了 driver 拿到该谓词之后的行为（见 LOW-4）。

---

## 三、测试盲区是否真消除

**结论：盲区的**方向**消除了（新增两条锁确实建在生产 delivery sink 上，raw-sink 正控保留），但盲区的**可靠性**没建立起来 —— 见 BLOCKER-1。**

- `tests/pipeline/heartbeat-survives-boundary-commit.it.test.ts` 用 `sinkFactory = production ? makeDeliverySseSink : makeSseSink` 同一 harness 双跑，正控与生产版共用完全相同的上游 / driver / 边界谓词 —— 这是本分支最好的一处设计：两种 sink 的语义分歧被显式对照出来，而不是各写各的。
- plan Task 6.4 的 sink 覆盖清单已填写（4 行），处置说明与实际改动一致（buffered-anchor.unit / retreat-anchor-collision 保留 raw，不做全量迁移）。这符合「补比迁安全」的裁决。
- **未消除的部分**：plan §「为什么至今没被发现」列的根因是「同名方法两条实现语义分歧 + 测试装在宽松那条」。现在生产那条有锁了，但 `types.ts` 的 `ClientSink` 契约 TSDoc **没有把新语义写死**（见 MEDIUM-3）——契约仍然只活在两处实现的注释里，下一个实现者仍可能再次分叉。

---

## 事实性发现

### [BLOCKER] tests/pipeline/heartbeat-survives-boundary-commit.it.test.ts:175-176 —— 新增的旗舰回归锁在项目标准测试档位下确定性变红

**问题**：该测试单跑绿、在 `bun scripts/parallel-test.ts unit it http`（= `test:backend` 的替代档位，也是 implementer 声称跑过的那条命令）下**确定性变红**。

**证据（实测，非推理）**：

- 单文件连跑 25 次：`solo: pass=25 fail=0`。
- 标准档位跑 4 次：4/4 都含
  `(fail) heartbeat after a real buffered boundary commit > after a real block-level commit on the production delivery sink, an inter-block idle emits keepalives`
  （`Expected: >= 1 / Received: 0` —— **与被修缺陷同形的症状**）。
  汇总分别为 `6491 tests · 6490 pass · 1 fail`、`6489 pass · 2 fail`、`6490 pass · 1 fail`、`6489 pass · 2 fail`。
  这与 implementer 自陈的 `6481 pass / 0 fail` **不符**（测试总数也对不上：6491 vs 6481）。
- 复算 `scripts/parallel-test.ts` 的 LPT 分桶，定位到该文件所在 shard 的 45 个文件；直接 `bun test <这 45 个文件>` 复现失败（`Ran 426 tests across 45 files`，同一条红）。注意 `parallel-test.ts` 的每个 shard 是**单进程共享 module 状态**（脚本头注释自陈的 trade-off），所以这是污染型不确定，不是随机 flaky。

**根因（已定位到具体机制）**：临时插桩副本（跑后已删除）打印出：

```
[dbg] delays-before [1000] written 4      ← 生产 delivery 版：唯一 live timer 的剩余延迟是 1000ms
[dbg] delays-after  [15000] written 4 []  ← advance(15000) 触发的是那个 1000ms 的外来 timer；0 个 ping
[dbg] delays-before [15000] written 4     ← raw sink 正控：这时才是心跳自己的 15000ms timer
[dbg] delays-after  [15000] written 5 ["ping"]
```

就绪门 `expect(clock.liveTimerCount).toBe(1)`（:176）用的是 **FakeClock 的全局 timer 计数**。在共享 shard 里，bucket 同伴模块会 arm 自己的 1000ms 定时器；就绪循环因此**在心跳 timer 还没 arm 的时候就退出了**，门断在了别人的 timer 上。随后 `clock.advance(15_000)` 的 `target = now + 15000` 在进入时就固定：外来 timer 在 now=1000 触发，心跳这时才排到 fireAt=16000 > target → 本次 advance 不触发 → 0 ping。

**为什么这是 blocker 而不是 minor**：① 它是本相位交付的**核心验收物**，红在项目交付前必跑的档位上；② 失败症状与缺陷同形，未来任何人看到这条红都会先怀疑生产代码回归；③ P5 的 oracle 明确要建在这条之上，一个不确定的 oracle 会把不确定性传染给后续全部相位。

**修复建议**：把就绪门与断言都改成对**心跳自己那个 timer** 的判定，而不是全局计数。`FakeClock.liveTimerDelaysMs` 正是为此存在（其 TSDoc 原文：「Lets integration tests distinguish a leaked short-cadence heartbeat from unrelated long-lived runtime timers」）。例如：

```ts
for (let i = 0; i < 500 && !clock.liveTimerDelaysMs.includes(15_000); i++) await Promise.resolve()
expect(clock.liveTimerDelaysMs).toContain(15_000)
```

并保留一条对「不多不少一个心跳 timer」的断言（可用 `liveTimerDelaysMs.filter((d) => d === 15_000).length === 1`，避免被外来 timer 干扰）。修完请**在标准档位连跑 ≥ 5 次**确认确定性，而不是只单跑。

**顺带**：同一形态的 `expect(clock.liveTimerCount).toBe(1)` 也出现在 `tests/responses/heartbeat-survives-item-commit.it.test.ts:187`。我把它换到同一个受污染的 bucket 里实跑（`425 pass / 0 fail`），当前**没有**触发 —— 属于**潜伏**同型缺陷，应一并改掉（分桶随文件增删会漂移，今天不中不代表明天不中）。

### [HIGH] exp/inter-block-anchor-allocator/pre-change-wire.sse + byte-equivalence.sh + README.md —— O-6「字节基线」实测是从 peer 会话的 mock 进程抓来的，不是本代理的 wire

**问题**：P0 的 O-6 交付物（README 称「实施 base `5c84a1e0` 捕获结果 SHA-256 `24eda6b8…` / 734 bytes」）并非本项目服务器产出。

**证据（实测，逐条可复现）**：

1. 复制脚本到 `/tmp` 只改 CAPTURE 路径后重跑，得到**与仓库内 fixture 逐字节相同**的输出（`diff` → IDENTICAL，sha 同为 `24eda6b8…`，734 bytes）——脚本"可复现"。
2. 但同一次运行的 `server.log` 末尾是：
   `[ERR] Failed to start server on port 42061. Is the port already in use? Error: Failed to start server. Is port 42061 in use?`
   —— 脚本自己起的服务器**根本没起来**。
3. `ss -ltnp` 显示 42061 的持有者是 pid 2509431；`/proc/2509431/cmdline` =
   `bun run --cwd /home/xp/src/copilot-api-js/.worktrees/keepalive-300s exp/tool-keepalive-safety/mock.ts`，启动时间 `Mon Jul 27 18:39:25 2026`（**早于**本分支全部 commit 的 23:45）。
4. 内容自证：`deterministic-hook.ts` 产出的是 `id:"msg_allocator_baseline"` / `model:"claude-opus-5"` / `text:"allocator baseline"` / `input_tokens:5`；而捕获文件是 `id:"msg_1"` / `model:"claude-opus-4-8"` / `text:"ok"` / `input_tokens:10`。管线中不存在能做这种改写的环节。→ **`deterministic-hook.ts` 从未被执行过，是死代码**。

这正是项目记忆库里已有的战例 `reference-spawn-fails-silently-hits-peer-server-verify-port-ownership`（起测试服务器端口被 peer 占用会静默打到 peer mock，health 仍绿）。

**影响**：

- plan-0「Task 0.1 Step 3：跑一次，记录为**权威 base 基线**」实际未达成；plan-0 收口表里的两行基线值、以及 plan-6「独立交付」清单里「P0 的 O-6 字节等价基线仍需先建，用于证明本修复不改变短请求 wire」这条**没有被满足**——本修复不改短请求 wire 这个结论目前**没有字节级证据**（不过它有别的支撑：src 改动只有 1 行且不触碰 wire 序列化，加上 6489+ 测试通过）。
- `byte-equivalence.sh` 会被 P8 用 `cmp` 复用。它**没有任何端口归属校验**：readiness 探针只 `curl /health`，任何监听者都能让它变绿。以现状合入 master 等于给后续相位埋一个"看起来绿的假 oracle"。
- README 里「当前 P0 的 hook、请求和响应 fixture 已显式冻结在本目录」这句是**不成立的断言**；`.gitattributes` + commit `063f45f9`（补尾换行"preserve exact SSE baseline bytes"）都是在给一个错误的产物做字节保真。

**修复建议**（三选一 + 一条必做）：

- 必做：给 `byte-equivalence.sh` 加**端口归属校验**——起服后先确认 `server.log` 无启动失败，再用 `ss -ltnp` 核对监听 PID 就是自己 spawn 的那个（或直接 `curl /health` 后比对某个自有端点的指纹）；不匹配就 `exit` 非 0 并打印占用者。参考记忆 `reference-spawn-fails-silently-hits-peer-server-verify-port-ownership`。
- 然后：改用一个**随机高位空闲端口**（或校验失败后自动换端口）重新捕获真基线，替换 fixture 并更新 README 的 SHA / 字节数 / provenance 叙述。
- 或者：如果本次独立交付不想再折腾 P0，就把 `pre-change-wire.sse` + README 的基线声明**标注为未验证并从 P0 收口表撤下**，留给 allocator 相位重建 —— 但**不要**带着一个被当作权威 oracle 的错误产物合进 master。

### [MEDIUM] src/lib/pipeline/driver.ts:1390 —— 成功终局的 terminal-drain flush 没有外层 suspend，C1「flush 期间绝不 tick」从硬保证降级为有界窗口

**问题**：`flushBufferedFrames` 的 4 个调用点里，:1272（retreat）与 :1322（block boundary）都被 `sink.suspendHeartbeat?.()` 包住，:1390（terminal drain，成功终局）**没有**。修复前 `freezeHeartbeat` 在 delivery sink 上等于 `closeHeartbeat`（置 `heartbeatStopped`），tick 与 `armHeartbeat` 都被硬挡；修复后它只清 timer，`heartbeatSuspended` 与 `heartbeatStopped` 都是 false。

**失败场景（推理，未实证 —— 明确标注）**：freeze 发生时若有一个 tick 正在飞（它的 `write` promise 或 `injectScaffold` promise 未 settle），其 `.finally(() => armHeartbeat())`（session.ts:123/140/164/167）会在 freeze **之后**重排一个 `intervalMs` 的 timer。若该 terminal flush 的耗时超过 `intervalMs`（16MiB buffer cap 上限 + 慢客户端并非不可能），tick 会在 flush 中间触发：
- 轻的后果：一个 `ping` 被插进真实块的 deltas 之间（协议合法，但违反 §4.4 明写的不变量）；
- 重的后果：在两个真实块之间（`pendingOpenBlocks` 为空）触发 `injectScaffold()` → 转发 message_start + anchor `content_block_start@0`，**与正在 flush 的真实块索引撞车**，即 C1 当初要防的那个缺陷。第二种要求 anchor 模式非默认 `ping`（`empty_text` / `enveloped_ping`），而那正是 A 方案的目标制度。

窗口是有界的（`finally sink.close?.()` 在 return 后立刻永久关闭），所以不是现网大概率事件；但它是**这次改动把一条硬不变量换成了软不变量**，且 plan Task 6.2 Step 5 的论证（「这由 `suspendHeartbeat` 保证——driver 在 flush 外层调，:1269/:1293」）**只覆盖了那两条腿，没覆盖 :1390**。implementer 给「终局 flush 路径」的答案是 `closeAnchorIfOpen` 改 `close()`，但那条路只在**失败**终局上跑。

**修复建议**：在 :1390 之前加 `sink.close?.()`（这里确实是终局，永久关闭语义正确，且已验证 close 之后 write 仍可用），或至少加一个不配对的 `sink.suspendHeartbeat?.()`。**不要**照搬 retreat 腿的 suspend/resume —— retreat 的 `isTerminalFlush:true` 并不是真终局（其后还有 live 续流），两者必须区别对待。同时补一条 it 测试：terminal flush 期间不得出现 keepalive/anchor 帧。

### [MEDIUM] tests/helpers/wire-index-oracle.ts:276-278 —— `isAnchorFrame` 恒为 false，`wireShape` 永远分不出 anchor 与 real，而 README 声称它能

**问题**：

```ts
function isAnchorFrame(frame: ClientFrame): boolean {
  return (frame as ClientFrame & { synthetic?: string }).synthetic === "anchor"
}
```

`ClientFrame` 上不存在 `synthetic` 属性。查证 `src/lib/pipeline/frame-origin.ts`：synthetic 溯源是 **Symbol-keyed** 私有属性，且其模块文档明写「Keepalive / anchor / synthetic-message-start are marked via dedicated sink write methods (`writeKeepalive`/`writeAnchor`/…), **not via a frame tag**」。anchor 的可辨识性活在 forwarded 记录层（`SseEventRecord.synthetic`），不在帧上。

**后果**：`wireShape` 永远输出 `real_start@N` / `real_stop@N`，anchor 分支是死代码。`exp/inter-block-anchor-allocator/README.md` 却写「`wireShape` 输出可读的 `real_start@N` / `anchor_start@N` / `delta@N` / `*_stop@N` 序列」——**doc 与 code 反向**。`wire-index-oracle.unit.test.ts` 的 8 条用例全是 real 形状，没有任何正样本能触达 anchor 分支（典型的「通过不自证」）。plan-0 Task 0.2 Step 3 明写「`wireShape`：输出可读的类型@index 序列（anchor 帧按 `synthetic` 标记区分），供 O-3 精确比对」——O-3 是后续相位的比对 oracle，届时会静默拿到错误标签。

**修复建议**：要么让 `wireShape` 接受一个显式的 anchor 判定（例如由调用方传入 anchor 帧集合 / 索引），要么让它读 forwarded 记录而非裸 `ClientFrame`；并补一条 anchor 正样本单测，证明该分支真的能被触达。在修好之前，README 里那句话应先改成事实。

### [MEDIUM] src/lib/pipeline/types.ts:687-696, 714-719 —— `ClientSink` 契约 TSDoc 没有把新语义写死，plan 明确要求的那一项未完成

plan-6 §Interfaces 写：「`ClientSink.freezeHeartbeat()` 的契约需被**明确写死**（当前两个实现分歧就是因为契约只在注释里、且两边注释各说各话）」。实际改动只更新了 `suspendHeartbeat` 的 TSDoc 与 `client-sink.ts` 的行内注释，**SSOT 的 `freezeHeartbeat` / `close` TSDoc 一字未改**：

- `freezeHeartbeat`（:687-696）仍只说「Stop the heartbeat timer WITHOUT closing the sink」，**没有**「RECOVERABLE —— `resumeHeartbeat` 可复活」这句，也没有「必须与 `suspendHeartbeat` 配对使用才能挡住已排队的 tick」。
- `close`（:714-718）只说「Release sink-held resources (the heartbeat timer)」，**没有**「PERMANENT —— `resumeHeartbeat` 之后不得复活」，也**没有**现在已经承重的「`close()` 之后 `write` / `writeAnchor` 仍必须可用（终局 anchor close-off 依赖它）」。

这正是本次缺陷的元凶形态（契约只活在实现注释里）。不写死，下一个实现者仍可能把 `close()` 实现成"连写也拒绝"，而那会让终局 `content_block_stop@0` 静默消失。

**修复建议**：把上面 4 句写进 `types.ts` 的 TSDoc（它是 SSOT），并在 `close` 处显式点名 `keepalive-anchor.ts:181` / `driver.ts:1105` 这两个「close 后仍写」的消费者。

### [MEDIUM] docs/DESIGN.md:75 —— 插入的心跳段把原句切断，`返回格式无关 ResponseOutcome` 被嫁接到了 CC 的从句上

原句是「driver `runResponseSink(...)` drain S5 链写进 `makeSseSink`/`makeWsSink`，返回格式无关 `ResponseOutcome`（…）」。新段插在「写进 `makeSseSink`/`makeWsSink`。」与「返回格式无关 `ResponseOutcome`」之间，现在读作：

> …CC 的 `ccCommitBoundaries` 只认终态 upstream error，正常响应无 mid-generation boundary，返回格式无关 `ResponseOutcome`（`complete{headers}`/…）。

主语从 `runResponseSink` 变成了 CC 的 commit boundaries —— 在项目的架构 SSOT 文档里制造了一处会误导下一位读者的错误归属。

**修复建议**：把心跳生命周期段整体后移到该 cell 里 `runResponseSink … ResponseOutcome（…）。` 这句**结束之后**再起，或独立成一个 `**buffered delivery 心跳生命周期（2026-07-27）**：…` 的加粗段。内容本身准确（`freezeHeartbeat` 可恢复 / `close()` 永久 / CC 结构性幸免的说明都与代码一致），只是插入点错了。

### [LOW] src/lib/pipeline/driver.ts:1267, 1292 —— 两处注释仍在说「terminal path 的 permanent freeze」，与新语义矛盾

`// SUSPEND/RESUME (recoverable) around the flush — NOT the terminal path's permanent freeze`（:1267）与 `// permanent freeze, the block-level flush is followed by MORE streaming`（:1292）。改完之后 `freezeHeartbeat` 在**任何**路径上都不再永久，"terminal path's permanent freeze" 这个指称对象已不存在（终局的永久性现在来自 `close()`）。这是本次改动漏改的 doc-vs-code 不一致，且恰好落在解释这套生命周期的核心注释上。

**修复建议**：改成「NOT a terminal `close()`」之类，指向真正提供永久性的入口。

### [LOW] src/lib/pipeline/types.ts:714-718 —— `close()` 的「之后 write 仍可用」属性只被间接锁住，没有直接单测

M3 mutation 证明 4 条既有 http 测试（`live-pump-terminal-anchor-closeoff` ×2、`live-post-commit-anchor-closeoff` ×2）会在 stop@0 丢失时转红，所以**有**回归保护。但它们锁的是"终局 stop@0 在 error 帧之前"这个更高层的行为，"close 之后 write 仍可用"只是被顺带覆盖。建议在 `delivery-session.unit.test.ts` 补一条直白的 `close() → write() 仍到达 sink` 单测（与已有的 `close remains permanent` 成对），把这条现在才承重的属性单独钉住。

### [LOW] tests/responses/heartbeat-survives-item-commit.it.test.ts —— 缺 raw-sink 正样本对照

boundary 那条用 `runBoundaryGap(production: boolean)` 同 harness 双跑，正控与生产版互为对照；Responses 这条只有生产版。当前它靠"修复前必红"获得裁决力（M1 已证），但少了"同 harness 换 raw sink 就绿"这一半，就无法在未来某次 harness 退化时区分「生产语义回归」与「harness 自己不灵了」。建议照 boundary 那条重构成参数化双跑。

### [LOW] tests/responses/heartbeat-survives-item-commit.it.test.ts:180 —— 锁住了 driver 行为，没锁住 handler 接线

测试把 `isResponsesCommitBoundary` 直接传给 `runResponseBufferedSink`，绕过了生产里真正决定"要不要挂这个谓词"的地方（`candidate-response-session.ts` 的 `transport === "http"` 分支）。也就是说：如果有人误删了那条接线，Responses HTTP 会退回"无 boundary commit"，缺陷不再触发但 A 方案的前提也没了，而这条测试依然绿。建议补一条 http 层测试（或在既有 Responses http 测试里加断言）锁住"HTTP 传输下确实挂了 `isResponsesCommitBoundary`"。

### [LOW] docs/plan/…/plan-0-baseline-and-guards.md:103-107 —— 记录值与文中展示的命令不同源

正文代码块展示的是 `bun test $(rg -ln "anchor" tests/ | tr '\n' ' ')`，实测该命令命中 **54** 个文件；记录的 51 来自 README 里另一条带 `-g '*.test.ts'` 的命令。两处各自自洽，但放在同一份计划里会让复核者算出不同的数。另外 `tests/e2e-client/anthropic-coexist-cli.e2e.test.ts` 里 `expect(r.result).toBe("")` 之后紧跟 `expect(r.result).not.toContain("COEXIST_OK_MARKER")` 是冗余断言。建议统一命令并去掉冗余那行。

---

## 四、scope creep 核查

**结论：src 侧无 scope creep，allocator 接线（P1/P2/P3M）确实没做。**

`git diff --stat` 的 src 侧只有 5 个文件：

| 文件 | 改动 | 是否 P6 必需 |
|---|---|---|
| `delivery/session.ts` | 1 行（`freezeHeartbeat: closeHeartbeat` → `stopHeartbeat`） | ✅ 修复本体 |
| `driver.ts` | `closeAnchorIfOpen` 里 `freezeHeartbeat?.()` → `close?.()` + 同段注释 | ✅ 必需 —— freeze 不再永久后，终局若仍用 freeze，就会给在飞 tick 留出重排窗口 |
| `keepalive-anchor.ts` | 同上（handler 侧的 `closeAnchorIfOpen`）+ 同段注释 | ✅ 同理由，且这是 8 个终局调用点的共享原语 |
| `types.ts` | 仅 `suspendHeartbeat` 的 TSDoc 重写 | ✅ 属契约澄清（但做得不够，见 MEDIUM-3） |
| `client-sink.ts` | 仅注释重写（`freezeHeartbeat` / `suspendHeartbeat` 分工说明） | ✅ 注释与新语义对齐 |

我逐一 grep 过 `createAnchorIndexAllocator` / `wireFrontier` / allocator 相关标识符：**src 内零命中**。P1–P5 的代码一行没写。

非 src 的改动（`exp/`、`tests/helpers/wire-index-oracle*`、`tests/e2e-client/*`、`plan-0*.md`、`spec` 状态行、`.gitattributes`）全部属于 **P0 基线与守卫**，是本次「P0 + P6」授权范围内的；`docs/DESIGN.md` 与 `docs/todo/deferred-backlog.md` 的同步属 plan-6「独立交付」清单明列项。**没有越界。**

`docs/todo/deferred-backlog.md` 新增的那句尤其值得肯定：它明确写了「本条仍活，因为它解决的是不同问题——ping 不重置 Claude Code 300s content watchdog」，避免了把 P6 误当成 300s carrier 问题的解决。这条边界划得准确。

## 五、implementer 自陈两处偏离

**① O-1/O-2 接进既有 `anchor-multiblock-lifecycle.it.test.ts` 而非新建 `wire-frontier-producer.it.test.ts` —— 可接受，且验收未被削弱（略有增强）。**

原断言是就地算 `maxOpen` 并 `expect(maxOpen).toBe(1)`。新断言是 `assertMonotonicWireIndices` + `assertBlockProtocolState`，后者的状态机包含「同一时刻至多一个 open」这条子断言，并额外覆盖 delta/stop 必须引用当前 open block、终局不得悬挂、重复 stop。这正是 plan-0 §Task 0.2 前言里点名要升级的那条「原 maxOpen 过弱」。**严格更强**。避免复制同一套 gated-upstream harness 的理由成立（新建文件会产生第二份需要同步维护的 producer）。

**② anchor 测试文件 51 而非计划写的 52 —— 不削弱验收，但记录方式有小瑕疵（已列 LOW）。**

计划里的 52 是写计划时的估数，实测（`-g '*.test.ts'`）为 51；README 记录了自己用的确切命令，可复算。我复跑 `rg -ln "anchor" tests/ -g '*.test.ts' | wc -l` = 51，一致。基线数字 `481 tests / 474 pass / 0 fail / 7 skip` 我未逐一复跑（已被更强的全量档位覆盖），但其中被修的那条 gated CLI e2e 我**实跑复现了**（1 pass），所以"基线里那条红被真实修掉了"这个关键点是有独立证据的。

## 六、代码质量

- **命名**：`stopHeartbeat`（清 timer）vs `closeHeartbeat`（置永久标志 + 清 timer）本来就分得清；这次只是把 `freezeHeartbeat` 接到了正确的那个上。命名反映实际职责，无异议。
- **无 swallow error**：改动没有引入新的 catch。`closeAnchorIfOpen` 里既有的 `catch { /* client gone mid-close — best-effort */ }` 带有解释性注释，符合 `never-swallow-errors` 的"至少写清为什么"。
- **契约注释**：`client-sink.ts:281-284` 与 `keepalive-anchor.ts:164-166` 的重写**准确**（与新语义一致）；`types.ts` 的 SSOT TSDoc **不够**（MEDIUM-3）；`driver.ts:1267/1292` **已过时**（LOW-1）；`DESIGN.md` **插入点错误**（MEDIUM-4）。
- **测试设计**：`runBoundaryGap(production)` 的参数化正负对照是本分支最漂亮的一处；`delivery-session.unit.test.ts` 的正控 + 负控成对（可恢复 / 不可复活）也符合"防修过头"的要求。扣分只在就绪门用了全局 timer 计数（BLOCKER-1）。
- **提交粒度**：8 个 commit 语义清晰、conventional commits 规范、红→绿顺序正确（`test(delivery): lock…` 先于 `fix(delivery): …`），无模型署名。唯一可议的是 `063f45f9 test(anchor): preserve exact SSE baseline bytes` —— 它给一个错误产物做字节保真（见 HIGH）。

## 七、其他实跑观察（供参考，非本分支责任）

- 全量档位里另外两条偶发红与本分支无关，我在多次运行中看到它们时有时无：`atomicWriteJson > crash during writeFile leaves the previous target intact`、`History V3 canonical capture performance > capture cost follows new work rather than growing superlinearly`（后者是性能阈值型）。建议主会话另行归因，不要让它们和 BLOCKER-1 混在一起。
- `bun run lint:all` 全仓 390 error 全在 `ui/`，本分支未触碰，属既有债。

## 主观建议

```text
[建议] tests/pipeline/heartbeat-survives-boundary-commit.it.test.ts —— 把 FakeClock 的就绪等待抽成共享 helper（例如 waitForTimerDelay(clock, ms)）—— 预期影响：BLOCKER-1 这一类「全局 timer 计数被同 shard 邻居污染」的坑在本仓已有多处 FakeClock 使用者，抽一个带语义的等待原语能一次性堵住同型问题，而不是逐个测试打补丁 —— 推荐做法：放 tests/helpers/fake-clock.ts 旁边，内部用 liveTimerDelaysMs。

[建议] exp/inter-block-anchor-allocator/byte-equivalence.sh —— 把「起服 + 校验端口归属 + 就绪」抽成可复用的脚本片段或 helper —— 预期影响：项目已在 tests/e2e-client/harness/spawn-proxy.ts 里做过一遍同样的事，且记忆库已有这条战例；两处各写各的迟早会再踩一次 —— 推荐做法：复用 spawn-proxy 的做法或至少在脚本里引用该战例的检查清单。

[建议] plan-6 §「独立交付」清单 —— 在合并前把「异模型 reviewer 审这一相位的合并态」那条打勾时，一并记录本报告路径与结论 —— 预期影响：后续相位接手时能直接看到 P0 的 O-6 基线曾被判定不可信，避免拿它当权威 base 做 cmp —— 推荐做法：在 plan-0 收口表的两行基线值旁加一行「⚠ 2026-07-27 code review 实测该捕获来自 peer 进程，待重建」。
```

---

## 可否合并入 master

**当前状态：不可合并。** 需先处理：

1. **必须修**（BLOCKER-1）：`heartbeat-survives-boundary-commit.it.test.ts` 的就绪门改用 `liveTimerDelaysMs`，并把 `heartbeat-survives-item-commit.it.test.ts` 的同型潜伏一并改掉；改完在 `bun scripts/parallel-test.ts unit it http` 连跑 ≥ 5 次确认全绿。
2. **必须处理**（HIGH）：O-6 字节基线。最低限度是给脚本加端口归属校验 + 把当前 fixture 标注为未验证并从 P0 收口表撤下；更好的做法是换端口重新捕获真基线。**不要**让一个会静默变绿的假 oracle 进主线。

**修完上面两项后可以合并** —— 心跳修复本体（`session.ts:205` 那一行 + 两处 `closeAnchorIfOpen` 改 `close()`）我认为是**正确、最小、根因级**的，值得尽快上主线止血（Responses HTTP 默认配置即受影响）。

MEDIUM-1（terminal-drain 无外层 suspend）建议在同一批里一起修——它是本次改动引入的不变量弱化，且修法只是一行 `sink.close?.()`；若主会话决定分开，请务必在 P5 开工前闭合，因为 A 方案的 gap anchor 正好依赖 tick 在 flush 期间不乱注入。MEDIUM-2/3/4 与全部 LOW 可作为随后一个 doc/test 补丁提交，不阻塞合并。

**绝对断言自查**：本报告里「未发现」「覆盖了」「恒为 false」「没有 scope creep」四类断言，均已按 `verifying-authoritative-claims` 复核 —— 分别对应「五入口全调用点 grep + 逐点读」「8 + 2 个 closeAnchorIfOpen 调用点逐个读上下文」「读 frame-origin.ts 实现 + 该模块文档明写 anchor 不走帧 tag」「grep allocator 标识符零命中 + diff --stat 逐文件过」。未复核到的部分我已在正文显式标注（MEDIUM-1 的失败场景标为「推理，未实证」；plan-0 的 481/474 基线数字未逐一复跑）。

---

# 最终确认（第二轮，2026-07-28）

复审对象：`063f45f9..HEAD` 新增 4 commit —— `238ed08c` / `71e6e1c9` / `16a3a933` / `d8f7546d`。仍是独立实测，不采信 implementer 与主会话的转述。

## 结论

**上轮全部 11 项发现（BLOCKER 1 · HIGH 1 · MEDIUM 4 · LOW 5）已全部闭合并经我独立验证。**

**本轮新增：MEDIUM 1（`byte-equivalence.sh` 每次成功运行泄漏一个测试服务器进程，且当前机器上已有 2 个存活残留）· LOW 1（一条与本分支无关的既有分片污染 flake）。**

**可否合并入 master：可以合并。** 新增的 MEDIUM 只影响 `exp/` 脚本卫生，不触及任何生产代码、也不影响新基线的正确性（我已逐字节复现），不构成合并阻塞；但建议同批或紧接着修掉，并清理机器上那 2 个残留进程。

## 逐项验证

### 1 · BLOCKER 闭合 —— 确认，且污染正控真能咬

两条锁的就绪门都已改为只认自己的 15,000ms timer：

```ts
for (let i = 0; i < 500 && !clock.liveTimerDelaysMs.includes(15_000); i++) await Promise.resolve()
expect(clock.liveTimerDelaysMs.filter((delay) => delay === 15_000)).toHaveLength(1)
```

- `heartbeat-survives-boundary-commit.it.test.ts:216-218` ✅
- `heartbeat-survives-item-commit.it.test.ts`（同型潜伏）**也已修**，且顺带把整个用例重构成 `runItemGap(makeSink)` 参数化双跑，补上了我上轮点名缺失的 raw-sink 正控 ✅（LOW-3 一并闭合）

**污染正控自验（按要求，不只信声称）**：两个文件都新增了 `setTimeout(() => undefined, 1_000) // shard-neighbor control`。我把两处就绪门**改回旧的 `liveTimerCount` 形态**后连跑 8 次：

```
old-gate: pass=0 fail=8
(fail) Responses HTTP … an idle still emits keepalives
(fail) Responses HTTP … positive control: raw sink
(fail) heartbeat after a real buffered boundary commit … production delivery sink
(fail) heartbeat after a real buffered boundary commit … positive control: raw sink
```

**8/8 稳定转红**，且 4 条 gap 用例全中——这个正控比原缺陷场景更强（它连 raw-sink 正控也一起保护住了）。还原后单跑 6/6 绿。

**标准档位连跑 5 次**（`bun scripts/parallel-test.ts unit it http`）：

```
run1: 6495 tests · 6495 pass · 0 fail
run2: 6495 tests · 6495 pass · 0 fail
run3: 6495 tests · 6495 pass · 0 fail
run4: 6495 tests · 6494 pass · 1 fail   ← 与本分支无关，见 LOW-新1
run5: 6495 tests · 6495 pass · 0 fail
```

**两条 P6 回归锁在 5 次运行里 0 次复发**（上轮是 4/4 复发）。BLOCKER 闭合成立。

### 2 · HIGH 闭合 —— 三层归属门逐层实测，能拦住我当初发现的那种静默命中 peer

- **门① 端口占用拒绝**：那个 peer 进程**至今仍在**（`pid=2509431`，`bun run --cwd .../.worktrees/keepalive-300s exp/tool-keepalive-safety/mock.ts`，仍占 42061）——这是最理想的活体正控。`PORT=42061 ./byte-equivalence.sh` → **rc=3**，打印 `refusing occupied test port 42061; current owner:` 并列出占用者，**没有生成任何 capture 文件**。这正是上轮那次静默污染的入口，现在被硬拦。默认路径改为内核选空闲高位端口（`socket.bind(("127.0.0.1", 0))`）。
- **门② 启动日志 + 监听 PID 归属**：readiness 循环同时校验 `grep -qE 'Failed to start server|port already in use'`（上轮那次 `server.log` 里正是这行，却被旧脚本忽略）与 `assert_listener_owned`（`ss -ltnp` 取唯一监听 PID，再沿 `/proc/<pid>/stat` 第 4 字段向上走 ppid 链，确认是本次 spawn PID 或其后代）。实跑成功路径输出 `port=45091 listener_pid=3299504 spawn_pid=3299496` —— 祖先链判定确实生效（监听者是 spawn 进程的子进程）。
- **门③ hook 独有标记**：`grep -Fq msg_allocator_baseline` + `grep -Fq 'allocator baseline'`，不中则 rc=7。**自验该门可达且真咬**：把 `HOOK_MARKER` 换成不可能出现的串重跑 → `rc=7` + `captured wire did not come from deterministic-hook.ts`。

**新权威基线独立复现**：`CAPTURE_OVERRIDE=/tmp/p6-newbase.sse ./byte-equivalence.sh` →

```
1c6163c62f568fd5e1a46605c23716d1017b47232021b371f3cb145b2a4277f9  764 bytes
diff /tmp/p6-newbase.sse exp/.../pre-change-wire.sse → IDENTICAL
```

与声称值、与仓库内 fixture **三方一致**。且 fixture 内容现在**确实是 `deterministic-hook.ts` 的产物**（`id:"msg_allocator_baseline"` / `model:"claude-opus-5"` / `text:"allocator baseline"` / `input_tokens:5` / `output_tokens:3`），与上轮那份 peer mock 的 `msg_1` / `claude-opus-4-8` / `"ok"` 彻底不同 —— 死代码 `deterministic-hook.ts` 现在真的被执行了。

provenance 叙述也处理得当：README 与 plan-0 都**保留**了「首版 `24eda6b8…/734` 经合并态 review 证实来自固定端口上的 peer mock，已作废」的记录，而不是悄悄换个数字。这符合项目的 `dont-lose-history` / 证伪留痕。

### 3 · MEDIUM（terminal-drain C1）闭合 —— 修法正确，未引入反向问题

`driver.ts:1391` 在 terminal-drain flush **之前**加 `sink.close?.()`，注释说明「true response terminus / 无后续流需要 resume / 阻断在飞心跳操作的 finally 重排」。我独立核实了三点：

- **没有后续流被误杀**：`if (drained && (sawMessageStop || sawUpstreamError))` 这个块的两条出口都是 `return`（`complete` 或 `stream-error`），continuation-retry 分支在其**之后**的失败路径里（`continuationCount++` 在 :1471，`continue` 在 :1499），**不可能**在 terminal-drain flush 之后再来一条腿。且 `runResponseBufferedSink` 的 `finally { sink.close?.() }` 本来就会在 return 后立刻关闭——这次只是把关闭点从"flush 之后"提前到"flush 之前"，能被影响的窗口只有这次 flush 本身。
- **不与 retreat / boundary 两腿混淆**：那两处 `isTerminalFlush:true` 但其后仍有流，注释已明确改成「NOT a terminal close」，仍走 suspend/resume。区分正确。
- **反向问题（close 之后 `write`/`writeAnchor` 仍须可用）未被引入**：终局 flush 内部会调 `closeAnchorBeforeReal()` → `writeAnchor(anchor.stopFrame)`，若 close 顺带禁写就会静默丢掉 `content_block_stop@0`。我上轮已用 mutation 证明 4 条既有 http 测试锁住这条；本轮 `delivery-session.unit.test.ts:166-188` 又补了直接单测（`suspend → close → writeAnchor → resume → 推进 4×20s`，断言 `writes` **恰好等于** `[{method:"anchor", …}]`）——一条断言同时钉住"写得进去"与"心跳没复活"，是很紧的 oracle。LOW-2 一并闭合。
- 配套红先测试 `terminal drain permanently closes heartbeat before a slow flush starts`：用装饰器卡住首个 flush write，断言 `closeCalls()===1`、15,000ms timer 已消失、推进 30s 无 ping、释放后 `complete`。设计合理。

### 4 · 其余 MEDIUM / LOW 闭合确认

| 上轮发现 | 闭合验证 |
|---|---|
| MEDIUM `wireShape` 的 `isAnchorFrame` 恒 false | 死分支已删，改为调用方注入 `isAnchorFrame(frame, ordinal)`；新增正样本得到 `["anchor_start@0","delta@0","anchor_stop@0","real_start@1","real_stop@1"]` —— anchor 分支**首次可达**。README 同步改成「裸 `ClientFrame` 不携带 anchor provenance，调用方必须传入判定」✅ |
| MEDIUM `ClientSink` SSOT TSDoc 未写死 | `types.ts` 的 `freezeHeartbeat` 改写为 RECOVERABLE + 「freeze 单独不 fence 已排队的 tick，故可恢复 flush 必须先 `suspendHeartbeat()`」+ 「真终局用 `close`」；`close` 改写为 PERMANENT + **「`write` 与 `writeAnchor` 之后仍必须可用，因为终局 close-off 先关心跳再写最后一帧」**并点名两个消费者。四条语义都写进 SSOT ✅ |
| MEDIUM DESIGN.md 原句被切断 | 原句 `…写进 makeSseSink/makeWsSink，返回格式无关 ResponseOutcome（…）。` 已完整恢复，心跳段移到其后独立成段 ✅ |
| LOW driver.ts:1267/1292 陈旧注释 | 「terminal path's permanent freeze」→「a terminal close」，指向真正提供永久性的入口 ✅ |
| LOW Responses 锁缺 raw 正控 | 已参数化双跑补上 ✅ |
| LOW 生产接线未锁 | 新增 `tests/responses/candidate-response-session.unit.test.ts`：HTTP 下 `output_item.done` 为 boundary、`output_text.delta` **不是**、WS 下 `commitBoundaries` 为 `undefined` —— 三态齐全，正是我点名的那条接线 ✅ |
| LOW plan-0 命令与记录值不同源 | 代码块改为 `rg -l "anchor" tests/ -g '*.test.ts'`，与记录的 51 同源 ✅ |
| LOW e2e 冗余断言 | 已删 ✅ |

### 5 · mutation 复核（最终状态）

把 `session.ts:205` 改回 `freezeHeartbeat: closeHeartbeat`：

```
16 pass / 3 fail
(fail) Responses HTTP … after the first response.output_item.done commit, an idle still emits keepalives
(fail) heartbeat after a real buffered boundary commit … production delivery sink
(fail) P3-T1 downstream delivery session > freezeHeartbeat is recoverable
```

两条 raw-sink 正控（pipeline 与 Responses）**均保持绿**，`close remains permanent` / `close … keeps the write port usable` / `terminal drain permanently closes heartbeat` 也保持绿 —— 正负样本仍然分得开。还原后 **19 pass / 0 fail**，与声称一致。

### 门禁

- `bun run typecheck` → 0 error。
- `bunx eslint --no-cache <本分支全部改动 .ts>` → 0 error。
- 工作树在我全部 mutation 之后已还原并 `git status --porcelain` 校验干净（仅本报告文件为 untracked）。

## 本轮新增发现

```text
事实性发现：

[MEDIUM] exp/inter-block-anchor-allocator/byte-equivalence.sh:88-101 — cleanup 只 kill 了 `bun run` 包装进程，真正监听的子进程被孤立，每次成功运行泄漏一个测试服务器 —
证据：我成功跑完一次后（rc=0、已打印 capture），`ss -ltnp` 显示 pid=3299504（spawn pid 3299496 的子进程）仍在 45091 上监听；`ps` 确认它在脚本退出数分钟后依然存活。更直接的证据是**机器上现存两个 implementer 自己 O-6 验证时留下的残留**：`pid=3259960`（port 54859，`XDG_DATA_HOME=/tmp/p6-o6-owned`）与 `pid=3261081`（port 43943，`XDG_DATA_HOME=/tmp/p6-o6-owned-final`），启动于 00:25 至今未退。这些残留各自持有一份从 `~/.local/share/copilot-api/github_token` 复制来的真实 token，且正是"下一个跑固定端口脚本的人会静默打中的 peer"这一类问题的来源——与本次 HIGH 的根因同源。
讽刺之处：脚本在 `is_owned_process` 里已经实现了完整的 ppid 祖先链遍历（用来*识别*后代监听者），却在 `cleanup` 里只 kill 了父进程——同一份知识在一处用了、另一处忘了。
修复建议：`cleanup` 里改为按进程树精确终止——先用 `assert_listener_owned` 已有的 `ss` 查出监听 PID，连同 spawn PID 一起 kill（保持"按 PID 精确 kill、绝不 pkill/killall"的纪律）；或给 `bun run` 加 `exec` 语义 / 直接 spawn `packages/cli/src/main.ts` 避免中间包装进程。另请**清理机器上现存的 3259960 与 3261081**（我只清理了自己启动的 3299504 / 3301237，未越权动别人的进程；4141 主服务器 pid=2557431 全程未触碰，已复查仍在监听）。

[LOW] tests/restart/states-flush-freeze.it.test.ts — 与本分支无关的既有分片污染 flake —
证据：标准档位 5 次运行里 1 次出现 `(fail) gracefulShutdown 普通信号(SIGINT)不 freeze、仅 handoff(SIGUSR2) freeze`；该文件单跑 6/6 绿；`git diff --name-only 5c84a1e0..HEAD` 不含任何 shutdown 相关文件。属于与上轮 BLOCKER 同一类（`parallel-test.ts` 分片内共享 module 状态）但**不同文件**的既有问题。
修复建议：不阻塞本次合并；建议单独立项，并把本次修好的"就绪门只认自己的 timer / 显式注册邻居污染正控"这套手法作为模板复用。
```

## 可否合并入 master

**可以合并。**

- 上轮 **BLOCKER 1 · HIGH 1 · MEDIUM 4 · LOW 5 全部闭合**，每一项我都独立复验（含把修复反向 mutation 回去确认正控转红）。
- 本轮**遗留 blocker：0**。
- 本轮新增 **MEDIUM 1 · LOW 1**，均**不阻塞合并**：前者只影响 `exp/` 脚本的进程卫生（不改变新基线正确性，我已逐字节复现），后者与本分支无关。
- 建议合并后立即做两件事：① 修 `byte-equivalence.sh` 的进程树清理；② 清掉机器上残留的 `3259960` / `3261081` 两个测试服务器。

**绝对断言自查**：本节的「全部闭合」「不可能在 terminal-drain 之后再来一条腿」「两条锁 0 次复发」「与本分支无关」四类断言，分别对应——逐项列表对照 diff 与实跑、读 :1378-1499 全部出口并核 continuation 分支位置、5 次标准档位运行日志逐条 grep、`git diff --name-only` 全量核对 + 该文件单跑 6/6。未复核项：`16a3a933` 的红先测试我确认了其断言设计但未反向 mutation 验证它会红（其保护的行为已被 `delivery-session.unit.test.ts` 与 4 条既有 http 测试从另外两个角度锁住，故未追加）。
