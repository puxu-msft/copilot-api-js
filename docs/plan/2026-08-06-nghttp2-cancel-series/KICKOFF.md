# NGHTTP2_CANCEL 接手提示词

> **状态：已评审·交接定稿**

你是新会话主会话，拥有编排权并负责调度 agents；agents 是叶子执行单元。首先在调用方显式提供的 `FINAL_COMMIT` 上运行下列完整证据门；未提供、对象不是精确 commit、manifest 任一 blob 不匹配、R10 任一缺失／机器字段冲突／存在 blocker 或 major finding，均立即停止。通过后读仓库内 `docs/plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md` 的状态头、系列恢复坐标、A.2“A3 六条 major”、A.3“文档／流程整改”、B.2“并行只读证据工作”、B.4“硬 gate”、B.5.2“A4 canonical diagnostics”与 B.5.3“Phase B 预注册缺口”；再读 `docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md` 的实施状态、A4、Phase B。按需读取仓库内 Supporting evidence 与 `docs/{DESIGN.md,history.md,API.md}`，不要重新考古四个会话或重做已落 A1～A3 核账。

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
硬 gate：绝不停止、重启或 kill 4141；测试实例只能用非 4141 端口，并只按 PID 清理自己启动的进程。先验证运行进程代码身份，不能用配置文件、branch tip 或 `is-active` 代替 PID／进程持有配置／commit 或 build 指纹。先刷新 `master`、worktree、ancestry 与 WIP 归属，不碰 peer 改动。A4 canonical diagnostics 未按 explicit dispatch 区分 stream／session／local-abort 并落最终 History 前，不进入 Phase B，不调 PING cadence，不加 generic `NGHTTP2_CANCEL` retry。真实迁移、主库写入、备份覆盖和维护窗口未经用户逐项授权不得执行。关键 gate 必须有正确样本和目标缺陷 mutation。

第一步只运行以下只读 preflight；它不 kill／restart 4141、不修改真实数据，也不假定服务已重启：

```bash
set -euo pipefail
repo=/home/xp/src/copilot-api-js
printf 'repo=%s\n' "$(realpath "$repo")"
printf '%s\n' '=== git ==='
git -C "$repo" rev-parse --show-toplevel
git -C "$repo" rev-parse HEAD
git -C "$repo" branch --show-current
git -C "$repo" --no-optional-locks status --short --branch
git -C "$repo" worktree list --porcelain
git -C "$repo" log --oneline 0840b929b0d0494b64c2a9ec532d0e859b159d14..HEAD
printf '%s\n' '=== 4141 listener ==='
listener=$(ss -ltnp 'sport = :4141')
printf '%s\n' "$listener"
pid=$(printf '%s\n' "$listener" | rg -o 'pid=[0-9]+' | cut -d= -f2 | sort -u)
test -n "$pid"
test "$(printf '%s\n' "$pid" | wc -l)" -eq 1
printf 'pid=%s\n' "$pid"
printf 'cwd=%s\n' "$(readlink -f "/proc/$pid/cwd")"
printf 'exe=%s\n' "$(readlink -f "/proc/$pid/exe")"
printf '%s\n' '=== redacted held argv shape ==='
python3 - "$pid" <<'PYARGV'
import sys
from pathlib import Path

raw = Path(f"/proc/{sys.argv[1]}/cmdline").read_bytes()
argv = [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]
if not argv:
    raise SystemExit("argv unavailable")

# Only argv[0] basename is emitted. Every later token is reduced to a fixed shape; no option name, value, path, digest, or length is exposed.
print(f"argv[0].executable={Path(argv[0]).name}")
for index, value in enumerate(argv[1:], 1):
    if value.startswith("--"):
        shape = "<long-option-redacted>"
    elif value.startswith("-"):
        shape = "<short-option-redacted>"
    else:
        shape = "<positional-redacted>"
    print(f"argv[{index}]={shape}")
PYARGV
printf '%s\n' '=== held environment keys and safe identity values ==='
python3 - "$pid" <<'PYENV'
import re
import sys
from pathlib import Path

environ = Path(f"/proc/{sys.argv[1]}/environ").read_bytes().split(b"\0")
items = {}
for raw in environ:
    if not raw or b"=" not in raw:
        continue
    key, value = raw.split(b"=", 1)
    items[key.decode("utf-8", "replace")] = value

# Key names are safe provenance and show which values the process actually holds.
for key in sorted(items):
    print(f"key:{key}=present")

# Only these generic process-identity values are emitted verbatim; they are not credentials.
for key in ("PATH", "HOME", "PWD", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "NODE_ENV", "BUN_ENV"):
    if key in items:
        print(f"value:{key}={items[key].decode('utf-8', 'replace')}")

# Credential-like and proxy-auth values are never printed or individually digested.
sensitive = re.compile(r"TOKEN|SECRET|PASSWORD|PASSWD|AUTH|AUTHORIZATION|COOKIE|CREDENTIAL|API_KEY|PROXY", re.I)
for key in sorted(k for k in items if sensitive.search(k)):
    print(f"redacted:{key}=present")
PYENV
```

配置文件、branch tip、文档声明、`is-active` 或计划值都是声明值，不等于进程持有的运行态。任一 `/proc` 字段、listener PID、环境持有值或 Git 身份读不到时，把该字段标为 `unverified`，并停止用它支持结论；不得补猜、不得为取证重启服务。若 worktree／WIP 归属不明，也停止编辑。随后按仓库内 `HANDOVER.md` 的现场 gate 补运行 build／commit 指纹与目标 worktree ancestry。
当前初稿 commit 是 `0840b929b0d0494b64c2a9ec532d0e859b159d14`；先完成 HANDOVER B.4 的 Git／WIP／运行身份 gate，并核 `0840b929..现场 HEAD` 是否改变 A3／A4 命题。随后并行派发 B.2／B.5.1 的只读 evidence agent 与 B.5.2 的 A4 implementer：没有自然新样本不阻断 A4。只有 HANDOVER B.5.3 所述 Phase B 因果裁决要求新可复跑自然样本。A3 的 6 major 与文档／skill／todo gate 作为独立尾项关闭，不混写成 CANCEL transport 进展。

## Agent-driven 编排

主会话只负责调度、证据裁决、跨 agent 协调、精确提交与最终报告；调查、实现、独立验证与 review 均由对应 agents 执行。主会话不得亲自接管长时多语义 A4 实现或 Phase B 验证。

当前 Agent tool schema 只有 `isolation:"worktree"`，没有 `cwd`。因此每个 packet 都必须执行同一 agent 的两阶段握手：

1. 主会话先在派发前冻结本地目标 commit `BASE_FULL_SHA`，再调用 `Agent(isolation:"worktree")` 发送阶段 1 bootstrap。bootstrap prompt 不包含尚未生成的 WORKTREE／branch，只读并立即返回。隔离树起点受 `worktree.baseRef` 控制，默认可能是 fresh `origin/<default>`，不得假定它等于本地未推送的 `BASE_FULL_SHA`。
2. 主会话等待 Agent tool 登记或通知 worktree path；尚未拿到登记路径就暂停，不猜。随后独立核证：登记路径、agent 报告的 `pwd -P` 与 top-level 三者完全相同；branch 等于 tool 生成并由主会话登记的 branch；status 无 WIP；并在主仓库验证 `git merge-base --is-ancestor BOOTSTRAP_HEAD BASE_FULL_SHA` 为真，证明隔离树可安全 fast-forward 到目标。任一不符即停止，不让 agent 自己导出的实际值充当 expected 值。
3. 核证通过后，主会话必须用 `SendMessage` 恢复**同一 agent**，不得新建 Agent。阶段 2 消息显式传入独立冻结的 WORKTREE、EXPECTED_BRANCH、BOOTSTRAP_HEAD、BASE_FULL_SHA、OWNED_WIP 及该任务的其余字段；prompt metadata 不会自动变成环境变量，故首个同调用 shell gate 必须显式 `export`。该 gate 先核当前 HEAD 仍是 BOOTSTRAP_HEAD 且树干净，再在隔离树内执行 `git merge --ff-only "$BASE_FULL_SHA"`，随后核 HEAD 等于 BASE、path／branch 正确且树仍干净；两 SHA 相等时 merge 无操作。全程不得 fetch 或 push。
4. 阶段 2 才开放实现或 report 写入。完成时 agent 必须回报 worktree 绝对路径、最终 HEAD、report 绝对路径与 report SHA256；主会话从 Agent tool 登记路径独立复核这些值，再精确提交。不得 push、建 PR、发布或改远端 refs。

