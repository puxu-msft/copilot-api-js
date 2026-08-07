# 文档／流程独立评审

- 评审范围：commit `c23ed8044e47b3313f74d4fd8d7e4627e0352567` 的文档，以及指定的 3 个当前未提交文档；逐项核验 D1–D6，并做接手方第一人称走查。
- 已读取／执行的证据：共享 checkout HEAD ref `77cc765f43d1a437b9b0899e43524a3e8eaab354`（因隔离 worktree 护栏拒绝 `git -C /home/xp/src/copilot-api-js`，改为直接读取 `/home/xp/src/copilot-api-js/.git/refs/heads/master`）；审查 commit diff；相关 live docs、实现与 tests；`wc -c`；相对链接存在性扫描。
- 总体 verdict：修复 major 后可进入下一阶段。
- blocker 数量：0。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/spec/2026-07-28-history-filter-semantics.md:177-188` — 活 spec 同时把旧的“persisted 返回空＋降级标记”写成“实现必须照此”的冻结契约，又只在末句说 A3 已实施 strict list-search；接手者会合理地恢复已退役行为。— 当前实现由 `/home/xp/src/copilot-api-js/src/lib/history/queries.ts:326-424` 调 sidecar 并由 handler 返回 400／503，API 文档也声明 strict 契约。— 明确将 §6-1 旧裁决标成“已被 A3 cutover 取代的历史过渡态”，把当前规范正文改为 strict list-search，旧语义移入历史注记或归档。

[minor] `/home/xp/src/copilot-api-js/docs/archive/plan/history-list-search-sidecar.md:58` — 归档文档的“待办 C”相对链接解析到不存在的 `docs/archive/plan/history-filtered-exact-total.md`。— 同文第 45 行使用了可解析的 `../../todo/history-filtered-exact-total.md`；全量相对链接扫描只报这一处。— 将第 58 行链接同步为实际载体路径，或若该待办已归档则指向其归档位置。

[major] `/home/xp/src/copilot-api-js/docs/memory/feedback-layered-iterative-delivery-not-all-at-once.md:12-17` — “后续项已落盘”只有载体存在性门，没有必达复议触发点、下一决策点或关闭父项目时的未完成项 gate；执行者可把正确事项永久留在 todo，同时逐轮声称“下一批可调整顺序”，形成以分批为名的无限延期绕过。— 这与 `never-drop-a-right-thing` 的目标不冲突，但流程判据不足以保证它。— 为每个后续项要求记录依赖／下一复议触发点，并在阶段收尾或父项目关闭前机械枚举未完成后续项，由用户或未卷入方明确继续排期／重新裁决；没有裁决不得把父项标完成。

[minor] `/home/xp/src/copilot-api-js/src/lib/history/queries.ts:139-143` — 实现注释仍称 ready persisted-summary path “does not yet apply full-text search; A3 routes…”，时态会让接手者误判 A3 尚未落地，虽 live docs 已更新。— 同文件 `getHistorySummariesAsync` 已在 :326-424 实际执行 strict sidecar 路径。— 将注释改成当前职责：`summaryMatchesFilters` 本身故意不做全文匹配，persisted search 由 async facade／sidecar 负责，而非未来式 A3。

[minor] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:38` — 压缩引入了明显的行尾截断：`01-core-princi` 既不是完整规则名，也丢失了原索引对用户语言能力与无独立 memory 的召回说明。— UTF-8／换行／124 个链接均有效，主条目集合未丢，且 15358 bytes < 17100；但该坏行违反 D5 的“无明显截断坏行”。— 恢复完整 `01-core-principles` 及最小必要触发说明，同时保持总字节门。

## 主观建议

[建议] `/home/xp/src/copilot-api-js/docs/memory/feedback-layered-iterative-delivery-not-all-at-once.md` — “一定规模”仍是自评词，可能导致不同执行者在同一项目上选择相反流程。— 预期影响：降低流程适用范围漂移。— 推荐用可观察信号替代抽象规模，例如多语义 commit、跨阶段依赖、实施中新增发现、需要独立验收中的任一项即触发。

## D1–D6 核验结论

- D1：除活 spec 的 major 矛盾和实现注释 minor 外，API／DESIGN／history／schema／plan 的 400／503、freshness、poison 与 schema SSOT 和代码一致；未发现其他把 A3 写成未实现的目标 live 文档。
- D2：通过。新记忆明确适用于任何具备一定规模且持续发现问题的项目；四条机械边界覆盖每批自洽、阻塞项不后推、后续项落盘和分批不删范围。
- D3：目标与三条 long-termism 规则一致，但存在上述无限延期的 major 可执行性缺口。
- D4：通过。todo 明示“待验证假设／源码路径推导”，含生产正样本、证伪方式、正确结果、pending／failed 正样本和 mutation control。
- D5：字节门通过（15358 < 17100），新增原则主链接存在，主条目集合较 committed baseline 未丢，全部 Markdown 相对链接可解析；但有一条明显截断坏行。
- D6：核心 commit `08046d5c` 与 docs commit 均在共享 master；plan 诚实写 A3 代码完成但 reviewer／verifier／真实大库验收待做，recent-overlay 已落 todo。未找到所称“skill 待办”的明确载体；若调用方确有该待办，应补入同一状态表。

