---
name: methodology-domain-peel-execution-techniques
description: 从 core god-object/SCC 剥离领域包（models/transport 等下一个 peel）时，实测有效的执行级技巧——两次真实 peel（token=SoT 反转型 / telemetry=只读消费+module-split 型）的合集：吸收 N 个测试文件零改动、ambient 端口 floor、peek/get 容忍分层、foundation 裸包名需 tsconfig path、facade 插层会让文件临时进 SCC、最后一条 core 边常藏在默认参数、边界守卫要 allowlist 不要 denylist、前端 ~backend 类型需纯类型 barrel
metadata: 
  node_type: memory
  type: project
  originSessionId: 182ee62e-f239-4378-baeb-2483de3616b8
  modified: 2026-07-23T13:02:56.085Z
---

token 域抽包 `@hsupu/ghc-proxy-token` 已 landed（commit DAG C3 `61e78be4`→C4 `28d27f5a`→hardening `3dfb923e`→C5 `faf2a896`→C7 `705f4f09`→guard-harden `ec567a41`，均 typecheck+test:backend 6315/0+lint 绿，经两轮异模型合并态审 0-blocker）。是首个真领域包剥离，作后续 models/transport peel 的**活模板**。**契约级模板**见 [docs/plan/monorepo-split/plan-token-package.md](../../docs/plan/monorepo-split/plan-token-package.md)「通用 DomainPeel Contract」；本条只记**执行级、plan 里没有的实测技巧**——是让「所有权反转」这种高危、高 test-ripple 步骤变得可控的关键。

**Why:** 反转 SoT 出 god-object（如 `state`）时，最大障碍不是生产读点（有限、类型系统逼出），而是**成百上千测试文件经 `setStateForTests({fieldX})` 写该字段**——本次 137 个。天真做法是 sed 改 137 文件（巨量 churn + 踩平行块/UTF-8 sed 坑）。承重技巧把它压到**零测试改动**。

