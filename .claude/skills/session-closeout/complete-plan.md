# 归档 plan 头部实施状态注解 · 模板

本模板定义 `docs/plan/*.md` 归档 plan 的**头部实施状态注解**格式，是该注解的唯一格式源。所有归档 plan（plan-mode 自动存档 + 手工精选）落库后都应带此注解，让读者一眼分辨「已落地 / 待办 / 废弃 / 研究」，避免把已实施的 plan 误当 todo、或把废弃方案误当路线图。是 CLAUDE.md `session-closeout` 步骤 3「归档 plan」的产物约定之一。

## 放置位置

紧跟 H1 标题行之后、正文（`## Context` 等）之前，作为一个 `>` blockquote 块。标题仍保持文件首行（利于预览/TOC/首标题派生）。注解里所有相对路径以**被注解文件所在的 `docs/plan/`** 为基准（`../` = `docs/`，`../../` = 仓库根）。

## 字段骨架

四个字段，缺省用 `—`。`实施状态` 整体加粗（字段名+取值同在 `**…**` 内），使取值词成为可靠 grep 句柄——`grep -rl '实施状态：已完成' docs/plan/` 才能命中（字段名单独加粗会让 `**` 卡在名与值之间，grep 落空）。

```markdown
# <原 plan 标题>

> **实施状态：<已完成 | 部分完成 | 未实施 | 仅研究>**（一句限定）
> **落地**：<YYYY-MM · commit `hash`（best-effort 血缘锚，rebase/squash 后可能失效）| —>
> **现状锚点**：<可点击链接，优先带 heading anchor 或小节名、避免易漂移的行号——DESIGN「活的架构现状」对应小节 / archive RFC / 模块文档 / 生效 config 键 / 代码路径；跟内容走、不跟 hash 走，是读者复核入口>
> **备注**：<一句话——与原 plan 的实质差异、未做的部分、被谁取代、或收尾说明>

## Context
...
```

`落地` 的 commit hash 只是 best-effort 血缘线索、可能因 rebase/squash 失效；**可核实的稳定锚点放「现状锚点」**（DESIGN 小节 / config 键 / 代码路径 / archive RFC 跟内容走，不随 hash 蒸发）。

## 四档取值与填充示例

**已完成** —— plan 描述的能力已在代码里落地并可核实。

```markdown
> **实施状态：已完成**
> **落地**：2026-06 · commit `a1b2c3d`（best-effort，rebase/squash 后可能失效）
> **现状锚点**：[DESIGN「活的架构现状」流式上游 RST 行](../DESIGN.md#活的架构现状v4-迁移态) · [archive RFC](../archive/2606-landed-rfcs/streaming-upstream-rst-buffered-retry.md)
> **备注**：opt-in 默认关；Phase 3/4 buffer cap + escalation 已落地。
```

**部分完成** —— 核心落地、部分 phase/子项暂缓；备注必须点名未做的部分及去向。

```markdown
> **实施状态：部分完成**
> **落地**：2026-06 · commit `...`（Phase 1–2）
> **现状锚点**：[DESIGN 对应小节](../DESIGN.md)
> **备注**：Phase 3（遥测分布）暂缓，见原 plan §N / 记忆 [[...]]。
```

**未实施（superseded / rejected / reverted）** —— 方案未采纳、被别的实现取代、或曾落地后被整体移除；现状锚点指向「实际生效的东西」，备注说明为何、及（reverted 时）落地—移除区间。

```markdown
> **实施状态：未实施（superseded）**
> **落地**：—
> **现状锚点**：项目仍用 Prettier（见 CLAUDE.md 代码风格）
> **备注**：dprint 方案未采纳；格式化仍走 `eslint --fix` + Prettier。
```

```markdown
> **实施状态：未实施（reverted）**
> **落地**：曾于 2026-05 落地（commit `...`），后随 observability 重写移除（commit `...`）
> **现状锚点**：现由 [observability projections](../../src/lib/observability/projections/) 取代（原 `src/tui` 已删）
> **备注**：React-Ink TUI 曾短期落地，后被 event-bus + projections 架构整体取代。
```

**仅研究** —— 研究/调研型交付，本就无代码；现状锚点指向研究结论的落点。

```markdown
> **实施状态：仅研究（无代码交付）**
> **落地**：—
> **现状锚点**：结论落到 [request-telemetry.ts](../../src/lib/request-telemetry.ts) 的自建 registry
> **备注**：裁决＝扩展现有 telemetry、不引 OTel。
```

### 档位边界（防误判）

**部分完成 vs 未实施(superseded) 的判定优先级**：只要有**任一子项按本 plan 原形状**落地，即归「部分完成」；`superseded` 仅用于**整体**被别的实现取代、无任何子项按原形状存活。「plan 的 A 部分原样落地、B 部分被后续 RFC 用不同形状取代」→ 标「部分完成」，备注写明 B 的去向。

## 配套文件（`-review` / `-research` / `_prompt` / phase-prompt 目录）

对抗性审查报告、研究报告、kick-off prompt **不是独立 plan**，不套用四档实施状态；改用一行**类型注解**指回父 plan，避免被误当待办：

```markdown
> **类型**：<父 plan slug> 的对抗性审查报告 —— 非独立 plan，实施状态见父 plan [<父>.md](<父>.md)。
```

**目录型多-phase prompt 集**（如 `pre-response-abort_prompt/`，内含 `P1…Pn.md` + `README.md`）：注解写在目录的 `README.md`，指向对应父 plan / RFC 的实施状态即可，目录内各 `Pn.md` 无需逐个注解。

## 判定纪律（empirical-verification）

「已完成/未实施」是**事实性主张**，必须靠证据判定、绝不凭标题猜：交叉核对 DESIGN.md「活的架构现状」状态表、`docs/archive/2606-landed-rfcs/`、`git log -S '<特性符号>'`、生效的 config 键（bundled `config.yaml` / `state.ts`）。证据写进「现状锚点」供读者复核。存疑而非确证时，宁可标「部分完成」并在备注写明不确定点，不谎报「已完成」。

**否定性核验**：标「未实施」前，先用一个**已知应命中的正样本**证明你的 `git log -S`/`grep` 确实触达了目标（符号名拼错会让 grep 空→误判「未实施」；空≠不存在，见 CLAUDE.md `empirical-verification`）。
