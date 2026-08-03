# 判据证伪评审

## 评审元数据

- **评审范围**：`HANDOVER.md`、`KICKOFF.md`，以提交基线 `5a7805e4` 为准；主责为数字、口径与 oracle 鉴别力。
- **已读取/执行的证据**：完整读取两份目标文档、spec v3、`session-closeout` §6/模板及相关 PoC/FINDINGS；逐 SHA 执行 `git cat-file/show`；逐条复跑 h2 PING、full napi spike、curl/libcurl PING、faithful RST、REFUSED_STREAM、Rust 环境、bunx 空 cache、classification 与全仓/分域 grep。每条发现均单列实际命令与输出。
- **总体 verdict**：**存在 blocker**。交接件当前不可作为下一阶段入口；须先修复完整 v3 契约/复评 gate 与 REFUSED oracle 事实错误，再修 major。
- **blocker 数量**：**2**（另有 7 major、9 minor、0 nit）。

## 事实性发现

### [minor] `HANDOVER.md:25` — SHA `a16bcc68` 的内容摘要不完整，掩盖同一提交捆入了另一份 spec 的 201 行改动

- **问题**：§1 把该 SHA 描述为“去掉文件名里的 curl”，但提交还修改了 `docs/spec/2026-07-26-server-tool-provenance-routing.md`，且是 165 additions / 36 deletions 的实质改写。接手者若据表做 provenance 或回滚判断，会误以为该提交是纯 rename。
- **我跑了什么命令**：`git -C /home/xp/src/copilot-api-js show --name-status --format='%H %s' a16bcc68`；`git -C /home/xp/src/copilot-api-js show --format='' --numstat a16bcc68 -- docs/spec/2026-07-26-server-tool-provenance-routing.md`。
- **得到什么输出**：前者除 `R100 docs/spec/2026-08-01-upstream-transport-provider-curl.md docs/spec/2026-08-01-upstream-transport-provider.md` 外，还输出 `M docs/spec/2026-07-26-server-tool-provenance-routing.md`；后者输出 `165 36 docs/spec/2026-07-26-server-tool-provenance-routing.md`。
- **修复建议**：把表项写成“rename provider spec；同时捆入 server-tool-provenance spec 的 peer/并行改动（非本主题产物）”，或至少明确“该提交非纯 rename，勿按表摘要做整提交回滚”。文档修复应交 `gpt-souls:doc-writer`。

### [major] `HANDOVER.md:37` — 事实 5 把 `src/ + packages/` 的生产实现结论写成“全仓”结论，且遗漏活的入口文档与测试配置命中

- **问题**：限定为“生产代码中是否存在 SearXNG 请求实现”时，`src/ + packages/` 搜索与 removal history 足以支持“实现已退役”；但证据栏声称“全仓 `rg -i searxng` 命中全部是注释”不成立。全仓还命中 `docs/DESIGN.md`、冻结 spec/ADR、`ui-v4/docs/spec/...` 和 `tests/config/config-compat.unit.test.ts:242` 的实际配置值。尤其 `docs/DESIGN.md` 是项目指定的当前架构入口，却仍把 SearXNG 写成活路径；这正是 T2 所谓“按 docs 常规路径走进来仍读到旧方案”的现实反例。事实 5 的边界没有框住它自己的“全仓”措辞，也没有把“生产实现不存在”与“仓库里不存在配置/声明”分开。
- **我跑了什么命令**：`git -C /home/xp/src/copilot-api-js grep -in -I 'searxng' 5a7805e4 -- .`；分别对 `ui-v4 scripts config.yaml config.example.yaml` 执行同一 `git grep`；`git -C /home/xp/src/copilot-api-js ls-tree -r --name-only 5a7805e4 -- src packages | rg -i 'web.?search|search.?backend|searx'`；`git -C /home/xp/src/copilot-api-js log --all --oneline -20 -S'DEFAULT_SEARXNG_BASE_URL' -- src packages`。
- **得到什么输出**：全仓命中包括 `docs/DESIGN.md:22,31,351,356`、`ui-v4/docs/spec/2026-07-05-ui-v4-config-form.md:94`、`tests/config/config-compat.unit.test.ts:242` 的 `web_search: { enabled: true, backend: "searxng" }`，并非“全部是注释”；`scripts/`、`config.yaml`、`config.example.yaml` 为 0 hits。`src/ + packages/` 的文件名扫描只剩 `src/lib/request/strategies/web-search-not-found-retry.ts`，没有 backend 模块；history 显示 `34eaa90e refactor(anthropic): 删 web_search 双跳模块 + legacy pipeline + 死导出（退役 Commit 2/5）`。
- **修复建议**：把事实拆成两个有边界的命题：①“在基线 `5a7805e4` 的 `src/ + packages/` 中，没有 SearXNG URL、配置 schema 或请求 backend；退役提交为 `34eaa90e`”；②“仓库文档、兼容测试和 UI spec 仍有陈旧/兼容性命中，不属于活的生产实现”。同时将 `docs/DESIGN.md` 的陈旧活路径列入必须同步的文档债，而不是用“全仓全是注释”掩盖。建议由 `gpt-souls:doc-writer` 对账。

