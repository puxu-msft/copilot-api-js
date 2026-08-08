# NGHTTP2_CANCEL 系列交接

> **状态：已评审·交接定稿**
>
> **核验基线：** 2026-08-06T20:56:17Z 首次读取本地 `master` 为 `fa2bfd2d902af444517b2fed1a44428c8bb47367`；成稿前刷新为 `17a7f612ba2cfda5c4c212555643b8626eb101d0`，提交时间 2026-08-06T20:56:03+00:00。复现：`git -C /home/xp/src/copilot-api-js rev-parse refs/heads/master` 与 `git -C /home/xp/src/copilot-api-js show -s --format=%cI refs/heads/master`。`c23ed804`、`fa2bfd2d`、`17a7f612` 均在当前 `master` ancestry；Supporting evidence 的代码评审与运行探针锚定 `fa2bfd2d`，`fa2bfd2d..17a7f612` 是否改变其事实结论未在本任务中重新调查，标为 unresolved，接手第一步必须核对。
>
> **分支与 worktree：** `fa2bfd2d` 核账时，成果分支 `nghttp2-history-fixes` 位于 `/home/xp/src/copilot-api-js/.worktree/nghttp2-history-fixes`，tip `50941d32fad621395f66d54b35ee837bbbd93598`；承接分支 `nghttp2-resume` 位于 `/home/xp/src/copilot-api-js/.worktree/nghttp2-resume`，tip `c23ed8044e47b3313f74d4fd8d7e4627e0352567`；二者均为当时 `master` 的祖先且相对 `master` 无增量。复现：`git merge-base --is-ancestor <tip> master` 与 `git diff --quiet master...<branch>`。初稿由 `0840b929b0d0494b64c2a9ec532d0e859b159d14` 提交；`/home/xp/src/copilot-api-js/.worktree/agent-adfcf471909fc141b` 及其基线只属于历史写作 provenance，不代表接手现场。接手时必须刷新分支 tip、差异与运行状态，不得把本文历史基线当 current master。
>
> **未提交 WIP：** 只作指针，不在本文复制易腐清单。接手时分别运行 `git -C /home/xp/src/copilot-api-js status --short`、`git -C /home/xp/src/copilot-api-js/.worktree/nghttp2-resume status --short`，按路径与 hunk 确认归属；不得覆盖、还原、stage 或提交 peer WIP。2026-08-06 运行实例自报 `gitDirty=true`，故运行字节不能等同于 commit tree；当前脏文件明细为 TBD，必须由接手者现场重取。

**阅读顺序：** 第一入口是仓库内本文件及同目录 `KICKOFF.md`；再读计划的“实施状态”、A4 与 Phase B（`../2026-08-06-history-read-path-and-h2-diagnostics.md`），随后按问题读取 `../../DESIGN.md` 的 transport／History 活架构、`../../history.md` 的 History 契约、`../../API.md` 的 `/api/status` 与 History REST 契约。计划是阶段契约 SSOT，本文只交接状态、证据、冲突与开工顺序。

**系列承接链：** `4f1f3be9-79eb-4cf1-8185-4ebc1bfd5c79` 完成故障分型并启动 A1/A2，因 context overflow 交给 `2a1071f7-25a6-4c5e-8675-c7ffde1138ff`；后者完成 A2 到 `50941d32`，因 context overflow 交给 `174f2b81-cab9-4415-a3b3-ef61f8033c2a`；后者整合分支并实现 A3 大部，因 context overflow 交给 `2684f077-d2ec-4112-9456-3371f8cb7f9d`；最后一会话提交并合入 A3、收到 `fa2bfd2d` 评审结论，并回到尚未实施的 CANCEL transport 主线。会话数量为 4，口径是 job 名或 transcript title 命中完整系列名；复现命令与排除项见 Supporting evidence 的 `session-inventory.md`。

**系列会话坐标：**

