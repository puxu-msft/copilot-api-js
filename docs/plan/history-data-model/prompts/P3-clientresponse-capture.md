# P3 kick-off — clientResponse 捕获（可与 P2.x 并行）

**前置**：P1 完成。**与 P2.5/P2.6 共享 `request.ts`（新 setter 与 fail/abort/toHistoryEntry 分属不同区域）**——非「不同文件」；并行须用不重叠行 + 显式 pathspec commit，稳妥可排在 P2.6 后串行（README DAG 红线，WARN-2）。读 [../README.md](../README.md) + [../plan.md](../plan.md)「P3」。

**为什么**：`clientResponse.status`（proxy 转发给客户端的 HTTP status）当前**无捕获点**（ForwardedResponse 只有 content/sseEvents）——这是 richest-data-flow 缺口，非删而是建（RFC §4 标「新捕获」）。

**目标**：先 grep 客户端 `Response` status 来源（`src/routes/*/handler-v4.ts` 的 `c.json(...,status)` / stream 200 / `src/lib/pipeline/client-sink.ts`），定位后加 `ctx.setClientResponseStatus(status)`（新 setter，request.ts）。`status?` optional，legacy 反序列化缺省 undefined。`clientResponse.body` 由旧 `inboundResponse.content` 迁移。

**TDD + 验收**：plan.md P3 Step 1-5。gate：成功 200 与失败转发时 `clientResponse.status` 被捕获；相关 http test 绿。**不建 aspirational 空槽**——须真找到数据源接线，找不到则回报（别留空 setter）。

**提交**：`feat(history): capture clientResponse.status at forward boundary`。

**红线**：../README.md。
