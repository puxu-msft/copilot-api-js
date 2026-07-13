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

## 待做（真 Tier 2）

本 PoC 用 fake server 隔离验证了 **claude 侧行为**。真 Tier 2 harness 应走**真 proxy**（spawn 非 4141 + upstream-hook mock 返回 thinking-only refusal + config `refusalSseRewrite:end_turn`/`refusalEndTurnText:""`），端到端证「proxy 配置 → 产出 thinking-only end_turn → claude stall」整链。剩余机制未知 = proxy boot 的 APP_DIR/token/hook-config 隔离（spawn 真进程，不能再用 Tier 1 的同进程 `setUpstreamFetchForTests`）。
