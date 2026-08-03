---
name: methodology-dont-specify-across-a-seam-you-havent-read
description: 在 plan/skill 里跨缝规定行为前必须读过缝的两侧，否则产出的是看起来权威、执行者物理上做不到的空指令
metadata:
  type: feedback
---

**要在指令文本（plan / skill / 契约表）里规定「A 调 B 时该怎么做」之前，先读 A 的调用点和 B 的签名。读不到就别定形状——只写必须成立的性质，把「定形状」写成一个带停下回报点的调查 task。**

**Why:** 2026-08-02 一天之内同一形状翻车四次，全部是「规则自洽、读起来合理，但执行者物理上做不到」：
1. **进度文件用 agent id 命名** —— agent id 要 spawn 之后才存在，而路径必须写进派活消息里；agent 自身环境也读不到它。
2. **让 10 个 close 站点「交给既有映射」** —— `ownerFailureOutcome` 是 `driver.ts` 的**私有函数**，handler 站点 import 不到。
3. **自拟 adapter 签名 `return d.outcome`** —— 部分 handler pump 返回 `Promise<void>`，没有 outcome 可 return；签名还缺 `env.clientFormat`，保不住 `streamErrorOutcome` 的 provenance-gap 语义。
4. **要求 owner「一并维护 legacy 字段」** —— owner 只持 `GenerationWireState`（`session.ts:46`），够不到 handler 持有的 `AnchorState`。**而我为修复它写的候选方案之一（mirror 写留在 injector wrapper 层）本身也不可执行**：那个 wrapper 只中介 open，11 个 close 站点不经过它。

**四次的动机都是「把事情定死、消除歧义」**——动机是对的，但**不掌握定死所需的事实时，「定死」产出的比留白更坏**：留白会让实施者去查，假指令会让他照着做然后卡住，而且指令的权威外观会压制他的怀疑。

**缝不只是代码缝**（2026-08-03 三个新实例，同一形状、不同介质，全部由外部证据打回、自审一次都没抓到）：
5. **角色边界缝** —— 规则写「收尾时交给一个 agent 审」，而全局硬规则禁止 leaf executor 派 agent。我写指令时**默认自己是能派 agent 的那种会话**，于是给一部分执行者写了条物理上执行不了的指令。修法是补转交分支（义务转移、不消灭）。
6. **数据可得性缝** —— 我判定「没有任何人能构造出包含『静默从未用过它』那批会话的分母」，据此把两条断言改成永不毕业。实际 transcript 对**每个**会话都落盘，与它调用过什么无关，本机 1030 主 + 2276 subagent 可直接枚举。**我把「不会主动来报告」错当成了「无法被枚举」**——行为不可得 ≠ 数据不可得。
7. **数据格式缝** —— 写「events 落在 `[start, cutoff)` 内」却没定义用哪个时间字段。实测 ~107 万条事件里 **~8.56 万条没有顶层 `timestamp`**，且长会话跨窗（本会话窗前 1750 / 窗内 630）；文件 mtime、首条 timestamp、「整文件是否命中」三种取法会选出三个不同的 population。

**How to apply:**
- **动手写「怎么调」之前先问：这个函数导出了吗？调用方的返回类型是什么？这个 id/对象在那一刻存在吗？** 三个问题任一答不上来，就不要写形状。
- **把同一组问题推广到非代码的缝**：执行这条指令的人**有没有这个权限/角色**？我说「查不到/拿不到」的东西，是**行为拿不到还是数据拿不到**？我写的时间/范围/键，**落到具体字段是哪一个、缺失时怎么办**？
- **写不了形状时的正确产出**：① 冻结**必须成立的性质**（唯一实现点、穷尽性、短路、终态分类、证据必须有持久载体…）；② 把「读完两侧 → 定签名与位置 → **停下回报**」写成第一个 task；③ 给该回填加硬门——**它本身就是指令文本**，须过独立评审 + 精确提交合主线，才能继续执行。
- **在过渡期给已有文字加读法**：「凡说『X 维护 Y』的表述，按『待调查定供给方式』理解」。不加这句，实施者会照着尚未修复的旧表述做。
- **给出候选方案时，每个方案也要过同一道检查**——第 4 次翻车就是候选方案自己没过。
- **把「为什么原措辞是错的」留在正文**，不要只写正确版本；否则后来者会凭直觉退回那个更省事的形状。

**相关但不同的一条**：合并同类项时，「动作相同」不等于「可以合并」——`client-gone` 的 preflight 与 write-catch 两个来源动作相同但**证据不同**（零字节 vs 发了一半），合并会丢 partial-delivery 事实。**证据不同就不能合并。**

**Related:** [[feedback-pass-null-clean-not-self-validating]]（结论不自证）[[methodology-new-oracle-discriminating-power-is-experimental]]（咬不咬得住是实验不是推理）[[methodology-each-fix-round-introduces-green-passing-regression-at-the-same-seam]]（同一条缝反复出事）[[methodology-abort-provenance-tag-at-source-not-guess-at-boundary]]（没有产生点标签就只写「已排除什么」）
