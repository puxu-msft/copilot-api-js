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

---

## 实测结果（2026-07-10，pty 无人化实测）

**终端型号**：pty via Python `pty.openpty()`（Linux/WSL2，util-linux `script` 亦可），固定 80x24、resize 场景改到 100x30 并发 SIGWINCH。**Bun 1.3.14**。所有结论均由抓取 pty 原始字节（hex dump）得出，非文档推断。

> pty 让 `isTTY=true`、`setRawMode` 生效，stdout 为 TTY 语义（与真终端一致，写同步）。但 pty 只是字节流，**无渲染层 / 无 scrollback / 无真实剪贴板**——凡涉及“视觉锚点是否漂移 / 闪烁 / 剪贴板是否真被写入”的判定，pty 验不了，需真人真终端复验（下逐条标注）。

### Q1 raw-mode + Ctrl-C：**YES（已实证闭合）**

喂 `a` `b` `0x03` `q`。抓到 `bytes: [03]  "."`，脚本打印 `SIGINT handler fired so far: false`，且进程在 Ctrl-C 后**仍存活**（ALIVE_AFTER_CTRLC=True），`q` 才正常退出（exit 0）。
- 结论：raw mode 下 Ctrl-C **以数据字节 `0x03` 进 stdin，不产 SIGINT**。→ controller **必须**自己捕获 `0x03` 转发 `handleShutdownSignal`，不能依赖 SIGINT。
- 关键字节：`... 62 [62="b"] ... 30 33 [03] ...`（见 raw-ctrlc 抓取）。

### Q2 sticky bottom region：**DECSTBM 胜出（byte 级已证；视觉需真人复验）**

同尺寸、同 resize 滥用对照两脚本，抓 CSI 序列频次：

| | relative-cursor (`sticky-region.ts`) | DECSTBM (`sticky-region-decstbm.ts`) |
|---|---|---|
| 定位方式 | 相对：`\x1b[3F`(上 3 行) + `\x1b[0J`(清到屏末) + `\x1b[s` | **绝对**：`\x1b[<row>;1H` + `\x1b[2K` + DECSC/DECRC(`\x1b7`/`\x1b8`) |
| 滚动区 | 无 | `\x1b[1;21r`(80x24, bottom=24-3)；resize 后 **`\x1b[1;27r`**(30-3) 正确重建 |
| resize 重锚 | 仅在当前光标处重画 region 内容（**无重定位**） | `\x1b[2J` + 新 DECSTBM + panel 重定位到 28-30 行（**完整重锚**） |
| 退出复位 | 无需（从未设滚动区） | **`\x1b[r`（复位滚动区）+ `\x1b[?25h`（显光标）** 均在退出尾字节出现 |
| 超长行截断 | ✓ 到宽度（尾部 `…`） | ✓ 到宽度（尾部 `…`） |
| 转义序列合法性 | ✓ 全合法（仅 3F/s/0J） | ✓ 全合法、well-formed |

- **byte 级裁决**：DECSTBM **correct-by-construction**——绝对定位 + 真滚动区，底部 panel 由终端本身钉住，日志区原生滚动**不可能**扰动 panel；退出干净复位（`\x1b[r`+`\x1b[?25h`，实测尾字节 `1b 5b 72 1b 5b 3f 32 35 68`），不留坏终端。relative-cursor **fragile-by-construction**——靠“光标在 region 正下方”的假设做相对上移（`\x1b[3F`），一旦底部写触发整屏原生滚动，锚点即失配。
- **定 `region.ts` 默认技术 = DECSTBM 滚动区。**
- **pty 验不了、需真人真终端复验**：① 视觉锚点在**原生滚动**下是否真漂移/重复（pty 无 scrollback 渲染，只能从构造推断）；② 100ms 定时重画 vs 用户原生滚动的**闪烁/打架**（感知性）；③ resize 后旧行成孤儿的观感。byte 证据强烈支持 DECSTBM，但最终视觉体验须人眼确认。

### Q3 OSC 52 复制：**wire YES；剪贴板 inconclusive（需真人）**

抓到发出字节 `\x1b]52;c;aGVsbG8tcmVxLTEyMzQ1\x07`（hex `1b 5d 35 32 3b 63 3b … 07`），base64 `aGVsbG8tcmVxLTEyMzQ1` 解码 = **`hello-req-12345`**，与载荷精确一致。
- 结论：OSC52 **线上字节正确**（格式 `ESC ] 52 ; c ; <base64> BEL` 无误）。
- **pty 验不了、需真人真终端复验**：字节能否真正写入**系统剪贴板**（跨 iTerm2 / Windows Terminal / tmux passthrough / ssh 各不同，且多数终端默认需开启 clipboard 权限）。pty 无真实剪贴板，无法 `Ctrl-V` 验证。若真终端不生效 → RFC 退回“醒目显示 req_id 供鼠标选”。

### Q4 崩溃 / exit-hook 终端还原：**YES（承重，已实证闭合）**

复刻 main.ts：raw mode + 藏光标 `\x1b[?25l` → 1s 后 `throw` → `uncaughtException` handler → `process.exit(1)`，唯一还原路径是 `process.on("exit")` 钩子。抓 pty 输出**尾字节**：
```
… process.exit(1)\r\n \x1b[?25h \r\n [exit hook ran: setRawMode(false) + show-cursor written]\r\n
tail hex: … 1b 5b 3f 32 35 68 [= \x1b[?25h 显光标] 0d 0a 5b 65 78 69 74 20 68 6f 6f 6b …
```
- exit code = **1**（匹配 process.exit(1)）；`\x1b[?25h` **与 marker 文本均在退出前 flush 到 pty**。
- 结论：Bun 1.3.14 下、**stdout 为 TTY 时**，`process.on("exit")` 钩子的同步转义序列写**确实被 flush**，终端还原有效。此处 Bun 已知雷区**未触发**。
- 谨慎注记（非 pty 局限，是稳健性建议）：本结论成立的前提是 stdout 为 TTY（同步写）——真终端 stdout 正是 TTY，故有代表性；但若 stdout 被重定向为 pipe，Bun 的异步 flush 可能不同。稳妥起见仍建议在 throw 点/finally 保留一条同步还原，exit hook 作兜底（而非唯一）。本测试中 exit hook **未坏**。

### 汇总：哪些 open question 已实证闭合 / 哪些仍需真人真终端

- **已实证闭合（pty 原始字节充分）**：Q1（Ctrl-C→0x03 无 SIGINT）、Q3-wire（OSC52 字节正确解码）、Q4（Bun exit-hook 同步 flush 还原字节有效）、Q2 的**序列合法性 / DECSTBM 正确设置与退出复位 / resize 时 DECSTBM 按新底重建 / 超长行截断**。
- **仍需真人真终端复验**：Q2 的**原生滚动下视觉锚点漂移**、**100ms 重画 vs 原生滚动的闪烁/打架**观感（DECSTBM byte 证据强，但视觉待人眼终审）；Q3 的**系统剪贴板是否真被写入**（跨终端 / tmux / ssh，且需 clipboard 权限）。
