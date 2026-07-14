# Spec：测试按速度分档（tier 正交于 type）

- 状态：草案 v2（已过两轮跨模型对抗 review → 待用户复审 → plan）
- 日期：2026-07-14
- 归属：`docs/spec/`，配套 plan 落 `docs/plan/`
- review：GPT reviewer（1 BLOCK/2 HIGH/2 MED）+ Claude reviewer（0 BLOCK/2 HIGH/4 MED），finding 已并入本 v2（§13 记录处理与不采纳项）。

## 1. 问题与目标

当前默认 `test`（= `test:backend` = `bun test .unit.test .it.test .http.test`）把三档一次跑完，约 **65–70s wall**，每次改动都要等全量。用户诉求：**分析运行效率 → 按速度分档 → 默认只跑快速档，慢的（集成/e2e/pty）按需运行**。

目标：
- 默认反馈路径压到「快速档」，慢测试移出默认、保留按需入口。
- 不牺牲覆盖面：全量入口仍在，只是不再是「每次改动」的默认。
- 借机修正三处测试健康债：类型误配的慢单元、脱离一切脚本的孤儿测试、e2e 发现机制分裂。
- 立一道 L1 守卫，长远防止「已分档但无脚本运行」的静默盲区复发。

## 2. 实测基线（empirical，2026-07-14 本机 bun 1.3.14；wall time 随机器负载/并行波动，仅作单次观测）

全部已分类后端测试在 `tests/` 下（`bunfig.toml` `[test] root=./tests`）。位置参数按**文件名/路径子串 OR 过滤**（实测 `bun test .unit.test .http.test` 命中 326 = unit 265 + http 61，不含 it）。`root=./tests` 使 `src/` 下测试**默认不被发现**。

| 档 | 脚本 | 文件 | 测试 | wall(本次) | 备注 |
|---|---|---|---|---|---|
| unit | `test:unit` | 265 | 3246 | 20–27s | 有 4 个真失败（§7） |
| http | `test:http` | 61 | 383 | 18–21s | wire/HTTP 层 |
| it | `test:it` | 97 | 1424 | ~27s | 集成，最慢档 |
| pty | `test:pty` | 6 | 7 | ~107s | 终端 UI，已不在 backend |
| e2e | `test:e2e` | 4 | — | 未测 | spawn 真服务，需真 GHC token（§4） |
| 孤儿 | 无 | **60**（tests 47 + src 13） | — | — | 无任何脚本运行（§5） |

fast 候选 `bun test .unit.test .http.test` 本次实测 **~38s**（单次；`test:backend` 本次 ~70s）。

**核心洞察：后缀分类是「测试类型（真相域）」轴，不是「速度」轴，两者不干净对应。** 慢由少数离群文件贡献：

| 耗时 | 测试数 | 档 | 文件 |
|---|---|---|---|
| 10.32s | 9 | it | `tests/history/http-headers-capture-golden.it.test.ts` |
| 5.51s | 346 | it | `tests/config/config-hot-reload.it.test.ts` |
| **5.30s** | **3** | **unit** | `tests/pipeline/request-payload.unit.test.ts`（挂 unit 却极慢） |
| 2.69/2.57/2.37s | — | http | 三个 `*-v4.http.test.ts` |
| **2.15s** | 28 | **unit** | `tests/shutdown/rate-limiter.unit.test.ts` |
| 1.27s | 38 | unit | `tests/shutdown/shutdown.unit.test.ts` |

## 3. 设计原则：type 与 tier

- **类型轴（真相域，不变）**：后缀 `.unit / .it / .http / .pty / .e2e` = 真相域（遵 `choosing-test-type` skill）。
- **执行轴 / tier**：**不新增独立速度轴**（§11 非目标）；tier = 「类型 → 档位」的**映射**，靠 package.json 脚本**按后缀组合**表达。故某文件落哪个 tier 是其后缀（类型）的确定性函数——脚本正是 key off 文件名。
- **改名的唯一充分条件（硬规则）**：慢**只是触发复核的信号**，不是改名理由。把某文件 `.unit → .it` 的**唯一充分条件**是**独立实测确认其真相域确为集成**（做真 I/O / spawn / 起服务）。慢的纯单元一律留 unit + 注释说明（如 `request-payload`）。防止实施退化成「只要慢就改 .it」。

