#!/usr/bin/env bash
set -euo pipefail
TARGET=${1:-/tmp/copilot-libcurl-node-poc}
mkdir -p "$TARGET"
printf '%s\n' '{"name":"copilot-libcurl-node-poc","private":true,"type":"module"}' > "$TARGET/package.json"
npm install --prefix "$TARGET" node-libcurl@5.1.2
printf 'installed node-libcurl in %s\n' "$TARGET"
