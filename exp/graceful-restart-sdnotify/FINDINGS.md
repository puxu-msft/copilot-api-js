# sd_notify 传输选型 PoC 结论

- Bun 版本: 1.3.14
- 环境: WSL2 Linux 6.18.33.2-microsoft-standard-WSL2，`systemd-notify` 二进制存在于 `/usr/bin/systemd-notify`
- Mock server: `dgram-server.py`（真实 Python `socket.AF_UNIX, socket.SOCK_DGRAM`，`bind()` 后 `recvfrom()`，模拟 systemd `$NOTIFY_SOCKET` 的 datagram 端点）
- 探针: `probe.ts`（3 次独立连跑，结果稳定一致）

## 候选逐项实测结果

### 候选 0（对照）：`node:dgram unix_dgram`

**FAIL（预期内，B3 已知）**：`dgram.createSocket("unix_dgram")` 直接抛
`Bad socket type specified. Valid types are: udp4, udp6`。Bun 与 Node 的 `node:dgram`
实现均只支持 UDP over IP，不支持 AF_UNIX SOCK_DGRAM。本次重新核实确认与计划记录一致。

### 候选 1：`bun:ffi` 直接 `socket(2)` + `sendto(2)` syscall

**PASS（3/3 连跑稳定）**。

实现要点：
- `dlopen("libc.so.6", { socket, sendto, close })`，用 `FFIType.i32`/`FFIType.ptr`/`FFIType.u64` 声明签名。
- 手工构造 `struct sockaddr_un`（Linux x86_64: `u16 sun_family` + `char sun_path[108]`），
  `sun_family` 用小端 `DataView.setUint16(0, AF_UNIX, true)`（该平台原生字节序）。
- `sendto` 的地址长度参数须是 `2（family）+ 路径字节数 + 1（NUL 终止符）`——已验证含 NUL 终止符可正确投递（不含也大概率可行，systemd 两种都接受，但含 NUL 更贴近 glibc 惯例）。
- 每次运行 server 都真实收到 `b'READY=1'`，`sendto` 返回值 = 已发送字节数（7，即 `"READY=1"` 长度）。

优点：**零外部运行时依赖**（不依赖任何二进制或原生 npm 包），纯 syscall，Bun 原生支持
`bun:ffi`（无需额外安装）。可控性最高，能精确构造 abstract socket（`\0` 前导路径）等边缘情形。

缺点：需要手写 `sockaddr_un` 结构体的字节布局（平台相关，但 Linux x86_64/arm64 的
`sockaddr_un` 布局是稳定 ABI，风险可控），代码略显底层。

### 候选 2：spawn `systemd-notify` 二进制

**PASS（3/3 连跑稳定，需加 `--no-block` 参数）**。

首次实测遇到非预期的 `Failed to invoke barrier: Connection refused`（退出码 1）——
根因是 `systemd-notify` 默认会与 socket 对端做一次「barrier」同步握手确认消息已被处理，
真实 `systemd` PID 1 会响应该握手，但本 PoC 的 mock Python dgram server 只是简单
`recvfrom` 一次就退出、不实现 barrier 协议，导致握手失败。加 `--no-block` 参数跳过
该握手后，恢复正常（退出码 0，server 正确收到 `READY=1`）。**这是 mock server 的局限，
不是候选本身的缺陷**——对接真实 systemd 时 `--no-block` 依然安全可用（含义是「不等待
barrier 确认」，systemd sd_notify 协议本身允许 fire-and-forget）。

优点：实现最简单（一行 `Bun.spawn`），行为与官方 `sd_notify(3)` C 库完全一致（就是调用
的同一套逻辑），维护成本低。

缺点：引入运行时对 `systemd-notify` 二进制的依赖（仅 systemd 环境本就自带
`systemd`/`systemd-utils` 包，可接受；但非 systemd 环境下这条路径根本不会被触发，因为
`detectSupervisor()` 已按 `NOTIFY_SOCKET`/`INVOCATION_ID` 判定，只有确认在 systemd 下才会调用）。

### 候选 3：原生绑定包（以 `sd-notify@2.8.0` 为代表）

**FAIL（隔离 `/tmp` 临时目录验证，未污染项目依赖）**。

- `bun add sd-notify` 触发 postinstall `node-gyp rebuild`；Bun 默认拦截未信任脚本
  （`Blocked 1 postinstall`）。
- `bun pm trust sd-notify` 放行后真实编译，编译期报错：
  `../notify.cc:5:10: fatal error: systemd/sd-daemon.h: No such file or directory`
  （本机未装 `libsystemd-dev`）。
- 即便补装对应 `-dev` 头文件包能编译通过，`node-gyp` 原生绑定在 Bun 运行时加载 `.node`
  文件仍是公认的系统性风险点（ABI/N-API 版本不匹配、跨平台预编译包缺失等），与计划文档
  「`sd-notify` 包实测 Bun 下加载失败，node-gyp 预编译包在 Bun 有系统性风险」的预判一致。

## 选定方案

**候选 1：`bun:ffi socket(2)` + `sendto(2)` 直接 syscall。**

理由：
1. 零外部运行时依赖（不依赖 systemd-utils 二进制存在、不依赖原生 npm 包编译），
   与项目「never-throw 边界」原则契合——失败模式可控且局限于本进程内。
2. `bun:ffi` 是 Bun 一等公民 API，无需任何额外安装步骤，实现完全自包含在 TypeScript 源码里。
3. 3/3 连跑稳定 PASS，行为确定。
4. 候选 2（spawn systemd-notify）作为**可选 fallback**记录：若未来发现某些精简
   systemd 容器镜像里 `bun:ffi` + `libc.so.6` 动态链接有问题（本次未观测到），可退回
   spawn 方案；但当前无需要退回的证据，直接选候选 1。

**Task 9 的 `sendDatagram()` 按候选 1（`bun:ffi` + `socket`/`sendto`/`close`）实现**，
关键实现细节（`sockaddr_un` 布局、`sendto` 地址长度含 NUL 终止符、AF_UNIX=1/SOCK_DGRAM=2
常量）均已在本 PoC 验证过，可直接照抄进正式实现。

## 文件

- `dgram-server.py` —— 模拟 systemd `$NOTIFY_SOCKET` 的真实 AF_UNIX SOCK_DGRAM server（Python）。
- `probe.ts` —— 逐候选实测脚本（含 0 对照 + 1/2/3 三个候选，一次运行输出全部结果）。
