# Task 9 ready-summary 完整性架构裁决

> 状态：用户于 2026-08-08 裁决范围 A；原 reviewer 对 `9842a62e` 的 2 个 Important 已逐项整改，等待复审；不修改产品代码。

## 1. 机械信任边界

- 本轮仅覆盖：任何造成 canonical `v3_operations` operation/manifest 或 `v3_transport_evidence` bytes/metadata 变化的数据损坏、程序错误与操作失误。分类只看被直接写入的实体是否为canonical operation/evidence，不按行为者意图分类。
- 任何原因导致派生 authority 表的直接 DML 均在受信边界外：`v3_operation_summaries`、`projection_status`、ready marker、attestation、normalized operation/journal refs、schema/format version。普通 SQL 可写者对这些派生行受信；B3 同时改 canonical 与派生行重新 ready 的反例不阻断范围 A。
- 生产 A/B writer 精确维护 normalized refs、summary/status/marker 仍是产品正确性要求，必须单测漏/多/重排和状态机；但这不是外部 SQL 防护。
- `DROP/ALTER TABLE`、删除/禁用 trigger、绕过 SQLite 修改 page同样不在范围内。不实现 native UDF、签名、防篡改或 A/B 双轨；若未来有真实异常证据，再重新裁决信任边界。

## 2. 已冻结目标与必要性

- Ready path 当前只读窄表并绕过 canonical；future-999 manifest 仍发布 summary，见 `task-9-review.md:24-30` 与 `queries.ts:214-240,273-280`。
- Spec §6.2要求 evidence缺失或hash/length/encoding不匹配时不得发布；§6.3要求future manifest fail loud；§9.4要求v1/v2/v3、corruption及各consumer覆盖。
- 原 reviewer已确认的必要命题：检测范围内canonical/evidence写后损坏，必须读时重算当前bytes，或让每次相关变化同步撤销可信ready；write-once attestation不成立。范围A不要求证明受信派生行无法被直接伪造。
- 窄读性能冻结：healthy get/list/session/stats使用summary indexes，无temp sort、canonical access、blob hydrate或per-row integrity join，见 `summary-query.it.test.ts:174-273`、`summary-query-performance.it.test.ts:31-163`。

## 3. 唯一推荐：同步 invalidation + 原子 ready snapshot

### 3.1 数据与 strict primitive

- 增加 `v3_operation_evidence_refs` 与 `v3_journal_evidence_refs`，逐event保存ordered `(owner,dispatchIndex,sequence,digest,byteLength,encoding)`；主键含sequence，不按digest去重。
- Strict primitive从当前uncompressed manifest严格decode；v1/v2 refs为空，v3保序且保留same-digest重复sequence；与normalized refs逐项精确相等，漏/多/重排/任一字段变化均invalid。
- 对每个entity验证存在、actual bytes SHA-256、byteLength、encoding；拒绝future/non-integer format。再从当前manifest bytes按现有domain重算operation digest，并从同一record/timing inputs重投影全部summary承重字段。
- Startup scrub、repair、journal recovery复用完整primitive；GC复用decode/refs/entity子集，禁止弱镜像。

### 3.2 Transaction A/B、recovery与GC

- A：evidence CAS + journal-v2 + 从实际journal envelope decode出的journal refs同事务提交；任一步失败共同回滚。
- B：先验证A recovery set，再在一个transaction中执行“canonical INSERT → summary pending → operation refs → strict validate → summary ready → journal+refs删除”。若事务前marker为1，pending中间态不可见，完整COMMIT后marker仍为1；若原marker缺席则不擅自发布，由全库repair重建。
- B任一步失败整体回滚：新canonical/operation refs/summary均不存在，A journal+evidence recovery set完整保留，marker保持事务前状态且不会发布新operation。
- Recovery先核对journal envelope与normalized refs ordered六元组精确相等，再重跑B；未知journal format拒绝。GC roots是committed operation refs与pending journal refs并集；先validate，再删真孤儿。Clear同事务清evidence与两类refs。

### 3.3 Canonical DML final-state matrix

“合法”表示体系允许且最终状态闭合；“fail-closed”表示允许canonical变化但撤ready；所有final state均指statement/transaction结束后的可见状态。

