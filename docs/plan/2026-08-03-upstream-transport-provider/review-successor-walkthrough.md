# 接手方第一人称走查评审

- 评审对象：`HANDOVER.md`、`KICKOFF.md`
- 提交基线：`5a7805e4`
- 视角：对该工作一无所知的接手方，严格按 `KICKOFF.md` → `HANDOVER.md` §0 行动，并对每个动作核验仓库前提。
- 判据：长远正确 + 完整；每条发现均明确“接手方会因此做出什么错误动作”。

## 走查记录

### KICKOFF 的第一动作

`KICKOFF.md:9` 给出的第一动作是完整阅读同目录的 `HANDOVER.md`，之后才按其 §0 继续。该相对链接可解析，且 `git ls-tree -r --name-only 5a7805e4` 证明两份文件都存在于基线提交，因此这个动作本身可执行。

### [BLOCKER] §0 宣称下文已按 v3 更新，但 spec 的冻结实现与测试契约仍大面积是 curl 版

**我实地看到什么**：`HANDOVER.md:10-14` 告诉我 spec v3 是“唯一权威”，只需先读 §0，动手前再读 §4、§7、§10；并说“§0 是最新裁决，与下文冲突时以 §0 为准”。spec 自己在 `docs/spec/2026-08-01-upstream-transport-provider.md:7` 声称 §3.2、§5、§6、§7 已按 Rust 重写，`:15` 更明确声称“§7 中 curl 专属的实现约束……已在 v3 重写”。然而实读后，至少存在以下未被 §0 消解、会直接驱动错误实现的冲突：

- `spec:205-225` 的冻结接口仍把 `ProviderId` 写成 `"http2" | "curl" | "undici"`，`close()` 注释仍规定“curl: 全部 child reap”，selection policy 仍说“供 curl 决定 `--http1.1` / `--http2` / `--http2-prior-knowledge`”；没有 `rust` provider id，也没有 Rust 所需的策略输入。
- `spec:435-449` 的冻结配置仍是 `provider: auto # auto | http2 | curl | undici` 和 `curl.binary`；`auto` 仍定义成“https → http2，明文 http → curl”，迁移规则仍是 `favor:false → curl`，可用性规则仍围绕 curl。它与 §0.2.1 `:58-67` 的“有原生产物就全局使用 Rust，否则回落 node:http2”不是同一个系统。
- `spec:464` 的冻结 `/api/status` 注释仍只给 “h2 session rows + reconcile；curl 在途 child”，没有 Rust runtime、任务或连接池的状态形状。
- `spec:478-491` 的 §10 追踪表仍逐项要求 stdout EOF、curl 参数映射、curl 自动 header、curl 环境代理、socks5/socks5h、exit-code 矩阵、child reap、`/dev/fd` 与 fd 继承；这不是 Rust 实现的验收表。`HANDOVER.md:93` 与 `KICKOFF.md:32` 却把“spec §10 逐行有测试且绿”列为 T6 的已裁决验收判据。

**接手方会因此做出什么错误动作**：我若遵照入口指引把 §4、§7、§10 当冻结契约直接开工，会实现一个不存在于 `ProviderId`/配置 union 的 Rust provider，同时继续添加 curl 配置、curl child 生命周期和 curl 专属测试；或者为了满足“逐行有测试且绿”，为已经否决的 curl 路径写整套实现与测试。仅靠“冲突时以 §0 为准”无法告诉我这些接口、配置、status 和测试行应替换成什么，接手方必须重新做本应由 spec 冻结的设计，违背“别再重新推导”。

**必须修正**：T4 不能只更新 §11/§12；在任何实现计划或 T6 前，必须把 §4 接口、§8 配置、§9 status、§10 追踪表及所有 curl 遗留统一重写为 Rust v3，并再评审。入口不得再声称 §7 已完成重写或 spec 当前可直接驱动实现。

### [MAJOR] T2 已在基线之后完成，但 KICKOFF/HANDOVER 仍把它列为待办

**我实地看到什么**：评审起点 `5a7805e4` 之后已有提交 `39dc9e10 docs(design): give the transport provider work a discoverable entry`，它修改了 `docs/DESIGN.md`；当前文件中已经存在指向本 spec/HANDOVER 的 `[wip]` provider 化权威入口。`HANDOVER.md:61-67` 与 `KICKOFF.md:23-29` 仍要求接手方执行 T2。

