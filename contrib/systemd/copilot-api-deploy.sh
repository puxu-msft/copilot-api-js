#!/usr/bin/env bash
# contrib/systemd/copilot-api-deploy.sh —— A1 无状态发现活槽 + B1 脚本发交接信号。
# 详见 docs/lifecycle.md「路径二：systemd blue-green 模板单元 + reusePort」。
set -euo pipefail

# A1：现场问 systemd 运行态确定当前活槽（零 app 状态文件——活槽本身就是 systemd 领地的运行态）。
if systemctl is-active --quiet copilot-api@a; then
  CUR=a
else
  CUR=b
fi
NEXT=$([ "$CUR" = a ] && echo b || echo a)
echo "当前活槽=$CUR，换代到=$NEXT"

# 启新槽，阻塞到 READY=1（Type=notify + notifyReady 的 sd_notify 腿）。
# 新槽起不来（新代码有 bug）= 零影响：systemctl start 失败、脚本止步于此，旧槽从未收到
# SIGUSR2、持续正常服务——这是相对「原地 restart」的硬优势。
systemctl start "copilot-api@$NEXT"

# B1：脚本发交接信号 → 旧槽停 accept + 4-phase drain（与 SIGTERM 走同一套 gracefulShutdown，
# 仅日志区分 handoff vs 真关机）。
systemctl kill -s SIGUSR2 "copilot-api@$CUR"

# 旧槽 drain 完自行退出（exit 0，Restart=on-failure 不复活）后，stop 仅收敛 systemd 记账（幂等）。
systemctl stop "copilot-api@$CUR"

# 翻转开机默认槽（enablement 符号链接，落在 systemd 配置态而非 app 状态）。
systemctl disable "copilot-api@$CUR"
systemctl enable "copilot-api@$NEXT"
echo "换代完成：活槽=$NEXT"
