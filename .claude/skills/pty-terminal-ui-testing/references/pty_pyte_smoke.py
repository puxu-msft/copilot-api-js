#!/usr/bin/env python3
"""Prove the pty + pyte pipeline: spawn a child that writes ANSI, parse the grid."""
import os, pty, select, subprocess, sys
import pyte

ROWS, COLS = 24, 80

def run(child_cmd):
    master, slave = pty.openpty()
    # set winsize on the slave so the child sees ROWS x COLS
    import struct, fcntl, termios
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    p = subprocess.Popen(child_cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)
    buf = b""
    while True:
        r, _, _ = select.select([master], [], [], 2.0)
        if not r:
            break
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        stream.feed(data)
    p.wait(timeout=5)
    os.close(master)
    return screen

if __name__ == "__main__":
    # trivial child: print 3 lines then a DECSTBM sticky bottom bar
    child = ["bash", "-c",
             "printf 'line1\\nline2\\nline3\\n'; printf '\\x1b[1;23r'; printf '\\x1b[23;1H'; printf '\\x1b7\\x1b[24;1H\\x1b[2KBOTTOM-BAR\\x1b8'; sleep 0.2"]
    screen = run(child)
    grid = [screen.display[i].rstrip() for i in range(ROWS)]
    print("=== non-empty grid rows ===")
    for i, row in enumerate(grid):
        if row:
            print(f"[{i:2}] {row!r}")
