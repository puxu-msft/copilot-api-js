# Task 9 ready-summary 完整性架构第四轮复审

## 评审结论

- 评审范围：第四版 `/home/xp/src/copilot-api-js/.worktree/agent-a0ace38c28cd88da1/.superpowers/sdd/task-9-summary-integrity-architecture.md`；复核第三轮 3 个 Important、authority matrix、capability seam、journal/recovery、repair provenance、controls、snapshot 与性能。
- 已读取／执行的证据：重读第四版全文；对照 candidate `9f9b0d7b` 的跨 Bun／Node SQLite driver；在项目固定 Bun 1.3.14 实测 `bun:sqlite.Database` 原型没有 `.function()`／自定义 scalar UDF 注册 API，只有 `exec/prepare/query/transaction` 等；复用 WAL snapshot 与 connection-local FK 探针。
- **Architecture FAIL；Necessity CONFIRMED；blocker 1，Critical 0，Important 1，Minor 0。D 不可交 implementer。**

## 第三轮 findings 复核

1. **ready projection authority：契约已闭合。** `/home/xp/src/copilot-api-js/.worktree/agent-a0ace38c28cd88da1/.superpowers/sdd/task-9-summary-integrity-architecture.md:49,63,65,90` 把 projection 除 pin overlay 外的 INSERT／REPLACE／UPDATE／DELETE 纳入拒绝矩阵，并补直接 DML controls。
2. **journal recovery authority：契约已闭合。** 同文件 `:47,61-63,89` 规定 A 后 journal 及 refs immutable，仅 B scope 可删；recovery 前 ordered 六元组精确相等，涵盖 FK on/off 与 payload+digest 同改 controls。
3. **repair provenance：契约已闭合。** 同文件 `:68-69,91` 自动 repair 只信 immutable journal／冻结备份／operator trusted original；current poisoned bytes 不得自动 rebase，explicit adopt 要新 revision、audit reason 与 strict validate。

## 事实性发现

### [blocker] `/home/xp/src/copilot-api-js/.worktree/agent-a0ace38c28cd88da1/.superpowers/sdd/task-9-summary-integrity-architecture.md:42,63,77,82` — 核心 connection-local UDF capability 在当前 Bun driver 上不可实施

方案要求“每个 connection 注册只读 UDF `history_write_scope()`”，但 candidate `packages/foundation/src/sqlite/driver.ts:28-41,63-72` 的统一接口和 Bun factory都没有函数注册能力；Bun 1.3.14 实测 `Database` prototype 也没有 `.function()`。因此 migration 无法创建／执行依赖该 UDF 的 trigger，A/B/backfill/repair scope 入口不存在，整套 authority matrix 不能落地；这不是缺测试而是基础 primitive 不可用。最小整改：先做平台 PoC并改用当前 Bun+Node 都支持的不可伪造机制；若必须 native UDF，则须引入支持注册 UDF 的统一 driver／binding并实测 Bun+Node，不能只改 TypeScript interface。

### [Important] `/home/xp/src/copilot-api-js/.worktree/agent-a0ace38c28cd88da1/.superpowers/sdd/task-9-summary-integrity-architecture.md:42,63,87-92` — capability 状态机与 controls 尚未定义嵌套、重入、异常泄漏的可执行语义

即使换成可注册 UDF 的 driver，`withHistoryIntegrityTransaction` 只说 `finally` 清 scope，未冻结：scope 已非 null 时是否拒绝 nested／不同 scope；UDF／trigger 引发 reentrant callback 时如何处理；同步 `fn` 若返回 Promise 是否在 COMMIT 后仍残留 authority；commit/rollback/finally 任一步抛错时清理优先级。controls也未逐项列 authorization spoof、scope leak、exception cleanup、nested/reentrant、async callback。最小整改：helper只接受同步回调；entry 时 scope 必须 null，nested/reentrant fail closed；先本地清 scope再传播 commit/rollback error；逐项 mutation/control，并证明异常后普通 SQL仍被拒。

## authority、snapshot 与性能复核

除不可实施 capability seam 外，authority matrix 已覆盖 canonical operation、journal、evidence/refs、projection 与 marker的普通 UPDATE／DELETE／existing-key INSERT／REPLACE／PK／FK-off 路径；DROP/ALTER/UDF 注册恶意 writer明确排除。短 read snapshot 与 search await 后新 snapshot 仍闭合；健康查询仍只做 marker+narrow SQL，不读 blob／refs join，可保持 EXPLAIN 与 size-independence。

## Verdict