**接手方会因此做出什么错误动作**：我会再次编辑 `docs/DESIGN.md`，重复造第二个入口，或把已经存在的单一权威行误当作前任未完成的草稿而重写；这正好破坏 T2 自己要求的“只建一个权威落点”。

**必须修正**：在本轮评审整改前先重读 `5a7805e4..HEAD`，把 T2 标成已完成并引用 `39dc9e10`；同时重新排定剩余顺序。若评审对象刻意冻结在 `5a7805e4`，则交接件也必须明确“执行前以 HEAD 重验并从待办中剔除已落地项”，不能让静态待办直接充当当前状态。

### [MAJOR] “工作区全部属于 peer”的无时界绝对断言会让接手方否认自己刚产生的 T1 产物

**我实地看到什么**：`HANDOVER.md:5,121` 与 `KICKOFF.md:15` 都把“工作区里所有未提交改动与未追踪文件都是别人的”写成持续有效的硬性事实，而不是某一时刻的快照。当前 `git status --short --untracked-files=all` 中，列出的 tool-name-sanitize、memory、tmp 等确实仍是既有 peer 工作；但目标目录同时出现了 T1 正要求产生的 `review-oracle-falsification.md` 和本报告 `review-successor-walkthrough.md`。这两份显然属于正在执行 T1 的本轮评审，不可能仍被归为“peer”。

**接手方会因此做出什么错误动作**：我严格相信这个断言后，会把自己刚生成的评审报告当作 peer 文件而拒绝提交，导致 T1 的“评审报告与入口一次精确 pathspec 提交”无法验收；更一般地，我在接手后产生的任何未提交文件都会被这句持续性规则错误夺走归属，造成工作遗失或永远悬空。

**必须修正**：把断言改成带基线和枚举的快照，例如“接手开始前，下列 dirty paths 经核对属于 peer；接手后新建/修改的路径按实际产生者归属”。同时记录核验命令与时间/提交，不得用 `docs/memory/*`、`docs/tmp/*` 这类会吞掉未来自有文件的宽 glob 代替路径清单。

### [MINOR] KICKOFF 单独看不包含“T1 要派两个正交视角”，但按既定入口顺序仍可取得

**我实地看到什么**：`KICKOFF.md:27` 只写“T1 过评审闭环”，没有写两个视角及其名称；具体要求只在 `HANDOVER.md:55`：“判据证伪 / 接手方第一人称走查”。不过 `KICKOFF.md:9` 已强制我先完整读 HANDOVER，所以按文档规定的顺序，我在执行 T1 前能取得该信息。

**接手方会因此做出什么错误动作**：若我把 KICKOFF 的待办表误当成可独立执行清单，而没有遵守第 9 行完整阅读 HANDOVER，会只派一个泛化评审，错误地宣布 T1 闭环。严格按入口走则不会出错，因此这是可用性缺口而非阻塞。

**建议修正**：在 KICKOFF 的 T1 行补成“两正交视角评审闭环（判据证伪 + 接手方走查；细则见 HANDOVER T1）”，让最关键门禁在摘要表中也不可丢失。

### [MAJOR] T3 不是可直接执行的七条取证任务，必须先替 spec 重新设计问题

**我实地看到什么**：`HANDOVER.md:69-75` 把 T3 命名为“§11 七条待证伪断言的取证轮”，但 `:71` 同时承认其中三条“需先按 v3 重列”；T4 `:77-82` 才负责替换 Rust 路径待证伪项。当前 spec §11（`spec:500-508`）仍包含 curl capability、curl 时代的 selection/config 映射等问题。KICKOFF 虽建议 T4 在 T3 前，但 T4 只说更新 §11/§12，没有给出替换后三条的完整命题、oracle、范围或通过标准。

**接手方会因此做出什么错误动作**：我无法“跑七条”；我必须先自行判断哪三条作废、为 Rust 发明三条或更多新断言，再决定如何取证。不同接手方会得到不同问题集；若照现有 §11 原样跑，则会花时间证明已否决 curl 设计，所得结果不能解除 v3 的计划门禁。

**必须修正**：把 T4 升为 T3 的硬前置且扩大到完整 v3 对账；先在权威 spec 中冻结每条待证伪命题、集合边界、独立 oracle 和判定枚举，经评审后，T3 才成为可执行的取证轮。不要把“重列”藏在执行动作里。

### [MAJOR] KICKOFF 从“完成 T6 实测项”直接跳到“动手实现”，缺失计划编制、计划评审与用户批准执行的门

