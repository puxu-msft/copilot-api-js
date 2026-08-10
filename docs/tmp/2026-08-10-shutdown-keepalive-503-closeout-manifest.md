# 2026-08-10 · shutdown keep-alive 503 收尾清单

配套交付：分支 `worktree-shutdown-keepalive-503`（master 之上 10 个提交）。本文件是收尾规程 `closing-a-development-session` 的 `inventory_job_tmp` / `discover_nonfile_candidates` / `review_temp_manifest` 三个阶段的产物，供独立评审对账。

## A. job 临时目录 manifest

枚举命令与口径：`find /home/xp/.claude/jobs/94a67bb3/tmp \( -type f -o -type l \)` = **6**，`fd -H -I --type f --type l` = **6**（两法一致；`fd` 不带 `-I` 会遵守 gitignore 而少报，本项目已有该踩坑记录）。枚举时点在终态报告**之前**；清单定稿前复列，**无新增文件**。

**最终处置：一律保留，零删除。** 理由：全部行的长期价值均已进入已提交的接收者，删除与否不影响可恢复性；而删除需要独立评审出具正面回执，保留是更保守的一侧。目录交由 harness 过期。

| 绝对路径 | 类型 | 长期价值 | 接收者 / 替代证据 | 最终动作 | 清理前置 |
|---|---|---|---|---|---|
| `…/tmp/probe-conn-close.ts` | file | **有**：唯一产出「Bun 转发 `Connection: close` 但不自行关 socket」这一断言，该断言写在 `src/lib/observability/middleware.ts` 的 doc comment 与 commit `4a86e826` body 里 | `exp/shutdown-keepalive-503/probe-bun-connection-close.ts`（commit `4245d832`，后经 `92f77476` 加固失败退出码） | 保留（已归档副本） | 接收者已在 commit 对象中 |
| `…/tmp/probe-undici-pool.mjs` | file | **有**：唯一产出「undici 见到该头即不复用 socket，3 请求→3 连接」这一承重实测 | `exp/shutdown-keepalive-503/probe-undici-pool-eviction.mjs`（`4245d832` / `8492beb2`） | 保留（已归档副本） | 同上 |
| `…/tmp/q3.ts` | file | **有**：产出 13:01:57.734Z–13:11:46.755Z 空洞这一事故证据 | `exp/shutdown-keepalive-503/query-history-gap.ts`（`4245d832`） | 保留（已归档副本） | 同上 |
| `…/tmp/q4.ts` | file | **有**：产出空洞两端时间戳 | `exp/shutdown-keepalive-503/query-history-gap-bounds.ts`（`4245d832`，头注释经 `92f77476` 收窄） | 保留（已归档副本） | 同上 |
| `…/tmp/q.ts` | file | **无**：history-v3.db 表名内省，一次性 | 结论已属 skill `history-sqlite-schema`；无需接收者 | 保留（可弃，但不删） | — |
| `…/tmp/q2.ts` | file | **无**：`PRAGMA table_info(v3_operations)`，一次性 | 同上 | 保留（可弃，但不删） | — |

## B. 非文件候选

事件源：本会话 transcript `~/.claude/projects/-home-xp-src-copilot-api-js--claude-worktrees-shutdown-keepalive-503/94a67bb3-b911-4df8-829b-314c171de9e2.jsonl`，**候选范围冻结在切片 1–2598 条**（该文件随会话继续增长，第二遍对账时已达 2685 条；版本探针等其后事件已单独并入下表）。

**版本 7（定稿）。** v1 为作者单方枚举 24 项；独立评审从同一事件源逐遍对账，**六遍无一为空**：第一遍 **+16 遗漏 / +2 更正**（`0/2 major`）、第二遍 **+4 / +5**（`0/3`，其中数条是作者在 v2 里**新引入**的）、第三遍 **+4**（`0/1`）、第四遍 **+1**（`0/1`）、第五遍 **+2**（`0/1`）、第六遍 **+1**（`0/1`）。轨迹 16→4→4→1→2→1。