执行任一 packet 前，主会话必须先逐行生成 repo-relative 精确路径 allowlist；禁止 glob、目录前缀或由 agent 自行扩表。carrier 固定为 `docs/plan/2026-08-06-nghttp2-cancel-series/dispatch/<TASK_ID>-allowed-paths.txt`。主会话把 allowlist 与最终交接 reviews 一并提交进本地 `BASE_FULL_SHA`，冻结其 SHA256 后才创建隔离 agent；allowlist 本身只读且不得出现在其授权集合。packet 0／2 的 allowlist 只含各自 report；packet 1 由主会话按正式 plan A4/A5 逐文件枚举实现、测试、live docs、progress 与 report，不能把“plan 列出的路径”交给 agent 自判。

发现额外必需路径时只允许以下无损扩表流程，三份 packet 共用，packet 0／2 通常不应触发：

1. agent 立即停止继续编辑，先证明现有全部 committed／WIP 路径仍在旧 allowlist。可形成有意义增量的 WIP 按旧 allowlist 精确提交；report／progress 也可提交，只要旧 allowlist 已授权。不可提交 WIP 保持原样，写精确 handover 后停止；禁止 reset、restore、覆盖、rebase、cherry-pick 或丢弃工作，未经主会话裁决不得继续。
2. agent 在旧 allowlist 下运行完成态 gate 的 `interim-subset` 模式。该模式不要求 report 已形成，但路径仍必须是旧 allowlist 子集；agent 回报 `INTERIM_HEAD`、committed／WIP 路径与 allowlist hash。主会话从登记 worktree 独立运行同一 gate。若仍有不可提交 WIP，主会话只裁决，不执行扩表维护提交。
3. WIP clean 后，主会话决定新 allowlist 的逐字节内容与预期 SHA256，并用 `SendMessage` 恢复同一暂停 agent，发送一次性 allowlist maintenance 消息。agent 只可把主会话冻结的精确 bytes 写到原 carrier，并提交**仅该 carrier**。主会话机械验证：新 commit 的唯一 parent 严格等于 `INTERIM_HEAD`；该 commit 的 diff 路径严格等于 carrier；carrier blob bytes／SHA256 等于主会话冻结内容；status clean。carrier 无需加入任务 allowlist，此 commit 是唯一的 main-authorized maintenance 例外。
4. maintenance commit 成为 `NEW_BASE`，故 `INTERIM_HEAD` 必须是 `NEW_BASE` 祖先，不产生分叉。主会话再以 `SendMessage` 恢复同一 agent，执行新的只读 bootstrap，把当前 HEAD 冻结为 `BOOTSTRAP_HEAD=NEW_BASE`；随后按阶段 2 注入 NEW_BASE、新 allowlist hash 与全部 literal 继续。不得新建 agent／worktree，也不得 fetch、rebase、reset、restore 或 cherry-pick。

完成前，每个 agent 必须运行其阶段 2 消息内的完成态路径 gate。该 gate绑定登记 worktree，枚举 `BASE..HEAD` **每个 commit 的完整触碰历史**与 porcelain WIP，rename／copy 两端都纳入；全部路径必须精确属于冻结 allowlist。最终 `exact-report`（packet 0／2）要求 `HEAD == BASE` 且路径集合严格等于唯一 report；最终 `subset-report`（packet 1）允许 allowlist 子集但必须含 report；`interim-subset` 仅供扩表前保存既有工作，不要求 report，但仍严格要求路径是旧 allowlist 子集。agent 回报 committed／WIP 清单、allowlist SHA256、report SHA256（interim 可为 null）、worktree 与 HEAD；主会话必须从 Agent tool 登记的 worktree 独立运行同一 gate，通过后才精确提交，不能只采信 agent 输出。

模板中的 `__MAIN_SHELL_LITERAL_*__` 必须被替换为一个完整 POSIX shell word，例如 `'/path'`；值内单引号按 `'\''` 编码。`export NAME=__MAIN_SHELL_LITERAL_*__` 本身没有额外引号，避免双重 quoting。正文中的 `__MAIN_TEXT_ABSOLUTE_*__` 必须同时替换为主会话从登记 WORKTREE 实例化出的绝对路径。发出阶段 2 前不得残留任何 marker、`<TBD>`、正文 `$WORKTREE` 路径或命令替换表达式。shell export 只服务首个同调用 gate，不保证跨后续 Bash 调用持久；后续读写只使用消息正文已实例化的绝对 literal。以下 packet 外层使用五反引号，内部 shell 使用四反引号，保持 Markdown fence 闭合。

### 可复制 packet 0：4141 History 只读 evidence agent

#### 阶段 1：bootstrap 消息

`````text
角色：gpt-souls:explorer。你处于隔离 worktree bootstrap 阶段。严格只读，不查询 4141、不写文件、不提交、不派生 agent。执行下面一个 block，原样返回输出后立即停止：

````bash
set -euo pipefail
printf 'pwd=%s\n' "$(pwd -P)"
printf 'top_level=%s\n' "$(git rev-parse --show-toplevel)"
printf 'branch=%s\n' "$(git branch --show-current)"
printf 'BOOTSTRAP_HEAD=%s\n' "$(git rev-parse HEAD)"
python3 - <<'PYSTATUS'
import json
import subprocess
raw = subprocess.check_output(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z"])
records = [item for item in raw.decode("utf-8", "surrogateescape").split("\0") if item]
print("status_porcelain_v1_z_json=" + json.dumps(records, ensure_ascii=True))
PYSTATUS
````
`````

主会话等待 tool 登记／通知 worktree path 后，独立核证登记路径＝`pwd`＝`top_level`、branch＝tool 生成并登记的 branch、status 数组为空，并在主仓库验证 `git merge-base --is-ancestor BOOTSTRAP_HEAD BASE_FULL_SHA`。登记路径尚不可得、ancestry 不成立或任一值不符即停止；通过才对同一 agent 使用 `SendMessage` 发送阶段 2。BOOTSTRAP_HEAD 只描述隔离树起点，不得自充 expected BASE。

#### 阶段 2：`SendMessage` 续跑消息