**我实地看到什么**：spec 状态明确是“未达可进入计划阶段”（`spec:3,547`），仓库中也没有本主题的实现 plan，只有 spec、HANDOVER/KICKOFF 和两份 T1 review 文件。`KICKOFF.md:19` 却只说“动手实现前先过 T1 与 T3”，待办顺序最终落到 T6“实现期必须闭合的实测项”，没有一项要求在 spec 定稿后编制分阶段 TDD plan、评审 plan、把定稿文档先合主线并停下等用户批准执行。项目 `CLAUDE.md` 的 `docs-merge-before-execute` 明确要求文档合主线后停下等用户拍板，执行再走隔离 worktree。

**接手方会因此做出什么错误动作**：我完成 T1/T3 后会把 T6 当作实现任务直接在隔离 worktree 开写 Rust addon 与生产接线，绕过计划评审和用户对“是否现在执行”的独立裁决；或者把 T6 的九个跨域实测项临场当计划，形成不可审计的多语义实现。

**必须修正**：在 T3/v3 复评之后增加明确阶段：spec 定稿并合主线 → 写实施 plan/kick-off → 独立评审 plan → plan 合主线 → 停下等用户决定是否执行 → 获批后才建隔离 worktree 开始实现。T6 应进入实施计划的验收矩阵，而不是当前交接的直接下一步。

### [MINOR] T5 的目标文件存在但条目前提尚不存在；动作可开始，验收却缺少鉴别力

**我实地看到什么**：`docs/todo/deferred-backlog.md` 存在；`rg -n 'libcurl|napi-rs|Rust provider|transport provider'` 无命中，所以待新增条目确实尚未落地。T5 给出了应含的五类内容和重评触发条件，但 `HANDOVER.md:88` 把“证伪方式”写成“无”。

**接手方会因此做出什么错误动作**：我可能只写一句“以后可重评 libcurl”并凭“条目存在”验收，漏掉“暂缓非否决”、Bun/Node 双运行时绑定和 PING 能力这两个承重触发条件；由于没有负控或结构核验，空壳条目也会被宣布完成。

**建议修正**：给 T5 增加可执行证伪：删除任一必填段或任一重评触发条件时，文档检查必须失败；至少以精确 `rg`/人工核对清单覆盖“根因、当前行为、理想架构、为何暂缓、若做需改什么、两个重评触发条件”。

### §4 复发点绑定检查

五条错误均能在 §3 找到实际动作，不是纯自我检讨：RST 夹具→T6 故障测试；trailers 写入路径→T6 trailers 接线；完备性搜索→T3/T4；Rust 工具链路径→T6 构建/CI；未冻结设计→T4 更新 spec。这里未发现绑不上 T<n> 的条目。不过第一条写“必须 `stream.destroy(err)`”过强：现存 `oracle-faithful-rst.mjs:11-16` 本身保留 `stream.close(code)` 作为不忠实负对照，真正不变量应是“用 `destroy(err)` 驱动忠实 INTERNAL_ERROR RST 正样本，不得把 post-DATA `close(code)` 的结果当 wire RST”。若接手方按字面禁止所有 `close(code)`，会删掉有价值的负控，并误伤下述 pre-response REFUSED 的不同夹具形态。

### [BLOCKER] “忠实 REFUSED_STREAM 夹具仍不存在”被仓库已有的决定性探针直接证伪

**我实地看到什么**：`HANDOVER.md:96` 与 spec `:415,489` 断言忠实 `REFUSED_STREAM(0x7)` 夹具不存在，并据此禁止错误分类子优先级上线。但仓库已有已提交产物 `exp/http2-refused-retry/`（commit `b0405021`）：`report.md:7-18` 记录 Node server → Bun/Node client 的决定性跨运行时探针，pre-response `stream.close(NGHTTP2_REFUSED_STREAM)` 确实发出真实 RST_STREAM，客户端得到 `rstCode=7` 与 `NGHTTP2_REFUSED_STREAM`；`probe-x.mjs` 是决定性跨运行时脚本。现有生产分类和测试也已引用该报告，`docs/DESIGN.md:177` 明确写该行为已实测，`tests/infra/error.unit.test.ts` 与 `tests/anthropic/anthropic-v4.http.test.ts` 已覆盖分类/重试链。新一轮 curl arbitration 证明的是“写过 DATA 后 `stream.close(code)` 不忠实”，不能反向抹掉“pre-response REFUSED + 独立 Node server”这个已证实形态。

