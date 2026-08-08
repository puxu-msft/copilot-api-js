// contrib/pm2/ecosystem.config.cjs
// pm2 托管样例：SIGINT/SIGTERM 停止 ingress 并无损 drain 已接纳请求，
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
  // pm2 必须配置有限 hard timeout；它不是应用级请求 deadline。取值应大于
  // timeouts.request_deadline 加 durability 余量，否则会在无损 drain 完成前 SIGKILL。
  kill_timeout: 1300000,
  // pm2 stop/restart 默认发 SIGINT → setupShutdownHandlers 接住并启动无损 drain。
}

module.exports = {
  apps: [
    { ...commonApp, name: "copilot-api-blue" },
    { ...commonApp, name: "copilot-api-green" },
  ],
}