`````text
bootstrap 已由主会话独立核证。继续同一 agent；不得重新派生 agent。下面所有 shell 与正文 marker 在发送前必须已按总则替换为冻结 literal，且不得仍含占位标记。

````bash
set -euo pipefail
export WORKTREE=__MAIN_SHELL_LITERAL_WORKTREE__
export EXPECTED_BRANCH=__MAIN_SHELL_LITERAL_EXPECTED_BRANCH__
export BOOTSTRAP_HEAD=__MAIN_SHELL_LITERAL_BOOTSTRAP_HEAD__
export BASE_FULL_SHA=__MAIN_SHELL_LITERAL_BASE_FULL_SHA__
export OWNED_WIP=''
export TASK_ID=__MAIN_SHELL_LITERAL_TASK_ID__
export ALLOWED_PATHS_FILE=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_FILE_ABSOLUTE__
export ALLOWED_PATHS_SHA256=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_SHA256__
export REPORT_RELATIVE_PATH=__MAIN_SHELL_LITERAL_REPORT_RELATIVE_PATH__
export ALLOWLIST_POLICY='exact-report'
test "$(pwd -P)" = "$WORKTREE"
test "$(git rev-parse --show-toplevel)" = "$WORKTREE"
test "$(git branch --show-current)" = "$EXPECTED_BRANCH"
test "$(git rev-parse HEAD)" = "$BOOTSTRAP_HEAD"
python3 - <<'PYWIP'
import subprocess
raw = subprocess.check_output(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z"])
records = [item for item in raw.decode("utf-8", "surrogateescape").split("\0") if item]
if records:
    raise SystemExit(f"bootstrap worktree is not clean: {records!r}")
PYWIP
git merge-base --is-ancestor "$BOOTSTRAP_HEAD" "$BASE_FULL_SHA"
git merge --ff-only "$BASE_FULL_SHA"
test "$(pwd -P)" = "$WORKTREE"
test "$(git rev-parse --show-toplevel)" = "$WORKTREE"
test "$(git branch --show-current)" = "$EXPECTED_BRANCH"
test "$(git rev-parse HEAD)" = "$BASE_FULL_SHA"
python3 - <<'PYWIP'
import subprocess
raw = subprocess.check_output(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z"])
records = [item for item in raw.decode("utf-8", "surrogateescape").split("\0") if item]
if records:
    raise SystemExit(f"post-fast-forward worktree is not clean: {records!r}")
print("base_alignment_identity_and_wip_gate=PASS")
PYWIP
export EXPECTED_ALLOWED_PATHS_FILE="$WORKTREE/docs/plan/2026-08-06-nghttp2-cancel-series/dispatch/$TASK_ID-allowed-paths.txt"
test "$ALLOWED_PATHS_FILE" = "$EXPECTED_ALLOWED_PATHS_FILE"
test -f "$ALLOWED_PATHS_FILE"
test "$(sha256sum "$ALLOWED_PATHS_FILE" | cut -d' ' -f1)" = "$ALLOWED_PATHS_SHA256"
allowed_relative=${ALLOWED_PATHS_FILE#"$WORKTREE"/}
git cat-file -e "$BASE_FULL_SHA:$allowed_relative"
python3 - "$WORKTREE" "$ALLOWED_PATHS_FILE" "$REPORT_RELATIVE_PATH" "$allowed_relative" "$ALLOWLIST_POLICY" <<'PYALLOW'
import sys
from pathlib import Path, PurePosixPath
root = Path(sys.argv[1]).resolve()
allow_file = Path(sys.argv[2]).resolve()
report = sys.argv[3]
allow_relative = sys.argv[4]
policy = sys.argv[5]
try:
    allow_file.relative_to(root)
except ValueError as exc:
    raise SystemExit("allowlist is outside WORKTREE") from exc
raw_lines = allow_file.read_text(encoding="utf-8").splitlines()
if not raw_lines or any(not line for line in raw_lines):
    raise SystemExit("allowlist must contain non-empty lines")
if len(raw_lines) != len(set(raw_lines)):
    raise SystemExit("allowlist contains duplicates")
for line in raw_lines:
    p = PurePosixPath(line)
    if p.is_absolute() or any(part in {"", ".", ".."} for part in p.parts):
        raise SystemExit(f"invalid allowlist path: {line!r}")
    if any(char in line for char in "*?[]"):
        raise SystemExit(f"glob syntax is forbidden: {line!r}")
if allow_relative in raw_lines:
    raise SystemExit("allowlist cannot authorize itself")
if report not in raw_lines:
    raise SystemExit("report path is absent from allowlist")
if policy == "exact-report" and set(raw_lines) != {report}:
    raise SystemExit("read-only packet allowlist must contain only its report")
if policy not in {"exact-report", "subset-report"}:
    raise SystemExit(f"unknown allowlist policy: {policy}")
print(f"allowlist_entries={raw_lines!r}")
PYALLOW
````

Repo：`__MAIN_TEXT_ABSOLUTE_WORKTREE__`。
冻结 allowlist：`__MAIN_TEXT_ABSOLUTE_ALLOWED_PATHS_FILE__`（SHA256 `__MAIN_TEXT_ALLOWED_PATHS_SHA256__`）；TASK_ID=`__MAIN_TEXT_TASK_ID__`；REPORT_RELATIVE_PATH=`__MAIN_TEXT_REPORT_RELATIVE_PATH__`；最终完成模式=`exact-report`；仅扩表保存点可由主会话显式注入 `interim-subset`。
Canonical HANDOVER：`__MAIN_TEXT_ABSOLUTE_HANDOVER__`（B.1/B.2）。
Canonical plan：`__MAIN_TEXT_ABSOLUTE_PLAN__`。
Supporting evidence：`__MAIN_TEXT_ABSOLUTE_SERIES_DIR__/{session-inventory.md,mainline-evidence.md,review-factual-r7.md,review-successor-r7.md,review-successor-r2.md,review-successor-r3.md}`。这些 review 必须已随本交接最终提交在该 worktree 内可达；缺文件即停止。
历史 sessions：`4f1f3be9-79eb-4cf1-8185-4ebc1bfd5c79`、`2a1071f7-25a6-4c5e-8675-c7ffde1138ff`、`174f2b81-cab9-4415-a3b3-ef61f8033c2a`、`2684f077-d2ec-4112-9456-3371f8cb7f9d`。只作 provenance，不是入口，禁止重做会话考古。Transcript：第一份在 `/home/xp/.claude/projects/-home-xp-src-copilot-api-js/<session-id>.jsonl`，其余三份在 `/home/xp/.claude/projects/-home-xp-src-copilot-api-js--worktrees-anchor-alloc/<session-id>.jsonl`；job 为 `/home/xp/.claude/jobs/<short-id>/state.json`；tasks 为 `/home/xp/.claude/tasks/<full-session-id>/`。
任务：被动查询 4141 History，寻找自然产生的新 `NGHTTP2_CANCEL`；没有新样本就报告 `none observed`，不视为失败，也不阻断 A4。
已知结论／禁止重复探索：旧 23 条属历史窗口；两条无稳定 ID 的旧样本不可复跑；不重算旧窗口、不从时序推根因、不重核 A1-A3、不修改正式计划。
唯一允许写入：`__MAIN_TEXT_ABSOLUTE_EVIDENCE_REPORT__`。仓库其余路径与 4141 只读。
禁止动作：不得主动向 4141 制造请求／流量；不得写 History 或配置；不得 kill／restart 4141；不得修改产品代码、Supporting evidence、review、HANDOVER/KICKOFF；不得提交或 push。
产出：样本记录稳定 entry ID、request ID、observedAt、时间、模型、attempt、终止形态、PID／运行指纹、字段路径与无占位符的重复查询命令；没有样本则记录查询时间、范围、命令与 `none observed`。

完成前原样运行以下 gate；所有 marker 在阶段 2 派发前已由主会话实例化：

````bash
set -euo pipefail
export WORKTREE=__MAIN_SHELL_LITERAL_WORKTREE__
export BASE_FULL_SHA=__MAIN_SHELL_LITERAL_BASE_FULL_SHA__
export ALLOWED_PATHS_FILE=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_FILE_ABSOLUTE__
export ALLOWED_PATHS_SHA256=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_SHA256__
export REPORT_RELATIVE_PATH=__MAIN_SHELL_LITERAL_REPORT_RELATIVE_PATH__
export COMPLETION_MODE=__MAIN_SHELL_LITERAL_COMPLETION_MODE__
test "$(pwd -P)" = "$WORKTREE"
test "$(git rev-parse --show-toplevel)" = "$WORKTREE"
python3 - "$WORKTREE" "$BASE_FULL_SHA" "$ALLOWED_PATHS_FILE" "$ALLOWED_PATHS_SHA256" "$REPORT_RELATIVE_PATH" "$COMPLETION_MODE" <<'PYFINAL'
import hashlib
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath

root = Path(sys.argv[1]).resolve()
if Path.cwd().resolve() != root:
    raise SystemExit("ambient cwd does not equal WORKTREE")
base, allow_name, expected_allow_hash, report, mode = sys.argv[2:]

def git_bytes(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=root)

def git_text(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()

if Path(git_text("rev-parse", "--show-toplevel")).resolve() != root:
    raise SystemExit("git top-level does not equal WORKTREE")
head = git_text("rev-parse", "HEAD")
if subprocess.run(["git", "merge-base", "--is-ancestor", base, head], cwd=root).returncode != 0:
    raise SystemExit("BASE_FULL_SHA is not an ancestor of HEAD")

allow_file = Path(allow_name).resolve()
try:
    allow_relative = allow_file.relative_to(root).as_posix()
except ValueError as exc:
    raise SystemExit("allowlist is outside WORKTREE") from exc
allow_bytes = allow_file.read_bytes()
allow_hash = hashlib.sha256(allow_bytes).hexdigest()
if allow_hash != expected_allow_hash:
    raise SystemExit("allowlist hash mismatch")
lines = allow_bytes.decode("utf-8").splitlines()
if not lines or any(not line for line in lines) or len(lines) != len(set(lines)):
    raise SystemExit("invalid empty or duplicate allowlist entry")
for line in lines:
    p = PurePosixPath(line)
    if p.is_absolute() or any(part in {"", ".", ".."} for part in p.parts) or any(c in line for c in "*?[]"):
        raise SystemExit(f"invalid allowlist path: {line!r}")
allowed = set(lines)
if allow_relative in allowed:
    raise SystemExit("allowlist cannot authorize itself")

# Union every path touched by every commit in BASE..HEAD; a later revert cannot erase an earlier unauthorized touch.
def parse_name_status_z(raw: bytes) -> set[str]:
    tokens = [p for p in raw.decode("utf-8", "surrogateescape").split("\0") if p]
    paths: set[str] = set()
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if "\t" in token:
            status, first = token.split("\t", 1)
        else:
            status = token
            i += 1
            if i >= len(tokens):
                raise SystemExit("truncated name-status record")
            first = tokens[i]
        paths.add(first)
        if status[:1] in {"R", "C"}:
            i += 1
            if i >= len(tokens):
                raise SystemExit("truncated rename/copy record")
            paths.add(tokens[i])
        i += 1
    return paths

committed: set[str] = set()
commits = [c for c in git_text("rev-list", "--reverse", f"{base}..{head}").splitlines() if c]
for commit in commits:
    lineage = git_text("rev-list", "--parents", "-n", "1", commit).split()
    if not lineage or lineage[0] != commit or len(lineage) < 2:
        raise SystemExit(f"range commit has no valid first parent: {commit}")
    first_parent = lineage[1]
    # Every side-branch commit is audited separately by rev-list. Comparing a merge only to its first parent captures paths introduced by the merge/conflict resolution without falsely attributing first-parent content that merely differs from another parent.
    committed |= parse_name_status_z(git_bytes("diff-tree", "-r", "--no-commit-id", "--name-status", "-z", "-M", "-C", first_parent, commit))
# Net name-only is only a cross-check/additional tripwire, never the committed-history oracle.
net_paths = {p for p in git_bytes("diff", "--name-only", "-z", "--find-renames", "--find-copies", f"{base}..{head}").decode("utf-8", "surrogateescape").split("\0") if p}
if not net_paths <= committed:
    raise SystemExit(f"net diff contains paths absent from commit history union: {sorted(net_paths - committed)}")

raw = git_bytes("--no-optional-locks", "status", "--porcelain=v1", "-z")
records = [p for p in raw.decode("utf-8", "surrogateescape").split("\0") if p]
wip: set[str] = set()
i = 0
while i < len(records):
    rec = records[i]
    if len(rec) < 4:
        raise SystemExit(f"invalid porcelain record: {rec!r}")
    status, first = rec[:2], rec[3:]
    wip.add(first)
    if "R" in status or "C" in status:
        i += 1
        if i >= len(records):
            raise SystemExit("truncated porcelain rename/copy record")
        wip.add(records[i])
    i += 1

all_paths = committed | wip
extra = sorted(all_paths - allowed)
if extra:
    raise SystemExit(f"paths outside frozen allowlist: {extra}")
report_file = root / report
report_hash = None
if mode in {"exact-report", "subset-report"}:
    if not report_file.is_file():
        raise SystemExit("report is missing")
    if report not in all_paths:
        raise SystemExit("report is absent from final path set")
    report_hash = hashlib.sha256(report_file.read_bytes()).hexdigest()
if mode == "exact-report":
    if head != base:
        raise SystemExit("read-only packet changed HEAD")
    if all_paths != {report}:
        raise SystemExit(f"read-only packet final paths must equal report: {sorted(all_paths)}")
elif mode == "subset-report":
    pass
elif mode == "interim-subset":
    pass
else:
    raise SystemExit(f"unknown completion mode: {mode}")
print(json.dumps({
    "committed_paths": sorted(committed),
    "net_paths": sorted(net_paths),
    "wip_paths": sorted(wip),
    "allowlist_sha256": allow_hash,
    "report_sha256": report_hash,
}, ensure_ascii=True, sort_keys=True))
PYFINAL
````
完成 gate 通过后，回报 WORKTREE、最终 HEAD、report 绝对路径、committed／WIP 路径清单、allowlist SHA256 与 report SHA256。主会话从登记 worktree独立运行同一 gate；通过后才精确提交 report。
`````