### [minor] `HANDOVER.md:40` — 事实 8 的 exact command/output 不稳定，基线仓库内复跑得到 `0.27.4` 而非文档的 `0.28.1`

- **问题**：核心能力“`bunx` 会解析平台 `optionalDependencies`”成立，但文档把 `bun x esbuild --version → 0.28.1` 当成可复现证据，没有说明解析上下文与 cache/lockfile。基线仓库当前 lockfile 持有 esbuild 0.27.4，原目录运行 exact command 得 0.27.4；只有隔离空 cache 后按 latest resolve 才得到 0.28.1。版本数字因此不能当稳定 oracle。
- **我跑了什么命令**：在仓库根运行 `bun x esbuild --version`；读取 `node_modules/esbuild/package.json` 的 `version/bin/optionalDependencies`；在 `/tmp` 空目录设置全新 `BUN_INSTALL_CACHE_DIR` 后运行 `bunx esbuild --version`，再 `find` cache 中的 `@esbuild/linux-x64`。
- **得到什么输出**：仓库根输出 `0.27.4`；package metadata 显示 `bin={"esbuild":"bin/esbuild"}` 且 `optionalDependencies["@esbuild/linux-x64"]="0.27.4"`，对应文件是 `ELF 64-bit ... statically linked`；空 cache 探针输出 `Resolving dependencies`、`Resolved, downloaded and extracted [2]`、`0.28.1`，并产生 `cache/@esbuild/linux-x64@0.28.1.../bin/esbuild`。
- **修复建议**：删除易漂移的具体版本值，改成可执行判据：“以空 `BUN_INSTALL_CACHE_DIR` 运行 `bunx esbuild --version` 后，断言 cache 同时出现 JS shim 包和当前平台 `@esbuild/<platform>` 原生包”；保留“未测平台包缺失行为”的边界。

### [major] `HANDOVER.md:64` — T2 的验收命令在入口不存在时已经为绿，完全咬不住“从 DESIGN.md 走到 spec”

- **问题**：`rg -n "upstream-transport-provider" docs/` 只证明任意文档含字符串。基线 `5a7805e4` 下 DESIGN 尚无 provider 行，但该命令已因 HANDOVER 自引用和 spec 文件名而命中，故 T2 未做也会通过。
- **我跑了什么命令**：`git -C /home/xp/src/copilot-api-js grep -n -I 'upstream-transport-provider' 5a7805e4 -- docs/DESIGN.md docs`；`git -C /home/xp/src/copilot-api-js show 5a7805e4:docs/DESIGN.md | rg -n 'upstream-transport-provider|上游传输 Provider 化'`；`git -C /home/xp/src/copilot-api-js log --oneline -S'上游传输 Provider 化' -- docs/DESIGN.md`。
- **得到什么输出**：第一条仅命中 `HANDOVER.md:10,64,112`，却已 exit 0；第二条 0 hits；第三条显示真正添加入口的是基线之后的 `39dc9e10 docs(design): give the transport provider work a discoverable entry`。
- **修复建议**：验收必须限定拥有方并核链接目标，例如 `rg -n '\[wip\].*upstream-transport-provider|upstream-transport-provider.*\[wip\]' docs/DESIGN.md`，再用 Markdown link checker 或解析出的相对路径断言目标文件存在；正控应临时把 DESIGN 链接改到不存在路径，确认 checker 变红。

### [major] `HANDOVER.md:79-82,93` — T4 可“删除旧断言”假绿，且 T6 仍以 v2/curl 的 §10 作为实现验收

