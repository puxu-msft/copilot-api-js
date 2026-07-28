# 交接：文档陈旧性清扫（doc staleness sweep）

**日期** 2026-07-27 · **状态** 主体已完成并提交；余下 4 项待用户裁决
**方法学** 全程 file:line 实测 + `git log -S` 定向，不采信文档自述状态行 → 教训归属见 §3（原独立记忆已于 `578e0cc1` 被后续会话判定「已被 user-rule / skill 覆盖」而删除，本文不再引用该文件）

---

## 1. 这次做了什么

### 1.1 起因

从「分析热路径性能」出发（profiling → finalize 异步卸载，见 §1.3），收尾时发现**文档与代码大面积不一致**，遂展开专项清扫。核心发现不是「文档落后于代码」这一种，而是**三种方向后果相反**：

| 方向 | 正确处置 | 误判代价 |
|---|---|---|
| ① 文档陈旧（代码演进/特性删除） | 改文档匹配代码 | — |
| ② 文档尚未实现（spec/意图，代码没做） | 保留待办或建代码 | 删文档行 = **掩盖未实现缺口** |
| ③ 代码缺陷（文档才是对的） | 修代码 | 改文档迁就 = **把 bug 固化成规范** |

**动手前必须用 `git log -S "<符号>" -- <path>` 定向**（看最近一次是 `+` 还是 `−`）。本次全部 discrepancy 经此法定向后才处置。

### 1.2 已完成（均已提交）

| 项 | 处置 | commit |
|---|---|---|
| **DESIGN.md `staleRequestMaxAge` 与代码矛盾** | 该行称 reaper「只调 ctx.fail()、不取消在飞 fetch、force-fail 是装饰性的」，但缺陷④ 早已落地 → 改写为现状（reapInFlight → lifecycleAbort → reaperSignal 折进 3 处 transport） | `3427e46` |
| **9 个「已落地但状态行仍写草案」的 RFC** | 两轮独立 subagent + 主线 file:line 双重核实全部 ✅ 落地 → 移入 `docs/archive/2606-landed-rfcs/` + 已落地 banner + 批次 README（逐个列实现证据）；修全部入站链接（DESIGN.md、~11 处源码注释、v4 文档、memory） | `3427e46` |
| **5 份 2026-04-14 文档审查快照** | point-in-time 产物、多数 ✅ 已失效 → 移入 `docs/archive/2604-doc-audits/`；**归档前 harvest 仍有效发现**（shutdown.md 状态机漏 `executing` → 已修进活文档） | 见 archive README |
| **history.md / README.md REST 表** | `GET /api/sessions/:id` 与 `/:id/entries` 路由**均不存在**（route.ts 仅 `GET /api/sessions` + `DELETE /api/sessions/:id`），`/history/v1` UI 不存在 → 删错误行 + 补正确取法（`GET /api/entries?sessionId=`） | 同批 |
| **docs/shutdown.md**（现已更名 `docs/lifecycle.md`，`6164a2b6`） | 3 处与代码矛盾（Phase 1 关 WS 客户端实为 Phase 4、memory-pressure monitor 不存在、consumers.ts 已删）→ 逐条修正 | `bc8e8b1` |
| **pre-response-abort ④ 小节自相矛盾** | 顶部状态行与 §C4 表都标 ④ 已落地，但 §2 小节标题仍写「资源泄漏,暂缓」→ 标题改 ✅ 已落地 + 补「落地状态」块（逐条实现锚点）；顺带修 3 处 monorepo 拆包后的链接腐烂 | `ce6ed08a` |

**验证**：`docs/archive/2606-landed-rfcs/` 17 处入站链接 **0 断链**；pre-response-abort spec 的全部 `.md` 链接与全部 `src/` + `packages/` 代码引用均解析；typecheck 净。

### 1.3 历史线索：finalize 异步卸载（已随 History V2 退役）

前半段会话做的热路径工作，**其修改的代码层已不存在**，但结论与原语存活，交接时需知：