### 可复制 packet 1：A4 implementer

#### 阶段 1：bootstrap 消息

`````text
角色：gpt-souls:implementer。你处于隔离 worktree bootstrap 阶段。严格只读，不实现、不测试、不写文件、不提交、不派生 agent。执行下面一个 block，原样返回输出后立即停止：

````bash
set -euo pipefail
printf 'pwd=%s\n' "$(pwd -P)"
printf 'top_level=%s\n' "$(git rev-parse --show-toplevel)"
printf 'branch=%s\n' "$(git branch --show-current)"
printf 'BOOTSTRAP_HEAD=%s\n' "$(git rev-parse HEAD)"
python3 - <<'PYSTATUS'
import json
import subprocess
raw = subprocess.check_output(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z"])
records = [item for item in raw.decode("utf-8", "surrogateescape").split("\0") if item]
print("status_porcelain_v1_z_json=" + json.dumps(records, ensure_ascii=True))
PYSTATUS
````
`````

主会话等待 tool 登记／通知 worktree path 后，独立核证登记路径＝`pwd`＝`top_level`、branch＝tool 生成并登记的 branch、status 数组为空，并在主仓库验证 `git merge-base --is-ancestor BOOTSTRAP_HEAD BASE_FULL_SHA`。登记路径尚不可得、ancestry 不成立或任一值不符即停止；通过才对同一 agent 使用 `SendMessage` 发送阶段 2。BOOTSTRAP_HEAD 只描述隔离树起点，不得自充 expected BASE。

#### 阶段 2：`SendMessage` 续跑消息

