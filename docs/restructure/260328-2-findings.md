# docs/restructure 二次复检结论

日期：2026-03-28

基于 `docs/restructure/260328-1-findings.md` 提出的意见，对 Claude 更新后的 `docs/restructure/` 再次审查。

本次复检关注两件事：

1. 上次指出的问题是否已变化
2. 更新后是否引入了新的问题

## 总结

这轮修改比上一版明显更好。

主要改进：

- `README.md` 不再把“500 行关注阈值”和“800 行硬上限”混为一谈，而是改成“按职责混合治理”
- `/history/v3` 被提升为 P0，路由入口问题被正确上升为阻塞项
- 测试文档不再强推“一源文件一测试文件”，而是改成“测试可追踪性”
- `05-state-management.md` 已补齐 12 个直接写入者，并纠正了 `serverStartTime` 不是 `State` 字段
- `07-cross-cutting.md` 已移除错误的静态路径分析，把该问题归并到 02

但这组文档仍未完全收敛，当前还存在：

- **2 个残留问题**
- **1 个新引入的问题**
- **1 个覆盖范围仍然偏窄的问题**

整体判断：

- 当前版本已经从“不能直接作为执行依据”提升到“**可以作为重构讨论底稿，但还不宜直接冻结执行**”
- 再做一轮小修即可进入较稳定状态

## 一、上次问题的变化

## 1. 已明显修正的问题

### 1.1 大文件治理基线已修正

上一版最大的问题之一，是把“7 个文件超过 500 行”和“违反 800 行上限”混写，导致优先级失真。

现在：

- `docs/restructure/README.md:3-5` 已明确改成“不以行数为驱动”
- `docs/restructure/01-oversized-files.md` 也已改成“职责混合的大文件”

这是正确方向。文档不再把“是否重构”机械绑定到某个行数阈值。

### 1.2 `/history/v3` 已被正确提升为核心问题

上一版把 `/ui` 和 `/history` 当成主路径，这是最严重的问题。

现在：

- `docs/restructure/README.md:9-13` 已把“路由与 UI 入口不一致”列为 P0
- `docs/restructure/02-route-organization.md:3-18` 已明确整理出“规范入口”和“实际注册”的冲突
- `docs/restructure/07-cross-cutting.md:39-44` 已把静态路径问题移出，不再重复放错位置

这部分已经从“事实错误”变成了“问题已识别，但方案还没完全写硬”。

### 1.3 测试文档已从“镜像命名”改成“可追踪性”

现在的 `docs/restructure/04-test-alignment.md`：

- 明确承认项目使用 `unit/component/integration/e2e` 分层
- 不再要求“一源文件一同名测试文件”
- 也修正了 `system-prompt-manager.test.ts`、`server-tool-rewriting.test.ts` 这类多模块覆盖测试的误判

这是正确修复。

### 1.4 状态治理文档已补足真实写入面

`docs/restructure/05-state-management.md:5-24` 已经准确反映：

- `state.ts` 被 12 个文件直接写入
- `serverStartTime` 不是 `State` 字段
- setter 化不是只改 `state.ts`，而是会波及 CLI、token、config 等模块

这一节现在已经基本可靠。

## 2. 从“错误”变成“部分修正”的问题

### 2.1 `02-route-organization.md` 已识别根因，但对“当前为何能工作”的表述仍然偏软

当前文档写法：

- `docs/restructure/02-route-organization.md:22-25` 正确指出 `/history/v3/assets/foo.js` 不匹配 `"/assets/*"`
- 但随后又写“当前之所以能工作，需要进一步验证具体机制（可能是 dist 产物内的相对路径、或者浏览器缓存）”

这里的问题是：这句仍然带有猜测色彩，而且猜测方向偏离当前仓库证据。

当前代码事实是：

- `src/routes/index.ts:46-48` 只注册了 `/history` 和 `/ui`
- `src/routes/history/route.ts:54-84` 只处理 `"/"` 和 `"/assets/*"`
- `ui/history-v3/dist/index.html` 明确引用 `/history/v3/assets/...`

所以更稳妥的表述应该是：

> 按当前代码无法解释 `/history/v3` 的工作机制，需要先确认代码、测试或部署方式哪一侧已经过时。

而不是举“相对路径”“浏览器缓存”这类弱证据猜测。

这说明该问题已被识别，但文档措辞还没完全收敛到“硬事实”。

## 二、仍然存在的残留问题

## R1. `06-frontend-cleanup.md` 的“当前真实行数”表仍有多处旧数字

这次修改已经刷新了一部分数字，但没有完全刷新。

文档当前写的是：

- `LogsPage.vue` 228
- `VLogsPage.vue` 174
- `UsagePage.vue` 241
- `VUsagePage.vue` 246
- `VHistoryPage.vue` 241

