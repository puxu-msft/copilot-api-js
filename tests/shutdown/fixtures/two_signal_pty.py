#!/usr/bin/env python3
import json
import os
import pty
import re
import select
import signal
import sys
import termios
import time

fixture = sys.argv[1] if len(sys.argv) > 1 else "tests/shutdown/fixtures/two-signal-process.ts"
middle_signal = sys.argv[2] if len(sys.argv) > 2 else None
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
    middle_alive = None
    tier2_alive = None
    status = None
    if middle_signal:
        match = re.search(rb"READY pid=(\d+)", output)
        if not match:
            raise RuntimeError(f"missing runtime pid in {bytes(output)!r}")
        runtime_pid = int(match.group(1))
        os.kill(runtime_pid, getattr(signal, middle_signal))
        time.sleep(0.2)
        waited, middle_status = os.waitpid(pid, os.WNOHANG)
        try:
            os.kill(runtime_pid, 0)
            runtime_alive = True
        except ProcessLookupError:
            runtime_alive = False
        middle_alive = waited == 0 and runtime_alive
        if waited == pid:
            status = middle_status
    if middle_alive is not False:
        # Tier 2 — the operator stops waiting for the request drain.
        # The process must NOT exit here: it still owes every durability barrier, and that is the whole difference between this tier and the escape hatch.
        os.write(fd, b"\x03")
        # Match the TIER marker, not the outcome wording. These fixture processes hold `gracefulShutdown` on a promise that never resolves, so they never reach the drain and tier 2 correctly reports that there was nothing to abandon — a different sentence from the one a real drain prints. What this layer proves is narrower than the banner text: the second signal selected tier 2 and the process SURVIVED it. Drain abandonment itself is proven at the component layer, which can inject a real drain source.
        read_until(b"Second termination signal")
        tier2_alive = os.waitpid(pid, os.WNOHANG)[0] == 0
        # Tier 3 — the escape hatch, which waits for nothing.
        os.write(fd, b"\x03")
    deadline = time.monotonic() + 2.0
    while status is None:
        waited, current_status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            status = current_status
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("child process did not exit within 2 seconds")
        time.sleep(0.01)
    lflag = termios.tcgetattr(fd)[3]
    print(json.dumps({"firstAlive": first_alive, "middleAlive": middle_alive, "tier2Alive": tier2_alive, "cookedBeforeSecondSignal": cooked_before_second_signal, "exitCode": os.waitstatus_to_exitcode(status), "canonical": bool(lflag & termios.ICANON), "echo": bool(lflag & termios.ECHO), "output": output.decode(errors="replace")}))
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(fd)
