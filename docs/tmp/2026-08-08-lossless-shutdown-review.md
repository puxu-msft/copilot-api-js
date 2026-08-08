# 首信号无损排空独立评审记录

> 评审对象：本地合并提交范围 `14974488..4c555ef9`。首轮由两位未卷入的异模型 reviewer 只读审查；整改在 `worktree-fix-shutdown-review-findings` 完成。详细逐项处置见 [2026-08-08-lossless-shutdown-review-dispositions.md](2026-08-08-lossless-shutdown-review-dispositions.md)。

## 首轮结论

### 测试、文档与 supervisor reviewer

结论：2 BLOCKER、4 MAJOR。

1. BLOCKER：entry-evidence discovery baseline 仍包含已删除的 `shutdown-anthropic`／`shutdown-mid-stream`，且漏登记新增 `rate-limiter-lossless-drain`。
2. BLOCKER：systemd handoff 在 SIGUSR2 后立即 `systemctl stop`，可能把随后 SIGTERM 变成 lifecycle 中的第二终止信号并强退在途请求。
3. MAJOR：PM2 未配置 `stop_exit_codes:[0]`，clean handoff exit 可能被 autorestart。
4. MAJOR：旧 Vue 配置页、类型、normalizer 与 `README.zh.md` 仍暴露已删除的 `shutdown.*` 字段。
5. MAJOR：核心测试未通过真实 route／真实 operation registry 证明长流与 History 不产生 shutdown error，也没有对应 early-teardown mutation control。
6. MAJOR：`process-lifecycle-shutdown` skill 的证据声明强于实际测试，且活测试列表不完整。

### 生命周期代码 reviewer

结论：0 BLOCKER、2 MAJOR。

1. MAJOR：count_tokens 与 embeddings 使用 lightweight ModelOperation，却不进入 shutdown drain 的 `RequestContextManager` registry；可能在 terminal publish 前关闭 token、transport、History 与 Telemetry。
2. MAJOR：冻结规格中的 token refresh、新 transport 与 durability 验收仍缺真实 manager-backed HTTP 交叉测试。

## 整改结果

- production drain oracle 现取 generation `RequestContextManager.getTrackedOperations()` 与 lightweight in-flight registry 的并集；count_tokens／embeddings 在创建时登记，在 terminal publish 的 `finally` 中注销。
- 新增真实 `/v1/messages` shutdown 测试，覆盖长流、已建 context 的 401 token-refresh strategy retry、pre-content clean EOF recovery；请求与 History 均正常 completed，资源只在 terminal publish 后关闭。
- 新增 generation registry 与 lightweight registry 两个 exact mutation controls；错误实现均确定性变红，反向恢复后复绿。
- systemd handoff 改为 SIGUSR2 后等待旧槽自行退出；超时或 failed 时保留双槽并失败退出。PM2 两槽配置 `stop_exit_codes:[0]`。
- 删除旧 Vue shutdown 字段全表面与中文 README 条目；legacy runtime 输入不会被重新序列化。
- entry-evidence baseline 按 canonical `unit/it/http` Glob 重冻结。
- skill、冻结规格、实施计划、lifecycle 与 DESIGN 同步为两个 registry，并把尚未直接覆盖的新 upstream WS 明确列为证据边界。
- 修复整改过程中暴露的两类 shared-process false-red：shutdown 单测 FakeClock 泄漏污染 shard；driver 负样本错误地把全进程任意 timer 当作 retry oracle。另修复 token manager dispose 测试未恢复全局 credential store 的跨文件污染。

## 最终验证快照

验证树：`worktree-fix-shutdown-review-findings`，基线 `444570479f9968c43f02b5ffe52d6cf441ff6d79`，执行日期 2026-08-08。

- `bun run test:backend`：16 shards，7228 tests，7228 pass，0 fail；7231 executed，30 skipped。
- `bun run test:fast`：16 shards，3969 tests，3969 pass，0 fail；5184 executed，1 skipped。
- `bun run typecheck`：通过。
- 改动 backend TypeScript 定向 ESLint：通过。
- 架构与 discovery guards：通过。
- `bun run test:pty`：19 pass，0 fail。
- 旧 Vue：Bun 249 pass、Vitest 78 pass、vue-tsc 通过、Vite build 通过。
- `git diff --check`：通过。

## 全仓 lint 状态

`bun run lint:all` 在当前 `master@44457047` 上仍失败：120 个文件、637 errors、5 warnings。绝大部分来自 entry-evidence／header-deadline 工作流在另一个并发分支 `worktree-nghttp2-header-deadline` 已提交但尚未合并的 140 文件变更；该分支同时含 response-header deadline 功能，不能安全 cherry-pick 或夹带进本 shutdown 整改。当前任务所有改动 TypeScript 已定向 ESLint 通过。此项是当前 master 的独立未合并工作，不作为本任务已绿结论；最终交付必须明确保留这项事实。
