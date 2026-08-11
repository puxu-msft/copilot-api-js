#!/usr/bin/env bash
# 无损 shutdown 整改的自有测试集（backend 档，不含 pty）。
#
# 这份清单是 docs/tmp/2026-08-08-lossless-shutdown-terminal-report.md 与
# docs/plan/2026-08-07-lossless-graceful-shutdown-drain.md 里
# 「Ran 100 tests across 12 files、退出码 0」这个数字的**唯一精确口径**。
# 先前有一版数字（98 pass）取自一个没写明的文件集——含 pty、缺 bypass——
# 因而不可复现；归档这个脚本就是为了让口径不再依赖记忆。
#
# 用法：bash docs/tmp/2026-08-08-lossless-shutdown-self-tests.sh
# 从仓库任意位置运行均可；它自己解析仓库根。
#
# 注意：tests/shutdown/shutdown-signals.pty.test.ts 属 pty 档，**不在此集内**，
# 单独由 `bun run test:pty` 覆盖。把它混进来正是先前那版数字对不上的原因。
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILES=(
  tests/shutdown/drain-waits-operation.unit.test.ts
  tests/shutdown/rate-limiter-lossless-drain.it.test.ts
  tests/shutdown/rate-limiter-reject-race.unit.test.ts
  tests/shutdown/rate-limiter-shutdown.unit.test.ts
  tests/shutdown/rate-limiter.unit.test.ts
  tests/shutdown/shutdown-abort-flow.unit.test.ts
  tests/shutdown/shutdown-h2-pool-drain.it.test.ts
  tests/shutdown/shutdown-messages-lossless.http.test.ts
  tests/shutdown/shutdown.unit.test.ts
  tests/context/lightweight-model-operation.unit.test.ts
  tests/infra/supervisor-lossless-handoff.unit.test.ts
  tests/history/model-operation-bypass.http.test.ts
)

echo "repo root: $ROOT"
echo "file count: ${#FILES[@]} (expected 12)"

missing=0
for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "MISSING: $f" >&2
    missing=1
  fi
done
if (( missing )); then
  echo "清单里有文件不存在——测试可能被改名或迁走了。先核对再改这份清单，不要直接删条目。" >&2
  exit 2
fi

bun test --coverage-reporter=text "${FILES[@]}"