- **问题**：T4 的“§11 无 curl 专属断言”只测删除，不测要求中承诺的四类 Rust 替换项或 §12 v3 disposition；即使把 §11 全删也通过。更严重的是，T4 只要求更新 §11/§12，而 T6 要逐行闭合 §10；基线 §10 仍是 curl 子进程契约（stdout EOF、exit codes、curl headers、stdin/stdout、`/dev/fd`），与 Rust provider 不相干。按交接执行会把实现验收到已否决实现的测试表上。
- **我跑了什么命令**：`git -C /home/xp/src/copilot-api-js show 5a7805e4:docs/spec/2026-08-01-upstream-transport-provider.md | nl -ba | sed -n '472,510p'`；并读取 `HANDOVER.md:77-95`。
- **得到什么输出**：spec §10 的行 478–491 明列 `stdout EOF`、`exit {7,18,23,28,56,92,unknown}`、`curl 自动 header`、`并发喂 stdin + drain stdout`、`/dev/fd`；§11 行 502–508 仍有 curl 视角。HANDOVER T4 的验收只有“§11 无一条引用已否决的 curl 路径”，T6 却写“spec §10 ... 逐行有对应测试且绿”。
- **修复建议**：T4 必须扩为同步更新 §10/§11/§12，并逐项列出 Rust 必有测试域；验收应断言四个指定 Rust 主题均存在、curl-only 主题均不存在、§12 有 v3 disposition，而非单向 grep 归零。T6 再指向更新后的追踪表。该修复属于 spec/交接架构，建议 `gpt-souls:architect-advisor` 与 `gpt-souls:doc-writer` 配合。

### [minor] `HANDOVER.md:57,65,73,81` — 四个“待执行期正控”中三个没有可执行 mutation，T1 的 mutation 也没有绑定到验收它的具体检查

- **问题**：T2/T4 只有标签，无“改什么、预期哪个命令红”；T3 只说“用一条已知不成立的断言”，未点名断言或变异；T1 虽写“植入错误 file:line”，但只要求第一人称 reviewer 抓到，不能证明“两个视角均无 BLOCKER/MAJOR”这套完成 gate 的鉴别力。
- **我跑了什么命令**：`nl -ba /home/xp/src/copilot-api-js/docs/plan/2026-08-03-upstream-transport-provider/HANDOVER.md | sed -n '51,96p'`；`rg -n '待执行期正控|鉴别力正控' /home/xp/src/copilot-api-js/docs/plan/2026-08-03-upstream-transport-provider/HANDOVER.md`。
- **得到什么输出**：命中行 57、65、73、81；其中 65、81 只有“待执行期正控”，73 仅“用一条已知不成立的断言”，没有具体 mutation/命令/预期红输出。
- **修复建议**：每项写成三元组“变异动作 → 运行命令/评审检查 → 必须出现的失败”。例如 T3 指定把某个已核 `file:line` 改为不存在行，要求结果为“不成立”并附实际读取；T4 指定删掉 `reqwest.*header` 待证伪项，结构检查必须报缺项。

### [blocker] `HANDOVER.md:96` — “忠实 `REFUSED_STREAM(0x7)` 夹具仍不存在”被已提交且可复跑的跨运行时 oracle 直接证伪

- **问题**：仓库已有 `exp/http2-refused-retry/probe-x.mjs`，其 Node server 在 response 前执行 `stream.close(NGHTTP2_REFUSED_STREAM)`，Node/Bun client 均收到真实 `rstCode=7`。curl arbitration 证伪的是“写过 DATA 后用 `stream.close(code)`”的形态，不能外推为 pre-response REFUSED 夹具不存在。当前绝对断言会让接手者重复造 oracle，并错误阻断现役 `refused-stream` 契约。
- **我跑了什么命令**：`node exp/http2-refused-retry/probe-x.mjs auto`；读取 `exp/http2-refused-retry/report.md:7-19` 与 `probe-x.mjs:21-30,52-63`。
- **得到什么输出**：Node client：`ERR_HTTP2_STREAM_ERROR "Stream closed with error code NGHTTP2_REFUSED_STREAM" ... rstCode=7`；Bun client 输出逐字相同且 `rstCode=7`。报告明确把它定义为“Node-server ← Bun-client，忠实镜像生产”。
- **修复建议**：撤销“全仓不存在”的断言，区分两件事：① 已有忠实 Node h2 server 的 pre-response REFUSED oracle；② 尚未验证的是 Rust/reqwest provider 能否把该帧保真映射为结构化 `refused-stream`。T6 应复用已有 server oracle 测 Rust client，而不是重造服务端夹具。该 blocker 涉及 spec 契约，建议 `gpt-souls:architect-advisor` 修正文档。

