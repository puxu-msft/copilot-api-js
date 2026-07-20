---
name: reference-cli-e2e-spawn-and-hook-load-gotchas
description: CLI e2e 跑真 claude→真 proxy 的两个硬机制：hook data-URL 具名导出丢失 + volta-shim spawn 清理
metadata:
  type: reference
---

在 copilot-api-js 搭 CLI e2e（真 `claude -p` → spawn 真 proxy〔非 4141〕→ config hook mock 上游）时踩的两个硬机制，权威细节 + bisect 全过程见 `exp/cli-e2e-stall/FINDINGS.md`，落地在 `tests/e2e-client/{harness/*,anthropic-cli.e2e.test}.ts`：

1. **upstream hook 文件的 data-URL 具名导出丢失**——loader（`src/lib/pipeline/hooks/loader.ts`）用 `Bun.Transpiler`+`data:` URL 加载 hook。**精确触发 = 源码里有 `JSON.stringify` 或字面 `{`/`}`/`"` payload**（比 skill/记忆里记的「yield 内联对象字面量」更细）；触发时 `import()` 返回 `{__esModule, default}`、具名 `onExchange` 静默变 undefined（`exports none of: onExchange`）。**规避**：帧 `data` 存 **base64**（源码无 JSON 括号引号）、`atob()` 运行时解码；帧存 `[event, base64]` 字符串元组数组（非对象字面量数组）；hook **零 import**（`~/` 别名在 data-URL 模块不解析）。同域 [[reference-bun-esm-cache-busting-query-fails-data-url-works]]。

2. **spawned proxy 清理：`Bun.spawn(...).kill()` 不够**——`bun run ./src/main.ts` + volta 的 bun shim 把 server 包进父子进程树（4141 也显示两 PID），`proc.kill()` 只杀 launcher、真 server 存活成 leftover（每次跑漏一个）。**规避**：close() 用**端口精确**的 `pkill -9 -f "main.ts start --port <唯一高位端口>"`（只匹配自己的 proxy、绝不碰用户 4141 或 peer 的 4142），spawn 前也先清同端口 leftover。呼应 CLAUDE.md `protect-user-main-server`（按精确匹配清自己的、绝不泛杀）。

配套：claude 用自定义端点必须 **`ANTHROPIC_AUTH_TOKEN`（非 API_KEY，订阅 OAuth 会覆盖 API_KEY）+ `ANTHROPIC_BASE_URL` + 隔离 HOME**（对齐 `src/setup-claude-code.ts`）；gate on `Bun.which("claude")` + 真 github_token（`homedir()` 基路径，非被测试沙箱重定向的 `XDG_DATA_HOME`）。