用户决策（2026-07-14）：快速档 = **unit + http**（守 wire 契约这条最易回归的线）。

## 4. 脚本改动（package.json）+ e2e 发现统一

### 4.1 e2e 发现机制统一（修 BLOCK：`.e2e` 后缀 vs `test:e2e` 目录过滤不匹配）

现状 `test:e2e = bun test tests/e2e/`（**目录**过滤），只覆盖 `tests/e2e/`；`tests/e2e-client/anthropic-cli.e2e.test.ts`（真 e2e、从 `./harness/drive-claude-cli` 导入真 CLI 驱动）**不被覆盖**，收编后仍是孤儿。

**决策：e2e 统一为后缀过滤**，与 unit/it/http/pty 的「后缀=类型」范式一致：
- `tests/e2e/*.test.ts`（4 个）→ 重命名加后缀 `*.e2e.test.ts`。
- `test:e2e` → `bun test .e2e.test`（覆盖 `tests/e2e/` 与 `tests/e2e-client/` 下所有 `.e2e.test.ts`）。
- 记录不采纳项：另一方案「把 e2e-client 文件物理迁进 tests/e2e/」被否——后缀过滤更自洽、不依赖目录布局，且免 harness 相对 import 迁移。

### 4.2 脚本表（唯一开发者行为变更 = `test` 去掉 it）

| 脚本 | 改后 | 说明 |
|---|---|---|
| `test` | `bun run test:fast` | **新默认 = fast** |
| `test:fast` | `bun test .unit.test .http.test` | 显式快速档（~38s，单次观测） |
| `test:unit` / `test:http` / `test:it` / `test:pty` | 不变 | 单档入口 |
| `test:e2e` | `bun test .e2e.test` | **改为后缀过滤**（§4.1） |
| `test:backend` | `bun test .unit.test .it.test .http.test` | **保持** = 全后端逻辑（~70s，pre-push） |
| `test:cov` / `test:cov:report` | 保持全后端（unit+it+http），**内联文件列表改为与 `test:backend` 同源**避免漂移 | 覆盖率应尽量全，不跟 `test` 去 it |
| `test:ci` | `test:backend && test:pty && test:e2e`（e2e 前提见下） | 当前漏 e2e/pty 全量 |
| `test:all` / `test:acceptance` | 补 `test:ui-v4`（§5 尾） | 现状漏 ui-v4（40 测试游离聚合门外） |

**e2e 入 `test:ci`（既成事实，无需新增 gating）**：e2e 直连真 GHC 上游、需真 token+网络，但**早已 token-gated**（`tests/e2e/*.test.ts` 自 commit `c1589b00`(2026-02-07) 起用 `describeWithToken = getE2EMode() !== "mock" ? describe : describe.skip`；`tests/e2e-client/anthropic-cli.e2e.test.ts` 用 `describe.skipIf(!GATED)`）。实测干净环境（无 token）`bun test .e2e.test` → 全 skip / 0 fail。故 `test:ci` 可直接纳入 `test:e2e`，**无需新增 skip 逻辑**——plan 对应 task 降为验证性（跑一次确认干净环境不 fail）。仓库当前无 `.github`/`.husky`/CI（已核实），`test:ci` 是为未来 CI 预备的全量门。

## 5. 收编 60 个孤儿测试

**tests/ 下 47 个**（无分类中缀的裸 `.test.ts`、`.integration.` ×4、`.sub.` ×1、`.e2e.` ×1）+ **src/ 下 13 个**（`root=./tests` 使其根本不被发现）。

处理：
1. **逐文件按真相域分类**，补正确后缀（`.unit` / `.it` / `.http` / `.e2e`）。混有真 e2e/heavy（`anthropic-cli.e2e.test.ts` 等）→ 归 `.e2e`（由统一后的 `test:e2e` 覆盖），**不塞 fast 档**。
2. **`.integration.test.ts`（4 个：cc-buffered / ws-buffered / footer-live-attempt / log-line-color）统一改 `.it`**——`.integration` 与 `.it` 真相域同义，消除双命名腐蚀「后缀=类型」唯一性。
3. **src/ 的 13 个 = 迁移 + 改写 import（非纯文件移动，修 HIGH）**。部分用同目录相对 import（`src/lib/observability/sinks/calibration.test.ts` → `./calibration`、`calibration-failure.test.ts` → `./calibration-failure`），迁到 `tests/` 后会解析到不存在的模块。plan 须逐文件列：旧路径、新路径（`tests/` 镜像）、相对 import 改写为 `~/` alias（tsconfig 已映射 `~/*`→`src/*`）、+ 后缀。**不改 `root` 配置**（避免双发现源）。
4. 验收 = **新路径的 tier 脚本实际运行该文件**（非仅文件名/grep）。