**收口口径（须如实读）**：差集**并非严格为空**，而是第六遍评审在补入 3.19 后**明确建议收口**——其理由是剩余未入表候选（API 抖动后 `SendMessage` 续跑、临时日志清理等）属既有规程的普通执行记录，对本主题无新增事实，继续逐命令枚举的边际收益已接近噪声。作者接受该判断，并记下这是**有理由的收口**而非「已穷尽」。

**本轮最该被记住的**：作者对刚做过的事最看不见（一遍两遍都不够）；**更正本身反复成为新的错误来源**（3.6、3.8、3.11、3.18）；而清单里行动价值最高的一条 3.19，指向的是**一条早已存在、被作者违反的规则**，不是新发现。

### 类 1 · 放弃的路线（试过、否决、别再试）

| # | 内容 | 来源 | 如何复现 / 为何否决 |
|---|---|---|---|
| 1.1 | 只修 `observabilityMiddleware` 的 503 分支（最先发现问题的那一层） | 首版实现 | 被评审用探针证否：config/token 中间件先于它且带 await，抛错走 `onError` 绕过 |
| 1.2 | 503 分支与基座中间件**都**设该头（双写） | 移到基座时 | 放弃以免同一不变量两处定义漂移；改为基座单一 owner + 分支注释指向 |
| 1.3 | 对 `docs/ws-openai-responses.md` 只做「陈旧标注」而不重写 | 处置评审第 11 条 | 放弃，因读者照旧文会调用 spec 明令禁止的 `stopNew()` |
| 1.4 | `git reset --hard master` 重置落后基线 | worktree 基线修正时 | 被 git 护栏拒绝；改用保留本地编辑的 `merge --ff-only master`（transcript `:322-327`） |
| 1.5 | 顺序变异写成「彻底不调用 `server.close(false)`」 | 变异 2 首版 | 自判不忠实（那是「不关」而非「关得晚」，判别力对不上），改为真实的「延后调用」变异；**该版本从未跑过测试**，故属放弃路线而非已执行变异（`:613-634`） |
| 1.6 | 用自建最小 Hono app 做接线守卫 | 首版测试 | 删除生产注册后仍 44/44 全绿 → 无判别力；改用真实 `createServer()`（`:1548-1653`） |
| 1.7 | 用 `bun test … \| tail -25` 直接看测试结论 | 首次跑 shutdown 档 | 管道触发 bun coverage `WriteFailed`，且**管道会把退出码换成过滤器的**；改为完整输出落盘后再筛（`:425-450`） |

> **不属于本类的相邻项**：让 `Connection: close` 覆盖**全部**响应（含 2xx 与已提交 200 的 SSE）**不是被否决的路线，而是有意未决**——需在流式响应提交头之前决策，已写进 middleware 的 scope note 与 `docs/lifecycle.md` 残留条。v1 把它误记为「放弃」，会错误劝阻后续研究（评审方向 A · major）。

### 类 2 · 被证伪的因果解释

| # | 我曾断言 | 被什么推翻 | 现在的说法 |
|---|---|---|---|
| 2.1 | uptime(1876s) 与 etime(2679s) 的差 = 进程内重启 | `setServerStartTime` 位于 listen 之后（`packages/cli/src/start.ts`），pidfile mtime 13:02 佐证 | 不是重启，是**启动耗时 803 秒**（成因未查明） |
| 2.2 | 9m49s 空洞证明该窗口内所有请求都被 503 | 第三方裁决：空洞只说明无记录；被 503 的请求本就不入 History | 有力证据是客户端 transcript（13:05:42/13:06:00/13:09:24 至少四个 session） |
| 2.3 | `Connection: close` 单独对症（机制 = 客户端池复用） | 裁决指出 (B′)：listener 可能根本还没关——两个 await 无上界 | 证据**不足以区分** (A)/(B)，故两条都堵 |
| 2.4 | 前任 16 秒 drain 完，余下 9 分钟是仍活着仍在拒绝 | 第三方裁决：该查询只读 operation 行，读不到进程存活/registry | 只能说两端时间戳。⚠️ **收窄本身又过度声称了一次**：第一次只改 README、写出「服务恢复于」（同样超出查询能力）且漏改脚本头注释，被第三方再次打回才收窄到位（见 3.11） |
| 2.5 | 是「证伪评审」污染了我的 worktree | 合并态评审事后自述是它做的 sed 变异 | **归属存疑**，不下结论；确定的只有：变异存在、被我发现并还原 |
| 2.6 | 「关机期**任何失败响应**都带该头」 | 先提交 200、随后流内失败的 SSE 拿不到头（头已发出） | 只主张**最终 HTTP 状态为 4xx/5xx**（`:1548`、`:1674`） |
| 2.7 | skill 初稿：「会一直复用」「实测造成近 10 分钟中断」写成确定因果 | 独立评审判 major | 改为可能性；近十分钟是 **History 空洞**，不是实测中断时长（`:2161-2276`） |
| 2.8 | 新 wiring 测试的污染成因先猜成 History admission 未还原 | 配对复现给出的真实报错是 `[model-operation-record] candidate candidate:0 has 1 open dispatch(es)` | 成因是进程级 runtime 未还原，改用 `useIsolatedRuntime()`（`:1795-1881`） |

