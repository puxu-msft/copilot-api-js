# prompts — 未来会话实现提示词

> ✅ **v4 流水线重构已全部完成 — 本目录归档为历史实现记录，勿再据此启动实现**。P0→P3 全部收官（v4 成唯一上游路径、`driver-flags.ts` 与各 legacy handler 均已删）；其后 Stage A（response-pipeline registry 激活）已完成、Stage B（driver-owned-writeout）进行中。下列各 prompt 是当时的实现说明，**file:line / 路径 / 策略数等引用已大幅过时**（如 anthropic codec 已迁 `src/lib/codec/anthropic/` 子目录、Anthropic 策略 8→10 条、`driver-flags.ts` 已删）。**当前架构现状以 [docs/DESIGN.md](../../DESIGN.md) + [docs/v4/05-progress.md](../05-progress.md) 为准；下方「▶ 当前位置（2026-06-17）」是历史快照、已失效。**

每个文件是一个**可直接粘贴到新会话**的完整任务说明，驱动该阶段的实现。按顺序执行（P0→P1→P2→P3），每个阶段一个或多个会话。

| 提示词 | 阶段 | 前置 |
|---|---|---|
| [P0-foundation.md](./P0-foundation.md) | 地基：接口 + transport 提取 + observability 收敛 + effort strategy | 无 |
| [P1-rewrite-registry.md](./P1-rewrite-registry.md) | 改写 registry 化（字节等价） | P0 完成 |
| [P2-driver-and-codecs.md](./P2-driver-and-codecs.md) | driver + 逐格式迁移 | P1 完成 |
| [P3-unify.md](./P3-unify.md) | 透传统一 + 采集下沉 + 删旧 handler | P2 完成 |

> **▶ 当前位置（2026-06-17）**：**P2.5 全部 ✅**（Gemini 已切 driver，flag `gemini`=**ON**，全套件经 v4 绿）。**下一步 = P2.6（Anthropic 切 driver，最复杂）**，粘 `P2-driver-and-codecs.md` 继续。**勿粘 P3**——P2.6 未完成，P3 会跑错（详见 `05-progress.md` 顶部「当前位置」）。排程已重排：P3.2 的 driver-采样半提前到各格式迁移点（CC=P2.3-S、Responses=P2.4、Gemini=P2.5 复用 cc 采样），响应侧采样下沉统一在 P3.2b。

## 通用红线（每个会话都必须遵守）

直接复制进每个实现会话，或依赖项目 `CLAUDE.md`（已含这些）：

1. **中文对话**回答与思考。
2. **绝不**在未经同意下 `git checkout/restore <file>`、`reset --hard`、`clean -f`、`rm` 工作区文件（不可逆，原则1）。
3. `git add`/本地 `commit` 允许；`git push`/改写已推送历史/`gh pr` 需用户明确同意（原则2）。
4. **不自动启服务器**（`bun run dev`/`start`）、不 `kill`/`pkill` 本项目进程（原则3）。验证用 `bun run typecheck`、`bun run test:backend`、`eslint --fix`。
5. 范围歧义先问（`AskUserQuestion`），范围内彻底修真实问题（原则4/5）。
6. **修复后必做 subagent review**，并亲自复核 reviewer 关键结论（原则6）。flaky/时序测试连跑 10-25 次。
7. 测试隔离：DI/fetch-mock，**不用 `mock.module`**；mutate 全局 state 用 `autoRestoreState()`；fs I/O 用注入临时目录，**绝不碰真实 `$HOME`/`~/.claude`**。
8. 不删有意义的注释；命名反映职责；同模块导入用相对路径；不使用分号、三元行首、`printWidth` 160。
9. 不忽视既有错误（原则10）——遇到的所有 typecheck/test/import 错误都修。
10. 只改 `.ts`/`tsconfig`/`package.json`/`.yaml` 才需验证（原则12）。

## 通用必读（每个会话开场先读）

```
docs/v4/README.md            # 全局导航
docs/v4/00-decisions.md      # 为什么这样设计（D1-D9）
docs/v4/01-architecture.md   # 目标架构
docs/v4/02-current-state.md  # 现状盘点（实现前复核 file:line，代码会漂移）
docs/v4/03-spec/             # 该阶段相关规格
docs/v4/04-migration-plan.md # 该阶段的 commit 序列 + invariant
docs/v4/05-progress.md       # 更新进度
```