## 6. 慢离群审查（守后缀=类型）

审 unit 档 >1.5s 文件（`request-payload` 5.3s、`rate-limiter` 2.15s、`shutdown` 1.27s…）。依 §3 硬规则：**唯有独立实测确认做真 I/O/spawn/集成**才改 `.unit → .it`；真 CPU-heavy 纯单元留 unit + 注释（`request-payload` 无 spawn/fetch，疑重计算，须读实现裁决）。

## 7. 4 个预存真失败（P0，拆两条具名裁决——非同质，修 MED）

隔离单跑仍失败（**非污染，非同一根因**，已亲手核实）：

- **P0a — `tests/infra/resetters-complete.unit.test.ts`（×1）= 生产隔离接线缺失**。`src/lib/observability/reaper-diagnostics.ts:123` 导出 `resetReaperDiagnosticsForTests`（注释自称「registered in RESETTERS」），但 `tests/helpers/isolated-fixture.ts` 的 RESETTERS 表**未注册它**，L1 守卫正确报错。裁决：**补注册进 RESETTERS**（supply，遵 `broken-reference-supply-vs-delete`），或据实际 singleton 生命周期给**有证据的 EXEMPT** 理由。**绝不为过守卫而删/放宽断言**。
- **P0b — `tests/observability/console-thinking.unit.test.ts`（×3）= 夹具状态序列不真实**。`makeCtx()` 硬编码 `state:"completed"` 并把该 terminal ctx 同时用于 `feature_applied` 与 `completed` event；而 `src/lib/tui/terminal-ui.ts` 对 terminal state 刻意返回不入 active map 的 throwaway entry。裁决：先把夹具改为**真实序列**（feature event 用非 terminal ctx，随后再发 completed ctx），再判生产 console 契约是否满足——可能是夹具陈旧，须证据裁决，不预设「删断言」。

**P0 是 fast 档验收的硬前置**（修「可跳过 vs 全绿」耦合 MED）：P0a 是真隔离 bug、P0b 可修，故不修完不算交付。若个别项经查须设计取舍无法即时定，带**根因**入 `docs/todo/deferred-backlog.md`，且 §10 验收改读「fast 除 N 个已 backlog 的既存失败外全绿」。

## 8. L1 发现矩阵守卫（长远防复发，两 reviewer 共同建议）

新增一个 L1 守卫测试（如 `tests/infra/test-discovery-matrix.unit.test.ts`）：枚举全仓 `**/*.test.ts`，断言每个文件**恰好匹配一个** tier 脚本的发现集（后缀 ∈ {unit,it,http,pty,e2e}，且不在 `src/`）。任何新增孤儿 / 双命名 / src 漏迁会即时红。这是「已分档但无脚本运行」盲区的结构性防线（对齐记忆 [architecture-map L1 存在性守卫] 思路）。

## 9. 文档同步（P5，扩围——修 HIGH）

- `CLAUDE.md` 工程纪律段补：默认 `test`=fast（仅快速反馈、**不是全后端验证**）、pre-push 用 `test:backend`、慢档按需。
- `docs/coding-conventions.md` 补 tier↔type 两轴 + §3 硬规则 + §8 守卫。
- **非归档 docs 语义审计**：全仓（排除 `docs/archive/`）grep 裸 `bun test`，凡语义为「全量/全后端/commit invariant/提交前验证」者（如 RFC commit-invariant、`docs/2606-bridge-features/design.md:279`、`docs/rfc/2026-07-07-*.md:203`）改为 `bun run test:backend`。指向具体单文件测试脚本的裸 `bun test <path>` 保留不动。

## 10. 验收标准（可执行 oracle——修 MED）

