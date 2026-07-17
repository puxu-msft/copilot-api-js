#!/usr/bin/env python3
# exp/graceful-restart-sdnotify/dgram-server.py
#
# 模拟 systemd 的 $NOTIFY_SOCKET：一个真实的 AF_UNIX SOCK_DGRAM server，
# 监听给定路径，收到任意 datagram 就打印出来（用于验证各候选发送方是否真的把
# "READY=1" 发到了这个 socket）。
#
# Usage: python3 dgram-server.py <socket-path> [--once]
#   --once: 收到一条消息后立即退出（供 shell 脚本同步等待用）。
import os
import socket
import sys

path = sys.argv[1]
once = "--once" in sys.argv[2:]

if os.path.exists(path):
    os.unlink(path)

srv = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
srv.bind(path)
srv.settimeout(5.0)

print(f"[dgram-server] listening on {path}", flush=True)

try:
    while True:
        data, _addr = srv.recvfrom(4096)
        print(f"[dgram-server] received: {data!r}", flush=True)
        if once:
            break
except socket.timeout:
    print("[dgram-server] timeout waiting for datagram", flush=True)
    sys.exit(1)
finally:
    srv.close()
    if os.path.exists(path):
        os.unlink(path)
