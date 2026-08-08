# History Worker Batch 1b 评审转录与处置

> 状态：整改后待原 reviewer 复审。
> 评审基线：`661e1792`；合并态基线：`51f0e57e`；当前整改工作树基于 `master@44457047`。
> 来源：生命周期 reviewer、overlay／判据 reviewer、lossless shutdown 合并态 reviewer 的工具回传；主会话转录并按 C 级代码裁定处置。

## 发现与处置

| ID | 严重度 | 发现 | 处置 |
| --- | --- | --- | --- |
| R1 | major | `createRequestContext()` bind 后，codec parse 中途抛错时 `getContext()`仍为 undefined，reservation 可永久占用。 | **采纳（C）**。四个 codec 在 `manager.create()`成功后立即发布 context给 `getContext()`；真实 malformed CC请求回归等待 admission quiescence后断言 `reserved=0/unacked=0`。 |
| R2 | blocker | pending／ack-recent overlay只覆盖 list／stats，session summaries、session entries与status memory漏掉。 | **采纳（C）**。新增共享 `history/overlay.ts`；sync list、stats、session两表面、status统一消费；session summary SQL用overlay JSON CTE并按operation ID排除DB重复。新增pending可见与ack-recent＋DB＋pending三源去重回归。 |
| R3 | major | 入口AST guard只数函数体中的同名调用，不能证明wrapper包围真实operation，豁免表面也缺饱和负控。 | **采纳（C）**。饱和controller动态驱动7个HTTP operation route，逐路径要求`waiting=1`；client abort后归零。liveness／History／status／metrics／dry-run在同一饱和状态保持`waiting=0`。Responses WS保留真实饱和＋close abort测试。 |
| M1 | major | lossless shutdown在reservation已grant、async continuation尚未bind时可先读空operation registry；迟到finalizer失败可能越过一次性join而被漏报。 | **采纳（C）**。新增acquire→bind/release handoff barrier；manager先将context放入operation registry再bind；shutdown Step 1 stop后、首次registry snapshot前drain handoff。真实controller＋manager成功双控与迟到finalizer失败双控均已通过。 |

## 整改验证

- `bun run typecheck`：通过。
- 四项整改联合目标集：91 pass／0 fail，14 files，289 assertions。
- Overlay性能／行为：`summary-query-performance`保持summary-only读取，128 MiB manifest下large read约22 ms，legacy scan约186 ms；相关两文件全绿。
- Handoff：成功路径与迟到finalizer失败路径均进入真实controller／manager；失败路径使shutdown返回`Shutdown persistence failed`并释放reservation。

## 复审要求

1. 生命周期 reviewer复核R1及相邻四codec成功／失败路径。
2. Overlay／判据 reviewer复核R2、R3，特别是三源去重与动态入口矩阵的false-green／false-red。
3. 合并态 reviewer复核M1与lossless shutdown：handoff barrier不得阻塞已接纳operation，也不得漏迟到finalizer失败。
4. 只剩minor时直接判可合；任一blocker／major继续整改。