| # | Entity／DML | 判定与动作 | COMMIT／ABORT 后 final state | 正／负 control |
|---|---|---|---|---|
| 1 | Operation `INSERT` new key，完整B | 合法；同tx先pending、写refs、strict后ready | COMMIT：canonical+exact refs+ready summary；原marker=1则仍1。失败：见#2 | 正：合法v1/v2/v3 new write；负：每个B failpoint |
| 2 | Operation `INSERT` new key，未完成B或strict失败 | fail-closed；trigger建pending并删除marker，或B整体ABORT | 独立SQL COMMIT：canonical存在、summary pending、marker缺席；B ABORT：canonical/summary/op-refs不存在，A recovery set保留 | 负：直接insert、bad manifest/evidence；断言零发布 |
| 3 | Operation plain `INSERT` existing key | 非法；PK conflict | ABORT：canonical/refs/summary/marker逐字不变 | 负：existing-key INSERT；正：existing read不受影响 |
| 4 | Operation `UPDATE manifest_gz/revision/digest` | fail-closed；逐列trigger poison该summary并删marker | COMMIT：canonical新值、refs保留供诊断、summary poisoned、marker缺席 | 负：future/valid-v3 bytes、stale digest分别不能发布 |
| 5 | Operation `UPDATE kind/created_at/terminal_sequence/ended_at/timing_source/committed_at/summary_json` | fail-closed；每个保护列同#4 | COMMIT：canonical新值、summary poisoned、marker缺席 | 负：逐保护列mutation；summary/order/session/model不得stale发布 |
| 6 | Operation `UPDATE operation_id` | 非法identity rename；BEFORE trigger拒绝，不依赖FK | ABORT：canonical/refs/summary/marker不变 | 负：FK-on/off PK UPDATE；正：旧summary仍有效 |
| 7 | Operation `UPDATE pinned` | 合法overlay；只同步两表pinned | COMMIT：canonical+summary pinned一致，refs/marker及其它承重字段不变 | 正：pin/unpin；负：pin路径夹带其它列 |
| 8 | Operation `DELETE` | 合法delete/GC形状；trigger显式删op refs+summary，不依赖FK | COMMIT：canonical/refs/summary均不存在；marker保持原值，evidence待GC | 正：GC/delete后其余summary仍ready；负：留下orphan summary/ref |
| 9 | Operation `REPLACE` new/existing | fail-closed；new等价未完成#2；existing先清旧derived再插pending并删marker | COMMIT：新canonical、refs空、summary pending、marker缺席；不得继承旧ready | 负：new/existing REPLACE零发布；正：之后trusted strict repair可ready |
| 10 | Evidence `INSERT` new digest | 合法A/CAS写；A先验证digest/length/encoding | COMMIT：entity存在；既有refs/summary/marker不变。A验证失败则ABORT | 正：A写新entity；负：hash/length/encoding不符时A ABORT |
| 11 | Evidence plain `INSERT` existing digest | 非法；PK conflict。合法CAS幂等路径是SELECT并逐字节/metadata验证，不执行INSERT | ABORT：entity/refs/summary/marker不变 | 正：shared digest走CAS verify/no-op；负：plain existing-key INSERT |
| 12 | Evidence `UPDATE evidence_gz` | fail-closed；按OLD digest定位依赖并poison；有依赖才删marker | COMMIT：entity新bytes、refs保留；有依赖则其summary poisoned且marker缺席，无依赖则summary/marker不变 | 负：referenced bytes corruption零发布；正：unreferenced update不误伤 |
| 13 | Evidence `UPDATE byte_length` | fail-closed；同#12 | COMMIT：metadata新值；有依赖则其summary poisoned且marker缺席，无依赖则marker不变 | 负：length mismatch；正：unreferenced update |
| 14 | Evidence `UPDATE encoding` | fail-closed；同#12 | COMMIT：metadata新值；有依赖则其summary poisoned且marker缺席，无依赖则marker不变 | 负：encoding mismatch；正：unreferenced update |
| 15 | Evidence `UPDATE digest` PK | 非法identity rename；BEFORE trigger拒绝 | ABORT：entity/refs/summaries/marker不变 | 负：FK-on/off digest UPDATE；正：旧entries仍ready |
| 16 | Evidence `DELETE` referenced，FK ON（项目默认） | FK拒绝statement；trigger先执行的poison/撤marker随statement一并回滚 | ABORT：entity、canonical、refs、summary、marker全部不变，旧entry仍ready | 正：Bun 1.3.14、FK ON DELETE抛约束错误且旧entry可读；负：不得声称poison被持久化 |
| 17 | Evidence `DELETE` referenced，FK OFF | fail-closed；按OLD digest poison全部依赖并删marker，再删entity | COMMIT：entity不存在；refs保留作missing-evidence oracle；依赖summary poisoned、marker缺席 | 负：Bun 1.3.14、FK OFF DELETE提交后零stale发布 |
| 18 | Evidence `DELETE` unreferenced | 合法GC形状 | COMMIT：entity不存在；refs/summary/marker不变 | 正：真孤儿GC；负：不得误伤其它summary |
| 19 | Evidence `REPLACE` new digest | 等价new insert；无既有依赖 | COMMIT：entity存在；既有refs/summary/marker不变 | 正：new REPLACE后A严格验证并引用 |
| 20 | Evidence `REPLACE` existing digest，FK ON/OFF | 两种FK设置均合法COMMIT但fail-closed；必须由INSERT-side referenced trigger按digest poison，不依赖隐式DELETE trigger。`recursive_triggers=OFF`时DELETE trigger不跑，ON时可同时运行，final state相同 | COMMIT：new entity+refs保留；全部依赖summary poisoned、marker缺席 | 负：Bun 1.3.14在FK ON/OFF及recursive_triggers OFF/ON均不能stale发布；正：均不得误判为FK ABORT |