- **profiling 反转了静态排序**：finalize 同步 CPU 阻塞（zstd 压缩 ~6MB 合并帧 + 搜索索引构建）**~164ms/请求事件循环冻结**，比逐帧 JSON.parse（~6ms）高两个数量级；中位请求 1.9MB 上下文、100% >200KB，是常态非离群。
- **落地** P0–P5（golden 预捕获 → compressAsync → 两相 finalize + shutdown drain → 分片索引 → 背压 → doc-sync）。
- **现状**：该 RFC 已随 History V2 移除归档至 `docs/archive/2607-history-v2-removal/history-finalize-async-offload.md`；`src/lib/history/sqlite/` 整层已被 V3 取代。
- **存活的部分**：异步压缩原语迁入 `packages/foundation/src/sqlite/compression.ts`（`compressAsync`，`src/routes/history/handler.ts` 在用）；drain-before-close 不变量由 V3 的 `drainV3Writer()` 承继。
- **exp harness 仍可复现**：`exp/hot-path-profile/`（数据文件含真实 auth header，已 gitignore）。

---

## 2. 待办：经核实确属未实现 / 待裁决（4 项）

全部已在**当前代码**（2026-07-27）核实，非旧结论沿用。

### T1 — per-request config 快照缺失（真实缺陷，未修）

- **现状**：`src/server.ts:127-135` 仍**每请求** `await applyConfigToState()`，handler 直读全局 `state`；`configSnapshot` / `RequestConfigSnapshot` 全仓零命中，未发现 per-request 配置快照的等价物。（注：`RuntimeConfig` 这个名字在仓库里**有**命中，如 `packages/token/src/dependencies.ts:41`，但与 per-request 快照无关，别被它误导。）
- **后果**：并发请求可能读到「变动中」的全局配置（热重载与请求处理交错）。
- **出处**：`docs/broken/260324-fixes.md` High-4（该文档已被后续会话移入 `docs/broken/`）。
- **判断**：真实存在的架构缺口，非文档陈旧。修法需引入 per-request 配置快照（请求入口冻结一份，handler 只读快照）。

### T2 — `start.ts` 职责混叠（未拆，且更大了）

- **现状**：`packages/cli/src/start.ts` **781 行**（monorepo 拆包时整体搬迁，未拆分；审查时约 500 行）。
- **出处**：同上 Medium-3。
- **判断**：低风险、纯结构性；可与任何 CLI 域改动顺手做（对齐 CLAUDE.md「顺手解环」纪律）。

### T3 — activity-detail outline-as-main：目标 UI 正在**逐页迁移**中（需用户裁决）

- **文档**：`docs/spec/activity-detail-main-outline.md`（Status: v3.1，"Implementation-ready pending user sign-off"）+ `docs/superpowers/plans/2026-06-15-activity-detail-outline-as-main.md`（两路径均已核实存在）。
- **现状（已核实，勿凭印象）**：实现存在于分支 `feat/activity-detail-outline-as-main`，基于 Vue `ui/`（`ui/src/pages/vuetify/VDetailPage.vue`）。**Vue `ui/` 并未退役**——`package.json:40,43` 仍有 `build:ui`/`dev:ui`，workspace 仍在；它是**正被逐页迁移到 React `ui-v4/`**，单一事实源是 [vue-ui-retirement.md](../vue-ui-retirement.md)。另注该文顶部 2026-07-22 时效性警告：主服务器**已不再挂载/服务任何前端 UI**，两个 workspace 都由运维独立托管，故「退役」已从「删主服务器 `/ui` 路由」变为「运维托管哪个产物 + `ui/` workspace 何时整体删除」。
- **裁决点**：① 直接在 Vue `ui/` 落地（分支已实现，最省事，但投在正被迁走的 UI 上）；② 把设计**移植到 ui-v4**（对齐迁移方向，plan 的 Vue SFC/composable 级步骤需重写）；③ 归档 spec+plan。
  **倾向 ②**，但这取决于 `ui/` 还要活多久 + Activity Detail 页在 [vue-ui-retirement.md](../vue-ui-retirement.md) 的迁移排期——**下一会话应先读该路线图再问用户**，别直接照搬本推荐。

### T4 — `entries-v3-per-leg-storage` 已被实际落地的 History V3 取代（需确认后归档）