### [blocker] `HANDOVER.md:10-14,79-93` — 交接把仍自相矛盾的 v3 spec 称作唯一权威，却没有把完整 v3 重写和复评列成 gate

- **问题**：不仅 §10 仍是 curl；冻结接口、配置、status 也仍保留 curl 形状。HANDOVER 只安排 §11/§12 更新，并说“不必读评审往返”，使接手者在 T1/T3 后可能按错误冻结契约进入计划。
- **我跑了什么命令**：`git -C /home/xp/src/copilot-api-js show 5a7805e4:docs/spec/2026-08-01-upstream-transport-provider.md | nl -ba | sed -n '195,230p;430,495p'`；`rg -n 'curl|ProviderId|provider:|details:' /home/xp/src/copilot-api-js/docs/spec/2026-08-01-upstream-transport-provider.md`；读取 spec 状态行与 HANDOVER T3–T6。
- **得到什么输出**：冻结接口仍有 `ProviderId = "http2" | "curl" | "undici"`、selection 为 curl 选择 `--http*`；配置仍是 `provider: auto # auto | http2 | curl | undici` 与 `curl.binary`，`auto` 仍为“https → http2，http → curl”；status 注释仍是“h2 sessions / curl children”；状态又写“v3 复评尚未执行”。HANDOVER 没有一项要求重写 §4/§8/§9/§10 并做 v3 全文复评。
- **修复建议**：在 T3 前增设硬 gate：按 §0 裁决完整重写 §4、§8、§9、§10、§11、§12，逐节清除 curl-only 冻结契约；随后对 v3 全文做独立复评并落 disposition。闭环前不得称其“唯一权威”或进入计划阶段。

### [major] `HANDOVER.md:61-67`、`KICKOFF.md:23-29` — T2 已被基线后的提交完成，静态待办会驱动重复入口

- **问题**：交接自己警告晚于核验基线的 peer 提交可作废结论，但待办没有规定接手时机械剔除已完成项。当前 `39dc9e10` 已完成 T2，KICKOFF 仍把它列为下一动作。
- **我跑了什么命令**：`git -C /home/xp/src/copilot-api-js log --oneline 5a7805e4..HEAD`；`rg -n -C 2 '上游传输 Provider 化|upstream-transport-provider' /home/xp/src/copilot-api-js/docs/DESIGN.md`；`git -C /home/xp/src/copilot-api-js show -s --format='%H %P %s' 39dc9e10`。
- **得到什么输出**：历史含 `39dc9e10 docs(design): give the transport provider work a discoverable entry`，其 parent 正是 `5a7805e4`；当前 DESIGN 第 80 行已有 `[wip]` 行并指向 spec/HANDOVER。
- **修复建议**：整改时将 T2 标为已完成并引用 `39dc9e10`，更新建议顺序；同时给所有状态型待办加接手首步：“运行 `<handover-baseline>..HEAD` 的路径限定 log，命中则复核并剔除已落地项”。

### [major] `HANDOVER.md:5,121`、`KICKOFF.md:15` — “所有 dirty 都属于 peer”是无时界绝对断言，会吞掉接手者自己的新产物

- **问题**：该断言在交接写下时可作为快照，但被 KICKOFF 写成持续 gate。T1 正会创建 review 文件；严格遵守后，接手者会把自己的报告当 peer 文件而拒绝提交。宽 glob `docs/memory/*`、`docs/tmp/2026-08-03-*` 同样会覆盖未来自有文件。
- **我跑了什么命令**：`git -C /home/xp/src/copilot-api-js status --short --untracked-files=all -- docs/plan/2026-08-03-upstream-transport-provider docs/DESIGN.md`；读取 HANDOVER 头部及 §6、KICKOFF 硬性工作方式。
- **得到什么输出**：状态显示 `?? .../review-oracle-falsification.md` 与 `?? .../review-successor-walkthrough.md`，两者都是当前 T1 评审产物，不是写交接时的 peer WIP；但文档仍断言“工作区里所有未提交改动与未追踪文件都是 peer 的”。
- **修复建议**：改成带核验时点和精确路径清单的 ownership snapshot；明确“接手后由本会话新建/修改的路径按实际写者归属”。KICKOFF 只保留安全 gate：“不要改动接手前快照列出的 peer paths；提交始终精确 pathspec”。

