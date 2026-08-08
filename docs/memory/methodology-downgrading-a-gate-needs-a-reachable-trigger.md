---
name: methodology-downgrading-a-gate-needs-a-reachable-trigger
description: 把自评闸门降级为「记录+择期裁决」时，判官与记录位置好补，触发点最容易漏；且要检查触发点的宿主会不会先于断言消失
metadata:
  type: feedback
---

**`downgrade-self-adjudicated-gates`（user-rule `30-use-of-agents`）要求的不止三样：判官、触发点、记录位置，外加**记录必须带 level**（level 决定日后被多严地复核，级别越高越要交给未卷入的一方；四档定义在 skill `adopting-agent-findings`）与**降级这件事本身要说出来让用户可否决**。写的时候会自然补上判官和记录位置——「交给一个没写过它的 agent」「追加到这个 log」——而**触发点最容易只写成一句陈述**。判据是：一个未来会话在它必经的流程里，会不会真的走到这一步？走不到，这个机制就还是装饰品，只是换了个文件住。**

**Why:** 2026-08-03 同一条判据被外部评审连打回三轮，每轮我都以为已经修好了（评审全过程在 `docs/tmp/2026-08-03-selfverify-mechanism-review.md`，五轮 244 行）：

1. **判据留在 always-on 规则正文**（`~/.claude/rules/00-user/20-tool-use-preference.md` 的 `root-each-bash-call`）—— 评审判定「没有执行者、没有触发点、没有记录位置」，是 `downgrade-self-adjudicated-gates` 要防的形态本身。
2. **第一轮打回：搬进 skill 的 verification-log 只修好三分之二** —— 补上了判官和记录位置，我以为闭合。评审实证：项目 `.claude/skills/session-closeout/` 里 `rg` 唯一命中的是**那个 skill 自己的**自验 log，我的断言一个入口都没有。
3. **第二轮打回：在规则正文加了触发指针，仍不可达** —— 同一轮两处：指针字面只要求「审有没有依赖 sticky cwd」，**照字面执行只裁得了三条断言里的一条**；且我没写 leaf executor 的转交分支（全局硬规则禁止 leaf 派 agent，`~/.claude/rules/00-user/00-kernel.md`）。
4. **第三轮打回：触发点寄生在会消失的宿主上** —— 它挂在规则的 `Provisional` 条目上，而该条目**会在另一条断言毕业时被删除**——那条断言毕业之日，就是这条断言失去唯一入口之时；同轮还指出审计人口仍偏（只覆盖离开初始 cwd 的会话）。修法是改成**按日期触发的独立 cohort 审计**（协议落在 `~/.claude/skills/proving-where-a-command-ran/verification-log.md`），不寄生在任何会消失的宿主上。

**配套的两条（都来自同一批产物，属于「自验机制自身怎么不烂掉」）：**

- **摘要 + 明细两个可独立写的点，没有对账门就必然漂。** 同一份 verification-log 里「票数」与「逐条记录」都要人手写，结果三张票记进了记录、票数小节纹丝不动地停在 `0 证实`。修法不是提醒自己细心：**指定明细为权威写入源、摘要降为派生视图**，规定投票必须在同一次编辑里追加记录并重算摘要、提交前从明细重数对账、不一致以明细为准。这是真正的单写入源机制，不是“其他文档不得完整解释结果”的复述禁令；摘要与说明仍可完整呈现，但必须可追溯到明细。任何「手工维护的汇总 + 明细」都适用。文档复述政策见 [[feedback-one-authority-allows-contextual-restatement]]。
- **写进文档的指纹必须带 canonical bytes 的取法。** 我记了 description 的 sha256 前缀却没说是否含行尾 LF，评审按「第 3 行」字面 hash 得出不匹配、报了 major，继续枚举后发现我那个值正是含 LF 版，当场自撤。**歧义是真的**——直接写成可复跑的命令（`sed -n '3p' F | sha256sum | cut -c1-16`）而不是一个裸值。**这与 [[methodology-dont-specify-across-a-seam-you-havent-read]] 的「数据格式缝」是同一教训的两个实例**（那边是没定义时间窗用哪个字段，这边是没定义 hash 含不含 LF）——改一处记得看另一处。

**How to apply:**
- **补完判官和记录位置后，把「未来会话读到什么」交给未写过这份文本的人走一遍**——**不要自己走**。本条自身的记录就是判据：这四轮打回**全部**来自外部评审，我自审的命中数是 0。自己走查时读到的是「我想表达的意思」，而执行者读到的是字面。走查要问：它只读 always-on 时能不能到达？**协议若只住在 skill 里，能读到它的恰恰是已经打开该 skill 的那批会话，而那批不需要被审计**。
- **触发指针要逐条列出要裁什么**。写「审一下 X」而实际有三条断言，执行者照字面只会裁 X。
- **检查触发点的宿主寿命**：这个入口会不会因为别的事情（另一条断言毕业、某个标记被摘掉、某份文档归档）先于断言消失？会，就换一个不依赖它的触发（日期、必经命令、独立文件）。
- **写指令时别默认执行者和你有一样的权限**。我默认自己是能派 agent 的会话，于是给 leaf executor 写了条它做不到的指令。补转交分支：义务转移，不消灭。
- **构造审计分母时，去找独立于被测行为的落盘数据源**。我一度判定「静默没用它的会话无法枚举」，据此把断言改成永不毕业——错的：transcript 对每个会话都落盘，与它调用过什么无关。**「不会主动来报告」不等于「无法被枚举」。**
- **「永不闭合」不是安全的保守选项**。它看起来更严格，实际产出一条永久占注意力、最终没人执行的僵尸断言。要正面权衡假绿毕业与永不闭合两种代价，别默认保守就是对。

**Related:** [[methodology-dont-specify-across-a-seam-you-havent-read]]（同一形状的通用版：跨没读过的缝规定行为）[[feedback-pass-null-clean-not-self-validating]]（零 miss 的 cohort 若一个 exposure 都没有，是 vacuous 而非通过）[[feedback-skill-claims-needing-field-proof-must-self-verify]]（自验表 + 记录文件的范式）
