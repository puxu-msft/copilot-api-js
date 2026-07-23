# 计划：TUI detail 视图统一模型重映射显示语义

> **实施状态（2026-07-23）：已完成并落地 master。** 提交 `ca9d471c`（modelRemapParts 原语）/ `0325d650`（log-line 重构）/ `83b23942`（detail 统一 + 测试）。typecheck 绿、`test:backend` 6189 pass、探针复核四场景通过。**范围内偏差**：完成日志行经实测确认本就正确（无需改动），实际改动收敛到 detail 视图 + 抽共享原语。**范围外未做**：footer/panel 只显示 resolved（已与用户确认）；detail 保持单色不置灰（渲染路径剥 ANSI，未重构）。

## Context（为什么做这个改动）

用户配置了模型重映射（`config.yaml`：`gpt-5.5: gpt-5.6-t`，客户端请求 `gpt-5.5`、实际路由到 `gpt-5.6-t`）。诉求：TUI 里显示 `format/model` 的地方，在发生重映射时应体现「源模型 → 目标模型」，而非只显示目标。

**实测确认的现状**（`FORCE_COLOR=1` 探针 + 代码追踪）：

- **完成日志行**（`formatLogLine` 的 compact `<format>/<model>` 形态）**已经正确**：对真实重映射渲染为 `anthropic/`+`gpt-5.5`（dim 置灰）` → ` `gpt-5.6-t`（magenta），并用 `isSameModelName` 抑制「同模型不同拼写」的噪声（如 `claude-opus-4-8` vs `claude-opus-4.8` 只显示后者）。运行期 `clientModel` 确由 [handler-v4.ts:324](src/routes/messages/handler-v4.ts#L324) + [codec.ts:399](src/lib/codec/anthropic/codec.ts#L399) 填充。→ **无需改动**，已被 [log-line.unit.test.ts:74](tests/observability/log-line.unit.test.ts#L74) 守护。
- **detail 视图**（[detail.ts:38](src/lib/tui/render/detail.ts#L38)）是真正的缺口：无条件渲染 `model: ${clientModel ?? "?"} → ${resolvedModel ?? "(resolving)"}`——对非重映射也堆 `源 → 目标`（噪声，如 `claude-opus-4-8 → claude-opus-4.8`），且 client 缺失时显示 `?`。与完成行的抑制语义不一致。

**用户决策**（AskUserQuestion）：分隔符保留箭头 `→`、源置灰；作用范围＝完成行 + detail 统一；detail 具体做法＝**仅统一语义**（detail 渲染路径 `sanitizeTerminalText` 会剥 ANSI、本就单色，不为置灰重构渲染路径）。footer/panel 只显示 resolved，**不在本次范围**。

## 目标

让 detail 视图的模型行与完成日志行**共享同一条「是否为真实重映射」的抑制判定**：仅真实重映射才显示 `源 → 目标`，否则只显示 resolved；去掉 `?` 占位噪声。detail 保持单色（不置灰）。

## 改动

### 1. 抽共享判定原语（SSOT）— `src/lib/models/resolver.ts`

在 `isSameModelName` 旁新增纯函数，集中「显示源否」的决策（当前该决策内联在 log-line，detail 加入后会变成两处副本）：

```ts
/** 决定模型显示是否体现重映射：仅当 clientModel 存在且与 resolved 是不同模型时返回 source。 */
export function modelRemapParts(clientModel: string | undefined, resolvedModel: string): { source?: string; target: string } {
  return clientModel && !isSameModelName(clientModel, resolvedModel) ? { source: clientModel, target: resolvedModel } : { target: resolvedModel }
}
```

### 2. log-line 改用共享原语（行为不变）— `src/lib/observability/projections/log-line.ts`

把第 199-201 行 `modelToken` 的内联判定替换为调用 `modelRemapParts(clientModel, model)`，着色逻辑（`pc.dim(source)` / `pc.magenta(target)`）不变。纯重构，由 log-line.unit.test.ts:74 守护等价。

### 3. detail 统一语义（本次核心）— `src/lib/tui/render/detail.ts`

改 [detail.ts:38](src/lib/tui/render/detail.ts#L38) 的 `model` 行，用 `modelRemapParts` 抑制非重映射的箭头、去掉 `?`：

```ts
const target = ctx.resolvedModel ?? "(resolving)"
const source = ctx.resolvedModel ? modelRemapParts(ctx.clientModel ?? undefined, ctx.resolvedModel).source : undefined
keyed("model", `model: ${source ? `${source} → ` : ""}${target}`)
```

结果：真实重映射 → `model: gpt-5.5 → gpt-5.6-t`；非重映射/仅拼写差异 → `model: claude-opus-4.8`；resolving 中 → `model: (resolving)`。保持单色。

### 4. 测试

- **detail**（`tests/tui/render/panel.unit.test.ts`）：新增两条——① 非重映射（client `claude-opus-4-8` + resolved `claude-opus-4.8`）断言 **不含** `→`、含 `claude-opus-4.8`；② client 缺失时只显示 resolved、无 `?`。既有 [panel.unit.test.ts:387](tests/tui/render/panel.unit.test.ts#L387)（sonnet→opus 真实重映射）仍应含两名与 `→`，不动。
- **helper**（`tests/models/` 就近，resolver 测试文件）：`modelRemapParts` 三例——真实重映射返回 source、同模型异拼写不返回 source、client undefined 不返回 source。
- log-line 无需新增（现有 compact-remap 测试已守护重构等价）。

## 不做（范围外，已与用户确认）

- footer（[footer.ts:66](src/lib/tui/render/footer.ts#L66)/130）、panel row（[panel.ts:196](src/lib/tui/render/panel.ts#L196)）只显示 resolved——不改。
- detail 不重构渲染路径去支持置灰（保持单色）。

## 验证

- `bun test tests/tui/render/panel.unit.test.ts tests/observability/log-line.unit.test.ts tests/models/` 全绿。
- 探针复核 detail：构造非重映射 `DetailView` 跑 `buildDetailLines`，确认输出无 `→`、无 `?`。
- `bun run typecheck` 绿。
- 收尾：`bun run test:backend`；细粒度提交（resolver 原语 / log-line 重构 / detail+测试 分语义单元，显式 pathspec）。