### [minor] `HANDOVER.md:35` — 事实 3 的“Node 与 Bun 各 5 次”成立，但输出自身把 Bun host 伪装成 `node v24.3.0`

- **问题**：TSFN 行为确实在两个 host 各跑一次并通过，但探针用 `process.release.name/process.version` 标 runtime；Bun 兼容层返回 `node v24.3.0`，所以 stdout 不能独立证明第二腿由 Bun 执行，只能靠调用命令。交接把这项列为实测时应绑定命令与输出，不应只引用“Node 与 Bun”标签。
- **我跑了什么命令**：`node exp/napi-http-spike/probe-tsfn.cjs`；`bun exp/napi-http-spike/probe-tsfn.cjs`；查看 `run-all.sh:5-6` 与 `probe-tsfn.cjs:12-14`。
- **得到什么输出**：Node 命令输出 `runtime:"node v24.16.0" ... 5 entries ... ok:true`；Bun 命令输出 `runtime:"node v24.3.0" ... 5 entries ... ok:true`。`run-all.sh` 的确分别调用 `node`、`bun`，但 JSON 没有 `typeof Bun` 身份。
- **修复建议**：探针输出改为 `typeof Bun === "undefined" ? node : bun`，文档证据附两条命令。事实边界“主会话只独立复核 Node-host”也应更新：本次评审已完整复跑 `run-all.sh`，Bun-host 实际绿，但 mutation 正控仍只沿用历史报告、未在本轮重做。

### [minor] `KICKOFF.md:38-44` — “踩坑”段复制了事实、数字、理由与完整动作，违反 HANDOVER/KICKOFF 单一归属契约

- **问题**：KICKOFF 可以列坑的短 gate，但现文复制了“三方同错”“两小时内两次”“连续四次”、具体 `stream.destroy/close` 机制，以及 `REPORT_FILE + 逐条落盘 + SendMessage` 完整程序。按 `session-closeout` §6，这些数字、理由、命令细节和后续步骤只能归 HANDOVER；KICKOFF 应是一行症状词加指针。
- **我跑了什么命令**：`rg -n 'HANDOVER.*事实|KICKOFF.*gate|允许的重复只有' .claude/skills/session-closeout/SKILL.md .claude/skills/session-closeout/handover.md`；`rg -n '两小时|四次|stream\.destroy|REPORT_FILE|SendMessage' KICKOFF.md HANDOVER.md`。
- **得到什么输出**：权威 skill 第 59–61 行规定 HANDOVER 收“事实、证据、理由、数字、命令、完整步骤”，KICKOFF 只收 gate/第一步/批准状态/指针，唯一可重复的是带指针的执行 gate；KICKOFF 命中上述全部细节。
- **修复建议**：压成五条短 gate，例如“h2 故障夹具先证 wire 忠实（见 HANDOVER §4#1）”；把数字与具体 mutation/恢复程序只留 HANDOVER。硬性“不 kill 4141”可逐字重复，但应补“见 HANDOVER §6”指针。

### [minor] `HANDOVER.md:38` — 事实 6 把“未识别 Error”说得过宽；真正会被重判的是消息命中 network patterns 的 transport-like Error

- **问题**：`classify.ts:151` 并非把任意未识别 `Error` 判为可重试；普通未知 Error 落 `bad_request`。spec 的风险只针对新 `unknown-transport` tag 若未在 structured switch 抢先消费、其 message 又命中 network patterns。
- **我跑了什么命令**：`bun --eval 'import { classifyError } ...; classifyError(new Error("completely novel failure")); classifyError(new Error("socket closed unexpectedly"))'`；读取 `packages/foundation/src/error/classify.ts:148-165,362-368` 和 `network-retry.ts:40-44`。
- **得到什么输出**：普通未知消息输出 `{type:"bad_request",status:0}`；`socket closed unexpectedly` 输出 `{type:"network_error",status:0}`；network retry 的 `canHandle` 对 `network_error` 返回路径成立。
- **修复建议**：事实改为：“`TransportErrorReason` 无 unknown；未在 structured switch 先处理的 transport-like Error 若消息命中宽泛 network patterns，会在 `classify.ts:151` 变为 `network_error` 并被 retry。”行号与四值本身在基线均准确。

### [major] `HANDOVER.md:57` — T1 正控直接污染权威 HANDOVER，且没有“命中指定 mutation + 还原验证”闭环

