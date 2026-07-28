# Kick-off：文档陈旧性清扫 —— 续做待裁决项

> 复制本文件全文作为新会话首条消息。配套交接文档：[2026-07-27-doc-staleness-sweep-handover.md](2026-07-27-doc-staleness-sweep-handover.md)

---

你接手 `copilot-api-js` 的**文档陈旧性清扫**收尾工作。前序会话已完成主体（见交接文档 §1），余下 4 项待办，其中 2 项需要先向用户拍板。

## 先读（按序，别跳）

1. `docs/plan/2026-07-27-doc-staleness-sweep-handover.md` —— 交接文档全文（做了什么、待办、纪律）
2. skill `verifying-authoritative-claims`（触发症状明列 doc-vs-code mismatch）+ CLAUDE.md 的 `empirical-verification` —— 本次沉淀的核心方法学归属（原独立记忆已被 `578e0cc1` 判定已被 user-rule/skill 覆盖而删除）
3. `CLAUDE.md` 的「文档路由」与「工程纪律」两节

## 铁律（前序会话踩过坑，别重蹈）

- **改任何文档前先定向**：文档与代码不一致有三种相反方向 —— ① 文档陈旧（改文档）② 尚未实现（删文档行会掩盖缺口）③ 代码缺陷（改文档会把 bug 固化成规范）。用 `git log -S "<符号>" -- <path>` 看该符号最近是被 `+` 还是 `−`，**定向后才动手**。方向赌对 ≠ 验证过。
- **提交非自己创建的内容**：逐条核验其每个声明对照当前代码，「部分准确」绝不外推成「整体准确」。
- **归档 ≠ 删除**：加注解（陈旧原因 + 关键 commit/日期）→ 移入 `docs/archive/<批次>/` → **先 harvest 其中仍有效的发现**到活文档 → 修全部入站链接。
- **工作区常有他会话未提交改动**：一律显式 pathspec 提交（`git add -- <精确路径>`）；同文件混杂时用 `git apply --cached` 只提自己的 hunk；**绝不** `git add -A` / `git checkout` / `reset --hard` 工作区文件。
- **绝不杀 4141 端口的主服务器**（用户实时在用）。需要起服务器验证就用其他端口，按 PID 精确清理自己起的那个。

## 待办

### 立即可做（无分叉，直接推进）

**T2 — 拆 `packages/cli/src/start.ts`（781 行，职责混叠）**
纯结构性、行为保持。建议抽 `buildStartupSummary` / `initCoreServices` / `bootstrapExternalState` / `startHttpRuntime` 之类的 helper（具体切分按实际读代码后判断，别照搬这些名字）。
- 走行为保持式重构纪律：先确认相关测试绿 → 小步搬迁 → 每步 `bun run typecheck` + `bun run test:backend` → 不顺手修 bug、不顺手加功能。
- 可考虑派 `gpt-souls:refactorer`（该角色专治零行为变更的结构改造）。

### 需先问用户（真分叉，别自行决定）

**T3 — activity-detail outline-as-main：目标 UI 正在逐页迁移中**
`docs/spec/activity-detail-main-outline.md` + `docs/superpowers/plans/2026-06-15-activity-detail-outline-as-main.md` 的实现在分支 `feat/activity-detail-outline-as-main`，基于 Vue `ui/`。
**先纠正一个易犯的误判**：Vue `ui/` **没有退役**（`package.json:40,43` 仍有 `build:ui`/`dev:ui`），它是正被**逐页迁移**到 React `ui-v4/`；单一事实源是 `docs/vue-ui-retirement.md`（注意其顶部 2026-07-22 时效性警告：主服务器已不挂载任何前端 UI，两 workspace 由运维独立托管）。
- **先做**：读 `docs/vue-ui-retirement.md` 的逐页退役状态与排期，看 Activity Detail 页处于哪一档；再读 spec 判断其设计意图在 ui-v4 组件模型下是否仍成立。
- **再用 `AskUserQuestion` 摆选项**（附量化影响）：① 直接在 Vue `ui/` 落地（分支已实现、最省事，但投在正被迁走的 UI 上）；② 移植到 ui-v4（对齐迁移方向，plan 的 Vue SFC/composable 级步骤需重写）；③ 归档 spec+plan。**别不核实就照搬任何推荐。**

**T4 — `entries-v3-per-leg-storage` 疑似被 History V3 取代**
该 spec 自带 FTS-era 陈旧告警，但注解**早于** History V3 落地（`docs/rfc/2026-07-16-source-governed-history-v3.md` 已 LANDED，`src/lib/history/v3/` 是活路径）。
- **先做核实**（前序会话没做）：逐条比对该 spec 的设计意图 vs V3 实际实现，判断 V3 是否真覆盖其全部意图，还是有未被吸收的部分。
- 若确属 superseded → 加注解归档；若有未吸收的有价值意图 → 提炼进 `docs/todo/deferred-backlog.md` 再归档。**别只凭「V3 已落地」就归档。**

### 需设计（较大，建议走 spec-driven）

**T1 — per-request config 快照缺失（真实架构缺口）**
`src/server.ts:127-135` 仍每请求 `await applyConfigToState()`，handler 直读全局 `state`，并发请求可能读到变动中的配置（`configSnapshot`/`RequestConfigSnapshot` 全仓零命中；注意 `RuntimeConfig` 这个名字在 `packages/token/src/dependencies.ts:41` 有命中但**与本议题无关**，别误判为已实现）。
- 这是**真实缺陷**（非文档陈旧），出处 `docs/broken/260324-fixes.md` High-4。
- 规模够大 → 走 spec-driven：先 `docs/spec/` 写清「请求入口冻结配置快照、handler 只读快照」的契约与迁移路径（现有多少处直读 `state`？热重载语义如何保持？），派 subagent 对抗评审，再 `docs/plan/` 写 TDD 计划。
- 注意 CLAUDE.md 的**配置哲学独立**：配置不享「无向后兼容负担」，键重命名要留旧别名 + warn-continue，热重载绝不因配置杀进程。

## 验证工具

全仓 markdown 链接解析检查（归档/移动文档后必跑）。

⚠️ **这是 baseline-diff 工具，不是 pass/fail 门**：2026-07-27 实跑基线为 **`checked 1390, broken 117`**——那 117 条是仓库既有的历史断链（与你的改动无关）。用法是**改动前后各跑一次比对**：只要 broken 数不增加、且新增断链里没有你动过的路径，就算通过。（若你有余力顺手清理既有 117 条，那是独立的收益，但别把它当本次任务的门槛。）

```bash
python3 - <<'PY'
import os,re,glob
b=0;n=0
for f in glob.glob("docs/**/*.md",recursive=True)+glob.glob("src/**/*.ts",recursive=True):
    t=open(f,errors="ignore").read(); d=os.path.dirname(f)
    for m in re.finditer(r'\]\(([^)#]+\.md)',t):
        tgt=m.group(1)
        if tgt.startswith(("http","mailto:")): continue
        n+=1
        if not os.path.exists(os.path.normpath(os.path.join(d,tgt))):
            print("BROKEN",f,"->",tgt); b+=1
print(f"checked {n}, broken {b}")
PY
```

常规验证：`bun run typecheck`、`bun run test:backend`（交付前）、`bun run lint:all`。

## 收尾

按 skill `session-closeout` 五步：① subagent 独立核验 ② doc-sync + 跨文档 grep 验证 ③ 归档 plan（本 kickoff 与交接文档加实施状态注解）④ 提炼教训维护记忆库 ⑤ 细粒度阶段提交（conventional commits、显式 pathspec、不加模型署名）。
