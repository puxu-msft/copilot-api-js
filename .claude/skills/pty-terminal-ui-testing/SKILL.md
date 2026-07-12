---
name: pty-terminal-ui-testing
description: 当需要自动化验证一个 raw-mode / ANSI TUI（DECSTBM 滚动区、备用屏幕、光标停泊、footer/面板重绘）的真实屏幕效果、而非只断言字节流时使用——用 Python 内置 pty 分配真伪终端驱动真 TUI 进程、pyte 把输出字节流解释成屏幕网格 + scrollback（HistoryScreen），断言「日志行没被吞 / 面板钉在底部 / 退出干净还原」等字节级单测证不了的整屏不变量。核心纪律：正样本对照（先证工具能抓到坏行为再信绿）、零填充编号防子串误配、连跑多次证时序确定性。取代「把真终端验证甩给用户手动复验」。本项目落地在 exp/tui-rawmode/pty_*.{py,ts}。
---

# PTY + pyte 自动化验证 raw-mode TUI

## 为什么需要它

raw-mode TUI 用 DECSTBM 滚动区（`\x1b[<t>;<b>r`）、绝对光标定位、备用屏幕（`\x1b[?1049h`）、DECSC/DECRC 停泊等把面板钉在屏底、日志在上方滚动。**这些的正确性是「整屏效果」，不是「某个字节存在」**：

- 字节级单测能断言「发了 `\x1b[1;23r`」，但**证不了**「切换视图时底部日志行有没有被新面板覆盖吃掉」——那要把整个字节流按终端语义解释成 24×80 的屏幕网格 + scrollback 才看得出。
- 因此这类 bug（吞行 / 空行 gap / footer 泄漏进历史 / 退出残留在备用屏）长期只能靠人肉重启真终端复验。**这是错的**——应该自己驱动伪终端把结果解释成网格来验证。

## 工具栈（都是现成的）

- **Python 内置 `pty`**：`pty.openpty()` 分配真 master/slave 伪终端对，`fcntl.ioctl(slave, TIOCSWINSZ, ...)` 设窗口大小，子进程的 stdin/stdout/stderr 接 slave → 子进程眼里是真 TTY（`isTTY===true`、`setRawMode` 可用）。
- **`pyte`**（`pip install pyte`）：纯 Python VT100 终端模拟器。`pyte.Screen(cols, rows)` + `pyte.ByteStream` 把喂进去的字节流解释成 `screen.display`（每行字符串）。**`pyte.HistoryScreen`** 额外保留 scrollback（`screen.history.top`），滚出屏顶的行仍可查——这是断言「没吞行」的关键（真被吃的行在 history 里也查不到）。

## 三步骨架（可复用实现在 `references/`）

1. **[pty_pyte_smoke.py](references/pty_pyte_smoke.py)** —— 先验证管线本身：spawn 一个只打几行 + DECSTBM sticky bar 的子进程，断言 pyte 把 bar 解释到正确行。**建管线先跑 smoke，别一上来接真 TUI。**
2. **[driver 模式](references/pty_selftest_driver.ts)** —— 一个 bun/node 脚本在 PTY 内驱**真** TUI 类（真事件流 + 真 raw-mode stdin），定时发编号事件、受键盘输入切换视图，跑完 `destroy()` 干净退出。**必须是生产同一个类、同一条接线**（不是 mock），否则测的不是真行为。
3. **[pty_grid_test.py](references/pty_grid_test.py)** —— Python harness 用 pty 起 driver，边喂键盘输入（如反复 `space` 切视图）边读输出喂 pyte HistoryScreen，跑完把 `history.top + display` 拼成全文，用正则数编号行是否连续，缺号 = 被吞。

## 关键纪律（踩过的坑）

- **正样本对照先行（最重要，呼应 `empirical-verification`「通过不自证」）**：一个报「0 吞行」的绿结果**不可信**，除非你先证明它能抓到坏行为——临时把修复代码删掉（如去掉 scroll-before-grow），跑同一测试，**必须变红并报出具体缺号**；再恢复、变绿。本项目实测：N=1 无防护吞 19/40 行、加防护 0 吞——这个红/绿对照才让绿有意义。
- **零填充编号防子串误配**：日志标签用 `LOG-0009` 而非 `LOG-9`，否则 `not.toContain("LOG-9")` 会被 `LOG-90..99` 误命中、`found` 集合数错。用 `re.findall(r"LABEL-(\d{4})", alltext)` 收集、与 `set(range(1,N+1))` 求差。
- **时序确定性连跑**：pty + 定时器是时序相关的，单次绿不够。**连跑 8–25 次、不同事件速率/数量**，全绿才算确定（flaky 见 `empirical-verification`）。键盘输入用墙钟节流（每 ~200ms 发一次），别和事件流严格同帧。
- **HistoryScreen 不是 Screen**：普通 `Screen` 只有当前屏、滚出去的行没了，会把「正常滚出屏」误判成「吞行」。必须 `HistoryScreen(cols, rows, history=2000)` 并把 `history.top` 也纳入断言全文。history 行是 dict-like（`{col: Char}`），取文本要 `"".join(row[c].data ...)`。
- **别把服务器启起来**：driver 只实例化 TUI 类跑事件，**不启 HTTP server**（本项目 `no-auto-server-no-kill`）；它像跑测试，不像跑 dev。
- **干净退出**：driver 跑完必 `destroy()`/还原（`setRawMode(false)` + 复位 DECSTBM `\x1b[r` + 退备用屏 `\x1b[?1049l`），否则 pty 关闭时终端状态泄漏、下次跑受污染。

## 能断言哪些整屏不变量

- **不吞行**：编号日志连续无缺号（本项目主用例）。
- **面板钉底**：footer/panel 内容出现在 `screen.display[rows-panelHeight ..]`、日志在其上。
- **退出干净**：跑崩溃/退出路径后，末屏无备用屏残留、光标可见、无半行覆盖。
- **detail 全屏可滚**：进备用屏后超屏内容能滚动（不被残留滚动区截断）。

## 与其它 skill 的关系

- 正样本对照、连跑证确定性、通过不自证 → `empirical-verification`（本 skill 是其在「TUI 整屏效果」维度的落地 oracle）。
- 纯字节级 TUI 断言（不需要屏幕语义时，如「发了某 escape 序列」「顺序对」）仍用 bun 单测（`tests/tui/`）——两者互补：字节测机制、pty+pyte 测整屏效果。
- TUI 渲染架构本身（DECSTBM 恒定/N=1、scroll-before-grow、备用屏）见 `docs/DESIGN.md`「渲染模型」+ spec/plan `2026-07-11-tui-render-model-layered`。
