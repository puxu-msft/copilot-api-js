# 03 — 模块规格

各模块的稳定接口契约、类型定义、行为规格、边界条件。新会话实现时以本目录为"该做成什么样"的权威；现状细节查 [../02-current-state.md](../02-current-state.md)，整体形状查 [../01-architecture.md](../01-architecture.md)。

| 规格 | 模块 | 对应阶段 |
|------|------|---------|
| [envelope-driver.md](./envelope-driver.md) | 薄信封 + stage + driver + 自动采样 | 骨架 / S1-S7 编排 |
| [codec.md](./codec.md) | FormatCodec + 4 格式实现 + 透传矩阵 | S1/S2/S6 |
| [rewrite-registry.md](./rewrite-registry.md) | RequestRewrite/ResponseRewrite + 装配 + 顺序契约 | S3/S5 |
| [retry-transport.md](./retry-transport.md) | 错误驱动重试 + strategy env 模型 + 纯收发 + rate-limiter | S4 |

**通用规格约定**：
- 所有 `env` 改写遵循不可变（返回新 envelope，不原地 mutate `body`），唯一例外是 `ctx`（RequestContext 是有状态句柄）。
- 所有"采样"= driver 在 stage 边界 `ctx.publish(event)`，subscriber 消费——业务 transform 永不直接调 history/log。
- 逐字节等价是 P1 的硬约束：任何 registry 化的改写，输出必须与现状对应函数逐字节一致（golden fixture 守）。
