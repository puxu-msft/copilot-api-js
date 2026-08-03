# KICKOFF —— 接手 inter-block anchor allocator（P3M 及之后）

> 整段复制为新会话第一条消息。事实、证据、理由、完整步骤**都在 [HANDOVER.md](HANDOVER.md)**，本文件只放启动 gate 与第一步。

```text
接手 inter-block anchor allocator 的实施。

先读 docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md（状态行 + 「接手先读什么」两节），再按它的待办 T1→T5 推进。

## 启动前的硬 gate（照做，理由在 HANDOVER）

1. **别信任何文档里的相位进度，先用 git 核**。该目录的 kickoff.md 顶部「先从 P0 开始」是 2026-07-27 的陈旧文本；P0/P1/P2/P6 早已 landed master。判据：`git merge-base --is-ancestor <sha> master`。
2. **每条 Bash 调用自己绑定目录根**（`cd <绝对路径> && ...` 或 `git -C <绝对路径>`），绝不依赖上一条命令留下的 cwd——本轮已因此查错过一次树。
3. **隔离 worktree 里不要用 `bun run test`**（rustup 前置会失败），用 `FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http`。
4. **绝不碰 4141 端口的用户主服务器**。需要真服务器就自起非 4141 实例，按 PID 精确 kill，绝不 pkill/killall。
5. **下任何全套件断言前，先确认没有 peer agent 在同一棵树跑测试或做 mutation**——本轮一次全套件 4 条失败全是并发污染，隔离复跑全绿。
6. **mutation 探针一律在自建的 scratch worktree 做**，做完还原并复跑确认真还原了。

## 第一步

看 HANDOVER 的「**M1 未闭合的判据问题**」那一节（G1–G3）与 T1。当前卡点**不是**等复评（两路复评都已回话并完成复核轮），而是**判据轴问题待第三方裁决**。

- **裁决已回**（`docs/tmp/2026-08-03-m1-guard-axis-adjudication.md` 有四项结论）→ 按裁决修 G1、按其定级处置 G2/G3 → SendMessage 恢复**原评审者**复核（别重派）→ 合 master → 进 T2。
- **裁决未回** → 等，**不要自己再换一次判据轴**。主会话已经自己换过两次，两次都被交出绕过 witness；轴的选择已经交出去了，别收回来。
- **裁决产物不存在或只有头部** → 那个 agent 中途撞了 API 抖动，用 SendMessage 续跑（它记得上下文），别重派。

⚠️ **门禁全绿不等于 M1 可定稿**：`typecheck` 绿 + 6848 pass 对 G1–G3 三处结构性失明——它们都是「实现落了但锁不住它」。


## 批准状态

- **用户已批准**：M1 直接开工做完再报；wire-torn 时 `closeOpenAnchor` 放行（已写进 C9）。
- **需用户先定**：P8.4 的 ADR D2 改动——**停点在写文件之前**，只出逐段草案，获明确同意才改。
- **不得自行拍板**：P7.2 若必须改 anchor 载体（β 方案），停下回报。

## 唯一的硬序约束

M6（特性开门、删 `semanticBlockCount === 0` 那道门）**必须晚于 M2–M4 全部完成**。开门前两种记账算法数值等价，开门后才会产出多 anchor。

## 这一轮反复踩的坑（HANDOVER 有完整表与复发点）

- 否定性/完备性断言（「共 N 个」「没有别的」）不能建立在被 `head` 截断的输出上。
- 新写的 oracle 可能在你**这次采纳的形状**下必红——写之前先问「正确实现会不会也红」。
- 给守卫补第二种拼写之前先自己写一个合法绕过 witness；写得出就换轴。
- 「落到持久载体」要核到 HistoryEntryData 字段与投影为止，别停在「它进了 observability 事件」。
```