`````text
bootstrap 已由主会话独立核证。继续同一 agent；不得重新派生 agent。下面所有 shell 与正文 marker 在发送前必须已按总则替换为冻结 literal。

````bash
set -euo pipefail
export WORKTREE=__MAIN_SHELL_LITERAL_WORKTREE__
export EXPECTED_BRANCH=__MAIN_SHELL_LITERAL_EXPECTED_BRANCH__
export BOOTSTRAP_HEAD=__MAIN_SHELL_LITERAL_BOOTSTRAP_HEAD__
export BASE_FULL_SHA=__MAIN_SHELL_LITERAL_BASE_FULL_SHA__
export OWNED_WIP=''
export TASK_ID=__MAIN_SHELL_LITERAL_TASK_ID__
export ALLOWED_PATHS_FILE=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_FILE_ABSOLUTE__
export ALLOWED_PATHS_SHA256=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_SHA256__
export REPORT_RELATIVE_PATH=__MAIN_SHELL_LITERAL_REPORT_RELATIVE_PATH__
export ALLOWLIST_POLICY='subset-report'
test "$(pwd -P)" = "$WORKTREE"
test "$(git rev-parse --show-toplevel)" = "$WORKTREE"
test "$(git branch --show-current)" = "$EXPECTED_BRANCH"
test "$(git rev-parse HEAD)" = "$BOOTSTRAP_HEAD"
python3 - <<'PYWIP'
import subprocess
raw = subprocess.check_output(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z"])
records = [item for item in raw.decode("utf-8", "surrogateescape").split("\0") if item]
if records:
    raise SystemExit(f"bootstrap worktree is not clean: {records!r}")
PYWIP
git merge-base --is-ancestor "$BOOTSTRAP_HEAD" "$BASE_FULL_SHA"
git merge --ff-only "$BASE_FULL_SHA"
test "$(pwd -P)" = "$WORKTREE"
test "$(git rev-parse --show-toplevel)" = "$WORKTREE"
test "$(git branch --show-current)" = "$EXPECTED_BRANCH"
test "$(git rev-parse HEAD)" = "$BASE_FULL_SHA"
python3 - <<'PYWIP'
import subprocess
raw = subprocess.check_output(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z"])
records = [item for item in raw.decode("utf-8", "surrogateescape").split("\0") if item]
if records:
    raise SystemExit(f"post-fast-forward worktree is not clean: {records!r}")
print("base_alignment_identity_and_wip_gate=PASS")
PYWIP
export EXPECTED_ALLOWED_PATHS_FILE="$WORKTREE/docs/plan/2026-08-06-nghttp2-cancel-series/dispatch/$TASK_ID-allowed-paths.txt"
test "$ALLOWED_PATHS_FILE" = "$EXPECTED_ALLOWED_PATHS_FILE"
test -f "$ALLOWED_PATHS_FILE"
test "$(sha256sum "$ALLOWED_PATHS_FILE" | cut -d' ' -f1)" = "$ALLOWED_PATHS_SHA256"
allowed_relative=${ALLOWED_PATHS_FILE#"$WORKTREE"/}
git cat-file -e "$BASE_FULL_SHA:$allowed_relative"
python3 - "$WORKTREE" "$ALLOWED_PATHS_FILE" "$REPORT_RELATIVE_PATH" "$allowed_relative" "$ALLOWLIST_POLICY" <<'PYALLOW'
import sys
from pathlib import Path, PurePosixPath
root = Path(sys.argv[1]).resolve()
allow_file = Path(sys.argv[2]).resolve()
report = sys.argv[3]
allow_relative = sys.argv[4]
policy = sys.argv[5]
try:
    allow_file.relative_to(root)
except ValueError as exc:
    raise SystemExit("allowlist is outside WORKTREE") from exc
raw_lines = allow_file.read_text(encoding="utf-8").splitlines()
if not raw_lines or any(not line for line in raw_lines):
    raise SystemExit("allowlist must contain non-empty lines")
if len(raw_lines) != len(set(raw_lines)):
    raise SystemExit("allowlist contains duplicates")
for line in raw_lines:
    p = PurePosixPath(line)
    if p.is_absolute() or any(part in {"", ".", ".."} for part in p.parts):
        raise SystemExit(f"invalid allowlist path: {line!r}")
    if any(char in line for char in "*?[]"):
        raise SystemExit(f"glob syntax is forbidden: {line!r}")
if allow_relative in raw_lines:
    raise SystemExit("allowlist cannot authorize itself")
if report not in raw_lines:
    raise SystemExit("report path is absent from allowlist")
if policy == "exact-report" and set(raw_lines) != {report}:
    raise SystemExit("read-only packet allowlist must contain only its report")
if policy not in {"exact-report", "subset-report"}:
    raise SystemExit(f"unknown allowlist policy: {policy}")
print(f"allowlist_entries={raw_lines!r}")
PYALLOW
````

Repo：`__MAIN_TEXT_ABSOLUTE_WORKTREE__`。
冻结 allowlist：`__MAIN_TEXT_ABSOLUTE_ALLOWED_PATHS_FILE__`（SHA256 `__MAIN_TEXT_ALLOWED_PATHS_SHA256__`）；TASK_ID=`__MAIN_TEXT_TASK_ID__`；REPORT_RELATIVE_PATH=`__MAIN_TEXT_REPORT_RELATIVE_PATH__`；最终完成模式=`subset-report`；仅扩表保存点可由主会话显式注入 `interim-subset`。
Canonical HANDOVER：`__MAIN_TEXT_ABSOLUTE_HANDOVER__`。
Canonical plan：`__MAIN_TEXT_ABSOLUTE_PLAN__`（只执行 A4/A5）。
Supporting evidence：`__MAIN_TEXT_ABSOLUTE_SERIES_DIR__/{session-inventory.md,completed-detour.md,mainline-evidence.md,review-core-a3.md,review-factual-r7.md,review-successor-r7.md,review-factual.md,review-successor.md,review-successor-r3.md}`。这些 review 必须已随最终提交可达；缺文件即停止。
历史 sessions 与 provenance 坐标同 packet 0；禁止重做会话考古。
已知结论：A1-A3 已落；A3 尾项独立；CANCEL transport 核心修复未实施；A4 是 Phase B 前置。不得重核 A1-A3、重考古、重新设计正式 plan、进入 Phase B、调 PING cadence或加 generic CANCEL retry。
允许修改：`__MAIN_TEXT_ABSOLUTE_WORKTREE__/` 下正式 plan A4/A5 列出的实现、测试与 live docs；`__MAIN_TEXT_ABSOLUTE_A4_PROGRESS__`；`__MAIN_TEXT_ABSOLUTE_A4_REPORT__`。列表外路径先报告并停止。
禁止动作：不得 kill／restart 4141；不得写真实 History／配置；不得覆盖 peer WIP；不得修改 Supporting evidence、review、HANDOVER/KICKOFF；不得 push、建 PR、发布或改远端 refs。
测试／产出与完成判据：只按正式 plan A4/A5；目标缺陷 mutation 转红、正确样本保持绿，最终 diagnostic 从持久 History 读取。你不自判 review 通过。

完成前原样运行以下 gate；所有 marker 在阶段 2 派发前已由主会话实例化：

````bash
set -euo pipefail
export WORKTREE=__MAIN_SHELL_LITERAL_WORKTREE__
export BASE_FULL_SHA=__MAIN_SHELL_LITERAL_BASE_FULL_SHA__
export ALLOWED_PATHS_FILE=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_FILE_ABSOLUTE__
export ALLOWED_PATHS_SHA256=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_SHA256__
export REPORT_RELATIVE_PATH=__MAIN_SHELL_LITERAL_REPORT_RELATIVE_PATH__
export COMPLETION_MODE=__MAIN_SHELL_LITERAL_COMPLETION_MODE__
test "$(pwd -P)" = "$WORKTREE"
test "$(git rev-parse --show-toplevel)" = "$WORKTREE"
python3 - "$WORKTREE" "$BASE_FULL_SHA" "$ALLOWED_PATHS_FILE" "$ALLOWED_PATHS_SHA256" "$REPORT_RELATIVE_PATH" "$COMPLETION_MODE" <<'PYFINAL'
import hashlib
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath

root = Path(sys.argv[1]).resolve()
if Path.cwd().resolve() != root:
    raise SystemExit("ambient cwd does not equal WORKTREE")
base, allow_name, expected_allow_hash, report, mode = sys.argv[2:]

def git_bytes(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=root)

def git_text(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()

if Path(git_text("rev-parse", "--show-toplevel")).resolve() != root:
    raise SystemExit("git top-level does not equal WORKTREE")
head = git_text("rev-parse", "HEAD")
if subprocess.run(["git", "merge-base", "--is-ancestor", base, head], cwd=root).returncode != 0:
    raise SystemExit("BASE_FULL_SHA is not an ancestor of HEAD")

allow_file = Path(allow_name).resolve()
try:
    allow_relative = allow_file.relative_to(root).as_posix()
except ValueError as exc:
    raise SystemExit("allowlist is outside WORKTREE") from exc
allow_bytes = allow_file.read_bytes()
allow_hash = hashlib.sha256(allow_bytes).hexdigest()
if allow_hash != expected_allow_hash:
    raise SystemExit("allowlist hash mismatch")
lines = allow_bytes.decode("utf-8").splitlines()
if not lines or any(not line for line in lines) or len(lines) != len(set(lines)):
    raise SystemExit("invalid empty or duplicate allowlist entry")
for line in lines:
    p = PurePosixPath(line)
    if p.is_absolute() or any(part in {"", ".", ".."} for part in p.parts) or any(c in line for c in "*?[]"):
        raise SystemExit(f"invalid allowlist path: {line!r}")
allowed = set(lines)
if allow_relative in allowed:
    raise SystemExit("allowlist cannot authorize itself")

# Union every path touched by every commit in BASE..HEAD; a later revert cannot erase an earlier unauthorized touch.
def parse_name_status_z(raw: bytes) -> set[str]:
    tokens = [p for p in raw.decode("utf-8", "surrogateescape").split("\0") if p]
    paths: set[str] = set()
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if "\t" in token:
            status, first = token.split("\t", 1)
        else:
            status = token
            i += 1
            if i >= len(tokens):
                raise SystemExit("truncated name-status record")
            first = tokens[i]
        paths.add(first)
        if status[:1] in {"R", "C"}:
            i += 1
            if i >= len(tokens):
                raise SystemExit("truncated rename/copy record")
            paths.add(tokens[i])
        i += 1
    return paths

committed: set[str] = set()
commits = [c for c in git_text("rev-list", "--reverse", f"{base}..{head}").splitlines() if c]
for commit in commits:
    lineage = git_text("rev-list", "--parents", "-n", "1", commit).split()
    if not lineage or lineage[0] != commit or len(lineage) < 2:
        raise SystemExit(f"range commit has no valid first parent: {commit}")
    first_parent = lineage[1]
    # Every side-branch commit is audited separately by rev-list. Comparing a merge only to its first parent captures paths introduced by the merge/conflict resolution without falsely attributing first-parent content that merely differs from another parent.
    committed |= parse_name_status_z(git_bytes("diff-tree", "-r", "--no-commit-id", "--name-status", "-z", "-M", "-C", first_parent, commit))
# Net name-only is only a cross-check/additional tripwire, never the committed-history oracle.
net_paths = {p for p in git_bytes("diff", "--name-only", "-z", "--find-renames", "--find-copies", f"{base}..{head}").decode("utf-8", "surrogateescape").split("\0") if p}
if not net_paths <= committed:
    raise SystemExit(f"net diff contains paths absent from commit history union: {sorted(net_paths - committed)}")

raw = git_bytes("--no-optional-locks", "status", "--porcelain=v1", "-z")
records = [p for p in raw.decode("utf-8", "surrogateescape").split("\0") if p]
wip: set[str] = set()
i = 0
while i < len(records):
    rec = records[i]
    if len(rec) < 4:
        raise SystemExit(f"invalid porcelain record: {rec!r}")
    status, first = rec[:2], rec[3:]
    wip.add(first)
    if "R" in status or "C" in status:
        i += 1
        if i >= len(records):
            raise SystemExit("truncated porcelain rename/copy record")
        wip.add(records[i])
    i += 1

all_paths = committed | wip
extra = sorted(all_paths - allowed)
if extra:
    raise SystemExit(f"paths outside frozen allowlist: {extra}")
report_file = root / report
report_hash = None
if mode in {"exact-report", "subset-report"}:
    if not report_file.is_file():
        raise SystemExit("report is missing")
    if report not in all_paths:
        raise SystemExit("report is absent from final path set")
    report_hash = hashlib.sha256(report_file.read_bytes()).hexdigest()
if mode == "exact-report":
    if head != base:
        raise SystemExit("read-only packet changed HEAD")
    if all_paths != {report}:
        raise SystemExit(f"read-only packet final paths must equal report: {sorted(all_paths)}")
elif mode == "subset-report":
    pass
elif mode == "interim-subset":
    pass
else:
    raise SystemExit(f"unknown completion mode: {mode}")
print(json.dumps({
    "committed_paths": sorted(committed),
    "net_paths": sorted(net_paths),
    "wip_paths": sorted(wip),
    "allowlist_sha256": allow_hash,
    "report_sha256": report_hash,
}, ensure_ascii=True, sort_keys=True))
PYFINAL
````
完成 gate 通过后，回报 WORKTREE、最终 HEAD、report 绝对路径、committed／WIP 路径清单、allowlist SHA256 与 report SHA256；主会话从登记 worktree 独立运行同一 gate，通过后才精确提交。若发现 allowlist 外必需文件，严格执行总则的 `interim-subset → INTERIM_HEAD → main 冻结 bytes → carrier-only maintenance commit → NEW_BASE → 同一 agent bootstrap` 流程；任何不可提交 WIP 原样保留并交接，禁止回退或覆盖。
`````

