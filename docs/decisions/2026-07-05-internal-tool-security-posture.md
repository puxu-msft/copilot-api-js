# ADR: 内部个人工具的安全立场

- **状态**：Accepted
- **日期**：2026-07-05
- **相关**：CLAUDE.md `internal-tool-security-posture` / `architecture-health-first`、user-level rule `30-redefined-security.md`（`objective-over-security`）、记忆 `feedback_real_problems_over_risk`、[spec/2026-07-05-ui-v4-models-enhancement.md](../spec/2026-07-05-ui-v4-models-enhancement.md) §13

## 背景

copilot-api 是一个**开发用途、内部个人使用**的本地代理工具——运行在开发者自己机器上、由本人启动与消费，不是面向公众的多租户 SaaS。它的所有 HTTP 端点（OpenAI/Anthropic/Gemini 兼容层、管理 API、History）都在受控的本地/内网环境里服务已知的自己。

在这种定位下，把"面向公众服务"的安全默认（防信息泄露、最小暴露、剥离内部字段以防外部消费者窥探）机械套用到本项目，会产生**与项目目标背离的多余处理**：既增加代码复杂度，又主动裁剪掉运维/诊断真正需要的数据，违背 richest-data-flow。

触发本 ADR 的具体实例：`/api/models`（`src/routes/models/internal.ts`）的 `stripInternalFields` 为"不暴露给外部消费者"而剥离 `request_headers`（模型专属上游请求头）。但本项目没有需要防范的"外部消费者"——消费者就是运维本人，而 `request_headers` 恰是诊断模型路由行为时有价值的信息。为一个不存在的攻击面做剥离，是典型的"不适合本项目的安全处理"。

## 定夺

**本项目对"信息泄露/安全"采取与公共服务不同的立场：绝不因不适合本项目定位的安全顾虑阻塞任务，也绝不为此做多余处理。**

1. **不阻塞**：不因"这样会泄露 X""外部可能看到 Y"而拒绝或推迟一个对运维有价值的功能。判据是"该顾虑对一个内部个人工具是否真实成立"，而非"在某个公共服务场景下是否成立"。
2. **不做多余处理**：不为不存在的攻击面加防护、不为假想的外部消费者剥离/脱敏运维需要的字段。缺省**全量暴露**（richest-data-flow），除非用户明确要求收敛。
3. **真实缺陷仍然处理**：本立场**不**否定真实安全缺陷——凭据硬编码、注入漏洞、真实数据丢失、把密钥写进日志等，仍按 user-level `objective-over-security` 的 `alert-on-suspicious` 大声提醒并提供缓解建议（但不擅自实施、不阻塞任务）。区别在于：真实缺陷是客观存在的问题，而"内部工具的信息泄露"多数是不适合本项目的假想风险。

### 本次应用（`request_headers`）

移除 `stripInternalFields` 对 `request_headers` 的剥离，`/api/models` 完整透传该字段，Models 页 Raw JSON 可展示它。剥离逻辑本身是应删的多余安全处理。

## 备选方案（未采纳）

- **维持 `stripInternalFields` 剥离，Models 页不展示 `request_headers`**：以"防外部消费者泄露"为由——但本项目无此类消费者，是不适合本项目的多余处理。
- **另开 operator-only 端点暴露 `request_headers`、公开端点仍剥离**：为不存在的"公开 vs operator"区分增加一个端点与分叉，是把公共服务的安全模型强加到个人工具上，复杂度纯属浪费。

## 后果

- **正向**：运维/诊断数据缺省全量可见，代码不背假想安全场景的包袱；后续遇到类似"要不要为泄露风险处理"的决策有明确、可引用的立场，不必反复权衡。
- **代价/边界**：本立场**仅**适用于本项目这类内部个人工具，不可外推到任何面向公众/多租户的部署。若本项目定位将来改变（如作为公共服务分发），本 ADR 需重新评估。真实安全缺陷不在豁免范围（见定夺第 3 条）。