## 结构怪味扫描

- `/home/xp/src/copilot-api-js/docs/spec/2026-07-28-history-filter-semantics.md:177-188` — 同一活章节叠放历史过渡契约与当前契约，属于时间层混叠；本轮建议修，理由见 major。
- `/home/xp/src/copilot-api-js/docs/archive/plan/history-list-search-sidecar.md:1-58` — 已完成归档仍保留“待办／若做／启动时机”正文但顶端有强归档状态，属于可接受历史快照；记 backlog 不修，理由是改写会损失当时决策证据，修断链即可。
- `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:1-132` — 索引压缩为“一条主链接一行”且主条目集合不减，未发现重复真相源；修截断行。

[major] `/home/xp/src/copilot-api-js/docs/memory/feedback-layered-iterative-delivery-not-all-at-once.md:16-18` — D6 所称“skill 待办”未在新记忆、recent-overlay todo、计划状态表或仓库 `.claude/` 中找到；当前产物只落了 memory 原则，没有可发现的 skill 后续载体。— 全仓按 `skill／待办／后续／layered／分层迭代` 交叉搜索仅命中新记忆与无关历史计划。— 若已决定要将本原则下沉 skill，立即把该未完成项写进正式 plan／todo，给验收与触发词接缝；若并无此决定，则从 D6 当前状态命题中撤回“skill 待办”并明确说明。

## 方法反思

- 更好的项目内替代：仅写 memory 不足以执行长期流程；应把“批次表＋复议触发点＋关闭 gate”下沉到现有 planning／session-closeout skill，而不是新造平行流程。
- 判据判别力：本轮同时检查错误状态能否通过（旧 spec／无限 todo）与正确状态能否通过（主条目集合未减少、recent-overlay 正样本保留），未把纯字节压缩或链接全绿当成充分证据。
- 第三方方案：这是项目治理文本，不存在适合替代的成熟第三方库；应复用现有 skill 与 user-rule，而非手写第二套编排框架。

## 拟议处置充分性复核（2026-08-06）

- 复核范围：只评估协调者列出的 4 组拟议修改能否关闭原 3 major＋3 minor；尚未看到修改后正文，因此这是“条件充分”，不是复评通过。
- verdict：方案本身足以关闭全部原发现；按下列闭合条件逐项落实后，可进入复评。当前未发现拟议修改会引入新的 major。

1. 原 major（活 spec 双契约）：可关闭。§6-1 标题、引导句及 :181 的“实现必须照此”都必须明确限定为“历史过渡裁决／已被 A3 取代”，不能只在 :188 再补一句现状；当前 strict 契约仍应有明确规范入口。
2. 原 major（无限延期绕过）：可关闭。每个后续项记录依赖、事件型下一复议触发点，并在父项目关闭前枚举；最终 gate 的裁决者应明确为用户或未卷入方，且无裁决不得把父项标完成。
3. 原 major（skill 待办无载体）：可关闭。正式 todo 应写 pending 状态、目标既有 skill／规则接缝、触发词、验收判据、独立评审门，并从新 memory 或相关状态表链接过去；仅创建孤立 todo 文件仍不足。优先下沉到现有 planning／session-closeout skill，避免新造平行流程。
4. 原 minor（归档断链）：修正 `docs/archive/plan/history-list-search-sidecar.md:58` 指向真实 todo／归档位置即可关闭。
5. 原 minor（queries 未来时注释）：改成“此 helper 故意不做全文；async facade／sidecar 当前负责 persisted search”即可关闭，避免继续出现 “does not yet／A3 routes” 时态。
6. 原 minor（MEMORY 截断）：恢复完整 `01-core-principles` 与最小召回说明，并复验 UTF-8、换行、链接和 `<17100 bytes`，即可关闭。

- 新 major 扫描：四项修改都在加强时态分层、可达性与复议门，没有缩减正确范围，也没有推翻 strict list-search／long-termism；未发现新的 major。
- 复评所需证据：修改后逐个读取上述 file:line；相对链接扫描；`wc -c docs/memory/MEMORY.md`；全仓搜索旧 imperative／`does not yet`／skill todo 链接；确认 todo 的独立评审状态未被提前写成完成。
