// contrib/pm2/ecosystem.config.cjs
// pm2 托管样例：SIGINT/SIGTERM 触发既有 4-phase 优雅 drain（gracefulShutdown），
// process.send('ready') 与 systemd sd_notify 共用同一个 notifyReady() 钩子。
// 详见 docs/lifecycle.md「路径三：pm2」。
//
// 注意：pm2 fork 模式的原生 `pm2 reload` 等价于重启（有 drain 间隙、非零停机）；
// 零停机换代不依赖 pm2 reload，见本目录 README.md「零停机换代」一节。
module.exports = {
  apps: [
    {
      name: "copilot-api",
      script: "src/main.ts",
      interpreter: "bun",
      args: "start",
      wait_ready: true, // 等 process.send('ready')（notifyReady 的 pm2 腿）
      listen_timeout: 30000,
      // 对齐 drain 宽限（shutdown.graceful_wait + abort_wait，默认 60+120=180s），留余量。
      // 若 config.yaml 调大过这两个值，须同步调大本项，否则 pm2 会在 drain 完成前 SIGKILL。
      kill_timeout: 200000,
      // pm2 stop/restart 默认发 SIGINT → 已被 setupShutdownHandlers 接住触发 4-phase drain。
    },
  ],
}
