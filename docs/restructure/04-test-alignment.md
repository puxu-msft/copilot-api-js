# 04 — 测试可追踪性（P1）

## 目标

不是"每个源文件一个同名测试文件"（本项目使用 unit/component/integration/e2e 分层测试，不适用镜像策略），
而是**从测试文件名能快速判断它测试的是什么模块/功能**。

## 命名与追踪性争议文件

### 名称与 import 不一致

| 测试文件 | 实际 import 的模块 | 问题 |
|----------|-------------------|------|
| `system-prompt-manager.test.ts` | `~/lib/config/config` + `~/lib/system-prompt` | 名称暗示只测 system-prompt，实际同时测 config 和 system-prompt 的集成 |
| `server-tool-rewriting.test.ts` | `~/lib/anthropic/message-tools` + `~/lib/anthropic/server-tool-filter` | 名称暗示只测 server-tool-filter，实际覆盖两个模块 |
| `copilot-headers.test.ts` | `~/lib/copilot-api` | 名称用了函数名而非模块名 |

### 覆盖分散

`anthropic/sanitize.ts` 的功能分散在 4 个测试文件中：
- `message-sanitizer.test.ts` — 主管道
- `dedup-tool-calls.test.ts` — 去重子功能
- `strip-read-tool-result-tags.test.ts` — 标签剥离子功能
- 部分 component test 也覆盖 sanitize 行为

这不一定需要合并（按功能点分测试是合理的），但需要能追踪到源模块。

## 建议

### 1. 重命名明确误导的文件

| 当前名称 | 建议名称 | 理由 |
|----------|---------|------|
| `copilot-headers.test.ts` | `copilot-api.test.ts` | 与源文件 `copilot-api.ts` 对齐 |
| `system-prompt-manager.test.ts` | `system-prompt-config-integration.test.ts` | 反映它测的是 config + system-prompt 集成 |

### 2. 不重命名的文件

| 文件 | 理由 |
|------|------|
| `dedup-tool-calls.test.ts` | 功能点命名，指向 sanitize 的子功能，足够清晰 |
| `strip-read-tool-result-tags.test.ts` | 同上 |
| `message-sanitizer.test.ts` | 虽然不叫 `anthropic-sanitize.test.ts`，但"message sanitizer"是 sanitize 模块的常见称呼 |
| `server-tool-rewriting.test.ts` | 覆盖两个模块的集成行为，当前名称尚可 |
| `response-utils.test.ts` | 单函数测试，保持即可 |

### 3. 与 01 协调

如果 `anthropic/sanitize.ts` 按 01 拆分为多个文件，现有的功能点命名测试（dedup、strip-tags）反而会自然对齐到新的子文件。无需提前调整。

## 验证

- [ ] 重命名后 `bun test tests/unit/` 通过
- [ ] 每个测试文件的被测模块可追踪（注释或 import 即可判断）