**How to apply（下一个 peel 照搬）：**
1. **`setStateForTests`-shim + snapshot-fold（make-or-break，吸收 N 测试文件零改动）**：① 把 test-only mutator 形参**加宽**为仍接收被迁走的键，运行时**转发**到新 store 的 setter（`"key" in patch` 门控，正确区分「显式 undefined→清」vs「缺席→不动」；4 键绝不进 `updateState`）；② 把 `StateSnapshot` 从 `= MutableState` 改**复合** `{state, tokenStore}`，`snapshotStateForTests`/`restoreStateForTests` **折入** store 的深拷贝快照/恢复——既有 per-test 夹具（isolated-fixture / autoRestoreState）单点 snapshot→restore 不透明往返，故自动原子隔离迁走的 state，无需碰夹具、无需独立 resetter。前提：全部 StateSnapshot 消费者都不透明往返（grep 证无一读快照字段/传裸 MutableState）。→ [[feedback-fix-all-comparison-sites]] 的对偶（正向版用类型系统逼出全站点）。
2. **ambient 端口 floor preload**：领域包的**自由函数**（非方法）失去直接 `~/lib/*` import 后，需要 ambient 安装的注入端口才能解析 transport/paths。加**第二个 bunfig preload**（排在 fs sandbox floor 之后，故 `PATHS` 已重定向），全局 install 默认端口——每个测试（含不走 isolated-fixture、直调自由函数的）都解析。端口的 `fetch` adapter 套在 live `upstreamFetch` 上（call-time 间接），故既有 mock（`setFetchMock`/`setUpstreamFetchForTests`/网络守卫）全部照旧穿透。端口是无状态 adapter → floor 装一次、永不 reset（per-test reset 的是 runtime 单例，见 `resetTokenRuntimeForTests` 入 RESETTERS）。
3. **peek/get 容忍分层**：composition-root 构造链（CLI）用 fail-fast `getRuntime()`（未装配=接线 bug）；请求/关停/重试腿用容忍 `peekRuntime()?.op()`（init 前 no-op 语义正确，且避免逼每个 http 测试装 dummy）。
4. **`@hsupu/ghc-proxy-foundation` 裸包名是首个消费者 → 需 tsconfig path**：foundation 此前处处经 `~/lib/*` alias 消费；抽出的包**头一个**用裸包名 import foundation，tsc/bun **不解析** `@hsupu/ghc-proxy-foundation/ghc-http-primitives` 除非加 `"@hsupu/ghc-proxy-foundation": [...index], "@hsupu/ghc-proxy-foundation/*": ["./packages/foundation/src/*"]` path 映射（foundation package.json `exports["./*"]` 只够 runtime 不够 tsc）。error/* 子路径不在 foundation barrel、只能子路径 import。
5. **过渡 alias 保消费者不改**：`git mv` 后加 `~/lib/<domain>` + `~/lib/<domain>/*` → `packages/<domain>/src/*`，排在 `~/*` 兜底前；核心里对该域的**相对** import（`./token`、`./lib/token`）须一并改指 alias（相对随目录移失效）。
6. **dispose 计时器泄漏（auto-refresh manager 通病）**：refresh `.then` 若**无条件** reschedule，则 dispose 中途在飞刷新会遗留计时器（cancel→await in-flight→`.then` 重排）。修=`disposed` 标志**在 drain-await 之前**置位 + `scheduleRefresh` 开头守卫 + belt-and-suspenders 二次 cancel。测试用**armed-timer getter 状态断言**（`refreshTimeout!==null`）而非 wall-clock，确定性；须实测 mutation 红/绿（去守卫→红）。
7. **边界守卫双向 + 全 import 形态**：unit guard（扫 `packages/<domain>/src` 拒所有 `~/`+sibling core/server/cli，带正样本证真命中）+ ESLint `no-restricted-imports` 镜像。守卫正则须覆盖 `from`/side-effect `import "X"`/dynamic `import()`/`require` 全形态（只 match `from` 会漏；ESLint `~/*` 实测已覆盖 nested+side-effect）。收官后异模型**合并态审**（非仅 per-commit），亲手 grep 复核「零残留双 SoT」。

**Related:** [[feedback-verify-named-target-resolves-before-large-work]]（踩坑=Vue `ui/` vs React `ui-v4/`；本次踩坑=CLI 已在 `packages/cli/src/` 非 `src/`）、[[git-commit-pathspec-commits-worktree-not-index]]（split-commit：deleted 文件 pathspec 让 `git commit -- <path>` fail，改暂存 index 再无-pathspec commit）、[[reference-worktree-bun-add-needs-main-tree-install-after-merge]]（新 workspace 包 `bun install` 更新 bun.lock=语义改动须保留，非 171B spurious touch）。

---

## 第二次 peel：telemetry → `@hsupu/ghc-proxy-telemetry`（landed 2026-07-27，T0 `8a762437`→T1 `714e83d4`→T2 `1b0bdb42`→T3 `8fbea803`→T4 `198d9026`→T5 `bd3aafe0`）

契约模板见 [plan-telemetry-package.md](../../docs/plan/monorepo-split/plan-telemetry-package.md)（含执行期 5 处偏差与理由）。**与 token 的形态差**：telemetry 只读 config、不 own 任何 `state` 字段 → **没有 SoT 反转**，所以技巧 1（setStateForTests-shim）整条用不上、测试零 churn 是白拿的；但它有 token 没有的 **module-split**（维度 registry 劈成「名字归包 / 提取器留 core」）。下一个 peel 先判自己属于哪一型。

**新增的执行级技巧（token 那轮没遇到）：**

8. **facade 插进调用链会让 facade 文件临时进 SCC —— ratchet「只减不增」会在中途被自己绊倒**。T2 把消费者从 registry 收敛到 runtime facade 后，环数降了（73→72）但**成员多了一个**（`telemetry-runtime.ts` 顶替 registry 的位置进环），因为剩余 type-edge（`history/store`、`telemetry-dimensions`）还没断。两条出路：① 把断 type-edge 的步骤**排在 seam 之前**（拿到严格单调的 ratchet），② 中途重冻结 baseline 但**必须先实测 diff、确认只有那一个预期新成员**，并在 commit message 里写明是过渡态。本次走了 ②。教训：**别假设「插一层门面」对环图是中性的**。
9. **包对 core 的最后一条边常藏在默认参数里**。`openTelemetryDb(dbPath: string = PATHS.TELEMETRY_DB)` —— 函数体干净、签名不干净。实测全部调用方本就显式传参，删掉默认值零成本；顺带消掉「忘了传路径就静默落到真实库」这个隐患。**扫包的 `~/` import 时，别忘了扫默认参数与类型默认值。**
10. **边界守卫用 allowlist，不要复制 token 的 denylist**。token 的检测器只拒 `@hsupu/ghc-proxy-{core,server,cli}` —— 随着 workspace 长出第 4、5 个包，它会**静默放行 sibling**（telemetry 引 token 不会红）。改成 allowlist：只许相对 / foundation / `node:` / package.json 已声明的 external，其余全拒。正样本对照里**必须**放一条 sibling 包（`@hsupu/ghc-proxy-token`）和一条未声明 external（单 lockfile hoist 会让未声明依赖照样 resolve，只有 manifest 断言能抓）。ESLint 侧镜像见 [[tooling-eslint-no-restricted-imports-group-is-or-not-allowlist]]。
11. **抽包后前端经 `~backend` 消费的后端类型会断**。做法：包出**纯类型 barrel**（`src/types.ts`，模块图零 value import → 即使打包器没消除 type-only import 也够不到后端运行时），前端改 import 包名子路径，`ui-v4/vite.config.ts` + `ui-v4/tsconfig.json` **两处**都要加别名。权威门是 `typecheck:ui-v4` + `build:ui-v4` 双跑（[[feedback-verify-ui-with-build-not-just-typecheck]]）。**顺带**：ui-v4 的 tsconfig 不继承根 tsconfig 的 `paths`，前几次抽包已把它的 typecheck 弄红（缺 foundation/token 别名 + 后端 ambient `.d.ts` 不在其 program 内）却没人发现——抽包时顺手核一下这个门是不是本来就红的。
12. **split-commit 陷阱会再踩一次**（HANDOFF §踩坑 1 已记，仍然踩了）。`git status --short` 对 rename 打印的是 `旧 -> 新`，拿它 `awk '{print $NF}'` 生成 pathspec 就只有新路径，**删除侧漏提** → 半坏 commit。修法照旧：删除侧本就已 staged，直接 `git commit --amend --no-edit`（**不带 pathspec**，让它吃整个 index；提交前确认 index 里没有别人的东西）。
13. **过渡 alias 这次没留**（token 那轮留了）。消费者面只有 9 生产 + ~20 测试文件，一步迁到包名比留双轨更符合本项目「无向后兼容负担」。**判据**：消费者面小到能一次迁完就别留 alias；tsconfig 里只留包名解析的 `paths`（那是包解析，不是双轨）。