### 类 3 · 改正的解析/口径错误（无失败信号，最难自查）

| # | 错误 | 表现 | 正确做法 |
|---|---|---|---|
| 3.1 | `rg -rn "restart"` | `-r` 是 replace，把命中改写成 `n`，输出看着像真代码 | 去掉 `-r` |
| 3.2 | `bun test --coverage=false` | 非法参数，打印 help（不是测试失败） | coverage 在 bunfig，改为输出落盘后再看 |
| 3.3 | `git status -uall -- exp/` 空输出 | 与「已提交」无法区分（`exp/` 被 gitignore） | 用 `git ls-tree` 查 commit 对象 |
| 3.4 | worktree 基线 | 从 `origin/master` 建，落后本地 master **858** 个提交，首处编辑落在错误版本上 | `merge --ff-only master` 后重做 |
| 3.5 | 替换覆盖面 | 两次 `Edit` 的 `old_string`/`new_string` 覆盖面不匹配，一次留下重复的 `return c.json(...)` 块（typecheck 才抓到）、一次插入 `server.close` 却没删原处 | 逐次核对差集 |
| 3.6 | unknown-path 测试的覆盖面 | 先误称覆盖 `notFound`/`onError`；**更正本身又**误称单测同时覆盖二者；第三次才收窄 | 已确证的只有：`shutdown.unit.test.ts` 覆盖 `onError`、不覆盖 `notFound`；该 wiring 用例因请求前已置 shutdown、被 gate 提前返回而未触达 `notFound`。⚠️ **不可写成「`notFound` 结构上不可达」**——请求在健康态通过 gate、之后才进入 shutdown 的时序下它是可达的（`:2210-2216`、`:2440-2466`） |
| 3.7 | `finalize` 写成「每条退出路径的汇合点」 | 它位于多个 await 之后且无外层 `finally` | 收窄为「正常 graceful 路径」（`:2227-2230`） |
| 3.8 | **两个探针都**吞掉错误却仍 `exit 0` | undici 探针 `catch {}` 吞掉全部 `fetch` 失败——三次全失败也能输出一份貌似合理的连接数；Bun 探针打印 socket error 后照样正常 resolve | 各自加 `failures` 计数、错误输出与非零退出码。undici 一侧由最终评审指出（`:2161`、`:2227-2244`），Bun 一侧由第三方裁决指出并补正样本对照（`:2471-2511`）——**同一个 false-green 形态在两个文件里各犯一次，且是分两轮才被抓全的** |
| 3.9 | 把「特性 worktree 干净、可快进」当成「主检出也安全」 | 据此给出 `merge --ff-only` 建议 | 从未核验共享主树的工作区与 index；护栏使我结构上查不到（`:2593`） |
| 3.10 | 先宣布收尾完成 | 事后对账发现 **4 个阶段未执行、2 个仅在对话里做过** | 收尾口径错误；本清单即补救产物（`:2565-2593`） |
| 3.11 | 收窄 `ended_at` 结论时只改了 README | 新写出的「服务恢复于」同样超出查询能力，且脚本头注释原样保留旧结论 | **同一处过度声称改了两轮**；第三方第二次打回才到位（`:2199-2207`、`:2440-2565`） |
| 3.12 | 评审称 commit `1854f192` 改了运行时短路顺序 | `git show` 证明它只加注释，顺序在更早的 `4a86e826` 已确立 | 我据证据驳回，第三方裁决支持驳回——**评审的绝对断言同样需要亲自核对**（`:2172-2182`、`:2440-2565`） |
| 3.13 | 旧 PoC 把默认 `fetch()` 的 keep-alive 复用判为「探针假阳性噪声」 | 该判断对「内核新连接分发」这个被测对象是对的，但**它同时就是生产 pooled-client 故障的形状**——当年只修了探针、没修生产 | 本轮才纠正。**这是整个修复的核心洞察，却是作者单方枚举时漏掉的**（`:211-239`） |
| 3.14 | `test-app.ts` 里把 close middleware 称作 outermost | `preMiddleware` 实际注册在它**外侧**，而 `preMiddleware` 占的正是生产 config/token 的位置 | 复评后调整顺序，使测试装配真正镜像生产（`:1226-1266`） |
| 3.15 | 新增 `.it` 文件首次未登记 `entry-test-discovery-baseline.json` | 全后端档位的 entry-evidence 门因此变红，且报错指不到根因 | 确认后补登记；**新增测试文件必须同步该 baseline**（`:1789-1914`） |
| 3.16 | 既有 shutdown 生命周期文档被确认严重陈旧 | 无 Phase 1 `stopNew()`、无 Phase 3 自动 abort、无 Phase 4 force close——五条中四条与现码相反 | 改为「finalize 唯一 `closeAll()` 路径」。1.3 只记了「标注 vs 重写」的路线取舍，**这组被纠正的事实本身**此前未入表（`:1965-2007`） |
| 3.17 | 评审对**工作树状态**的绝对断言 | 它报告「未修改任何文件、保持只读」，而 `src/server.ts` 里 `MUTATION-REMOVED` 就在那儿；靠提交前 `git status`/`git diff` 才发现并逐行还原 | 2.5 只记了「污染者归属存疑」，**漏了这个独立形态**：评审的绝对断言不止在「代码结论」上要复核，**对工作树的自述同样要复核**（`:1589-1621`、`:2424`） |
| 3.18 | 往 `closing-a-development-session` 验证日志追加记录 | 新小节先落到 `## Graduated` **之后**；第一次调序后**仍挂在该节下**；第二次才修对结构 | 又一次「更正本身仍错误」，且发生在收尾记录自身上（`:2386-2424`） |
| 3.19 | 派评审时只在 prompt 文本里写目标目录（「工作目录 = /home/xp/src/copilot-api-js」），**未用工具参数绑定** | agent 实际继承主会话的 worktree cwd，于是变异落进**我的**树而非我以为的主树——这是 3.17 那次污染的**执行接缝与根因** | **这不是新教训，是违反了已有规则**：user-rule `20-tool-use-preference` 的 `bind-delegate-directory` 明写「用工具参数绑定，绝不靠 prompt 点名——prompt 文本对目录零绑定力」。可执行结论：派任何会写文件的 agent 必须用 `Agent` 的 `isolation`/`cwd` 参数绑定，并在其返回后对账 `git diff`（`:1589`） |

