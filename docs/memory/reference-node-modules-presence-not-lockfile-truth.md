---
name: reference-node-modules-presence-not-lockfile-truth
description: node_modules 里有某包 ≠ bun.lock 有 ≠ 可安全直引；裸 bun add 装最新 major；选依赖前须对 bun.lock 核实
metadata:
  type: reference
---

选用某个包前，**「node_modules 里存在」不等于「bun.lock 里有」也不等于「可安全直接 import」**。node_modules 里可能躺着 `bun install` 会 prune 的**游离产物**——某个包的传递依赖被 hoist 上来、但它自己并不在锁文件里（CI `--frozen-lockfile` 不会装它，`bun install` 会清掉）。直接 `import` 这种游离包运行期解析不可靠。

判据只有一个：`grep '"<pkg>@' bun.lock`（命中数 > 0 才是真被锁定的依赖）。

追加依赖时：
- **裸 `bun add <name>` 会拉 registry 最新版**（可能是新 major）并写 `^newmajor`，**不复用**锁里已有的旧版本。若意图是「把既有传递依赖提升为直接依赖、不引入新版本」，必须钉版号 `bun add <name>@^<existing>`（先 `grep bun.lock` 查既有版本）。
- 只手改 `package.json` 不实跑 `bun add` → 锁文件不同步。

实例（2026-07-10 footer 宽度感知，见 [[reference-undici-websocket-runtime-split-bun-vs-node]] 同域 Bun 陷阱）：计划原打算直引 `cli-truncate@5.2.0`（node_modules 里确实有），审查实测发现它**不在 bun.lock**（是游离 orphan），且其依赖 `string-width@^8.2.0` 与锁里既有的 `7.2.0` 会造成双版本。改为 `bun add string-width@^7.2.0`（v7 真在锁里、仅提升为直接依赖、dedupe 零新版本），并用手写纯文本截断绕开 cli-truncate。

**Why:** 「node_modules 存在」是最容易被当成「依赖可用」的假前提，但锁文件才是事实源；被这条误导会写出 CI 装不上的代码、或悄悄引入新 major。
**How to apply:** 选依赖先 `grep '"<pkg>@' bun.lock` 证其真被锁定；提升传递依赖为直接依赖时 `bun add <name>@^<锁里现版本>` 钉版号；任何 `bun add` 后 `git --no-pager diff --text bun.lock` 复核只含预期变动（新增直接依赖 + 其自身传递依赖的 hoist 重排，无无关包）。