- **现状**：该 spec 自带告警「部分前提已陈旧（FTS-era）」，但该注解**早于** History V3 落地；而 `docs/rfc/2026-07-16-source-governed-history-v3.md` 已 **LANDED 2026-07-16**、`src/lib/history/v3/` 是活路径。
- **判断**：per-leg 存储意图已由 source-governed V3 以不同形态实现 → 该 spec 实为 **superseded**，宜加注解移入 `docs/archive/`（与 V2 移除批次同处或独立）。
- **未擅自执行**：归档 spec 属结构性处置，且需确认 V3 是否真覆盖其全部意图（我只核实了 V3 已落地且是活路径，**未逐条比对两者设计意图**）。

### 已解决（无需跟进）

- `SECURITY_RESEARCH_MODE.md` —— 功能从未实现（代码零命中），文档**已被后续会话归档**至 `docs/archive/`，处置正确。
- MEMORY.md 的 response-pipeline 钩子 —— 当前链接均解析，无断链。

---

## 3. 给下一会话的纪律要点

1. **改任何文档前先定向**（`git log -S`），尤其**非自己创建**的内容——本次连犯两错：整体提交了一份几月前别人写的 shutdown.md（只验两点），以及发现不一致后直接假设「陈旧」而未验证（方向赌对≠做对）。
2. **归档不是删除**：陈旧文档加注解（说明陈旧原因 + 关键 commit/日期）后移入 `docs/archive/<批次>/`，并**先 harvest 其中仍有效的发现**。
3. **归档必修链接**：移动后跑全仓链接解析检查（本次脚本见下方 kickoff）。
4. **并发/pending 改动**：本仓库工作区常有他会话未提交改动 —— 一律显式 pathspec 提交；同文件混杂时用 `git apply --cached` 只提自己的 hunk（本次 P2.6 两文件即如此处理，其 pre-existing 改动完好保留）。

---

## 4. 相关产物

- 方法学教训归属：原独立记忆 `feedback-verify-doc-vs-code-direction-before-acting.md` 已被后续会话（`578e0cc1`「delete 15 covered by user-rules/skill/DESIGN/todo」）判定为已被 user-rule / skill 覆盖而删除；实践指引见 skill `verifying-authoritative-claims`（其触发症状明列 doc-vs-code mismatch）+ CLAUDE.md `empirical-verification`。MEMORY.md 无悬空钩子。
- 归档批次：`docs/archive/2606-landed-rfcs/`（9 个逻辑 RFC + HANDOFF/prompt 伴随件 + `response-pipeline/` 子目录 + README，顶层共 12 个 .md）、`docs/archive/2604-doc-audits/`（5 快照 + README）
- profiling harness：`exp/hot-path-profile/`（REPORT.md 含落地后端到端实测修正）
- kickoff 提示词：[2026-07-27-doc-staleness-sweep-kickoff.md](2026-07-27-doc-staleness-sweep-kickoff.md)

---

## 5. 本文档自身的勘误（诚实记录）

本文初稿经异模型 reviewer 核验，**查出 4 处事实错误**，均已在上文修正：

| 初稿错误 | 正确事实 |
|---|---|
| 引用记忆 `feedback-verify-doc-vs-code-direction-before-acting.md` | 该文件已被 `578e0cc1` 删除（判定为已被 user-rule/skill 覆盖） |
| 称 `docs/shutdown.md` | 已更名 `docs/lifecycle.md`（`6164a2b6`） |
| 称 Vue `ui/` **已退役**、package.json 只有 ui-v4 脚本 | `ui/` **未退役**，`package.json:40,43` 仍有 `build:ui`/`dev:ui`；是逐页迁移中 |
| 称「全仓无 `RuntimeConfig` 等价物」 | `RuntimeConfig` 有命中（`packages/token/src/dependencies.ts:41`），只是与 per-request 快照无关 |

**根因**：初稿这几处凭**会话记忆**而非重新核实当前仓库——与本文 §1.1 反复强调的纪律恰好相反。这条自打脸值得后继者引以为戒：**交接文档尤其要逐条重验，因为后继者会完全据此决策**。
