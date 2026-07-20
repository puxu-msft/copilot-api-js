#!/usr/bin/env python3
import fcntl
import json
import os
import pty
import select
import signal
import termios
import time

FIXTURE = "tests/tui/pty/drivers/job-control.ts"


def read_until(fd: int, output: bytearray, needle: bytes, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while needle not in output and time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
    if needle not in output:
        raise RuntimeError(f"missing {needle!r}: {bytes(output)!r}")


def wait_for(pid: int, stopped: bool, timeout: float = 3.0) -> int:
    deadline = time.monotonic() + timeout
    flags = os.WNOHANG | (os.WUNTRACED if stopped else 0)
    while time.monotonic() < deadline:
        waited, status = os.waitpid(pid, flags)
        if waited == pid:
            if stopped and not os.WIFSTOPPED(status):
                raise RuntimeError(f"child changed state without WIFSTOPPED: {status}")
            return status
        time.sleep(0.01)
    raise RuntimeError("child state transition timed out")


signal.signal(signal.SIGHUP, signal.SIG_IGN)

# Become the controlling-session parent. The Bun child gets its own foreground
# process group, whose parent remains in this session but outside that group;
# therefore POSIX SIGTSTP is not discarded as an orphaned-group stop signal.
os.setsid()
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setpgid(0, 0)
    for target in (0, 1, 2):
        os.dup2(slave, target)
    if slave > 2:
        os.close(slave)
    os.execvp("bun", ["bun", FIXTURE])

try:
    try:
        os.setpgid(pid, pid)
    except PermissionError:
        pass
    previous_ttou = signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    os.tcsetpgrp(slave, pid)
    signal.signal(signal.SIGTTOU, previous_ttou)
    os.close(slave)
    output = bytearray()
    read_until(master, output, b"READY")
    os.write(master, b"\x1a")
    stopped_status = wait_for(pid, stopped=True)
    cooked_flags = termios.tcgetattr(master)[3]
    os.killpg(pid, signal.SIGCONT)
    read_until(master, output, b"RESUMED")
    raw_flags = termios.tcgetattr(master)[3]
    os.write(master, b"q")
    exit_status = wait_for(pid, stopped=False)
    result = {
        "wifstopped": os.WIFSTOPPED(stopped_status),
        "stopSignal": os.WSTOPSIG(stopped_status),
        "cookedCanonical": bool(cooked_flags & termios.ICANON),
        "cookedEcho": bool(cooked_flags & termios.ECHO),
        "resumedRaw": not bool(raw_flags & termios.ICANON),
        "resumedNoEcho": not bool(raw_flags & termios.ECHO),
        "exitCode": os.waitstatus_to_exitcode(exit_status),
    }
    print(json.dumps(result))
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    os.close(master)