但当前代码实际为：

- `ui/history-v3/src/pages/LogsPage.vue` 242
- `ui/history-v3/src/pages/vuetify/VLogsPage.vue` 216
- `ui/history-v3/src/pages/UsagePage.vue` 292
- `ui/history-v3/src/pages/vuetify/VUsagePage.vue` 278
- `ui/history-v3/src/pages/vuetify/VHistoryPage.vue` 285

也就是说，`docs/restructure/06-frontend-cleanup.md:7-15` 这张表仍然混合了新旧数据。

这不是方向性错误，但会降低文档可信度，尤其是这份文档本身就在讨论“大组件”。

建议：

- 统一重新跑一遍行数统计后更新整张表
- 不要手动修一半数字、保留一半旧值

## R2. `01-oversized-files.md` 的覆盖范围现在偏窄，遗漏 `openai/auto-truncate.ts`

`docs/restructure/01-oversized-files.md` 当前列了：

- `history/store.ts`
- `error.ts`
- `anthropic/sanitize.ts`
- `anthropic/auto-truncate.ts`
- `context/request.ts`

但没有再提 `src/lib/openai/auto-truncate.ts`。

从当前代码看，这个文件仍然明显符合“职责混合的大文件”的判断标准：

- 文件 755 行
- 同时承担 auto-truncate 主逻辑、limit calculation、message utilities、token 相关逻辑

也就是说，虽然文档已经不再以“行数超限”为驱动，但在“职责混合”这个新标准下，它依然是候选项。

这不一定要升为最优先，但如果 01 的标题是“职责混合的大文件”，那把 `openai/auto-truncate.ts` 完全拿掉，会让覆盖范围显得不完整。

建议：

- 要么在 01 中补回 `openai/auto-truncate.ts`
- 要么明确说明为什么只治理 anthropic 版、不治理 openai 版

否则读者会以为它已经不再是问题，但当前代码并没有支持这个结论。

## 三、新出现的问题

## N1. `README.md` 对 `01-oversized-files.md` 的优先级标记和执行顺序不一致

`docs/restructure/README.md:42` 把 `01-oversized-files.md` 标成：

```md
P0 + P1
```

但执行顺序里：

- `docs/restructure/README.md:53-56` 把 `02` 单独放进 `Phase 1`
- `01` 被放进 `Phase 2`

这会产生歧义：

- 如果 `01` 真的是 `P0 + P1`，那它为什么整体落在 `Phase 2`
- 如果 `01` 是“部分内容 P0、部分内容 P1”，那 README 需要拆开写，而不是给整篇文档挂一个混合优先级

这是本轮修改后新出现的**内部一致性问题**。

建议：

- 二选一：
  - 把 `01` 改成纯 `P1`
  - 或把 `01` 明确拆成“其中 `history/store.ts` 为 P0，其余为 P1”

目前这种写法会让执行顺序和优先级矩阵打架。

## 四、当前版本的可靠性评级

| 文档 | 本轮状态 | 结论 |
|------|---------|------|
| `README.md` | 明显改善，但有新的优先级不一致 | 需小修 |
| `01-oversized-files.md` | 方向正确，但覆盖偏窄 | 需补充或说明范围 |
| `02-route-organization.md` | 已抓住核心问题，但措辞仍偏软 | 需收紧表述 |
| `03-module-boundaries.md` | 基本稳定 | 可保留 |
| `04-test-alignment.md` | 已明显修正 | 基本可用 |
| `05-state-management.md` | 已明显修正 | 基本可用 |
| `06-frontend-cleanup.md` | 方向合理，但数字未完全刷新 | 需修表 |
| `07-cross-cutting.md` | 已收敛 | 基本可用 |

## 五、建议的最后一轮修订

建议只做 4 个小修，不需要再大改结构：

1. 修 `02-route-organization.md`
   - 把“当前之所以能工作，可能是……”改成更硬的事实性表述

2. 修 `06-frontend-cleanup.md`
   - 重新刷新整张行数表

3. 修 `README.md`
   - 统一 `01` 的优先级标记和执行顺序

4. 修 `01-oversized-files.md`
   - 补回 `openai/auto-truncate.ts`，或明确说明为何暂不纳入

## 结论

相较第一次审查，`docs/restructure/` 已经完成了一次有效纠偏。

当前剩下的问题，已经不是“整体方向错误”，而是：

- 个别文档的措辞还不够硬
- 个别表格数据没完全刷新
- 个别范围边界没有说明
- 一处新的内部优先级不一致

这些都属于**再修一轮即可收敛**的问题。

如果目标是让 `docs/restructure/` 成为后续执行重构的正式依据，建议先完成上述 4 个小修，再进入代码实施阶段。
