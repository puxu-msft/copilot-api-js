#!/usr/bin/env bash
# 同步所有参考项目：已有的 fetch + rebase，不存在的 clone
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 参考项目列表：目录名=仓库URL
REPOS=(
  "agent-maestro=https://github.com/Joouis/agent-maestro"
  "awsl-maxx=https://github.com/awsl-project/maxx"
  "CLIProxyAPIPlus=https://github.com/router-for-me/CLIProxyAPIPlus.git"
  "ghc-api-py=https://github.com/sxwxs/ghc-api/"
  "vscode-copilot-chat=https://github.com/microsoft/vscode-copilot-chat"
)

for entry in "${REPOS[@]}"; do
  name="${entry%%=*}"
  url="${entry#*=}"
  # 解析符号链接，获取实际路径
  target="$SCRIPT_DIR/$name"

  echo "=== $name ==="

  if [ -d "$target" ]; then
    # 目录已存在（可能是符号链接指向的目录），进入并更新
    cd "$target"
    echo "  fetch + rebase ..."
    git fetch origin
    git rebase
    cd "$SCRIPT_DIR"
  else
    # 目录不存在，clone
    echo "  cloning $url ..."
    git clone "$url" "$target"
  fi

  echo ""
done

echo "Done."
