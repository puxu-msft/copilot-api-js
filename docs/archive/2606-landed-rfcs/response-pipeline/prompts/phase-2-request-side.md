# Phase 2 — 请求改写迁进 driver S3（A0）

> Stage A 的 Task 2 / 设计稿的 A0。开场先读 [README.md](./README.md) 的通用红线 + 通用必读。**独立、最低风险**——与 Anthropic 响应链（Phase 1/3/4/5）格式无关，OQ2 已裁定可先行并行。

## 背景

driver 七阶段的 S3（请求改写）调用 `runRewriteIn`，它跑 `REQUEST_REWRITES`（`src/lib/pipeline/rewrite-registry.ts`，**至今为空**）。真正的请求改写现在散在各 codec.parse 里——例如 `src/lib/codec/anthropic.ts:~287` 在 parse 内调 `runAnthropicRequestRewrites`（sanitize 管道：system-reminder 剥离、thinking 清洗、server-tool 降级、coerce-adaptive-thinking 等）。

把请求改写迁进 registry 的价值：让"新增一条请求侧拦截/修复 = 注册一个 `RequestRewrite`"（env→env 纯函数），与响应侧对称。**比响应侧风险低**——请求改写是 whole-env 同步变换、无 buffer/flush/index 重映射的时序复杂度。

## 目标

把 Anthropic 请求改写从 codec.parse 内联调用，迁为注册进 `REQUEST_REWRITES` 的 `RequestRewrite` 条目，由 driver 的 S3 `runRewriteIn` 统一驱动。

接口（设计稿 §3，已存在于 `rewrite-registry.ts`）：
```ts
interface RequestRewrite {
  name: string
  order: number
  appliesTo(env: RequestEnv): boolean
  apply(env: RequestEnv): RequestEnv   // 纯函数,返回新 env(immutability)
}
```

**迁移策略**：逐条把 `runAnthropicRequestRewrites` 内的子变换抽成独立 `RequestRewrite` 条目（每条带 `appliesTo` 守卫 + `order`），codec.parse 不再内联调用、改由 driver S3 跑。注意 **codec.parse 仍负责格式翻译**（wire→IR），只把**非翻译的改写**移出。

## 关键约束

- **顺序等价**：原 `runAnthropicRequestRewrites` 内子变换的执行顺序必须靠 `order` 字段精确复刻——请求 sanitize 有顺序依赖（如 system-reminder 剥离 → system_messages_sanitize → ensureStartsWithUser）。先读现有调用点把顺序固定成 order 常量表。
- **request golden**：迁移前先对**改动前**的若干请求场景捕获 wire payload golden（发往上游的最终 body），迁后逐字节等价。复用 `tests/anthropic/` 既有 request-side 测试 + 自捕。
- **count_tokens + web_search 双跳路径**也走同一请求改写（DESIGN.md 多处标注），确认这两条旁路迁后仍应用同一条 registry 链。

## TDD

1. 先建/扩 request golden（改前锁字节）。
2. 抽第一条改写为 `RequestRewrite` + 注册 + codec.parse 移除该条内联 → typecheck → request golden 等价 → 单条 commit。
3. 逐条重复（fine-grained，每条改写一 commit，保持历史可读）。
4. 全迁完后 `runAnthropicRequestRewrites` 应空壳化或删除（确认无其它消费者再删，用 grep + subagent 核 dead code）。

## 验收

- request golden 逐字节等价 + `bun run test:backend` 绿。
- `bun run typecheck` 绿；`bunx eslint --fix`。
- **subagent 对抗 review**（全量工具）核验顺序契约 + 双跳路径覆盖，主线亲核每个 file:line。

## 提交

每条改写迁移一个 commit：
```bash
git add -- src/lib/pipeline/rewrite-registry.ts src/lib/codec/anthropic.ts <被抽出的改写文件> tests/...
git commit -m "refactor(pipeline): Stage A A0 迁 <改写名> 进 REQUEST_REWRITES(driver S3 统一驱动)"
```