**Necessity 继续 CONFIRMED**：write-after-attestation 检测必须重算当前 bytes，或有覆盖每次受保护变化且普通 writer不可伪造的同步 authority/invalidation。第四版在逻辑矩阵上已显著闭合，但选定的 UDF primitive 当前物理不可用；先由 `gpt-souls:poc-runner` 验证跨 Bun／Node capability方案，再由 `gpt-souls:architect-advisor` 重写 seam，复审前不可交 implementer。

---

## `cc431fee` 范围分叉追加裁决

### 1. A／B 是否为未决用户范围

**是，范围本身未决；我第四轮把 B 当成冻结要求，超出了证据效力。** 冻结 spec `/home/xp/src/copilot-api-js/.worktree/agent-a402828e4f4b73596/docs/spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md:595-624,628-639,850-876` 明确要求 canonical/evidence 缺失、hash／length／encoding 不符、future format 与 recovery/GC 悬空引用不得发布，却没有规定具有普通 DB 写权限的一方能否同时写 marker/status/attestation/projection。necessity 的已确认部分仅是“canonical/evidence 写后变化须由当前 bytes 重算或同步 invalidation 捕获”；它不能自行推出派生 authority 必须防同权限重写。故 `cc431fee:40-45,102,115-116` 把该扩展交用户裁决是正确修正。

### 2. A／B 描述准确性与方案完备性

方向准确，但 **A 的信任边界需再写全**：它排除的不能只写 marker/status/attestation，还应明确包括 ready projection、normalized integrity refs/version 与任何能重新授权发布的派生行；否则普通 SQL 直接改 summary 或删 ref 的归属仍含混。B 则把这些派生 authority 的普通 DML 全纳入，`cc431fee:47-59,70-76` 的矩阵与前三轮 findings 一致。

没有独立的同规模“第三种威胁范围”：可做中间档（例如只保护 marker、不保护 projection）但会留下等价重新授权路径，不闭合。实现上另有同规模候选 C（每读 epoch/ref join，`cc431fee:33-38`），以及每读重算 current bytes；二者是 A/B 任一范围下的检测实现，不是第三种信任边界。DB 外签名/Merkle 是更大范围。

### 3. 若用户选择 A

A 仍必须满足：canonical manifest、evidence bytes/metadata、ordered refs 的每次范围内变化同步撤 ready／poison，或读取时重算 current bytes；事务 A/B 与 recovery/GC 保持 spec §6 原子性；marker check 与 get/list/cursor/session/stats 位于同一短 read snapshot，search 必须在 `await` 后新开 snapshot复核；v1/v2/v3、future format、missing/corrupt evidence和窄表性能 controls仍不可删。A 只是信任派生 authority 不被同权限直接改写，不是放弃 canonical 完整性。

选择 A 后，第四轮 UDF blocker与 scope-state Important不再阻断，因为 A 无需区分授权/未授权派生 DML；第三轮 direct projection/journal DML findings也仅作为超出 A 威胁模型的主观加固建议。B3 若只证明“普通 SQL 可伪造派生 authority”，不阻断 A；但若它还能绕过 canonical/evidence 同步 invalidation而不写派生 authority，仍阻断 A。

### 4. 若用户选择 B

当前材料没有提供可定位、可重放的 B1/B2 native capability PoC；仓内搜索只找到草案对 B3 的引用，故**无法据称 B1/B2 已足够进入正式设计**。最低证据应在项目固定 Bun 与 Node runtime各证明：persistent trigger可调用 capability；未注册的第二连接、FK-off、TEMP同名对象和普通SQL不能伪造；合法 A/B/migration/backfill/repair可进入精确 scope；异常/COMMIT/ROLLBACK后先清 scope；async callback、nested、不同-scope嵌套与reentrant调用 fail closed；B3 的正负控确实咬中该机制。

即使 native primitive可用，正式设计仍须冻结统一 driver/API、部署与打包方式、extension加载失败语义、scope状态机、每个 authority entity×DML×scope 的 trigger表，以及 Bun/Node双runtime测试。第四轮实测只证当前 `bun:sqlite` JS API没有 `.function()`；若 B1/B2 通过 native binding绕开该限制，它们可推翻“物理不可用”，但必须交出上述实测资产，不能以机制说明替代。

### 5. 推荐与代价

**推荐 B。** 不是因为 A“不值得做”，而是项目已把“应用 bug或运维普通 SQL修改 canonical”纳入考虑；允许同一权限随后直接改 derived authority，会让同步 invalidation 成为可被同级操作抵消的软约定，长期维护中最容易复发。B 的具体代价是 native跨runtime substrate、触发器/授权状态机复杂度、冷写路径与迁移测试面增加，以及 extension/binding 的部署维护；健康 read仍可保持 marker+narrow SQL，不牺牲冻结的 EXPLAIN／size-independence。若用户暂选 A，应明确记录这是信任边界裁决而非正确性降级，并保留未来迁 B 的 schema seam。