### 3.4 派生 writer正确性与migration/repair

- Direct refs/summary/status/marker DML不设外部防护；但生产writer单测必须证明A/B生成refs与actual envelope/manifest ordered精确相等，漏/多/重排均红，summary由同一canonical重投影。
- 原子migration删除marker、创建refs/index/triggers、把既有summary置pending、strict scrub并初始化ready/poison；任一步失败全回滚。Migration不重建marker。
- 独立repair仅在全体operation strict-valid、零pending/poison后重建marker。Backfill从canonical生成refs与summary，不从旧summary反推。合法existing/read-only、pin、delete/GC不false-red。

### 3.5 Read snapshot

- `withValidatedSummarySnapshot`在一个短同步SQLite transaction中读取marker并执行/解析get/list/cursor/session/stats原窄SQL；不暴露“先check再query”组合。
- Marker false时走strict canonical fallback或typed integrity error，不silent-filter poison。Search先await sidecar，随后开新短snapshot复核marker并按IDs取summary；不跨await持锁。

## 4. 不采用方案与文件面

- 不采用write-once attestation（检测不了写后损坏）、周期scrub单独守门（有窗口）、每读anti-join（list O(page×refs)、aggregate O(N+R)且破坏窄读）。B3 per-row anti-join成本只作未采用证据。
- 不采用native UDF/签名/防篡改/范围B双轨；当前没有异常证据支持该威胁。
- `migrations/index.ts:62-66`：原子refs/invalidation migration；`v3/store.ts` candidate `:810-848,1169-1178,1365-1465`：A/B、strict、recovery/GC；`summary-schema.ts:22-100`：matrix triggers；`summary-store.ts:39-579`：snapshot+repair；`queries.ts:214-481`、`sessions.ts:25-156`、`stats.ts:99-154`接snapshot；`state.ts:115-126,216-222`调度migration/repair。

## 5. Reviewer待核验命题

1. 范围机械按实体划分：只防canonical operation/evidence变化；派生authority direct DML无论原因均排除，但生产writer精确维护仍受单测约束。
2. 上表20个DML格均冻结合法性、动作、COMMIT/ABORT final state及control；其中evidence DELETE按项目默认FK ON与探针FK OFF拆分，existing-key REPLACE冻结为FK ON/OFF均COMMIT；implementer无需临场选择。
3. Marker=1时合法B new INSERT的pending中间态不可见，完整COMMIT后仍ready；任一failpoint不发布且A recovery set完整。
4. v1/v2/v3、same-digest重复sequence为绿；future、missing/corrupt evidence、refs漏/多/重排为红。
5. Marker与同步ready query同一短snapshot；search await后新snapshot；healthy path无blob hydrate/per-row join。
6. Existing read、pin、delete/GC、shared evidence幂等正样本防止matrix false-red。