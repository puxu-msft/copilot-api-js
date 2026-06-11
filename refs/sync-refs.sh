#!/usr/bin/env bash
# 同步所有参考项目：
#   - 列表中的项目：已有的 fetch + rebase，不存在的 clone
#   - vscode-copilot-chat-upstream：sparse-checkout microsoft/vscode 的 extensions/copilot 子树
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 参考项目列表：目录名=仓库URL
REPOS=(
  "agent-maestro=https://github.com/Joouis/agent-maestro"
  "awsl-maxx=https://github.com/awsl-project/maxx"
  # "CLIProxyAPIPlus=https://github.com/router-for-me/CLIProxyAPIPlus.git"
  "ghc-api-py=https://github.com/sxwxs/ghc-api/"
  # vscode-copilot-chat 上游已归档（2026-05-20），活跃开发并入 microsoft/vscode。
  # 旧副本 refs/vscode-copilot-chat/ 冻结在归档点，仍可作离线参考，不再 fetch/rebase。
  # 最新源码由下方 sparse-checkout 块单独拉取（整仓巨大，只取 extensions/copilot）。
  # "vscode-copilot-chat=https://github.com/microsoft/vscode-copilot-chat"
)

# microsoft/vscode 的 extensions/copilot 子树（vscode-copilot-chat 归档后的活跃源码）。
# 整仓太大，用 partial clone（blob:none）+ sparse-checkout 只取需要的子目录。
VSCODE_UPSTREAM_DIR="$SCRIPT_DIR/vscode-copilot-chat-upstream"
VSCODE_SPARSE_PATH="extensions/copilot/src"

echo "=== vscode-copilot-chat-upstream (microsoft/vscode: $VSCODE_SPARSE_PATH) ==="
if [ -d "$VSCODE_UPSTREAM_DIR/.git" ]; then
  cd "$VSCODE_UPSTREAM_DIR"
  echo "  pull ..."
  git sparse-checkout set "$VSCODE_SPARSE_PATH"
  git pull --ff-only
  cd "$SCRIPT_DIR"
else
  echo "  sparse clone ..."
  git clone --filter=blob:none --sparse https://github.com/microsoft/vscode "$VSCODE_UPSTREAM_DIR"
  cd "$VSCODE_UPSTREAM_DIR"
  git sparse-checkout set "$VSCODE_SPARSE_PATH"
  cd "$SCRIPT_DIR"
fi
echo ""

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