- `bun run test`（fast）只跑 unit+http、**全绿**（P0 完成后，或除 N 个已 backlog 者）；wall 以固定 bun 版本 + 同机连跑 ≥5 次的 median 报告，与原 `test:backend` median 对比呈显著下降（不把单次 38s 当硬阈值）。
- `bun run test:backend` 跑 unit+it+http 全绿；`test:it`/`test:pty`/`test:e2e` 各自可独立跑。
- `test:ci` 覆盖 backend+pty+e2e（e2e 按 §4 前提）。
- **孤儿 oracle**：`find tests -name '*.test.ts' | grep -vE '\.(unit|it|http|pty|e2e)\.test\.ts$'` 输出为空；`find src -name '*.test.ts'` 输出为空。
- **§8 守卫测试绿**。
- 无按速度命名的文件（后缀仍纯表达真相域）。
- `test:all`/`test:acceptance` 含 ui-v4。

## 11. 非目标

- 不引入正交速度标记（`.slow.` 中缀/目录）——守后缀=类型，靠脚本组合分档。
- 不改 bun 运行器 / `root` 配置。
- 不做测试并行化 / sharding（另议）。
- 不重设计 ui/ui-v4 前端测试**内容**（但 §4 尾把 `test:ui-v4` 补进聚合门，属修既存缺口，不算重设计）。

## 12. 实施阶段（重排——先定发现矩阵与 e2e 入口，再改默认，最后迁孤儿，修 GPT 顺序建议）

- **P0**（硬前置）：拆解处理 4 个真失败（§7，P0a/P0b 分别裁决）。
- **P1**：§8 发现矩阵守卫 + §4.1 e2e 后缀统一（先立防线与 e2e 边界）。
- **P2**：§4.2 脚本改动（纯 package.json）——拿到 fast 档。
- **P3**：§5 收编 60 孤儿（分类 + src 迁移+import 改写 + `.integration→.it`），逐批提交，守卫测试转绿即验证。
- **P4**：§6 慢离群审查——按实测逐个裁决。
- **P5**：§9 文档同步（含裸 `bun test` 语义审计）。

## 13. Review finding 处理台账

| finding | 级别 | 处理 |
|---|---|---|
| e2e-client 后缀 vs test:e2e 目录过滤不匹配 | GPT BLOCK / Claude HIGH | 采纳 → §4.1 e2e 统一后缀过滤 |
| doc-sync 范围不足（裸 bun test=全量语义回归） | GPT HIGH | 采纳 → §9 语义审计扩围 |
| e2e 入 ci 前提 → **实为既成事实（早已 gated）** | plan-review BLOCK | 采纳 → §4 改既成事实、plan Task 2b 降验证性 |
| test:cov oracle 恒真（bunfig coverage=true） | plan-review HIGH | 采纳 → plan Task 2 改 `--coverage-dir` 副作用判定 |
| src 迁移需 import 改写非纯移动 | GPT HIGH / Claude 提及 | 采纳 → §5.3 |
| 4 失败非同质、需拆具名裁决 | GPT MED / Claude 佐证 | 采纳 → §7 P0a/P0b |
| 38s 数字过稳、需相对指标+重测 | GPT MED | 采纳 → §2 标注单次 + §10 median 相对 |
| 两轴措辞过强（tier=f(type)） | Claude MED | 采纳 → §3 改「映射」+ 硬规则 |
| 「全仓无孤儿」vs ui-v4 出范围 | Claude MED | 采纳 → §10 收敛后端 + §4 补 test:ui-v4 |
| 验收缺可执行 oracle | Claude MED | 采纳 → §10 grep oracle + §8 守卫 |
| P0「可跳过」vs「fast 全绿」耦合 | Claude MED | 采纳 → §7 P0 硬前置 + backlog 兜底 |
| 孤儿实数 60 非 ~56 | 两方 | 采纳 → §2/§5 |
| test:cov 漏提 | Claude 建议 | 采纳 → §4.2 保持全后端+去内联漂移 |
| .probe 例子不准（已被 test:it 覆盖） | Claude 建议 | 采纳 → §5 例子去掉 .probe |
| .integration→.it 统一 | Claude 建议 | 采纳 → §5.2 |
| L1 发现矩阵守卫 | 两方建议 | 采纳 → §8（长远防线） |
| 「默认 test 去 it 致 CI 静默漏测」 | — | **不采纳为既成事实**：已核实无 `.github`/hook/scripts 依赖裸 `bun run test`；真实风险在文档语义（已由 §9 覆盖）。 |