- **问题**：正控要求在正式交接件植入假 `file:line`，但没有规定隔离副本、精确 mutation 标识、reviewer 必须点名该项、以及最终移除证明。后端中断正是已知条件；假信息可能随精确 pathspec 进入正式档案。
- **我跑了什么命令**：`git -C /home/xp/src/copilot-api-js show 5a7805e4:.../HANDOVER.md | nl -ba | sed -n '53,60p'`；读取 `.claude/skills/session-closeout/SKILL.md:22,130` 的报告恢复与 KICKOFF 回查规则。
- **得到什么输出**：T1 只写“在 HANDOVER 里植入已知错误 file:line，确认走查能抓”，随后直接“整改、复审、精确提交”；没有任何还原命令或残留检查。
- **修复建议**：在临时副本或可逆 patch 上跑正控；记录唯一 marker，要求 reviewer 的报告点名 marker；随后反向应用 patch，并以 `rg <marker>` 0 hits 加 `git diff` 人工核验最终目标无 mutation。正控记录与正式 finding 分开。

### [minor] `HANDOVER.md:84-88` — T5 没有鉴别力正控且“证伪方式：无”，空壳条目也能过“存在”验收

- **问题**：T5 要求五段内容与重评触发条件，但验收只有“条目存在且写明重评触发条件”，没有检查五段、没有点名两个承重触发条件，也缺模板要求的正控栏。
- **我跑了什么命令**：读取 HANDOVER 84–88 行；`git -C /home/xp/src/copilot-api-js grep -n -I -E 'libcurl|napi-rs|Rust provider|transport provider' 5a7805e4 -- docs/todo/deferred-backlog.md`。
- **得到什么输出**：基线 backlog 为 0 hits，证明确实待新增；T5 只有“条目存在且写明重评触发条件”，下一行“证伪方式：无”，且完全缺“鉴别力正控”。
- **修复建议**：列出验收 checklist：根因、当前行为、理想架构、为何暂缓、若做需改、Bun/Node 双可用 binding、libcurl h2 PING 成立；正控为删除任一承重项后 checklist 必须红。

### [major] `KICKOFF.md:19,23-32` — 阶段序列从 spec gate 直接落到实现期 T6，缺实施计划、计划评审、文档先合主线和用户批准执行 gate

- **问题**：项目纪律要求 spec 定稿后另写 TDD plan、评审、合主线，再停下等用户决定是否执行；当前目录只有 HANDOVER/KICKOFF，KICKOFF 却只说 T1/T3 后可动手实现，并把 T6 排为末项。
- **我跑了什么命令**：`git -C /home/xp/src/copilot-api-js ls-tree -r --name-only 5a7805e4 -- docs/plan | rg 'upstream-transport-provider|transport-provider'`；读取项目 `CLAUDE.md` 的 `docs-merge-before-execute` 与 KICKOFF 19、23–32 行。
- **得到什么输出**：基线只列 `.../HANDOVER.md` 与 `.../KICKOFF.md`，无 implementation plan；KICKOFF 写“动手实现前先过 T1 与 T3”，没有 plan 或用户执行批准步骤。
- **修复建议**：在 v3 全文复评后增加明确阶段：spec 定稿并合主线 → 编写分阶段 TDD plan/kick-off → 独立评审 plan → 合主线 → 停下等用户批准执行 → 获批后才建隔离 worktree。T6 应成为 plan 的验收矩阵，不是本交接可直接执行的最后一步。

### [minor] `HANDOVER.md:36` — 事实 4 的“四客户端全部检测到 `rst=2`”混淆了 wire reason 与各客户端 surface

- **问题**：四客户端都检测到 INTERNAL_ERROR 截断成立，但只有 Node/Bun `node:http2` surface `rstCode=2`；curl exe surface exit 92 + 文本 `err 2`，Bun FFI libcurl 只 surface code 92/通用 framing error。统一写成“四客户端检测到 rst=2”会误导错误映射设计。
- **我跑了什么命令**：启动 `oracle-faithful-rst.mjs` 后，分别运行 curl exe、Node/Bun `node:http2` client 和 Bun FFI `Libcurl.perform()` 请求 `/b`。
- **得到什么输出**：curl：`exit=92 ... INTERNAL_ERROR (err 2)`；Node/Bun：`error:ERR_HTTP2_STREAM_ERROR, close:rst=2`；FFI：`{"code":92,"error":"Stream error in the HTTP/2 framing layer"}`。
- **修复建议**：改为“四客户端都检测到忠实 INTERNAL_ERROR 截断；surface 分别为 curl/libcurl code 92 与 node:http2 rstCode 2”，并保留“只废 RST 半、connection drop 半仍成立”的边界。

