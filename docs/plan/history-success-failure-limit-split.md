# 拆分 success / failure history limit

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：运行时选项 `historySuccessLimit`/`historyFailureLimit`；reaper 分桶淘汰
> **备注**：双桶独立淘汰落地；旧 history.limit 保留为兼容垫片

## Context

当前 history 写入 SQLite 后,reaper 用单一 `history.limit`(state 里 `historyLimit`,默认 200)对**全表**按 `started_at ASC` 淘汰最旧的超额行,不区分请求成败([reaper.ts:13-19](src/lib/history/sqlite/reaper.ts#L13-L19))。问题:一批刷屏的失败请求会把有价值的成功历史挤出表;反之亦然。两类记录的诊断价值和保留需求不同,应各自独立配额。

用户决策(已确认):
- **配置结构**:两个平级键 `history.success_limit` / `history.failure_limit`(不是嵌套对象)。
- **清理周期**:`success`/`failure` 共用一个 `history.reaper_interval`(不拆)。
- **淘汰方式**:reaper 按**状态分桶**淘汰——成功桶超 `success_limit` 删最旧的成功记录,失败桶超 `failure_limit` 删最旧的失败记录,两桶互不干扰。
- **内置默认值**:`success_limit = 50`,`failure_limit = 200`(失败留更多用于诊断)。

成败判定与查询侧 [read.ts:47-52](src/lib/history/sqlite/read.ts#L47-L52) 保持一致:`failed` = `status = 'failed'`;**成功桶 = `status != 'failed'`(含 `completed` 及兜底的 `unknown`/NULL)**,确保任何非失败行都被 `success_limit` 管控、无行能逃逸 reaper。命中现有 `idx_entries_v2_status` 索引。

向后兼容:`history.limit` 是现存的 `.strict()` schema 键,旧用户 override 文件里就写着它。直接删除会让旧配置 `loadConfig` 校验失败。方案保留 schema 对 `limit` 的接受(deprecated 兼容垫片),`success_limit`/`failure_limit` 缺省时回退到 `limit`——主结构是双键,垫片仅防炸旧配置。

## 改动清单

### 1. Reaper 分桶淘汰 — [src/lib/history/sqlite/reaper.ts](src/lib/history/sqlite/reaper.ts)
- `runReaperOnce` 签名改为 `(successLimit: number, failureLimit: number): number`,返回两桶删除总数。
- 内部抽出 `evictBucket(db, where: string, limit: number): number`:`limit <= 0` 跳过;`SELECT COUNT(*) FROM entries_v2 WHERE <where>`;超额时 `DELETE ... WHERE id IN (SELECT id FROM entries_v2 WHERE <where> ORDER BY started_at ASC LIMIT ?)`。
  - 失败桶 `where = "status = 'failed'"`,success 桶 `where = "status IS NULL OR status != 'failed'"`。
- `startReaper(successLimit, failureLimit, intervalSeconds)`:`intervalSeconds <= 0` 或**两个 limit 都 <= 0** 时不启动 timer;tick 内调 `runReaperOnce(successLimit, failureLimit)`。
- 日志按桶输出删除条数(沿用现有 `consola.info` 风格)。

### 2. State — [src/lib/state.ts](src/lib/state.ts)
- `MutableState`:删 `historyLimit`,加 `readonly historySuccessLimit: number` / `readonly historyFailureLimit: number`(JSDoc 说明)。`historyReaperInterval`/`historyDbPath` 不变。
- `CONFIG_MANAGED_DEFAULTS`(state.ts:826 附近)+ 内部 default 表(state.ts:890/933 附近):`historyLimit: 200` → `historySuccessLimit: 50, historyFailureLimit: 200`。
- `setHistoryConfig` 的 `Pick` 改为 `"historySuccessLimit" | "historyFailureLimit" | "historyReaperInterval" | "historyDbPath"`;`limitChanged` 判定改为两个 limit 任一变化即触发监听器。
- `onHistoryLimitChange` 监听器签名改为传 `{ success, failure }`(或直接无参、listener 自行从 state 读)。**推荐无参信号**:`historyLimitListeners` 触发时 listener 重新从 `state` 读两个 limit,避免参数膨胀 → `setHistoryMaxEntries()` 无参化。

### 3. History state 接线 — [src/lib/history/state.ts](src/lib/history/state.ts)
- `initHistory`:`startReaper(state.historySuccessLimit, state.historyFailureLimit, state.historyReaperInterval)`。
- `setHistoryMaxEntries()`:无参,`startReaper(state.historySuccessLimit, state.historyFailureLimit, state.historyReaperInterval)`。

### 4. Config schema — [src/lib/config/schema.ts](src/lib/config/schema.ts)
`HistoryConfigSchema` 加 `success_limit: nullableNonnegativeInt()` / `failure_limit: nullableNonnegativeInt()`;`limit` 保留(加 `/** @deprecated 兼容旧配置,缺省的 success/failure_limit 回退到它 */` 注释)。

### 5. Config apply — [src/lib/config/config.ts:494-502](src/lib/config/config.ts#L494-L502)
```
if (config.history) {
  const h = config.history
  const successLimit = h.success_limit ?? h.limit   // 双键优先,旧 limit 兜底
  const failureLimit = h.failure_limit ?? h.limit
  if (successLimit !== undefined) setHistoryConfig({ historySuccessLimit: successLimit })
  if (failureLimit !== undefined) setHistoryConfig({ historyFailureLimit: failureLimit })
  if (h.reaper_interval !== undefined) setHistoryConfig({ historyReaperInterval: h.reaper_interval })
  if (h.db_path !== undefined) setHistoryConfig({ historyDbPath: h.db_path })
}
```

### 6. 路由暴露字段
- [src/routes/config/route.ts:62-63](src/routes/config/route.ts#L62):`historyLimit` → `historySuccessLimit` + `historyFailureLimit`。
- [src/routes/status/route.ts:152](src/routes/status/route.ts#L152):`historyLimit: state.historyLimit` → 两字段。

### 7. Bundled / example config
- [config.yaml:146-148](config.yaml#L146):`history:` 段改为 `success_limit` + `failure_limit` + 新增 `reaper_interval`(此前未列出,默认 600,本次补上,呼应你的要求)。
- [config.example.yaml:155-157](config.example.yaml#L155):同样改造,带注释说明两桶语义。

## 测试

- **[tests/history/sqlite/reaper.unit.test.ts](tests/history/sqlite/reaper.unit.test.ts)**:`seed()` 扩展支持按 state 注入(`completed`/`failed`);新增用例——成功超额只删成功、失败超额只删失败、一桶满不影响另一桶、`successLimit=0`/`failureLimit=0` 各自禁用、两桶混合 FIFO 正确。更新现有三例的 `runReaperOnce` 调用为双参。
- **[tests/history/history-store.it.test.ts:1005](tests/history/history-store.it.test.ts#L1005)**:`runReaperOnce(3)` → 双参。
- **[tests/config/config-hot-reload.it.test.ts:414-435](tests/config/config-hot-reload.it.test.ts#L414)**:history 测试矩阵把 `history.limit/historyLimit` 行替换为 `history.success_limit/historySuccessLimit` 与 `history.failure_limit/historyFailureLimit` 两行;更新 743 行的 side-effect 用例(改用新键);若有完整性守卫枚举字段需同步。
- **新增**:apply 兼容用例——旧 `history.limit: 100` 配置应让两个 state limit 都变 100(验证兜底回退)。

## 验证

```
bun run typecheck
bun run test:backend            # 全 offline 套件
bun run test:unit -- reaper     # 聚焦 reaper 分桶
bun run lint:all
```
flaky 风险低(reaper 纯 SQL + in-memory db),但 reaper 新用例连跑确认确定性:
```
for i in $(seq 1 10); do bun test tests/history/sqlite/reaper.unit.test.ts || break; done
```
config 热重载矩阵的完整性守卫会校验新字段已登记——未登记即 fail,是新字段未遗漏的硬保证。
