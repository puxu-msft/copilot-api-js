// contrib/pm2/ecosystem.config.cjs
// pm2 托管样例：SIGINT/SIGTERM 触发既有 4-phase 优雅 drain（gracefulShutdown），
// process.send('ready') 与 systemd sd_notify 共用同一个 notifyReady() 钩子。
// 详见 docs/lifecycle.md「路径三：pm2」。
//
// 两个 app 条目（blue/green）而非一个：pm2 fork 模式的原生 `pm2 reload` 等价于重启
// （有 drain 间隙、非零停机），零停机换代改走与 systemd blue-green 同构的显式双槽 +
// 脚本/操作者显式 SIGUSR2 交接（不依赖任何"自动接管"——pm2 托管实例不写 pidfile，
// 见本目录 README.md「零停机换代」一节）。日常只运行其中一个槽；换代时临时并存。
const commonApp = {
  script: "src/main.ts",
  interpreter: "bun",
  args: "start",
  wait_ready: true, // 等 process.send('ready')（notifyReady 的 pm2 腿）
  listen_timeout: 30000,
  // 对齐 drain 宽限（shutdown.graceful_wait + abort_wait，默认 60+120=180s），留余量。
  // 若 config.yaml 调大过这两个值，须同步调大本项，否则 pm2 会在 drain 完成前 SIGKILL。
  kill_timeout: 200000,
  // pm2 stop/restart 默认发 SIGINT → 已被 setupShutdownHandlers 接住触发 4-phase drain。
}

module.exports = {
  apps: [
    { ...commonApp, name: "copilot-api-blue" },
    { ...commonApp, name: "copilot-api-green" },
  ],
}
