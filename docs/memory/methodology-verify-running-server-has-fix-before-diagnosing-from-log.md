---
name: methodology-verify-running-server-has-fix-before-diagnosing-from-log
description: 从生产日志判定「代码有缺陷」前，先核实跑着的服务器进程是否含该修复（启动时间 vs 修复提交时间、无 --hot 不热重载）
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 40f4cfdd-1039-4814-bdb6-c7ce1b1813be
---

**一条刚出炉的生产日志，可能是一个跑着修复前代码的陈旧服务器进程打的。从日志断定「代码现在还有这个缺陷」之前，先核实运行中的进程是否已含该修复。** 属 [[methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth]] / verification 簇，但对象是「进程的代码版本」而非计数器接线。

**Why**：本项目 4141 主服务器用 `bun run ./src/main.ts start`（**无 `--hot`/`--watch`**）——启动后一直执行那一刻的源码快照，`git commit` 不会被它接住。所以「工作树/HEAD 已修」与「运行实例仍在犯病」可以同时为真。

**How to apply**：拿到日志事故要动手修前，三步核实——① `ps -o lstart,etime,cmd -p <pid>` 拿服务器**启动时刻**（`ss -tlnp | grep :<port>` 解析 pid）；② `git log -1 --format=%ci <fix-commit>` 拿修复**提交时刻**（`git merge-base --is-ancestor <fix> HEAD` 确认在祖先链）；③ 比较时区一致的两个时刻（`ps` 本地时 vs git UTC vs 服务日志时间——先 `date +%z` 校准）+ 确认进程无 `--hot`。若服务器启动早于修复 → 日志是陈旧码打的、代码可能已无可修，只需重启（本项目**绝不**擅自重启 4141 主服务器，交用户）。

实例（2026-07-14 gpt-5.6-sol NGHTTP2_CANCEL 事故）：用户贴 13:34 的 `frames=0` 断流日志要我修观测缺陷；探 History 上游轨证实是健康长流被误报后，进一步查到 translate leg 的 `frames=0` 缺陷**已由 41aeeba2（13:28 提交）修好**，而 4141 服务器 12:45 启动、无 --hot——日志是启动早于修复 43 分钟的陈旧进程打的。真正待修的是同类**其它腿**（缺口 A：responses/ws/cc/gemini 直连零诊断），而非事故那条已修的 translate leg。省下了重修已修代码。相关：[[feedback-fix-all-comparison-sites]]（真正缺口在其它未修腿）。
