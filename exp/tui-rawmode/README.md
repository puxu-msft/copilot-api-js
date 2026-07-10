# TUI raw-mode / sticky-region / OSC52 PoC

交互式 live query TUI（RFC `docs/rfc/2026-07-10-interactive-tui-live-panel.md`）落地前，三个**必须在真终端实测**的不确定点。工具沙箱 stdin 非 TTY（`setRawMode` 都不存在），故交给人在真终端跑。

运行：`bun exp/tui-rawmode/<script>.ts`（**不经服务器**，纯独立脚本）。

## PoC-1 raw-mode + Ctrl-C：`raw-ctrlc.ts`

验：raw mode 下 `Ctrl-C` 是否以字节 `0x03` 进 stdin（而非产 SIGINT）？SIGINT 是否仍触发？→ 决定 controller 必须捕获 `0x03` 转发 `handleShutdownSignal`。

**观察**：按各种键，脚本打印每个字节的 hex。按 `Ctrl-C`——若打印 `03` 且脚本没退出，则「Ctrl-C 变 data」假设成立（controller 必须自己转发关闭）。按 `q` 正常退出。若脚本还监听了 `SIGINT` 且它触发，一并记录。

## PoC-2 sticky bottom region：`sticky-region.ts`

验：日志在上滚动 + 底部固定 N 行 region 重画，Bun 下光标管理是否无错位/闪烁？窗口 resize（拖动改宽高）时是否即时重算不破屏？

**观察**：脚本每 300ms 在上方打印一条递增「日志」，底部恒 3 行 region 显时间/宽高/一条超长行（应被截断）。**拖动终端改大小**，确认 region 始终贴底、不串行、超长行随宽度截断。`Ctrl-C`/`q` 退出（须能还原终端）。

## PoC-3 OSC 52 复制：`osc52-copy.ts`

验：`\x1b]52;c;<base64>\x07` 能否写入终端剪贴板（跨 tmux/ssh/常见终端）？否则 RFC 退回「醒目显示 req_id 供鼠标选」。

**观察**：脚本发一个 OSC52 写「hello-req-12345」。到别处 `Ctrl-V` 粘贴，若得到该串则可行。记录你的终端（iTerm2/Windows Terminal/tmux/…）与结果。

## 结论回填

跑完把结果填到本 README 末尾（终端型号 + 三问 yes/no），RFC 的 open-questions 据此定稿。
