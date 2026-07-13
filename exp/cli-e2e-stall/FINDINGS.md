# PoC: CLI e2e — claude 对 thinking-only end_turn 是否 stall

- **日期**：2026-07-13
- **动机**：Tier 2 CLI e2e 的核心未知——空串 refusal recovery（`refusal_end_turn_text:""`）产出的 **thinking-only end_turn**（thinking 块 + 无 text + `stop_reason:end_turn`）是否让真实 Claude Code 的 agent-loop **stall**。这是 SDK 层（Tier 1）证不了的 agent 行为，之前标记为「需真实 live oracle」。
- **结论**：**会 stall，且可观测、可自动化断言。**

## 三个未知全部实证解决

### 未知 1：跨进程怎么让 claude 用自定义端点（非订阅真 Anthropic）

**踩坑**：先用 `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` → **claude 无视、直连真 Anthropic**（订阅 OAuth 覆盖 API_KEY；fake server 返回的 marker 文本没出现在 result、用量显示真实 $0.22）。

**正解**（对齐项目 `src/setup-claude-code.ts` 的 `buildEssentialEnv`）：**`ANTHROPIC_AUTH_TOKEN`**（非 API_KEY）+ `ANTHROPIC_BASE_URL` + **隔离 HOME**（避免订阅覆盖 + 不污染用户真实 `~/.claude`）+ `.claude.json` 含 `hasCompletedOnboarding:true`（跳过 onboarding）。验证：result == fake server 的 `FAKESERVERMARKER_9x7q` → claude 确用了自定义端点。

### 未知 2：stall 是否可观测（核心）

`--output-format json` 给结构化 oracle。三模式对照（fake Anthropic server 返回不同 wire，claude `-p` 驱动）：

| FAKE_MODE | wire 形状 | `num_turns` | `result` | 上游请求数 | 判定 |
|---|---|---|---|---|---|
| `marker` | 正常 text turn | **1** | `FAKESERVERMARKER_9x7q` | 1 | 正常 |
| `thinking` | thinking-only end_turn（= 空串 recovery） | **2** | **`''`（空）** | **2** | **STALL** |
| `recovertext` | thinking + recovery text + end_turn | **1** | 恢复文本 | 1 | 不 stall |

**stall 的可观测签名**：`result:''`（用户拿到空）+ `num_turns==2`（agent 自动再请求一轮）+ **上游被调 2 次**（重打）。`is_error:false`、`subtype:success`——claude 不报错，只是**静默空转一轮后交空结果**（交互式下即「继续」循环）。

### 未知 3：recovery 文本是否防 stall（反证特性价值）

`recovertext` 模式 num_turns=1、result=恢复文本、上游 1 次——**有 recovery 文本则不 stall**。这实证了 refusal-recovery 特性 `end_turn` 模式的存在价值：**注入的 text 块正是防止这个 stall 循环的**；空串是主动拿掉这层保护（zero-wrapping 的代价）。

## 对 Tier 2 harness 的意义

1. **机制**：spawn 真 proxy（非 4141）+ 隔离 claude HOME（`ANTHROPIC_AUTH_TOKEN`+`ANTHROPIC_BASE_URL`+onboarding）+ `claude -p --output-format json` → 解析 `{result, num_turns}` 作 oracle。
2. **stall 断言**：`num_turns > 1 && result === ""`（+ 可选上游调用计数 > 1）。
3. **对照**：同一 thinking-only 上游 + `refusalEndTurnText` 非空 → `num_turns===1 && result!==""`（recovery 文本防住）。
4. **门控**：`claude` 不在 PATH 则 skip（CI）。

## 复现

```bash
# 隔离 HOME
mkdir -p /tmp/iso-claude-home/.claude
echo '{"hasCompletedOnboarding":true}' > /tmp/iso-claude-home/.claude.json
# settings.json 写 env（见 exp 目录示例）

# 起 fake server（模式切换）
FAKE_MODE=thinking PORT=4199 bun run exp/cli-e2e-stall/fake-anthropic-server.mjs &

# 驱动 claude（注意 AUTH_TOKEN 非 API_KEY）
HOME=/tmp/iso-claude-home ANTHROPIC_BASE_URL=http://localhost:4199 \
  ANTHROPIC_AUTH_TOKEN=copilot-api \
  claude -p "say hello" --model claude-sonnet-4.6 --output-format json | jq '{result, num_turns}'
```

## 真 Tier 2 已落地（端到端通过真 proxy）

fake-server PoC 之后，真 Tier 2 harness 已建成并验证通过：真 `claude -p` → spawn 真 proxy（非 4141）→ config 声明的 upstream hook mock thinking-only refusal → proxy 的空串 refusal recovery 产出 thinking-only end_turn → **claude STALL**（`numTurns=2 result="" stopReason=end_turn`，确定性重跑同值）；对照 recovery 文本非空 → `numTurns=1 result 含标记`。落在 `tests/e2e-client/{harness/{spawn-proxy,drive-claude-cli,cli-refusal-hook},anthropic-cli.e2e.test}.ts`（gated：claude 在 PATH + github_token 存在，否则 skip）。

落地时又踩两个硬机制（记录以免重蹈）：

1. **hook data-URL 具名导出丢失的精确触发 = 源码里的 `JSON.stringify` 或字面 `{`/`}`/`"` payload**（比 skill 记的「yield 内联对象字面量」更细）。loader 用 `Bun.Transpiler`+`data:` URL 加载，触发时 `import()` 返回 `{__esModule, default}`、具名 `onExchange` 静默变 undefined（`exports none of: onExchange`）。**修法**：帧 `data` 存 **base64**（源码无 JSON 括号引号）、`atob()` 运行时解码；帧存 `[event, base64]` 字符串元组数组（非对象字面量数组）；hook **零 import**（`~` 别名在 data-URL 模块不解析）。bisect 全过程见本目录。
2. **spawned proxy 清理：`proc.kill()` 不够**——`bun run ./src/main.ts` + volta 的 bun shim 把 server 包进父子进程树，`proc.kill()` 只杀 launcher、真 server 存活成 leftover。**修法**：close() 用**端口精确**的 `pkill -9 -f "main.ts start --port <唯一端口>"`（只匹配自己的 proxy、绝不碰 4141/peer），spawn 前也先清同端口 leftover。

## 复现（真 Tier 2）

```bash
bun test tests/e2e-client/anthropic-cli.e2e.test.ts   # gated on claude + github_token
```