### 类 4 · 本轮产生或修订的标定值

| # | 值 | 依据 | 对照 |
|---|---|---|---|
| 4.1 | `Retry-After: 1` | **未标定，且选值理由未在会话中记录**——代码里确是 1，但 transcript 没有当时的推理；不要事后补一个听起来合理的理由 | 无 |
| 4.2 | 生产判据阈值 `c.res.status >= 400` | 与「4xx/5xx 即失败」的语义对齐；实际未写上界（`>= 600` 不是合法 HTTP 状态，故不构成实务缺口，但断言本身是松的） | ⚠️ **未做边界校准**：`>= 600` 变异只证明「测试能咬住不加头」，**没有**验证 399/400/599/600 的边界行为——把它称作「校准」是错的 |
| 4.3 | Bun 探针 socket 等待上限 `1500 ms` | 取值随手定 | **未标定**；过短会把慢响应误报成失败 |
| 4.4 | undici 探针每组 3 请求、`150 ms` 结算等待 | 取值随手定 | **未标定**；样本量仅够区分「复用/不复用」，不足以刻画池行为 |

### 类 5 · 实际执行的变异与正样本对照

| # | 变异对象 | 触发的测试 | 失败形态 |
|---|---|---|---|
| 5.1 | 去掉 503 的 `Connection` 头 | `shutdown.unit.test.ts` | 1 fail，`Expected "close" / Received null` |
| 5.2 | `server.close(false)` 移回所有 await 之后 | 同上 | 1 fail（顺序断言）；既有「calls server.close(false)」仍绿——证明新断言补了判别力 |
| 5.3 | 基座判据 `>= 400` → `>= 600` | 同上 | 恰好 2 fail（两条断言该头的），两条反向对照仍绿 |
| 5.4 | 删除 `src/server.ts` 的生产注册 | 两个文件对照 | 新 wiring 测试 4 中红 2；`shutdown.unit.test.ts` **44 条全绿**——「生产接线假绿」的直接证据 |
| 5.5 | Bun 探针指向关闭端口 | 探针自身 | `rc=1`，两行标 `FAILED — result not meaningful`；还原后 `rc=0` |

