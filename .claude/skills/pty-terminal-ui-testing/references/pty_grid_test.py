#!/usr/bin/env python3
"""
PTY self-test: drive a REAL interactive TerminalUi in a pty, hammer `space`
(collapsed<->panel toggle) while a numbered log stream runs, then assert with
pyte's HistoryScreen that NO numbered log line was eaten.

The user's invariant (2026-07-11): blank gaps are tolerable, EATING log lines is
the red line. So we check line-count continuity (SELFTEST-LOG-0001..N all
present in the scrollback), not blank-line absence.

Usage: python3 pty_grid_test.py [TOTAL_LOGS]
Exit 0 = no lines eaten; exit 1 = some line(s) eaten (prints which).
"""
import os, pty, select, subprocess, sys, time, struct, fcntl, termios, re
import pyte

ROWS, COLS = 24, 80
TOTAL = int(sys.argv[1]) if len(sys.argv) > 1 else 40
INTERVAL_MS = 120

def main():
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    env = dict(os.environ, DRIVER_LOGS=str(TOTAL), DRIVER_MS=str(INTERVAL_MS), FORCE_COLOR="0")
    p = subprocess.Popen(
        ["bun", "run", "exp/tui-rawmode/pty_selftest_driver.ts"],
        stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=env,
    )
    os.close(slave)

    # HistoryScreen keeps scrollback so lines that scrolled off the top are still
    # counted (a genuine "eaten" line never appears in history at all).
    screen = pyte.HistoryScreen(COLS, ROWS, history=2000, ratio=0.5)
    stream = pyte.ByteStream(screen)

    start = time.time()
    toggles = 0
    next_toggle = start + 0.25
    while True:
        if p.poll() is not None:
            # drain remaining output
            while True:
                r, _, _ = select.select([master], [], [], 0.2)
                if not r:
                    break
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    break
                stream.feed(data)
            break
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if data:
                stream.feed(data)
        # Hammer `space` (collapsed<->panel) every ~200ms while logs stream.
        now = time.time()
        if now >= next_toggle:
            try:
                os.write(master, b" ")
                toggles += 1
            except OSError:
                pass
            next_toggle = now + 0.2
        if now - start > 30:
            break

    try:
        p.wait(timeout=3)
    except Exception:
        p.kill()
    os.close(master)

    # Gather ALL text: scrollback history (top) + current screen.
    top_text = "\n".join(_row_text(row, COLS) for row in screen.history.top)
    cur_text = "\n".join(screen.display)
    bot_text = "\n".join(_row_text(row, COLS) for row in screen.history.bottom)
    alltext = top_text + "\n" + cur_text + "\n" + bot_text

    found = set(int(m) for m in re.findall(r"SELFTEST-LOG-(\d{4})", alltext))
    expected = set(range(1, TOTAL + 1))
    missing = sorted(expected - found)

    print(f"toggles sent: {toggles}")
    print(f"log lines expected: {TOTAL}, found in grid+scrollback: {len(found)}")
    if missing:
        print(f"❌ EATEN log lines (missing from scrollback): {missing[:30]}{'...' if len(missing)>30 else ''}")
        sys.exit(1)
    print("✅ no log line eaten — all SELFTEST-LOG-0001.."+f"{TOTAL:04} present")
    sys.exit(0)

def _row_text(row, cols):
    # pyte history rows are dict-like {col: Char}
    try:
        return "".join(row[c].data if c in row else " " for c in range(cols)).rstrip()
    except Exception:
        return ""

if __name__ == "__main__":
    main()