| 顺序 | Session | Transcript | Job | Tasks | 实际工作树 |
|---|---|---|---|---|---|
| 1 | `4f1f3be9-79eb-4cf1-8185-4ebc1bfd5c79` | `/home/xp/.claude/projects/-home-xp-src-copilot-api-js/4f1f3be9-79eb-4cf1-8185-4ebc1bfd5c79.jsonl` | `/home/xp/.claude/jobs/4f1f3be9/state.json` | `/home/xp/.claude/tasks/4f1f3be9-79eb-4cf1-8185-4ebc1bfd5c79/` | `/home/xp/src/copilot-api-js/.worktree/nghttp2-history-fixes` |
| 2 | `2a1071f7-25a6-4c5e-8675-c7ffde1138ff` | `/home/xp/.claude/projects/-home-xp-src-copilot-api-js--worktrees-anchor-alloc/2a1071f7-25a6-4c5e-8675-c7ffde1138ff.jsonl` | `/home/xp/.claude/jobs/2a1071f7/state.json` | `/home/xp/.claude/tasks/2a1071f7-25a6-4c5e-8675-c7ffde1138ff/` | `/home/xp/src/copilot-api-js/.worktree/nghttp2-history-fixes` |
| 3 | `174f2b81-cab9-4415-a3b3-ef61f8033c2a` | `/home/xp/.claude/projects/-home-xp-src-copilot-api-js--worktrees-anchor-alloc/174f2b81-cab9-4415-a3b3-ef61f8033c2a.jsonl` | `/home/xp/.claude/jobs/174f2b81/state.json` | `/home/xp/.claude/tasks/174f2b81-cab9-4415-a3b3-ef61f8033c2a/` | `/home/xp/src/copilot-api-js/.worktree/nghttp2-resume` |
| 4（当前协调） | `2684f077-d2ec-4112-9456-3371f8cb7f9d` | `/home/xp/.claude/projects/-home-xp-src-copilot-api-js--worktrees-anchor-alloc/2684f077-d2ec-4112-9456-3371f8cb7f9d.jsonl` | `/home/xp/.claude/jobs/2684f077/state.json` | `/home/xp/.claude/tasks/2684f077-d2ec-4112-9456-3371f8cb7f9d/` | 实现在 `/home/xp/src/copilot-api-js/.worktree/nghttp2-resume`，协调 origin 为 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc` |

**Agent dispatch packet：** 新会话主会话拥有编排权。每次分派 agent 时必须逐项填写：任务边界；相关 session IDs；transcript／job／tasks 绝对路径；repo 与目标 worktree；base commit 与 target commit 的 full SHA；必读 Supporting evidence；已有结论及“禁止重查”的范围；允许写入的精确路径；期望验收输出、正控、证伪和报告落盘路径。缺字段必须写 `TBD`，不得让 agent 自猜路径、状态或调查范围。对当前任务，默认禁止重复考古四个会话、重复核账 A1–A3 已落 commits、或把 A4 当作旁支未合并；只有刷新 `17a7f612` 相对 `fa2bfd2d` 的增量与执行未闭合任务属于新调查。

**Canonical 入口与证据集：** `0840b929b0d0494b64c2a9ec532d0e859b159d14` 锚定当时初稿目录中的 8 个文件：`HANDOVER.md`、`KICKOFF.md`、`session-inventory.md`、`completed-detour.md`、`mainline-evidence.md`、`handover-structure.md`、`review-core-a3.md`、`review-docs-layered-delivery.md`。冻结的 26 项 blob 清单由 `evidence-manifest.sha256` 持有；manifest 不列自身或后续 R10；双 R9 以其原始旧 manifest 声明作为不可改写历史内容进入新 manifest，不构成对新 manifest 的引用。首轮至 R9 是不可改写的历史发现链；R7 证明终态化前技术机制双绿，R8 factual 为 0 blocker／0 major，而 R8 successor 发现 manifest 缺口；R9 继续发现 FINAL 对象类型与全文机器字段缺口。最终收口由同一 `FINAL_COMMIT` 中、不进入 manifest 的 `review-factual-r10.md` 与 `review-successor-r10.md` 双绿证明。job tmp、job state、tasks 与 transcript 只保留为历史 provenance 或必要时深挖的恢复坐标，不是后继执行的必需入口或状态真相源。point-in-time review 保留原 commit／时间锚；后续处置另写 disposition，不改 Supporting evidence 或 review 覆写历史结论。

## 最终提交证据门

本交接的状态头描述文档定稿状态；**提交有效性以本门在调用方明确指定的 `FINAL_COMMIT` 上通过为准**。不得默认使用 `HEAD`，不得从 checkout 目录扫描或反推证据清单。R7 是终态化前技术机制双绿；R8 是终态状态审，其中 factual 为 0 blocker／0 major，successor 发现冻结 manifest 缺口；R9 发现 FINAL 对象类型门与全文机器字段门仍有缺口；首轮至 R9 均为不可改写的历史发现链。R10 只复核修订后的 manifest／gate，必须 factual 与 successor 双绿后才算最终收口。

R10 两份报告顶部必须各自包含以下机器字段，且 manifest hash 取自同一 `FINAL_COMMIT` 中的 manifest blob：

```text
- evidence-manifest-sha256: <64hex>
- verdict: 0 blocker / 0 major
```

调用方显式设置完整 40 位 commit 后，原样运行以下只读 gate：

```bash
set -euo pipefail
: "${FINAL_COMMIT:?set FINAL_COMMIT to the exact 40-hex final commit}"
MANIFEST_PATH='docs/plan/2026-08-06-nghttp2-cancel-series/evidence-manifest.sha256'
python3 - "$FINAL_COMMIT" "$MANIFEST_PATH" <<'PY_EVIDENCE_GATE'
import hashlib
import re
import subprocess
import sys

