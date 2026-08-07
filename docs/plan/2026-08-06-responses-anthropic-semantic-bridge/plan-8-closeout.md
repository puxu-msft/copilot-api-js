# P8 — Merged-State Verification, Documentation, and Rollout

> **状态**：未实施
>
> **前置**：P0–P7全部landed。此phase不新增semantic scope，只收口、证伪与同步。

**Goal:** 对合并态做全 population、双协议客户端、History、mutation和文档对账，关闭旧债项并产出可执行验收记录。

### Task 8.1: Property→acceptance机械对账

**Files:**
- Create: `docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-acceptance.md`
- Create: `docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-progress-p8-closeout.md`

- [ ] 为规格 AC1–AC24建表：property边界、量词/基数、排除项、test文件／命令、目标mutation、结果。
- [ ] 检查无孤儿AC、无测试声称更窄；用一条故意量词不一致正样本证明对账会报错，再删除正样本。
- [ ] 数字都锚当前commit、命令、路径口径；未交叉验证数字标未核实。

### Task 8.2: 全测试与目标 mutation 执行

- [ ] Run: `bun run typecheck`。
- [ ] Run: `files=$(git diff --name-only "$FEATURE_BASE"..HEAD -- '*.ts'); test -z "$files" || bun x eslint $files`，其中 `FEATURE_BASE` 取 P0/P1 首个 implementation progress 的共同起始 master SHA。Expected: eslint 0 error。
- [ ] Run: `bun run test:backend`。
- [ ] Run: `bun test tests/e2e-client/semantic-bridge-*.it.test.ts tests/e2e-client/responses-nodelta.probe.it.test.ts`。
- [ ] Run: `bun test tests/e2e-client/semantic-bridge-web-search-cli.e2e.test.ts`。Expected: PASS。若 harness 明确报告缺少 `claude` binary／客户端 fixture，本 feature 验收保持阻塞；不得跳过、用内部 Messages 子请求替代或把缺环境写成通过。
- [ ] 对 AC18 mutation清单逐个用冻结exact patch注入／反向恢复；恢复前reverse-apply check，恢复后status＋backend回归。
- [ ] 每个 mutation确认失败来自目标机制，不是旁路assert。

### Task 8.3: History V3／upstream／forwarded／candidate对账

**Files:**
- Test: `tests/history/v3/semantic-bridge-acceptance.it.test.ts`
- Test: `tests/history/semantic-bridge-api.it.test.ts`

- [ ] Request success/reject/throw三路；无candidate reject仍落request records。
- [ ] Hedge loser、failed、cancelled完整明细；winner顶层唯一投影；无winner不伪造response records。
- [ ] Upstream track完整source event；forwarded track客户端实收wire；synthetic provenance可辨。
- [ ] V3 terminal store→History API真实读回，不只内存对象。
- [ ] Opaque payload不进普通disposition/log，只记录scheme/version/kinds。

### Task 8.4: 文档同步

**Files:**
- Modify: `docs/DESIGN.md` 活架构现状与翻译矩阵
- Modify: `docs/tool-use.md` Claude Code WebSearch两层模型
- Modify: `docs/decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md` superseding clarification
- Modify: `docs/rfc/2026-07-14-anthropic-responses-direct-bridge.md` 过时Web Search事实注解
- Modify: `docs/todo/deferred-backlog.md` 迁入／关闭旧silent-drop与server-tool债项
- Modify: `docs/coding-conventions.md` semantic bridge测试／owner约定（若形成长期惯例）
- Modify: 本计划README状态与各phase状态

- [ ] ADR保留原决定与当时证据，只追加后续事实；不倒写历史。
- [ ] 跨文档扫描 `暂缓|暂未|未实现|TODO|reserved|无源`，逐条disposition本特性残留。
- [ ] 新关键词 `semantic bridge|bridgeDispositions|BridgeCompatibilityError|WebSearch.call` 跨docs检查应提之处。
- [ ] broken-link／L1守卫绿。

### Task 8.5: 独立验收与merged-state review

- [ ] 派 verifier 从冻结spec独立推导oracle，不读implementer测试结论；主责客户端行为、continuation真上游、unknown四格。
- [ ] 派 reviewer 主责代码质量、跨phase接缝、commit messages、无双轨、第三方oracle、结构怪味。
- [ ] 派前列可验证当前状态命题；报告逐条file:line／命令证据，落盘append，不只返回正文。
- [ ] 主会话独立复核所有绝对断言；整改后恢复原reviewer，直到0 BLOCKER/MAJOR。

### Task 8.6: 关闭progress与提交

- [ ] 每个phase progress三样折回正式plan，标已归档／被plan取代。
- [ ] 跑`--first-parent`进度对账脚本，输出必须为空；不把空输出当内容真实证明。
- [ ] 更新README为已实施并写landed commits。
- [ ] 精确pathspec提交文档／验收记录；不push。

## 最终完成判据

- AC1–AC24全有独立证据与目标mutation。
- `bun run test:backend`、typecheck、SDK／CLI client E2E绿。
- 真GHC物理接受性结论有边界，不以HTTP 200冒充语义恢复。
- History V3、API、upstream／forwarded、candidate/winner对账通过。
- 全部文档同步，reviewer／verifier 0 BLOCKER/MAJOR。
- 4141主服务器全程未被停止或重启。
