#!/usr/bin/env bash
# 把 job 临时目录的清单与 commit-message 对照落盘为可复核证据。
# 评审指出：先前清单把「文件计数」「msg 输入与 commit subject 相等」标成
# 「job 清理后不可复现、只能采信作者自报」，但**目录当时尚存**，这件事
# 那一刻仍做得到——把「未做」写成了「不可做」。本脚本就是补做它。
set -euo pipefail
TMP="${1:?usage: $0 <job-tmp-dir> <out-dir>}"
OUT="${2:?usage: $0 <job-tmp-dir> <out-dir>}"
ROOT="$(git rev-parse --show-toplevel)"

{
  echo "# job 临时目录清单与 commit-message 对照"
  echo
  echo "> 采集时间：$(date -Iseconds)。采集命令见本文件末尾。这是 \`docs/tmp/2026-08-08-lossless-shutdown-temp-manifest.md\` 所述文件计数与 msg↔subject 对照的**原始证据**——目录本身会随 job 删除消失，本文件是它唯一的留存。"
  echo
  echo '## 目录清单'
  echo
  echo '```'
  echo "bytes	name"
  find "$TMP" -maxdepth 1 -type f -printf '%s\t%f\n' | sort -k2
  echo '```'
  echo
  printf '常规文件 %s 个；符号链接 %s 个；子目录 %s 个。\n' \
    "$(find "$TMP" -maxdepth 1 -type f | wc -l)" \
    "$(find "$TMP" -maxdepth 1 -type l | wc -l)" \
    "$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | wc -l)"
  echo
  echo '## commit-message 输入 ↔ 已落地 commit subject 对照'
  echo
  echo '每行格式：`msg 文件` → 其首行 → 匹配到的 commit（`git log --all --format=%H%x09%s` 中 subject 完全相等者）。'
  echo
  echo '```'
  # 先把全仓 subject 表落成临时文件再查，避免 awk 的提前 exit 关闭 git 管道触发 SIGPIPE（exit 141）。
  subjects="$(mktemp)"
  trap 'rm -f "$subjects"' RETURN 2>/dev/null || true
  git -C "$ROOT" log --all --format='%H%x09%s' > "$subjects"
  for f in "$TMP"/msg*.txt; do
    [ -f "$f" ] || continue
    subj="$(head -n1 "$f")"
    sha="$(awk -F'\t' -v s="$subj" '$2==s {print $1; exit}' "$subjects")"
    printf '%s\t%s\t%s\n' "$(basename "$f")" "${sha:-NO-MATCH}" "$subj"
  done
  rm -f "$subjects"
  echo '```'
  echo
  echo '## 采集命令'
  echo
  echo '```'
  echo "bash docs/tmp/2026-08-08-lossless-shutdown-capture-job-tmp.sh <job-tmp-dir> <out-dir>"
  echo '```'
} > "$OUT/2026-08-08-lossless-shutdown-job-tmp-inventory.md"

echo "written: $OUT/2026-08-08-lossless-shutdown-job-tmp-inventory.md"
