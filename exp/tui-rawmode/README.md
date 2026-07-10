# TUI raw-mode / sticky-region / OSC52 PoC

交互式 live query TUI（RFC `docs/rfc/2026-07-10-interactive-tui-live-panel.md`）落地前，三个**必须在真终端实测**的不确定点。工具沙箱 stdin 非 TTY（`setRawMode` 都不存在），故交给人在真终端跑。

运行：`bun exp/tui-rawmode/<script>.ts`（**不经服务器**，纯独立脚本）。

## PoC-1 raw-mode + Ctrl-C：`raw-ctrlc.ts`

验：raw mode 下 `Ctrl-C` 是否以字节 `0x03` 进 stdin（而非产 SIGINT）？SIGINT 是否仍触发？→ 决定 controller 必须捕获 `0x03` 转发 `handleShutdownSignal`。

**观察**：按各种键，脚本打印每个字节的 hex。按 `Ctrl-C`——若打印 `03` 且脚本没退出，则「Ctrl-C 变 data」假设成立（controller 必须自己转发关闭）。按 `q` 正常退出。若脚本还监听了 `SIGINT` 且它触发，一并记录。

## PoC-2 sticky bottom region：`sticky-region.ts`（相对光标） vs `sticky-region-decstbm.ts`（DECSTBM 滚动区）

验：日志在上滚动 + 底部固定 N 行 region 重画，Bun 下光标管理是否无错位/闪烁？**两种技术 bench-off**——相对光标（`\x1b[NF`+`\x1b[0J`，log-update/ink 那套）在「region+日志超终端高度、终端原生滚动」时会锚点失配；DECSTBM 滚动区（`\x1b[<top>;<bottom>r`，tmux/htop 那套）保留 scrollback + 划底部保留区不受滚动扰动。

**观察**（两个脚本用**同样的**滥用测试对照）：让日志填满超过屏高触发原生滚动 → 底部 3 行 panel 是否始终贴底、不 drift/不重复？**拖动 resize** → region 是否在新底部重建？超长行随宽度截断？`Ctrl-C`/`q` 退出（DECSTBM 版**必须** `\x1b[r` 复位滚动区，否则终端留坏）。记录三场景（超高 / resize / native-scroll）下哪种存活 → 定 `region.ts` 默认技术。

显式验收项：① 100ms 定时重画 vs 用户原生滚动是否打架；② resize 时 `rows` 变化的**重锚**（region 高度变、旧行成孤儿）。

## PoC-3 OSC 52 复制：`osc52-copy.ts`

验：`\x1b]52;c;<base64>\x07` 能否写入终端剪贴板（跨 tmux/ssh/常见终端）？否则 RFC 退回「醒目显示 req_id 供鼠标选」。

**观察**：脚本发一个 OSC52 写「hello-req-12345」。到别处 `Ctrl-V` 粘贴，若得到该串则可行。记录你的终端（iTerm2/Windows Terminal/tmux/…）与结果。

## PoC-4 崩溃 / exit-hook 终端还原：`crash-restore.ts`

验：进程经 `process.exit(1)`（main.ts uncaughtException 路径）死亡时，`process.on("exit")` 钩子能否**可靠还原终端**——尤其 Bun 下同步写转义序列（`setRawMode(false)` + 显光标 `\x1b[?25h`）是否在真正退出前 flush？（Bun exit-hook 同步 flush 是 `bun-node-runtime-gotchas` 已知雷区。）

**观察**：脚本开 raw mode + 藏光标，注册 exit hook，1s 后抛 uncaughtException（复刻 main.ts 的 `process.exit(1)`）。退出后：能否正常打字（echo/Ctrl-C 工作）？光标可见？若终端卡死（无 echo、光标不见），则 exit-hook 还原**没 flush**——RFC 绝不能只靠 `process.on("exit")`，须另找同步还原点。

## 结论回填

跑完把结果填到本 README 末尾（终端型号 + 四问 yes/no + PoC-2 哪种技术存活），RFC 的 open-questions 据此定稿。