## §1 SHA 逐项核验记录

- **我跑了什么命令**：对表中 15 个 SHA 逐个运行 `git cat-file -t <sha>`、`git show -s --format='%H%n%s' <sha>`、`git show --stat --oneline --format= <sha>`。
- **得到什么输出**：15 个 SHA 全部输出 `commit`。`5f5923fb` 增 3 个 curl PoC 共 75 files/2488 insertions；`cc12bc64` 新增 curl spec v1；`7d0776b1` 改 RFC 6 行；`89d2d22c` 增 faithful-RST oracle；`b72c5c28`、`0083baaa`、`5d1b1ebe`、`7ef99722`、`29a7f870` 均只改当时的 provider-curl spec，commit subjects 分别对应六契约、SearXNG 纠错、删 capability、terminal ordering、第二轮 disposition；`02d2af36` 选 hyper；`549b1457` 改分发；`dd6476ed` 改 auto；`db284175` 增 napi spike 16 files/721 insertions；`36dafc48` 重写 Rust 章节。唯一描述不完整的是 `a16bcc68`，已列为 finding。
- **结论**：除 `a16bcc68` 的捆绑内容漏报外，SHA 存在性与摘要均成立；“v2 两轮评审 21/22 采纳”可由 §12 的首轮 17 行中 16 个全/部分采纳 + 第二轮 8 行中 8 个采纳还原为 24/25，而不是直观 21/22；该表述口径不透明，建议直接写“两轮处置仅 1 条不采纳，其余全/部分采纳”，避免读者重算歧义。

## §2 八条硬事实逐项核验记录

| # | 结论 | 我跑了什么命令 | 得到什么输出 / 边界裁决 |
|---|---|---|---|
| 1 | 成立 | 设 `RUSTUP_HOME`/`PATH` 后运行 `bun exp/napi-http-spike/run-h2-probe.cjs` | summary 为 `totalPings:6, controlPings:1, rustPings:5`；确实只证本地直连 TLS h2。 |
| 2 | 在文档限定边界内成立 | curl CLI 对 held-open h2 流跑 7 秒并数 oracle ping；运行 libcurl `run-keepalive-probe.sh` 与 `run-ping-oracle-control.sh` | CLI：`hold_events=1` 且 ping count 0；libcurl：`upkeepCalls:66, upkeepErrors:0` 且 `observed_h2_ping_count=0`；独立 Node control 输出一个 `h2-ping`。只支持当前 CLI/API surface，不外推未来/patch/nghttp2。 |
| 3 | 行为成立，证据身份标签有缺陷 | 完整运行 `bash exp/napi-http-spike/run-all.sh`，另分别直接运行 Node/Bun TSFN probe | run-all exit 0；两腿各 5 个按序 callback、`ok:true`。Bun 输出自称 `node v24.3.0`，需靠调用命令证明 host，已列 minor。 |
| 4 | 核心结论成立，surface 措辞需收窄 | 对 faithful `/b` 同时跑 curl、libcurl FFI、Node/Bun node:http2 | 四方均检测截断；surface 不都叫 `rst=2`，已列 minor。边界“只废 RST 半、drop 半沿用旧差分”与 FINDINGS 一致。 |
| 5 | “生产实现不存在”成立；“全仓全注释”不成立 | 对基线全仓及 `src/packages/ui-v4/scripts/config*.yaml` 分域 `git grep`，查 removal history | `src/packages` 无 URL/backend，`34eaa90e` 为删除提交；但 docs/UI/test 有非注释命中，已列 major。 |
| 6 | 四值与行号成立，措辞过宽 | 基线 `nl -ba` 查 transport reason/classify/network retry，并以两个 Error 实跑 `classifyError` | type 在 37 行且四值；宽匹配在 151 行；network retry 在 41 行接 `network_error`。普通未知 Error 是 `bad_request`，transport-like 文本才变 network，已列 minor。 |
| 7 | 完全成立 | 分别在有/无 `RUSTUP_HOME` 下运行 `rustup toolchain list`、`rustc/cargo --version`、`rustup target list --installed` | 有环境：stable、rustc/cargo 1.97.1、仅 x86_64 target；无环境：`no installed toolchains` 与 rustup error。 |
| 8 | 能力成立，exact version 不稳定 | 仓库根与空 cache `/tmp` 各跑 bunx，并检查 cache 的平台包 | 仓库根 0.27.4；空 cache resolve 2 packages、0.28.1 且出现 `@esbuild/linux-x64/.../bin/esbuild`。已列 minor。 |

