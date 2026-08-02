---
name: methodology-verify-running-server-has-fix-before-diagnosing-from-log
description: 从生产日志/事故 payload 判定「代码有缺陷」前，先核实产出它的进程是否含该修复（启动时间 vs 修复提交时间；更硬的是 payload 自证：落库字段的有无就是版本指纹）
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 40f4cfdd-1039-4814-bdb6-c7ce1b1813be
  modified: 2026-07-27T15:07:03.453Z
---

**一条刚出炉的生产日志，可能是一个跑着修复前代码的陈旧服务器进程打的。从日志断定「代码现在还有这个缺陷」之前，先核实运行中的进程是否已含该修复。** 属 [[methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth]] / verification 簇，但对象是「进程的代码版本」而非计数器接线。

**Why**：本项目 4141 主服务器用 `bun run ./src/main.ts start`（**无 `--hot`/`--watch`**）——启动后一直执行那一刻的源码快照，`git commit` 不会被它接住。所以「工作树/HEAD 已修」与「运行实例仍在犯病」可以同时为真。

**How to apply**：拿到日志事故要动手修前，三步核实——① `ps -o lstart,etime,cmd -p <pid>` 拿服务器**启动时刻**（`ss -tlnp | grep :<port>` 解析 pid）；② `git log -1 --format=%ci <fix-commit>` 拿修复**提交时刻**（`git merge-base --is-ancestor <fix> HEAD` 确认在祖先链）；③ 比较时区一致的两个时刻（`ps` 本地时 vs git UTC vs 服务日志时间——先 `date +%z` 校准）+ 确认进程无 `--hot`。若服务器启动早于修复 → 日志是陈旧码打的、代码可能已无可修，只需重启（本项目**绝不**擅自重启 4141 主服务器，交用户）。

实例（2026-07-14 gpt-5.6-sol NGHTTP2_CANCEL 事故）：用户贴 13:34 的 `frames=0` 断流日志要我修观测缺陷；探 History 上游轨证实是健康长流被误报后，进一步查到 translate leg 的 `frames=0` 缺陷**已由 41aeeba2（13:28 提交）修好**，而 4141 服务器 12:45 启动、无 --hot——日志是启动早于修复 43 分钟的陈旧进程打的。真正待修的是同类**其它腿**（缺口 A：responses/ws/cc/gemini 直连零诊断），而非事故那条已修的 translate leg。省下了重修已修代码。相关：[[feedback-fix-all-comparison-sites]]（真正缺口在其它未修腿）。

**更硬的判据——payload 自证版本（2026-07-27 事故补）**：`ps` 拿不到时（**远端实例**、别人的机器、事后取证），落库的诊断字段本身就是版本指纹——**某个字段随修复引入，它缺席就证明产出者是修复前的代码**，无需访问那台机器。实例：远端实例的 `does not support assistant message prefill` 400（entry `req_1785160010003_3754`），其 `pipelineInfo.sanitization[].destack`（今名 `blockLayout`）里**没有 `terminalRepairs` 字段**——该字段正是 07-26 修复 `a17c4191` 引入的；再加 entry 自带的 `process.bootTime`（早于修复 26 小时）双证。第三条腿是**离线重放**：把 entry 的**客户端** payload 灌进当前管线看产出是否合法（探针 `exp/thinking-terminal-block/probe-remote-c3-regression.ts`），三者一致 → 「升级即修复」，不必改代码。**做这个判定的顺序很重要**：先证「是不是我们现在的代码造的」，再决定改不改代码——否则容易照着陈旧症状去改一份已经正确的实现。

**复发一次即查「是不是同一台」（2026-07-28 二次事故补）**：`req_1785276101202_7795` 与上条事故的 `process` 指纹（`pid`/`bootTime`/`procStartTicks`/`version`）**逐字段相同** → 同一进程、上次归因后**没人升级它**，于是继续每轮必败。所以拿到同类事故的第二例，先比 `process` 指纹：**相同 = 归因正确但落实没发生**（该催的是部署，不是再查一遍代码）；**不同 = 才可能是新缺陷**。反面警示：`gitSha` 缺席**不能**推出「跑的是打包产物」——`initProcessIdentity` 把 git 查询的一切失败（binary 缺失、cwd 不在 checkout、权限、2s timeout）都折叠成不写该字段，只能说「git 身份未采集到」；这属 [[feedback-verify-facts-before-superlative-completeness-verdict]]（从缺字段反推唯一原因是结构推断，不是实测）。
