#!/usr/bin/env python3
import json
import os
import pty
import select
import signal
import sys
import termios
import time

fixture = sys.argv[1] if len(sys.argv) > 1 else "tests/shutdown/fixtures/two-signal-process.ts"
startup_delay_ms = int(os.environ.get("TWO_SIGNAL_READY_DELAY_MS", "0"))
READY_TIMEOUT = 6.0
pid, fd = pty.fork()
if pid == 0:
    if startup_delay_ms:
        time.sleep(startup_delay_ms / 1000)
    os.execvp("bun", ["bun", fixture])

output = bytearray()


def read_until(needle: bytes, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while needle not in output and time.monotonic() < deadline:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            raise RuntimeError(
                f"child exited before {needle!r}: exit={os.waitstatus_to_exitcode(status)} output={bytes(output)!r}"
            )
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            waited, status = os.waitpid(pid, 0)
            raise RuntimeError(
                f"child closed PTY before {needle!r}: pid={waited} exit={os.waitstatus_to_exitcode(status)} output={bytes(output)!r}"
            )
        if not chunk:
            waited, status = os.waitpid(pid, 0)
            raise RuntimeError(
                f"child closed PTY before {needle!r}: pid={waited} exit={os.waitstatus_to_exitcode(status)} output={bytes(output)!r}"
            )
        output.extend(chunk)
    if needle not in output:
        raise RuntimeError(f"timed out waiting for {needle!r}: output={bytes(output)!r}")


def wait_for_cooked_mode(timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        lflag = termios.tcgetattr(fd)[3]
        if (lflag & termios.ICANON) and (lflag & termios.ECHO):
            return
        time.sleep(0.005)
    lflag = termios.tcgetattr(fd)[3]
    raise RuntimeError(f"terminal did not restore cooked mode: lflag={lflag} output={bytes(output)!r}")


try:
    read_until(b"READY", READY_TIMEOUT)
    os.write(fd, b"\x03")
    read_until(b"graceful shutdown started")
    first_alive = os.waitpid(pid, os.WNOHANG)[0] == 0
    wait_for_cooked_mode()
    cooked_before_second_signal = True
    os.write(fd, b"\x03")
    deadline = time.monotonic() + 2.0
    while True:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("second Ctrl+C did not exit within 2 seconds")
        time.sleep(0.01)
    lflag = termios.tcgetattr(fd)[3]
    print(json.dumps({"firstAlive": first_alive, "cookedBeforeSecondSignal": cooked_before_second_signal, "exitCode": os.waitstatus_to_exitcode(status), "canonical": bool(lflag & termios.ICANON), "echo": bool(lflag & termios.ECHO), "output": output.decode(errors="replace")}))
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(fd)