final_commit, manifest_path = sys.argv[1:]
if not re.fullmatch(r"[0-9a-f]{40}", final_commit):
    raise SystemExit("FINAL_COMMIT must be an explicit lowercase 40-hex commit")

def git_bytes(*args: str) -> bytes:
    try:
        return subprocess.check_output(["git", *args], stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", "replace").strip()
        raise SystemExit(f"git {' '.join(args)} failed: {detail}") from exc

def git_text(*args: str) -> str:
    return git_bytes(*args).decode("utf-8", "strict").strip()

# A 40-hex tree/blob/tag can still serve <object>:<path>; require the exact input object itself to be a commit before reading any evidence blob.
if git_text("cat-file", "-t", final_commit) != "commit":
    raise SystemExit("FINAL_COMMIT object type is not commit")
peeled_commit = git_text("rev-parse", f"{final_commit}^{{commit}}")
if peeled_commit != final_commit:
    raise SystemExit(f"FINAL_COMMIT does not resolve exactly to itself as a commit: {peeled_commit}")

expected_paths = (
    'docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/KICKOFF.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/session-inventory.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/completed-detour.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/mainline-evidence.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/handover-structure.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-core-a3.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-docs-layered-delivery.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-factual.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-successor.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-factual-r2.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-factual-r3.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-factual-r4.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-factual-r5.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-factual-r6.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-factual-r7.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-factual-r8.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-successor-r2.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-successor-r3.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-successor-r4.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-successor-r5.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-successor-r6.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-successor-r7.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-successor-r8.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-factual-r9.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-successor-r9.md',
)
expected_set = set(expected_paths)
if len(expected_paths) != 26 or len(expected_set) != 26:
    raise SystemExit("internal evidence path set is not exactly 26 unique literals")

def blob(path: str) -> bytes:
    try:
        return git_bytes("show", f"{final_commit}:{path}")
    except SystemExit as exc:
        raise SystemExit(f"missing evidence in FINAL_COMMIT: {path}") from exc

manifest_bytes = blob(manifest_path)
manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
try:
    manifest_lines = manifest_bytes.decode("utf-8").splitlines()
except UnicodeDecodeError as exc:
    raise SystemExit("evidence manifest is not UTF-8") from exc
if len(manifest_lines) != 26:
    raise SystemExit(f"manifest must contain exactly 26 lines, got {len(manifest_lines)}")
entries = {}
line_re = re.compile(r"^([0-9a-f]{64})  ([^\r\n]+)$")
for line in manifest_lines:
    match = line_re.fullmatch(line)
    if not match:
        raise SystemExit(f"invalid sha256sum manifest line: {line!r}")
    digest, path = match.groups()
    if path in entries:
        raise SystemExit(f"duplicate manifest path: {path}")
    entries[path] = digest
if set(entries) != expected_set:
    missing = sorted(expected_set - set(entries))
    extra = sorted(set(entries) - expected_set)
    raise SystemExit(f"manifest literal set mismatch; missing={missing}, extra={extra}")
for path in expected_paths:
    actual = hashlib.sha256(blob(path)).hexdigest()
    if actual != entries[path]:
        raise SystemExit(f"blob hash mismatch for {path}: manifest={entries[path]}, actual={actual}")

r10_paths = (
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-factual-r10.md',
    'docs/plan/2026-08-06-nghttp2-cancel-series/review-successor-r10.md',
)
manifest_prefix = "- evidence-manifest-sha256:"
manifest_field = re.compile(r"^- evidence-manifest-sha256: ([0-9a-f]{64})$")
verdict_prefix = "- verdict:"
verdict_field = "- verdict: 0 blocker / 0 major"
for path in r10_paths:
    try:
        report_text = blob(path).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SystemExit(f"R10 report is not UTF-8: {path}") from exc
    lines = report_text.splitlines()
    manifest_lines = [(index, line) for index, line in enumerate(lines) if line.startswith(manifest_prefix)]
    verdict_lines = [(index, line) for index, line in enumerate(lines) if line.startswith(verdict_prefix)]
    if len(manifest_lines) != 1:
        raise SystemExit(f"{path} must contain exactly one full-file manifest field")
    manifest_index, manifest_line = manifest_lines[0]
    manifest_match = manifest_field.fullmatch(manifest_line)
    if manifest_index >= 20 or manifest_match is None or manifest_match.group(1) != manifest_sha256:
        raise SystemExit(f"{path} manifest field must be exact, unique, and within the first 20 lines")
    if len(verdict_lines) != 1:
        raise SystemExit(f"{path} must contain exactly one full-file verdict field")
    verdict_index, verdict_line = verdict_lines[0]
    if verdict_index >= 20 or verdict_line != verdict_field:
        raise SystemExit(f"{path} verdict field must be exact, unique, and within the first 20 lines")
    findings = [line for line in lines if line.strip().lower().startswith(("[blocker]", "[major]"))]
    if findings:
        raise SystemExit(f"{path} contains blocker/major finding markers: {findings}")
print(f"FINAL_COMMIT={final_commit}")
print(f"evidence_manifest_sha256={manifest_sha256}")
print("evidence_paths=26")
print("r10_verdicts=2x(0 blocker / 0 major)")
PY_EVIDENCE_GATE
```


# A．偏离 CANCEL 主线但已完成的内容状态

## A.1 结论与边界

A1、A2、A3 的已实现部分均已落 `master@fa2bfd2d902af444517b2fed1a44428c8bb47367`，且该 commit 是成稿 `master@17a7f612ba2cfda5c4c212555643b8626eb101d0` 的祖先，但三者状态不能合并写成“终态完成”。A1 是受 ready marker 保护的长期兼容态，停服 002 收敛未实现；A2 代码已落，真实生产库副本验收未做；A3 主要功能与 live docs 已落，但 `fa2bfd2d` 独立评审仍为 **0 blocker／6 major**，不是终态。该计数证据是 `review-core-a3.md` 的增量复核；`c23ed804..fa2bfd2d` 只改 summary backfill/readiness，没有触及六条 finding 的核心文件。`fa2bfd2d..17a7f612` 的影响尚 unresolved，故不得把该计数无条件称为 current-HEAD verdict。

| 单元 | 当前状态 | `master` 可达证据 | 已解决 | 没有证明／仍未完成 |
|---|---|---|---|---|
| A0 调查与计划 | 已落 | `b6fb0947686ea6620bfafb63a4fd151d18599483`；验收 `git merge-base --is-ancestor b6fb0947 master` | 把 History 本地放大器与 CANCEL transport 根因拆为不同阶段 | 计划本身没有实施 transport 修复 |
| A1 summary projection | 已落兼容态，非最终单源态 | `92fcc611`、`a8a9475c`，以及 current master 后续 `77cc765f`、`fa2bfd2d`；验收逐个运行 ancestry 命令 | 建立窄型 `v3_operation_summaries`、兼容 triggers、bounded/keyset backfill、ready/pending/poisoned 可见性 | 停服 002 maintenance command、跨进程 writer 门、旧列删除、真实生产库副本 dry-run 未做 |
| A2 SQL 读路径 | 代码已落 | `8afd3c26..50941d32`，整合 commit `2d4f400d`，live-doc cutover `0a84bbb3` | status 专用 count、双向 keyset list、sessions/stats SQL 聚合、窄 hydrate、filter/cursor 与 durability 对齐 | 自动 guard 的对象是 512 行×每行 256 KiB、约 128 MiB manifest；只证明读路径与该测试 BLOB 体积解耦，不证明约 6.3 万行生产副本的 wall time、WAL、缓存或 HTTP max-gap。数字锚定 `70b7f1c0`，测试常量见 `completed-detour.md` |
| A3 strict persisted list-search | 主要功能与文档已落，但评审未闭合 | 实现 `08046d5c`，文档 `c23ed804`；验收 `git merge-base --is-ancestor c23ed804 master` | entries list 的 `search=` 改走 strict Tantivy `list-search`，不完整时 503；原 `/history/api/search` partial 契约不变 | `fa2bfd2d` 独立评审仍有 6 major；native suite 是否在 current HEAD 实际非 skip、真实生产库副本、`test:ci` PTY/E2E 与独立 verifier 均未闭合 |

计划记录的 `108 pass / 1 skip / 0 fail` 锚定 `2d4f400d50d1061810db284b44bdbf62203dfff7`，命令口径是计划内 A1/A2 目标套件；A3 计划另记录 backend、UI、typecheck、build、lint 与 mutation 通过，但本交接未复跑。它们只能作为二手执行记录，不能冒充 current-HEAD 验收。

## A.2 A3 在 `fa2bfd2d` 的六条 major

以下六条均以 `master@fa2bfd2d902af444517b2fed1a44428c8bb47367` 为对象提出；准确 file:line、反例与建议见 `review-core-a3.md`（该报告是时点记录，不随修复改写）。**六条现已全部处置**，逐条落点如下——其中第 4 条仍在分支上、尚未合并，合并前不得把它算作 master 状态。

1. 已持久化 recent terminal 可绕过 strict sidecar ID 集合，导致错误 index 仍 false-green，且 entries 与 total 可不一致。**已闭合**：归属与目标在单一冻结原语 `freezeHistorySearchTarget` 里一次性确定（`src/lib/history/queries.ts:46`、`:380`）。
2. sidecar await 前后重分类读取不同快照，可能得到 `entries.length=1,total=0`。**已闭合**：同上，await 两侧不再各自取快照。
3. `state` 覆盖 `success`，违反 frozen spec 的 AND 语义，现有测试还把错误行为固化为正样本。**已闭合**：`lifecycleStatesForQuery` 成为唯一判定源，冲突谓词返回空集而非放宽（`src/lib/history/lifecycle-state.ts`）。
4. native `list-search` 物化全部全文命中后再过滤排序，复杂度随全库线性增长，与计划的 fast-field keyset＋`limit+1` 不符。**已实现，待合并**（分支 `nghttp2-cancel-a3-next`）：改为按 term ordinal 在列式 fast field 上过滤 + 每段一次批量解析 id；精确 `total`、tuple 顺序、keyset 四项语义均未变（遍历全部命中仍是精确计数的前提，被消除的是评分堆与 stored-doc 物化）。实测与「它没有证明什么」见 `exp/history-search-list-perf/README.md`，条目收口在 `docs/todo/deferred-backlog.md`。
5. list query 参数缺少枚举、有限数与范围校验，错误输入可变成 500/503 或放大资源消耗，而不是统一 400。**已闭合**：`rejectsInvalidListQuery`（`src/routes/history/handler.ts`），按用户 2026-08-08 裁决**只作用于 `/api/entries`**，`/api/search` 保持既有宽松降级契约。
6. durable cursor 未绑定 Tantivy index generation；旧 cursor 配空／重建 index 可被认证为完整。**已闭合**：cursor 记录 `indexOpstamp`，与 `HistoryIndex.generation()` 比对，不匹配即弃用重新 tail（`src/lib/history/search/daemon.ts`）。

A3 尾项作为独立工作单元处置，未混写成 CANCEL transport 进展。**未闭合的验收项**：六条各自带目标回归与 mutation 对照，但**尚未做过一次覆盖全部六条最终合并态的独立复评**（`0 blocker／0 major` 那道门）；第 4 条另有一处**实测证明当前不可达、因而无测试覆盖**的 `alive_bitset` 分支，保留理由写在代码与用例注释里。证伪：任一原反例仍可复现，或测试在注入对应缺陷后仍绿。

## A.3 文档／流程整改与后续 gate

`review-docs-layered-delivery.md` 的 findings 尚未形成修改后复评结论。后续必须纳入以下 gate：

- 活 spec `docs/spec/2026-07-28-history-filter-semantics.md` 要把旧“persisted 空结果＋降级标记”明确标为已被 A3 取代的历史过渡裁决，并给 strict list-search 当前规范明确入口；不能只在末句补一句现状。
- 分层迭代 memory 的每个后续项必须写依赖与事件型复议触发点；父项目关闭前机械枚举未完成后续项，由用户或未卷入方明确继续排期／重新裁决。没有裁决，不得把父项标完成。
- 已决定下沉 skill 的后续项必须进入正式 todo，写目标现有 planning／session-closeout skill 接缝、触发词、验收、独立评审门，并从 memory 或状态载体可达；不得只留孤立 memory，也不得新造平行流程。是否已经决定下沉 skill 的原始裁决为 unresolved，接手者须回一手来源；若没有该决定，应撤回“skill 待办已存在”的状态命题。
- 同轮修复归档断链、`queries.ts` 的未来时注释、`MEMORY.md` 截断行；修改后复验相对链接、旧 imperative／`does not yet` 搜索、`wc -c docs/memory/MEMORY.md` 的项目字节门，并交独立复评。

该文档整改的验收：上述载体形成可达链，旧／新契约不再同层并列，复评逐条关闭原 3 major＋3 minor。证伪：新会话只读活 spec 仍会恢复退役行为、后续项可无限留在 todo 而父项仍被标完成、或 skill 待办无正式载体。正控：放入一个依赖尚未满足的合法后续项，确认 gate 允许父项目保持未完成并能在已记录触发事件到达时被重新枚举，而不是误判为必须立刻实施。

## A.4 A 段未闭合待办

- **A1 最终 002 收敛。** 前置：用户明确授权真实维护窗口、迁移与备份操作；当前交接不授权。验收：按计划完成 owner generation、独占 writer、readiness、旧列删除、回滚中点与六臂兼容验证。证伪：旧 binary 可在新 owner 上半可用启动、任何中点失败不能完整回滚、或 canonical／summary 键集合不一致。正控：兼容态下真实 pre-002 fixture 的 insert／repair／pin／delete 仍正确，证明 gate 没把合法旧 writer 误拒。当前状态：未实现。
- **真实生产库副本验收。** 只用临时副本和非 4141 隔离实例；验收对象、命令、commit、配置、wall time、WAL／磁盘峰值与 event-loop max-gap 全部落 `exp/`，并写“它没有证明什么”。证伪：窄读仍触碰 canonical manifest、默认页产生不应有的 temp B-tree、或生产规模下 max-gap 仍随 BLOB 体积放大。正控：显式运行 canonical manifest 全扫反样本，确认探针能观测到明显更差的读取量／max-gap。当前状态：TBD，尚无实验 artifact。
- **A3 review／verifier／CI 收口。** 验收与双控见 A.2；另须先 `bun run build:history-search`，再证明 native suites 实际执行而非 skip，并跑计划要求的 `bun run test:ci`。证伪：current-HEAD 六条 major 任一仍成立，或 native binary 缺失却把 skip 当绿。正控：暂时注入一条已知 native filter／freshness 缺陷，确认目标 suite 精确转红且失败来自目标机制。

# B．回归 NGHTTP2_CANCEL 主线

## B.1 已知事实与边界

1. **传输层核心修复没有实施，不是“已实现但未合并”。** `nghttp2-history-fixes`、`nghttp2-resume`、`h2-observability-block-delivery-docs` 三个相关 branch tip 均为 `master@fa2bfd2d` 祖先且相对 master 无增量；自计划提交后，`master` 的 transport／transport-reason／transport tests 无 A4 相关提交。复现命令与搜索范围见 `mainline-evidence.md` §8 与 `completed-detour.md` 的实际核账命令。
2. **冻结调查窗口确有 23 条 `NGHTTP2_CANCEL`。** population 是 `2026-08-05T03:28:10.512Z..2026-08-06T03:28:10.512Z` 的 3038 个 GPT 请求，其中 57 失败、23 条为该错误；该数字来自 `b6fb0947` 计划记录，本交接未重算。当前 strict History search 返回 503，因此不能把旧数字写成当前运行率。
3. **现有 transport 已有 TCP keepalive、15 秒 H2 PING、N=1 容量池及 REFUSED／pre-response retry，但它们没有消灭全部 CANCEL。** 运行 PID `3575452` 的 `/api/status` 与 `ss` 在 2026-08-06 探测到 `tcpKeepaliveProbeDelayMs=15000`、`h2PingIntervalMs=15000` 与内核 keepalive timer；新鲜样本 `req_1786048981227_99` 在约 162.6 秒、6031 个 upstream SSE events 后仍报 CANCEL，最后 token 到终止约 121ms。该样本锚定运行指纹 `gitSha=fa2bfd2d`、`gitDirty=true`；只回答“现有机制未消灭全部 CANCEL”，不回答发起方或根因。复跑查询与字段见 `mainline-evidence.md` §8。
4. **两条旧一代 CANCEL 只保留为不可独立复跑的历史线索。** 既有记录称它们分别有 3509／5013 events，末 token 到终止约 107.9／114.2 秒，但 Supporting evidence 没有保存稳定 entry/request ID，无法把通用查询模板绑定到具体对象。因此这些数字不是可复跑证据，不能独立承担“两型存在”的结论，也不得从时间相关性推导 peer RST、session lifecycle、event-loop stall 或其他根因。
5. **4141 仍有间歇性长 stall／排队，但 HTTP 延迟不能单独归因。** 同一 PID 的 `/health` 曾约 1.94～1.98ms，收尾复验一次为 8.691s；`/api/status` 曾约 0.340～0.741s，也曾在 10s 内零字节超时后恢复。population 是该报告记录的点探针，不是持续基准；它证明间歇性失活存在，不证明是 History、event-loop 或 upstream I/O。
6. **当前诊断不能区分 peer CANCEL 与 local abort。** 本地 pre-response abort、post-response signal abort 与 ReadableStream cancel 都会 `req.close(NGHTTP2_CANCEL)`；session 无稳定 ID，GOAWAY 丢 code／lastStreamID／opaqueData，PING ACK 是 NOOP，stream 诊断未按 explicit dispatch 持久化。源码锚点与 final file:line 见 `mainline-evidence.md` §4、§8。

## B.2 并行只读证据工作：被动查找新的可复跑 CANCEL 样本

该工作由 KICKOFF 的只读 evidence agent 执行，可与 A4 实现并行；没有自然产生的新 CANCEL **不阻断 A4**。agent 只被动读取 4141 History，不主动制造 4141 流量，不修改、停止或重启 4141。发现样本时，报告稳定 History entry ID、request ID、observedAt、请求开始与终止时间、请求／解析模型、attempt 序号、终止形态、运行 PID 与代码指纹、读取字段路径，以及可直接重复执行的完整查询命令。若 History 搜索端点不可用，可用只读列表／详情端点定位，但最终命令必须含具体 ID，不能保留 `<id>` 占位符；没有新样本时如实报告 `none observed`，不视为 agent 失败。

新自然样本是 Phase B 因果裁决前置，不是确定性 A4 h2c 双控的前置。进入 Phase B 前，另一执行者必须能仅凭报告的命令与 ID 重读同一 entry／attempt；只有 PID、时间窗口、事件数或通用模板均不满足。任何自然样本的时序都不能直接写成根因。

## B.3 已排除与仍未决线索

**已排除的全称解释：** 不是所有 CANCEL 都由 TCP keepalive 未生效、单 session 多流 blast radius 或全程零帧静默造成；REFUSED 未重试也不是当前缺口。证据分别是内核 timer、新鲜 N=1 形态下 CANCEL、6031-event 样本与当前 retry 分类。这里排除的是全称，不是排除这些机制对部分样本有贡献。

**仍未决：** peer 主动 RST_STREAM CANCEL、session GOAWAY／close 连带影响、本地 abort 与 peer CANCEL 混淆、GHC 单流／服务生命周期上限、flow-control 或 DATA stall、主线程 starvation 延迟 PING／ACK／stream callback、fresh 与 pooled session 差异、buffered／continuation 在不同 commit 阶段的可恢复性。它们都是假设，不得并成单一根因。

PING ACK 即便正常，也只证明对端 HTTP/2 connection endpoint 回帧；不能证明 DATA stream 可写、flow-control 未耗尽、上游应用健康或随后不会 GOAWAY／RST。当前 ACK callback 被丢弃，所以连这一有限结论也还没有 per-session 时序证据。

## B.4 硬 gate 与环境禁区

- **绝不 kill、停止或重启用户的 4141 主服务器。** 不用 `kill`／`pkill`／`killall`，不做任何会终止它的操作。测试服务器只用非 4141 端口，并只按 PID 清理自己启动的实例。
- **先证明运行代码身份。** 接手时记录 listener PID、`/proc/<pid>/{cmdline,cwd,cgroup}`、启动时间、进程持有配置、History detail 的 `process.gitSha/gitDirty` 或等价 build 指纹。配置文件、`is-active`、branch tip 与文档声明不能替代运行态身份。若 `gitDirty=true`，只能写“从该 HEAD 的脏树启动”，不能断言运行字节等于 commit tree。
- **A4 未按 explicit dispatch 区分 stream/session/local-abort 并持久化前，不进入 Phase B。** 不先调 PING cadence，不加 generic `NGHTTP2_CANCEL` retry。
- **真实迁移、主库写入、备份覆盖与维护窗口需用户逐项授权。** 性能、迁移与协议实验只用临时副本／非 4141 隔离实例。
- **每个 correctness gate 同时做正确样本与目标缺陷 mutation。** 绿色结果若未证明命中目标路径，不得作为完成证据。

## B.5 下一步：先 A4，再 Phase B

### B.5.1 现场复验与并行证据工作

先执行 B.4 的 Git／WIP／运行身份 gate。身份与归属闭合后，A4 可直接依靠正式计划的确定性 h2c 双控开工；不要求先出现自然 CANCEL。B.2 的只读 evidence agent 与 A4 并行运行；没有新样本只记 `none observed`。只有 Phase B 因果裁决仍要求至少一条带稳定 ID 与完整只读命令的新自然 CANCEL。

### B.5.2 A4 canonical diagnostics

**目标：** 让最终持久 History 能按 explicit dispatch 区分 stream／session／local-abort，并保留裁决 CANCEL 所需的 canonical 诊断。**当前缺口：** A4 尚未实施，现有 History 无法回答取消发起方或 session 关联。实现范围、schema、ownership、quiescence 与完整双控只以正式计划 [A4. H2 canonical transport diagnostics](../2026-08-06-history-read-path-and-h2-diagnostics.md#A4-H2-canonical-transport-diagnostics) 为准；本文不维护步骤级实现副本。

验收边界：最终持久 record 是 oracle；peer CANCEL 与 local abort 可机械区分；session 事件不误归 sibling；诊断不改变 transport 行为；目标缺陷 mutation 转红、正确样本保持绿；独立 reviewer／verifier 与 merged-state review 在同一最终 commit 上闭合。HTTP/2 注入按 Node 官方语义：对端 `stream.close(NGHTTP2_CANCEL)` 发送 peer `RST_STREAM(CANCEL)`，本地 `req.close(NGHTTP2_CANCEL)` 注入 local abort，并核对两端 `rstCode`／事件序列；`stream.destroy(error)` 未预设 code 时属于 INTERNAL_ERROR／destruction 分支，不用于制造 peer CANCEL。

### B.5.3 Phase B 预注册缺口与启动门

Phase B 的分型、实验矩阵、执行顺序和裁决规则只以正式计划 [Phase B — NGHTTP2_CANCEL 根因实验与缓解裁决](../2026-08-06-history-read-path-and-h2-diagnostics.md#Phase-B--NGHTTP2_CANCEL-根因实验与缓解裁决) 为准。A4 合并态未闭合、没有新可复跑样本、或预注册缺口未关闭时，不启动用于因果裁决的实验，也不调整产品行为。

现有正式计划尚不足以防止看见结果后改变统计口径。每轮实验 artifact carrier 固定为 `docs/plan/2026-08-06-nghttp2-cancel-series/phase-b/<ROUND_ID>/`，其中 `preregistration.md` 是冻结预注册、`data-manifest.json` 绑定该轮原始数据位置与 digest、`results.md` 保存按预注册方法得到的结果；完整实验契约仍只在正式计划。首次实验前，冻结计划或用户裁决必须补齐并落盘：每个 cell 的目标有效样本量与最大尝试量；主／次指标及分母；CANCEL 分类规则；fresh／pooled 与开关矩阵；置信区间或比较方法；排除规则；超时预算；提前停止／继续／升级触发条件。数值不得由交接文档发明；无人裁决的值保持 TBD，任一 TBD 存在即不得采集裁决数据。正式计划已有的字段只引用，不在预注册或本文重述。

验收边界：预注册 artifact 早于数据采集并锚定 full commit、配置、运行身份和冻结时间；独立 verifier 不看结果即可判断纳入、分母、分类、比较和停止／升级；结果出现后任何口径修改都开启新一轮预注册，旧结果降为探索性证据。任一字段事后修改、失败尝试被静默排除、secondary metric 替换 primary、正控不咬或负控制造差异，均使该轮因果结论无效。

## B.6 unresolved 与 TBD

- **unresolved：** A3 frozen filter spec 与当前实现的 `state`／`success` 语义冲突应以哪份已接受裁决为准。reviewer 指向 spec 的 AND 语义，代码与测试采用 precedence；接手者必须回 ADR／frozen spec／用户原话裁决，不能自行改文档迁就代码。
- **unresolved：** “分层迭代原则必须下沉 skill”是否已有用户决定。只有 reviewer 证明载体缺失，尚无一手决策证据。
- **TBD：** 接手时的主树与相关 worktree 未提交 WIP 明细及归属；只允许用现场 `git status --short` 与 hunk 对账补。
- **TBD：** `fa2bfd2d..17a7f612` 是否改变 A3 六条 major；随后才补 current-HEAD disposition、实现 commit 与复评结果。
- **TBD：** A3 native suites 在 current HEAD 非 skip 的实跑证据、`test:ci` PTY/E2E、真实约 6.3 万行副本与隔离 HTTP max-gap。
- **TBD：** A4 实施 commit、canonical diagnostic 样本与独立验收；当前事实是未实施。
- **TBD：** Phase B 样本量、发生率、PING／TCP keepalive／starvation／session-age 对照结果；不得从冻结窗口或单个现场样本预填。
