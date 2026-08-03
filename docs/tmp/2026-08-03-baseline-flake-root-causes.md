## `legacy Vue ui/ stays detached from the main chain > root eslint ignores every file under ui/`

### 守的不变量

旧 Vue 前端 `ui/` 必须与根工具链保持脱钩：根 ESLint 必须忽略 `ui/` 下每一个现存源文件，同时不能把后端或 `ui-v4/` 一并忽略。依据是测试名与 `tests/infra/ui-v3-decoupling.unit.test.ts` 的文件级注释，以及 `docs/vue-ui-retirement.md` §0 中用户于 2026-07-28 裁决的边界“root `eslint .` 整体 ignore”。逐文件全集而非抽样是既有不变量的一部分，用来阻止只忽略 `ui/src/**`、却漏掉 `ui/` 根层配置或其他子树的半脱钩状态。

### 复现与根因

修前在 commit `2c3397847b3d85eebfe32e794d3ad700cb00e1f4` 的隔离 worktree 单跑为 4.72s；六轮 16 路全套件中曾在 5.416s 撞 Bun 默认 5s timeout。源码没有 spawn 子进程，而是在测试进程中构造真实 `ESLint` 并对 164 个 `ui/` 源文件逐个调用 `isPathIgnored()`。这是负载/超时型 false-red：检测面正确且会终止，但加载完整 typed flat config 并逐文件走 ESLint resolver 的正常成本已与通用 5s 预算同量级，并发负载把它推过边界。

### 修法

保留真实 ESLint oracle、164 文件全集与两个非 ignore 正样本，不改任何断言；只把该条测试的预算显式设为 15s。没有采用“直接读 exported flat config”：该导出是 39 块配置的原始数组，绕过 ESLint 的 schema、global/local ignores、`files` 匹配、negation 与 config lookup 会改变检测面；自行复刻这些语义不是根因修复。15s 是该 integration oracle 的容量预算，不是行为阈值。

### 正样本对照结果

临时删除生产 `eslint.config.js` 的 `"ui/**"` 后，该测试在 3.76s 转红，明确报告 95 个未忽略文件；反向应用同一变异恢复后，该测试在 3.19s 复绿。故预算调整没有削弱判别力。

### 连跑证据

待三条全部修完后的全套件 ≥10 次连跑补充。

## `state → foundation：出边 ratchet > packages/foundation/src/state-vocabulary.ts 的出边集与登记表逐条相等`

### 守的不变量

`packages/foundation/src/{state,state-defaults,state-vocabulary}.ts` 正在叶子化；每个文件的解析后出边身份必须与 `tests/architecture/state-out-edges.unit.test.ts` 的登记表逐条相等，新增边与已移除但未更新登记表的边都必须转红。`state-vocabulary.ts` 是零 import 词汇叶，登记出边为空。依据是该测试文件顶部注释：人工审计曾漏五条边，其中 `~/lib/token/types` 是会阻断最终搬迁的包分层倒置；此检查明确是 ratchet 而非可放宽的快照。

### 复现方式与根因

单跑 ratchet 稳定绿；修前让 `package-boundaries.unit.test.ts` 的三条“守卫真的消费”正控在一个 Bun 进程反复运行，同时让 ratchet 在另一个 Bun 进程运行，稳定复现同一 `../../node_modules/consola/dist/browser.d.mts` 假边，并同时观察到 `node:module` 探针假边。这证明不是 AST cache 污染，而是跨进程共享 production source 的文件系统竞态。污染者为 `package-boundaries.unit.test.ts:349-359`：它把 `node:module`、ambient `require`、`import("consola")` 三个正控逐一写入真实 `packages/foundation/src/state-vocabulary.ts`，调用 closure guard 后再恢复。`scripts/parallel-test.ts` 的 16 个 shard 是并行进程；其他 shard 可在 planted→restore 窗口读到临时源码。`consola` 经 TypeScript resolver 解析成上层主树 `node_modules/consola/dist/browser.d.mts`，故失败值精确吻合。

### 修法

给 `stateUnitClosureViolations` 注入默认读取真实文件的 `readSource` seam；三条接线正控只在该 seam 中为 `state-vocabulary.ts` 返回 `planted + original`，不再修改 production source。守卫的 closure、AST、specifier resolver、断言集合均未改变。

### 正样本对照结果

在真实 `state-vocabulary.ts` 临时加入 `import type { ConsolaInstance } from "consola"` 并导出别名后，ratchet 为 `4 pass / 2 fail`，明确报告 `../../node_modules/consola/dist/browser.d.mts`；撤销 exact mutation 后为 `6 pass / 0 fail`。修复后的并发复现对照：注入正控 `600 pass / 0 fail` 与 ratchet `6000 pass / 0 fail` 同时完成；普通配对为 `30 pass / 0 fail`。

### 连跑证据

待三条全部修完后的全套件 ≥10 次连跑补充。
