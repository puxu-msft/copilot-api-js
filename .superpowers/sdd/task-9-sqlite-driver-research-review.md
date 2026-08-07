# Task 9 SQLite authority driver 研究评审

## 已闭合发现

- **Important — `/home/xp/src/copilot-api-js/.worktree/agent-a0d890a338019a02a/.superpowers/sdd/task-9-sqlite-driver-research.md:168-170`：把 `node-sqlite3-wasm` 的“README 未声明 Bun”升级为“跨 Bun 物理 blocker”不成立。未声明只证明支持契约缺失；该候选是预编译 WASM+JS，缺少本机 native ABI 这一常见物理障碍，实际可加载性必须用精确版本 tarball 在 Bun 1.3.14 运行同一 UDF/trigger/file-WAL probe 裁决。即使 probe 通过，缺 authorizer 仍是独立能力缺口；即使 probe 失败，才可将该版本/平台判为运行时 blocker。来源：候选 README 与 npm `node-sqlite3-wasm@0.8.60`。
- **Important — 同文件:26、108、118、124、132、144、152、158、164、170：反复把“未声明 Bun support／未实测 Bun”称为“物理 blocker”，混淆了证据状态与失败事实。`better-sqlite3`、`@libsql/client`、`sql.js`、`wa-sqlite`、官方 WASM 与 `node-sqlite3-wasm` 在目标 Bun+Node 环境的表格应统一标为“未验证或已探测失败”；仅已运行的 `bun:sqlite` API 缺 UDF 是当前可证 blocker，`node:sqlite` 的目标 Bun import 失败是该版本可证 blocker。每个没有原生 ABI 但未声明 Bun 的 WASM 项尤其不能凭文档沉默排除。
- **Important — 同文件:140-152：`wa-sqlite` 被错误归类为“公共 operation 是 async，故 sync contract 阻断”。已下载的已发布 `wa-sqlite@1.0.0` README 明示同时提供 synchronous 和 Asyncify asynchronous build，发布 tarball 含 `dist/wa-sqlite.mjs` 与 `dist/wa-sqlite-async.mjs`；作者实际 import 的 `src/sqlite-api.js` 在第15行硬编码 `const async = true`，仅说明该入口是 async wrapper，不能代表同步 dist build 不存在。该候选仍未证明 Node/Bun file VFS，故当前不可采纳，但淘汰理由必须改为“Node/Bun file VFS 与同步 variant integration 未验证”。
- **Important — 同文件:166-170：未核验 `node-sqlite3-wasm` 的 WAL 硬约束，却以“direct filesystem persistence”近似满足 file/WAL。已发布 `0.8.60` JS VFS 只有文件读写、锁目录和 fsync imports，未见 WAL 所需 shared-memory `xShm*` 桥接；须以 `PRAGMA journal_mode=WAL` 后重开第二 connection、读写并断言实际 pragma 仍为 `wal` 的 probe 定性。若失败，它是已证 WAL blocker；若成功，报告才可继续评估 Bun runtime 和 trigger path。普通 file-open 成功不是 WAL 证据。
- **Minor — 同文件:100-110、140-152：候选覆盖不是穷尽式的。至少应记录活跃的 `@journeyapps/wa-sqlite@2.0.1`（原 `wa-sqlite@1.0.0` 不是唯一维护线）与 `@livestore/wa-sqlite` fork；后者一手 README 声称 Node target 和 synchronous operations。两者尚无现成 Bun+file-VFS+authority 证据，未必合格，但未查即不支持“研究覆盖充分”。另可列 `@tan-yong-sheng/sqlite-vec-wasm-node`，其 metadata 声称 Node filesystem WASM VFS；同样应以同一 probe 排除或保留。
- **Important — 同文件:36-40、48-50：`better-sqlite3@13.0.3` 的安装证据不准确。精确 npm tarball 已含 macOS arm64/x64、Linux glibc/musl arm64/x64、Windows arm64/x64 的八个 `.node` prebuild；不是“未取得当前 tarball 对应资产清单”。这不能证明 Bun 可加载，亦不能覆盖所有 OS/CPU，但否定“默认安装不要求 compiler”前应按项目实际支持平台给结论：这些已覆盖平台的 Node 安装不需编译，其他平台才 fallback `node-gyp`。修订矩阵并以 Bun 1.3.14 import+trigger probe 单独裁定兼容性。

## Verdict

- **Research coverage verdict：修复 Important 后才能作为选型依据。**已正确排除 remote `@libsql/client` 作为本地 authority driver，也正确将 `sql.js` 的 whole-DB import/export 判为非 drop-in；但上述误判与候选遗漏同时会错误拒绝潜在正确候选。
- **Recommendation quality verdict：结论措辞可保留为“尚未有候选被实证满足全部约束”，不能保留为任何候选的物理不可能性。**当前材料仍没有一项经过 Bun 1.3.14 + Node 24 的完整实测，故这个“已证不足”的认识论结论成立；推荐路线及淘汰理由需重写。
- **最小补证：**在隔离临时目录从精确 tarball 安装/解包 `node-sqlite3-wasm@0.8.60`、`better-sqlite3@13.0.3` 与 WASM forks，分别用 `node`、`bun` 执行同一脚本：打开临时 file；`PRAGMA journal_mode=WAL`；注册零参 closure UDF；持久 trigger 两次写入并断言 `[0,1]`；尝试普通 SQL 切换而失败；重开第二 connection 后确认 `wal` 与读写；输出 runtime、package version 和异常。对 `wa-sqlite` 另须选同步 dist entry 并先证明 file VFS。已下载 tarball 未执行外部包代码，因为本轮环境拒绝未授权执行 npm 外部代码。

**计数：Critical 0，Important 5，Minor 1。**