### 可复制 packet 2：Phase B verifier

#### 阶段 1：bootstrap 消息

`````text
角色：gpt-souls:verifier。你处于隔离 worktree bootstrap 阶段。严格只读，不验证、不写 report、不修改任何文件、不派生 agent。执行下面一个 block，原样返回输出后立即停止：

````bash
set -euo pipefail
printf 'pwd=%s\n' "$(pwd -P)"
printf 'top_level=%s\n' "$(git rev-parse --show-toplevel)"
printf 'branch=%s\n' "$(git branch --show-current)"
printf 'BOOTSTRAP_HEAD=%s\n' "$(git rev-parse HEAD)"
python3 - <<'PYSTATUS'
import json
import subprocess
raw = subprocess.check_output(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z"])
records = [item for item in raw.decode("utf-8", "surrogateescape").split("\0") if item]
print("status_porcelain_v1_z_json=" + json.dumps(records, ensure_ascii=True))
PYSTATUS
````
`````

主会话等待 tool 登记／通知 worktree path 后，独立核证登记路径＝`pwd`＝`top_level`、branch＝tool 生成并登记的 branch、status 数组为空，并在主仓库验证 `git merge-base --is-ancestor BOOTSTRAP_HEAD BASE_FULL_SHA`。登记路径尚不可得、ancestry 不成立或任一值不符即停止；通过才对同一 agent 使用 `SendMessage` 发送阶段 2。BOOTSTRAP_HEAD 只描述隔离树起点，不得自充 expected BASE。

#### 阶段 2：`SendMessage` 续跑消息