**接手方会因此做出什么错误动作**：我会重复调查和重造一个已经存在的 oracle；更糟的是，我可能把 `stream.destroy(err)` 当成所有 RST code 的唯一造法，从而造不出 code 7，错误地继续判定 REFUSED 不可验证，并阻塞已存在的安全重试契约。也可能误以为现役 `refused-stream` 可重试尚未获实证，去撤销已经上线且有生产/探针依据的行为。

**必须修正**：对账 `exp/http2-refused-retry/{probe-x.mjs,report.md}` 与 curl arbitration 的不同流阶段，撤销“不存在”的绝对断言。若 Rust/hyper 路径需要的是“Rust provider 能保真 surface code 7”的新夹具，应精确写成该缺口，并复用现有 Node server 跨进程 oracle，而不是声称全仓没有忠实 REFUSED 夹具。

### [MAJOR] §0 说“不必读评审往返”，但 v3 的评审前提与未完成状态没有可读档案

**我实地看到什么**：`HANDOVER.md:14` 说评审结论已折进 spec §12/§12.1，因此不必读往返细节。但仓库没有本主题已提交的 review report 文件；§12 只记录 v1→v2 和第二轮的摘要。spec 状态 `:3,547` 又说“v3 复评尚未执行”，而 HANDOVER T1 只评 HANDOVER/KICKOFF/docs 入口，不包含 spec v3。也就是说，接手方若不读旧评审尚能理解 v2，但没有任何现成材料证明 Rust 重写后的 v3 经独立评审，更没有任务负责完成该复评。

**接手方会因此做出什么错误动作**：我会把“两轮评审已逐条修订”误读为当前 Rust v3 已通过两轮独立复评，只做 §11 取证后就把 spec 推入计划阶段；实际上两轮意见针对的是 curl v1/v2，Rust 改写及其跨节遗留从未评审。

**必须修正**：在待办中单列“v3 全文独立复评与处置闭环”，覆盖 §0、§4、§7-§10 的一致性，并把报告落盘。§0 的“不必读”只能在 v3 处置完整写入权威 spec 后成立；当前应明确旧评审只覆盖 v1/v2。

### [MAJOR] T1 的鉴别力正控要求污染权威交接件，却没有规定还原与验证 mutation 已清除

**我实地看到什么**：`HANDOVER.md:57` 要“在 HANDOVER 里植入一处已知错误的 file:line”验证 reviewer 能抓住；`:55-59` 只写整改、复审和提交，没有规定 mutation 必须在评审后移除、用 diff 验证错误不在最终交接件、或确保 reviewer 抓到的是植入项而非另一处自然错误。

**接手方会因此做出什么错误动作**：我会在共享主树的权威 HANDOVER 中注入已知假信息；若 reviewer 后端再次中断或我只修自然发现，假信息可能被精确 pathspec 提交进正式交接。即使 reviewer 报了一个别的问题，我也可能误判正控“咬住了”。

**必须修正**：正控应在隔离副本或临时 patch 上执行；若必须改目标文件，则先记录精确 mutation，要求报告点名该 mutation，随后反向应用并用 `git diff --check` 加精确 `rg` 证明植入文本已消失，最终提交前再核对目标 diff 不含正控。把“正控命中”与“正式报告发现”分开记录。

### [MAJOR] §0 指向的“七候选穷举”没有接手入口，无法按指引复核选型

**我实地看到什么**：`HANDOVER.md:12` 让我在需要复核选型时读 `exp/upstream-client-survey/`；`:114` 又承认该目录“无 FINDINGS.md”，agent 结论只回在当时会话正文，主会话仅把结论折进 spec §0.1/§6，且一个 .NET sidecar 候选未独立复核。目录当前有约 40 个顶层文件及多个子目录，但没有 `README.md`、`FINDINGS.md` 或 `run-all.sh`；没有候选矩阵到具体脚本/输出的映射，也没有“它没有证明什么”。

**接手方会因此做出什么错误动作**：当选型被质疑时，我会在一堆无入口的源码、构建残留和 JSON 输出中猜哪些文件对应“七候选”，自行重建运行顺序与判据；我可能把存在输出文件误当作已验证结论，或因无法复现而重新做整轮调查。文档声称“只在需要时读”并没有让我真的能读懂或复跑。

**必须修正**：为该实验补正式 `FINDINGS.md`/README，列七候选、每格证据文件与命令、环境、正控、未验证边界和 .NET 未独立复核状态；spec 矩阵应链接到对应证据，而不是只链接目录。完成前不得把该目录称为可供接手方复核的“七候选穷举”。

