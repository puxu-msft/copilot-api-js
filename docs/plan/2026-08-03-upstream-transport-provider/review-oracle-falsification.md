# 判据证伪评审

## 评审元数据

- **评审范围**：`HANDOVER.md`、`KICKOFF.md`，以提交基线 `5a7805e4` 为准；主责为数字、口径与 oracle 鉴别力。
- **已读取/执行的证据**：已完整读取两份目标文档；已确认 `HEAD=5a7805e45dc7`、`5a7805e4` 为 commit、目标文件相对该基线无差异，且两文件均由该提交引入。后续每条发现单列实际命令与输出。
- **总体 verdict**：评审进行中；最终结论见文末“最终汇总”。
- **blocker 数量**：评审进行中。

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

