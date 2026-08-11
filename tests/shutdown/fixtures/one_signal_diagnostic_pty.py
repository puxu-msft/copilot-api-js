#!/usr/bin/env python3
import json
import os
import pty
import select
import signal
import sys
import time

if len(sys.argv) not in (2, 3):
    raise SystemExit("usage: one_signal_diagnostic_pty.py <diagnostic-directory> [fixture]")

directory = sys.argv[1]
fixture = sys.argv[2] if len(sys.argv) == 3 else "tests/shutdown/fixtures/diagnostic-shutdown-process.ts"
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bun", ["bun", fixture, directory])

output = bytearray()


def read_available(timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            return
        if not chunk:
            return
        output.extend(chunk)


def read_until(needle: bytes, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while needle not in output and time.monotonic() < deadline:
        read_available(0.05)
    if needle not in output:
        raise RuntimeError(f"missing {needle!r} in {bytes(output)!r}")


try:
    read_until(b"READY")
    os.write(fd, b"\x03")
    deadline = time.monotonic() + 5.0
    while True:
        read_available(0.05)
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            read_available(0.1)
            break
        if time.monotonic() >= deadline:
            raise RuntimeError(f"first Ctrl+C did not complete shutdown within 5 seconds: {bytes(output)!r}")
    print(json.dumps({"exitCode": os.waitstatus_to_exitcode(status), "output": output.decode(errors="replace")}))
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(fd)