## KICKOFF ↔ HANDOVER 对账记录

- **我跑了什么命令**：抽取 KICKOFF 全部命令、数字、T 编号与 § 指针；对照 HANDOVER 对应行、spec §3.3、`session-closeout` §6；运行 `git show -s` 核 `0a2e3bdf`，运行 full spike 核 exit 0。
- **得到什么输出**：`0a2e3bdf` 存在且早于 handover commit；KICKOFF 的 T1–T6 名称/批准状态、建议顺序与 HANDOVER 表面一致；spec §3.3 确实列 spike 未覆盖项；full spike exit 0。实质不一致有三类：T6 指向仍为 curl 的 §10、阶段序列漏 plan/用户批准、T2 已被后续提交完成；均已列 finding。
- **归属越界结果**：KICKOFF 的 Rust 环境、4141 禁区、T1/T3 gate 属允许重复的执行 gate，但前两者应带 HANDOVER 指针；“踩坑”五条携带事实/数字/机制/完整程序，违反唯一归属，已列 minor。

## 主观建议

[建议] `HANDOVER.md:29` — “别再重新推导”宜改成“优先复跑留存探针，不要凭印象重做研究” — 预期影响：避免把硬事实冻结成不可质疑权威；本轮 REFUSED 绝对断言正说明交接事实也会错 — 推荐做法：保留证据等级与边界，但明确接手时若代码/提交已越过核验基线，先复验再采信。

### [minor] `HANDOVER.md:24` — “两轮评审 21/22 采纳”没有对象口径，无法从唯一可见的 §12 处置表复算

- **问题**：这是计数事实，却未说明分母是 findings、处置行、需改项还是排除“确认无需改动”的行。仓库又没有本主题的原始 review report，接手者只能从 §12 猜。
- **我跑了什么命令**：`git grep -n -I -E '21/22|0 Critical|10 High|3 Medium|全部 8 条|评审处置表' 5a7805e4 -- docs exp`；用脚本枚举 spec §12 的 `| <number> |` 与 `| R<number> |` 行。
- **得到什么输出**：唯一 `21/22` 命中是 HANDOVER 自身；§12 有首轮 17 行、第二轮 8 行，共 25 行；其中 #17 明写“不采纳”，R1 是“确认，无需改动”，其余为全/部分采纳。按“处置行”是 24/25，按“要求改动的 finding”又需排除 R1，均不能推出 21/22。
- **修复建议**：删掉不可复算数字，或明确写“对象集合、排除项、生成方法”，并链接原始评审报告；若只想表达处置状态，写“§12 中唯一不采纳的是 #17，R1 为确认无需改动，其余全/部分采纳”更诚实。

> **更正前文 §1 核验记录**：其中“21/22 可还原为 24/25”的句子仅能说明按 §12 处置行计数得到 24/25，不能裁定作者原本的 22 个对象是什么；以紧接其后的本条 finding 为准。

## 最终汇总

- **Verdict**：存在 blocker。
- **计数**：2 blocker / 7 major / 9 minor / 0 nit。
- **最严重问题 1**：所谓“唯一权威” spec 仍同时冻结 Rust §0 与 curl §4/§8/§9/§10 两套互斥契约，而交接漏掉完整重写及 v3 全文复评 gate。
- **最严重问题 2**：“忠实 REFUSED_STREAM 夹具不存在”被 `exp/http2-refused-retry/probe-x.mjs` 现场复跑直接证伪。
- **硬事实总体**：事实 1、2、3 核心行为、4 核心行为、6 的四值/行号、7、8 核心能力成立；事实 5 的全仓口径错误；3/4/6/8 有证据或措辞边界缺陷。
- **oracle 总体**：T2、T4、T5 均可假绿；T1 正控缺 mutation 清除闭环；T3 正控不具体；T6 绑定已否决的 curl 测试表。
- **下一修复方**：spec/契约由 `gpt-souls:architect-advisor`；HANDOVER/KICKOFF 与 DESIGN/backlog 对账由 `gpt-souls:doc-writer`；修完后恢复原两位 reviewer 复审。