`````text
bootstrap 已由主会话独立核证。继续同一 agent；不得重新派生 agent。发送前，主会话必须按总则替换每个 shell 与正文 marker；任何字段未冻结时不得发送本消息。

````bash
set -euo pipefail
export WORKTREE=__MAIN_SHELL_LITERAL_WORKTREE__
export EXPECTED_BRANCH=__MAIN_SHELL_LITERAL_EXPECTED_BRANCH__
export BOOTSTRAP_HEAD=__MAIN_SHELL_LITERAL_BOOTSTRAP_HEAD__
export BASE_FULL_SHA=__MAIN_SHELL_LITERAL_BASE_FULL_SHA__
export EXPECTED_TARGET_FULL_SHA=__MAIN_SHELL_LITERAL_EXPECTED_TARGET_FULL_SHA__
export OWNED_WIP=''
export TASK_ID=__MAIN_SHELL_LITERAL_TASK_ID__
export ALLOWED_PATHS_FILE=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_FILE_ABSOLUTE__
export ALLOWED_PATHS_SHA256=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_SHA256__
export REPORT_RELATIVE_PATH=__MAIN_SHELL_LITERAL_REPORT_RELATIVE_PATH__
export ALLOWLIST_POLICY='exact-report'
export ROUND_ID=__MAIN_SHELL_LITERAL_ROUND_ID__
export PREREGISTRATION=__MAIN_SHELL_LITERAL_PREREGISTRATION_ABSOLUTE_PATH__
export DATA_MANIFEST=__MAIN_SHELL_LITERAL_DATA_MANIFEST_ABSOLUTE_PATH__
export RESULTS=__MAIN_SHELL_LITERAL_RESULTS_ABSOLUTE_PATH__
export PREREG_SHA256=__MAIN_SHELL_LITERAL_PREREG_SHA256__
export DATA_ROOT=__MAIN_SHELL_LITERAL_DATA_ROOT_ABSOLUTE_PATH__
test "$(pwd -P)" = "$WORKTREE"
test "$(git rev-parse --show-toplevel)" = "$WORKTREE"
test "$(git branch --show-current)" = "$EXPECTED_BRANCH"
test "$(git rev-parse HEAD)" = "$BOOTSTRAP_HEAD"
python3 - <<'PYWIP'
import subprocess
raw = subprocess.check_output(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z"])
records = [item for item in raw.decode("utf-8", "surrogateescape").split("\0") if item]
if records:
    raise SystemExit(f"bootstrap worktree is not clean: {records!r}")
PYWIP
git merge-base --is-ancestor "$BOOTSTRAP_HEAD" "$BASE_FULL_SHA"
git merge --ff-only "$BASE_FULL_SHA"
test "$(pwd -P)" = "$WORKTREE"
test "$(git rev-parse --show-toplevel)" = "$WORKTREE"
test "$(git branch --show-current)" = "$EXPECTED_BRANCH"
test "$(git rev-parse HEAD)" = "$BASE_FULL_SHA"
python3 - <<'PYWIP'
import subprocess
raw = subprocess.check_output(["git", "--no-optional-locks", "status", "--porcelain=v1", "-z"])
records = [item for item in raw.decode("utf-8", "surrogateescape").split("\0") if item]
if records:
    raise SystemExit(f"post-fast-forward worktree is not clean: {records!r}")
print("base_alignment_identity_and_wip_gate=PASS")
PYWIP
export EXPECTED_ALLOWED_PATHS_FILE="$WORKTREE/docs/plan/2026-08-06-nghttp2-cancel-series/dispatch/$TASK_ID-allowed-paths.txt"
test "$ALLOWED_PATHS_FILE" = "$EXPECTED_ALLOWED_PATHS_FILE"
test -f "$ALLOWED_PATHS_FILE"
test "$(sha256sum "$ALLOWED_PATHS_FILE" | cut -d' ' -f1)" = "$ALLOWED_PATHS_SHA256"
allowed_relative=${ALLOWED_PATHS_FILE#"$WORKTREE"/}
git cat-file -e "$BASE_FULL_SHA:$allowed_relative"
python3 - "$WORKTREE" "$ALLOWED_PATHS_FILE" "$REPORT_RELATIVE_PATH" "$allowed_relative" "$ALLOWLIST_POLICY" <<'PYALLOW'
import sys
from pathlib import Path, PurePosixPath
root = Path(sys.argv[1]).resolve()
allow_file = Path(sys.argv[2]).resolve()
report = sys.argv[3]
allow_relative = sys.argv[4]
policy = sys.argv[5]
try:
    allow_file.relative_to(root)
except ValueError as exc:
    raise SystemExit("allowlist is outside WORKTREE") from exc
raw_lines = allow_file.read_text(encoding="utf-8").splitlines()
if not raw_lines or any(not line for line in raw_lines):
    raise SystemExit("allowlist must contain non-empty lines")
if len(raw_lines) != len(set(raw_lines)):
    raise SystemExit("allowlist contains duplicates")
for line in raw_lines:
    p = PurePosixPath(line)
    if p.is_absolute() or any(part in {"", ".", ".."} for part in p.parts):
        raise SystemExit(f"invalid allowlist path: {line!r}")
    if any(char in line for char in "*?[]"):
        raise SystemExit(f"glob syntax is forbidden: {line!r}")
if allow_relative in raw_lines:
    raise SystemExit("allowlist cannot authorize itself")
if report not in raw_lines:
    raise SystemExit("report path is absent from allowlist")
if policy == "exact-report" and set(raw_lines) != {report}:
    raise SystemExit("read-only packet allowlist must contain only its report")
if policy not in {"exact-report", "subset-report"}:
    raise SystemExit(f"unknown allowlist policy: {policy}")
print(f"allowlist_entries={raw_lines!r}")
PYALLOW
test "$EXPECTED_TARGET_FULL_SHA" = "$BASE_FULL_SHA"
test "$PREREGISTRATION" = "$WORKTREE/docs/plan/2026-08-06-nghttp2-cancel-series/phase-b/$ROUND_ID/preregistration.md"
test "$DATA_MANIFEST" = "$WORKTREE/docs/plan/2026-08-06-nghttp2-cancel-series/phase-b/$ROUND_ID/data-manifest.json"
test "$RESULTS" = "$WORKTREE/docs/plan/2026-08-06-nghttp2-cancel-series/phase-b/$ROUND_ID/results.md"
test -f "$PREREGISTRATION"
test -f "$DATA_MANIFEST"
test -f "$RESULTS"
test -d "$DATA_ROOT"
test "$(sha256sum "$PREREGISTRATION" | cut -d' ' -f1)" = "$PREREG_SHA256"
````

Repo：`__MAIN_TEXT_ABSOLUTE_WORKTREE__`。
冻结 allowlist：`__MAIN_TEXT_ABSOLUTE_ALLOWED_PATHS_FILE__`（SHA256 `__MAIN_TEXT_ALLOWED_PATHS_SHA256__`）；TASK_ID=`__MAIN_TEXT_TASK_ID__`；REPORT_RELATIVE_PATH=`__MAIN_TEXT_REPORT_RELATIVE_PATH__`；最终完成模式=`exact-report`；仅扩表保存点可由主会话显式注入 `interim-subset`。
Canonical HANDOVER：`__MAIN_TEXT_ABSOLUTE_HANDOVER__`。
Canonical plan：`__MAIN_TEXT_ABSOLUTE_PLAN__`（Phase B 是唯一实验契约）。
Supporting evidence：`__MAIN_TEXT_ABSOLUTE_SERIES_DIR__/{session-inventory.md,mainline-evidence.md,review-factual-r7.md,review-successor-r7.md,review-factual.md,review-successor.md,review-successor-r2.md,review-successor-r3.md}`；必须已随最终提交可达。
历史 sessions 与 provenance 坐标同 packet 0；禁止重做会话考古。
已知结论：旧窗口不是当前 baseline；无稳定 ID 的旧样本不可复跑；A4、自然新样本与预注册均已由主会话在阶段 2 派发前核证。不得从旧样本重推根因、替用户修改预注册、复述／改写 Phase B 契约或把 PING ACK 当 stream 健康。
唯一允许写入：`__MAIN_TEXT_ABSOLUTE_PHASE_B_REPORT__`。预注册、manifest、results 与 DATA_ROOT 只读；原始数据不进 Git 时，manifest 必须逐项记录可达位置与 digest。
禁止动作：不得 kill／restart 4141；不得写真实 History／配置；不得修改产品代码、预注册、Supporting evidence、review、HANDOVER/KICKOFF；不得 push、建 PR、发布或改远端 refs。
完成判据：ROUND_ID、路径、hash、base 与 data root 均已冻结；manifest 数据可达、digest 相符且晚于预注册；双控有效、HEAD 不漂移。任一缺失／不符只报告 gate 未满足，不给因果 verdict。

完成前原样运行以下 gate；所有 marker 在阶段 2 派发前已由主会话实例化：

````bash
set -euo pipefail
export WORKTREE=__MAIN_SHELL_LITERAL_WORKTREE__
export BASE_FULL_SHA=__MAIN_SHELL_LITERAL_BASE_FULL_SHA__
export ALLOWED_PATHS_FILE=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_FILE_ABSOLUTE__
export ALLOWED_PATHS_SHA256=__MAIN_SHELL_LITERAL_ALLOWED_PATHS_SHA256__
export REPORT_RELATIVE_PATH=__MAIN_SHELL_LITERAL_REPORT_RELATIVE_PATH__
export COMPLETION_MODE=__MAIN_SHELL_LITERAL_COMPLETION_MODE__
test "$(pwd -P)" = "$WORKTREE"
test "$(git rev-parse --show-toplevel)" = "$WORKTREE"
python3 - "$WORKTREE" "$BASE_FULL_SHA" "$ALLOWED_PATHS_FILE" "$ALLOWED_PATHS_SHA256" "$REPORT_RELATIVE_PATH" "$COMPLETION_MODE" <<'PYFINAL'
import hashlib
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath

root = Path(sys.argv[1]).resolve()
if Path.cwd().resolve() != root:
    raise SystemExit("ambient cwd does not equal WORKTREE")
base, allow_name, expected_allow_hash, report, mode = sys.argv[2:]

def git_bytes(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=root)

def git_text(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()

if Path(git_text("rev-parse", "--show-toplevel")).resolve() != root:
    raise SystemExit("git top-level does not equal WORKTREE")
head = git_text("rev-parse", "HEAD")
if subprocess.run(["git", "merge-base", "--is-ancestor", base, head], cwd=root).returncode != 0:
    raise SystemExit("BASE_FULL_SHA is not an ancestor of HEAD")

allow_file = Path(allow_name).resolve()
try:
    allow_relative = allow_file.relative_to(root).as_posix()
except ValueError as exc:
    raise SystemExit("allowlist is outside WORKTREE") from exc
allow_bytes = allow_file.read_bytes()
allow_hash = hashlib.sha256(allow_bytes).hexdigest()
if allow_hash != expected_allow_hash:
    raise SystemExit("allowlist hash mismatch")
lines = allow_bytes.decode("utf-8").splitlines()
if not lines or any(not line for line in lines) or len(lines) != len(set(lines)):
    raise SystemExit("invalid empty or duplicate allowlist entry")
for line in lines:
    p = PurePosixPath(line)
    if p.is_absolute() or any(part in {"", ".", ".."} for part in p.parts) or any(c in line for c in "*?[]"):
        raise SystemExit(f"invalid allowlist path: {line!r}")
allowed = set(lines)
if allow_relative in allowed:
    raise SystemExit("allowlist cannot authorize itself")

# Union every path touched by every commit in BASE..HEAD; a later revert cannot erase an earlier unauthorized touch.
def parse_name_status_z(raw: bytes) -> set[str]:
    tokens = [p for p in raw.decode("utf-8", "surrogateescape").split("\0") if p]
    paths: set[str] = set()
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if "\t" in token:
            status, first = token.split("\t", 1)
        else:
            status = token
            i += 1
            if i >= len(tokens):
                raise SystemExit("truncated name-status record")
            first = tokens[i]
        paths.add(first)
        if status[:1] in {"R", "C"}:
            i += 1
            if i >= len(tokens):
                raise SystemExit("truncated rename/copy record")
            paths.add(tokens[i])
        i += 1
    return paths

committed: set[str] = set()
commits = [c for c in git_text("rev-list", "--reverse", f"{base}..{head}").splitlines() if c]
for commit in commits:
    lineage = git_text("rev-list", "--parents", "-n", "1", commit).split()
    if not lineage or lineage[0] != commit or len(lineage) < 2:
        raise SystemExit(f"range commit has no valid first parent: {commit}")
    first_parent = lineage[1]
    # Every side-branch commit is audited separately by rev-list. Comparing a merge only to its first parent captures paths introduced by the merge/conflict resolution without falsely attributing first-parent content that merely differs from another parent.
    committed |= parse_name_status_z(git_bytes("diff-tree", "-r", "--no-commit-id", "--name-status", "-z", "-M", "-C", first_parent, commit))
# Net name-only is only a cross-check/additional tripwire, never the committed-history oracle.
net_paths = {p for p in git_bytes("diff", "--name-only", "-z", "--find-renames", "--find-copies", f"{base}..{head}").decode("utf-8", "surrogateescape").split("\0") if p}
if not net_paths <= committed:
    raise SystemExit(f"net diff contains paths absent from commit history union: {sorted(net_paths - committed)}")

raw = git_bytes("--no-optional-locks", "status", "--porcelain=v1", "-z")
records = [p for p in raw.decode("utf-8", "surrogateescape").split("\0") if p]
wip: set[str] = set()
i = 0
while i < len(records):
    rec = records[i]
    if len(rec) < 4:
        raise SystemExit(f"invalid porcelain record: {rec!r}")
    status, first = rec[:2], rec[3:]
    wip.add(first)
    if "R" in status or "C" in status:
        i += 1
        if i >= len(records):
            raise SystemExit("truncated porcelain rename/copy record")
        wip.add(records[i])
    i += 1

all_paths = committed | wip
extra = sorted(all_paths - allowed)
if extra:
    raise SystemExit(f"paths outside frozen allowlist: {extra}")
report_file = root / report
report_hash = None
if mode in {"exact-report", "subset-report"}:
    if not report_file.is_file():
        raise SystemExit("report is missing")
    if report not in all_paths:
        raise SystemExit("report is absent from final path set")
    report_hash = hashlib.sha256(report_file.read_bytes()).hexdigest()
if mode == "exact-report":
    if head != base:
        raise SystemExit("read-only packet changed HEAD")
    if all_paths != {report}:
        raise SystemExit(f"read-only packet final paths must equal report: {sorted(all_paths)}")
elif mode == "subset-report":
    pass
elif mode == "interim-subset":
    pass
else:
    raise SystemExit(f"unknown completion mode: {mode}")
print(json.dumps({
    "committed_paths": sorted(committed),
    "net_paths": sorted(net_paths),
    "wip_paths": sorted(wip),
    "allowlist_sha256": allow_hash,
    "report_sha256": report_hash,
}, ensure_ascii=True, sort_keys=True))
PYFINAL
````
完成 gate 通过后，回报 WORKTREE、最终 HEAD、report 绝对路径、committed／WIP 路径清单、allowlist SHA256 与 report SHA256；主会话从登记 worktree独立运行同一 gate，通过后才精确提交 report。
`````

所有 agent 报告先落对应隔离 worktree 的仓库路径，再由主会话核证、处置与精确提交。