### 类 6 · 实跑过的运行时/外部能力探针

环境锚点（本轮实测于同一台机器）：Bun **1.3.14**、Node **v24.16.0**、Hono **4.12.27**、Linux `6.18.33.2-microsoft-standard-WSL2`。

| # | 目标 | 观测 | 它不证明什么 |
|---|---|---|---|
| 6.1 | Bun 1.3.14 `Bun.serve` | 转发应用设置的 `Connection: close`，但**不自行关闭 socket**（两组 `serverClosedSocket=false`） | 未覆盖 SSE、HTTP/2、真实 `server.stop` 期间行为 |
| 6.2 | undici（Node v24.16.0 `fetch`） | 带头时 3 请求→3 新建连接；不带头复用（3→2） | 服务端用的是 `node:http`，只证客户端行为；对照组的 2 不是精确池模型 |
| 6.3 | Hono 4.12.27 中间件 | 外层 `await next()` 后可给 `onError` 产生的响应与 404 加头；200 不受影响 | 未覆盖流式已提交头之后 |
| 6.4 | Hono 4.12.27 `Context` | `get res()` 为 `this.#res ||= createResponseInstance(...)`，未设置时会**物化占位响应** | 据此写下短路顺序注释；未构造 WS upgrade 实例验证后果 |
| 6.5 | 4141 运行实例（**只读**：`ss -ltnp`、进程列表、`/api/status`、pidfile、`/openapi.json`） | 取得持有 :4141 的 PID、监听状态、健康态、uptime 与 pidfile mtime（据此定出 13:02:06 开始监听） | 只是事故后的现场状态；不证明事故期间的因果，也不证明当时哪个进程在服务 |
| 6.6 | History V3 只读查询（`q.ts`/`q2.ts`/`q3.ts`/`q4.ts`） | 枚举 schema 与列、定位空洞及其两端时间戳 | 只能说明数据库记录的形状与时间戳；**不**证明 drain 完成、进程存活或 503 成因 |
| 6.7 | 客户端侧 transcript 扫描 | 13:05–13:09 至少四个独立 session 收到同一条 503 | 证明该 503 持续可见；**不**区分是复用旧 socket 还是新建连接仍落到旧 listener |
| 6.8 | config/token pre-gate 绕过复现 | `{"status":503,"connection":null}` | 证明分支级修复可被绕过；**不**证明已穷举所有 ingress 形态 |


## C. 其余阶段的显式处置

- `archive_docs`：本轮**未产出** plan / spec / kickoff / 评审草稿文件，无可归档件；`docs/tmp/` 下既有文件均属他人他轮，未触碰。本行即该阶段的显式处置记录。
- `clean_temp`：**未执行任何删除**（理由见 A 节）。
- `resolve_branch`：分支保留待合并，**未发布**。⚠️ 规程要求合并前检查主检出的工作区与 index，但本会话是隔离 worktree、护栏拒绝对共享检出做 git 操作，**结构上无法自查**——已在终态报告点名，由用户执行前自行确认。
