# KICKOFF：把「比解析后目标、别比拼写」搬到剩下两个架构守卫

## 一句话

`telemetry-domain-surface` 与 `generation-engine-boundaries` 仍按 **specifier 拼写**判边界，而不是**解析后的目标**。工具已经现成，把这一课搬完。

## 背景：为什么这是一个独立任务

state→foundation 那轮（landed `9ec79010`）在**三个**消费者上修掉了同一个形状，但仓库里还剩两个没搬到。**教训只落地一部分消费者**本身就是那轮反复踩的坑——core→server ratchet 保留旧形状**又活了四轮**，就是因为修复落在了消费者里而不是共享处。

范围判断（用户 2026-07-29 拍板）：不塞进 state 分支，**合并后立刻单独起分支修**。理由是这两个守卫各有六条以上独立边界规则，改判据后每条都要重新确认并重新冻结，属独立改动。

## 两处缺陷（均已复现，不是推断）

### 1. `tests/architecture/telemetry-domain-surface.unit.test.ts`

deep-import 判据是 `specifier.startsWith("@hsupu/ghc-proxy-telemetry")`——**包名拼写**。

**复现**：把下面这行放进 `src/lib/telemetry-assembly.ts`：

```ts
import type { RequestTelemetrySnapshot } from "../../packages/telemetry/src/request-telemetry"
```

结果：`bun run typecheck` **0 error**，telemetry + package 两个守卫合计 **26 pass / 0 fail**。它绕过包名直接摸到包内部文件。

附带：该守卫的生产扫描只覆盖 `.ts/.tsx`，`.mts` deep import 同样全绿。

### 2. `tests/architecture/generation-engine-boundaries.unit.test.ts`

六条边界**全部是对源码文本跑正则**、逐条枚举路径拼写：

```ts
expect(source, file).not.toMatch(/from ["'](?:~\/lib\/pipeline\/generation|\.\.\/generation|~\/lib\/transport|\.\.\/\.\.\/transport)/)
```

且 `sourceFiles()` 只收 `.ts`。任何等价但未被枚举的拼法（多一段 `./`、相对深度不同、`.mts`）都能穿过去。

**当前没有已知的实际违规**——坏的是保证强度，不是今天的状态。

## 现成工具（都在 `tests/architecture/source-ast.ts`）

| 工具 | 用途 |
|---|---|
| `createSpecifierResolver(repoRoot)` | 用项目自己的 compilerOptions 解析 specifier，守卫与 tsc 不可能再分歧 |
| `allModuleSpecifiers(sourceFile)` | AST 枚举**全部** import 形态（含 `import()`、`import =`、inline import 类型节点、模板字面量实参） |
| `containedIn(root, target)` | canonical 化 + **按路径段**比较（两个坑都写在它的文档里） |
| `referencedFilePaths(sourceFile)` | triple-slash `/// <reference path>`——一条没有 specifier 的依赖边 |
| `mayContainDecoded(text, needle)` | 三档预过滤（原文命中 / 无反斜杠跳过 / 否则 lexer 比解码值） |

扫描面照抄 `package-boundaries` 的 `SOURCE_EXTENSIONS` 或 core ratchet 的 `SOURCE_GLOB`（`.ts,.tsx,.mts,.cts` + `.js` 家族），**两处都已有持久 oracle 可抄**。

## 做法

1. 两个守卫的判据改成：**AST 取 specifier → 解析 → 判断规范化目标是否落在目标目录内**。
2. 扫描面扩到全部可编译扩展名。
3. telemetry 那条还要把「只允许 `index.ts` / `types.ts`」表达成**解析后的目标文件**判断。
4. 改完逐条确认六条以上边界**仍然成立**（这是主要工作量，不是判据改写本身）；有变化的重新冻结并写明理由。

## 验收（每一条都不许省）

- **每条转换配一个 live oracle**：把判据 mutation 回拼写匹配后**必须变红**。上一轮的教训是「primitive 有测试 ≠ 守卫接了线」——删掉守卫里那行消费，76 个测试照样全绿。
- 扫描面本身也要 oracle：把扩展名列表改回 `.ts`-only 必须有测试变红。
- 上面两处复现样本，改完后必须**在 live guard 上变红**，且 typecheck 仍绿。
- `bun run typecheck` 绿；`bun scripts/parallel-test.ts unit it http` 全绿（**不要**用 `bun run test:backend`，本机缺 rust toolchain 会挂在无关的前置构建）。
- 改完派 subagent 复审，prompt 里显式写裁判轴（长远正确 + 完整，不是 ROI/YAGNI）。

## 纪律

- 一律显式 pathspec 提交（`git commit -F <msgfile> -- <精确路径>`）；主树有并发 peer 的十余个未提交文件，**`git add -A` 绝对禁止**。
- 绝不碰用户跑在 **4141 端口**的主服务器。
- 变异实验要**验证 mutation 真的写进去了**——静默没生效的 mutation 看起来和真咬得住的测试一模一样。

## 参考

- 判据形状的演化与「换轴 vs 补形态」：[docs/plan/2026-07-28-state-to-foundation/HANDOVER.md](../2026-07-28-state-to-foundation/HANDOVER.md)「判据形状的演化」
- backlog 条目（含完整复现记录）：[docs/todo/deferred-backlog.md](../../todo/deferred-backlog.md)「另外两个架构守卫仍按「specifier 拼写」…」
