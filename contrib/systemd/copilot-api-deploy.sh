#!/usr/bin/env bash
# contrib/systemd/copilot-api-deploy.sh —— A1 无状态发现活槽 + B1 脚本发交接信号。
# 详见 docs/lifecycle.md「路径二：systemd blue-green 模板单元 + reusePort」。
set -euo pipefail

SYSTEMCTL_BIN=${SYSTEMCTL_BIN:-systemctl}
DRAIN_WAIT_SECONDS=${DRAIN_WAIT_SECONDS:-3600}
DRAIN_POLL_SECONDS=${DRAIN_POLL_SECONDS:-1}

# A1：现场问 systemd 运行态确定当前活槽（零 app 状态文件——活槽本身就是 systemd 领地的运行态）。
if "$SYSTEMCTL_BIN" is-active --quiet copilot-api@a; then
  CUR=a
else
  CUR=b
fi
NEXT=$([ "$CUR" = a ] && echo b || echo a)
echo "当前活槽=$CUR，换代到=$NEXT"

# 启新槽，阻塞到 READY=1（Type=notify + notifyReady 的 sd_notify 腿）。
# 新槽起不来（新代码有 bug）= 零影响：systemctl start 失败、脚本止步于此，旧槽从未收到
# SIGUSR2、持续正常服务——这是相对「原地 restart」的硬优势。
"$SYSTEMCTL_BIN" start "copilot-api@$NEXT"

# B1：脚本发交接信号 → 旧槽停 accept + 无损 drain。绝不紧接着 `systemctl stop`：
# stop 会再发 SIGTERM，而 lifecycle 中的 SIGTERM 是用户明确要求强退，会撕毁 drain。
"$SYSTEMCTL_BIN" kill -s SIGUSR2 "copilot-api@$CUR"

deadline=$((SECONDS + DRAIN_WAIT_SECONDS))
while "$SYSTEMCTL_BIN" is-active --quiet "copilot-api@$CUR"; do
  if (( SECONDS >= deadline )); then
    echo "旧槽 copilot-api@$CUR 在 ${DRAIN_WAIT_SECONDS}s 内未完成无损 drain；保留两槽并停止换代" >&2
    exit 1
  fi
  sleep "$DRAIN_POLL_SECONDS"
done
if "$SYSTEMCTL_BIN" is-failed --quiet "copilot-api@$CUR"; then
  echo "旧槽 copilot-api@$CUR 以失败状态退出；保留 enablement 并停止换代" >&2
  exit 1
fi

# 翻转开机默认槽（enablement 符号链接，落在 systemd 配置态而非 app 状态）。
"$SYSTEMCTL_BIN" disable "copilot-api@$CUR"
"$SYSTEMCTL_BIN" enable "copilot-api@$NEXT"
echo "换代完成：活槽=$NEXT"