### [MINOR] 交接件没有显式移交编排权，接手者不知道自己是协调者还是执行者

**我实地看到什么**：KICKOFF 说“接手工作”，但没有明确“新会话拥有后续编排权”；T1 要派 reviewer、T3/T4 涉及 spec 修订、后续又要求代码进隔离 worktree。不同动作分别需要协调、文档主责和未来执行主责，HANDOVER 没有声明这些角色边界。

**接手方会因此做出什么错误动作**：我可能把自己当成只执行 T3 的叶子，等待原会话派两个 reviewer；或者反过来在未获执行批准时自任 implementer，直接推动 T6。两种误读都由编排权未移交造成。

**建议修正**：明确写“接手的新主会话拥有 T1-T5 的编排权与文档整改责任；实现编排权只有在 plan 合主线且用户批准执行后才生效；reviewer 只核验、不改权威文档”。

### [MINOR] “别再重新推导”的关键证据引用已经发生行号漂移且缺完整路径

**我实地看到什么**：`HANDOVER.md:38` 把 `TransportErrorReason` 引到 `packages/foundation/src/error/transport-reason.ts:38`，实际 union 在当前 `:37`，`:38` 是空行；同一证据只写 `classify.ts:151`、`network-retry.ts:27-41`，没有完整路径。仓库里 `classify.ts` 位于 `packages/foundation/src/error/classify.ts`，`network-retry.ts` 位于 `src/lib/request/strategies/network-retry.ts`，并非相邻目录。虽然我通过 basename 全仓搜索找到了它们，但这已不是“按证据直达”。

**接手方会因此做出什么错误动作**：我会打开第 38 行看到空白，误判关键 union 已被 peer 删除；或者在 `src/lib/error/` 下寻找 `classify.ts`、在错误目录编辑新 `unknown-transport` 分支，直到重新全仓调查才纠正。

**建议修正**：关键硬事实全部改用仓库相对完整路径，并在交接定稿时复验行号；对于容易漂移的类型/函数同时给符号名，令接手方可用 `rg` 定位而不依赖单一行号。

## 入口与前提核验汇总

- `KICKOFF.md` → `./HANDOVER.md`：存在且链接可解析。
- HANDOVER §0 → `../../spec/2026-08-01-upstream-transport-provider.md`：存在且链接可解析，但内容存在本报告首条 BLOCKER 所列跨节冲突。
- `exp/napi-http-spike/FINDINGS.md`：存在；`run-all.sh`、构建脚本和探针也存在。`RUSTUP_HOME=/home/xp/.local/rustup` 下实测可见 active stable toolchain、`rustc 1.97.1`、`cargo 1.97.1`、唯一 installed target `x86_64-unknown-linux-gnu`，故工具链指引可执行。
- `exp/upstream-client-survey/`：目录存在，但缺接手入口，见 MAJOR。
- 三个 `exp/curl-transport-*` 目录及各自 `FINDINGS.md`：均存在。
- `docs/DESIGN.md` 与 `docs/todo/deferred-backlog.md`：均存在；前者的 T2 已由后续提交完成，后者尚无 libcurl 暂缓条目。
- 当前生产树中没有 Rust transport provider 源码或 provider abstraction；现状仍是 `upstream_transport.http2.favor` + `upstreamFetch`。这与“本轮零生产代码改动”一致，但也意味着接手实现必须先取得完整 spec/plan，不能从现有 provider skeleton 起步。
- 当前 `package.json` 的发布 `files` 仍只有 `dist`、`config.yaml`、`config.example.yaml`，`prepack`/`prepare` 仍只跑 backend build，且没有平台 optionalDependencies；与 spec 所列分发改造前提一致。

## 最终结论

**Verdict：不通过 T1 的接手方走查门禁。** 共 13 条发现：2 BLOCKER、7 MAJOR、4 MINOR。最先必须闭合的是：① 将 spec 的 §4/§8/§9/§10 从 curl v2 全量迁到 Rust v3，并做 v3 全文复评；② 撤销“忠实 REFUSED_STREAM 夹具不存在”的错误断言，改为精确描述 Rust provider 尚待验证的映射；③ 把 T2 当前状态、dirty path 归属、T3 前置关系和 plan/用户批准门同步到 HEAD。上述 BLOCKER/MAJOR 未整改并由原 reviewer 复审前，HANDOVER 不应改成“进行中”，更不能据此进入实现。

