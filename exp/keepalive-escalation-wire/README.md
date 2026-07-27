# 探针：升级期的空 content_block_delta 到底上不上 wire

## 它回答的问题

2026-07-22 的 G2 实测里，21 帧空 `text_delta` **一个都没到 CC**，导致 ADR D2 把 `empty_text` 保活判为无效并退役。但那次实测的**丢失层从未定位**——可能是 CC、可能是 harness、也可能是**我方管线自己吞了帧**。这个区别是承重的：2026-07-27 落地的 keepalive 升级（`stream_keepalive_escalate_sec`，逼近 300s 死线时从 ping 升级为内容 delta）**正是靠这条帧活命**；若管线自己吞掉它，那个修复就是无效的。

## 结论（2026-07-27 实测）

**空 delta 会到达 wire。我方管线不吞它。** 见 `wire-capture-2026-07-27.txt`：12 秒块内静默期间，客户端 wire 上收到 8 个 `ping` + **3 个空 `text_delta`（index=0）**，随后真实内容在 index=1 正常收尾。

推论：
1. G2 的丢失发生在**我方之外**（CC 或它的 harness），D2 第 ② 条判据是**假阴性**——这与源码判据一致（`app.pretty.js:10018` 只丢 `event: ping`，内容 delta 一律 `he()` 重置）。
2. 刚落地的升级修复在 wire 层**有效**。
3. 副产品观察：该配置（buffered + `stream_commit_after_sec: 1`）下 **anchor 块@0 确实被发出**，真实块被 remap 到 index=1。所以"客户端历史里的空 text 块全部来自上游"这个说法**需要收窄**——index=0 的那些可能是我方 anchor。

## 复跑（~20 秒，不打真上游、不碰 4141）

```bash
TESTDATA=/tmp/ka-probe-4143 && rm -rf "$TESTDATA" && mkdir -p "$TESTDATA/copilot-api"
cp ~/.local/share/copilot-api/github_token "$TESTDATA/copilot-api/"
cat > "$TESTDATA/copilot-api/config.yaml" <<'YAML'
anthropic:
  stream_keepalive_ping_sec: 1
  stream_keepalive_escalate_sec: 3
  stream_commit_after_sec: 1
hooks:
  enabled: true
  upstream_module: "./exp/keepalive-escalation-wire/hook.ts"
YAML
XDG_DATA_HOME=$TESTDATA NODE_ENV=production bun run ./packages/cli/src/main.ts start --port 4143 > "$TESTDATA/server.log" 2>&1 &
sleep 6
timeout 25 curl -sN localhost:4143/v1/messages -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-opus-5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}' > /tmp/ka-wire.txt
awk '/^event:/{e=$2} /^data:/{print e}' /tmp/ka-wire.txt | sort | uniq -c | sort -rn
# 清理：按 PID 精确 kill（绝不 pkill —— 4141 是用户主服务器）
ss -ltnp | grep :4143 | grep -oP 'pid=\K[0-9]+' | sort -u | xargs -r kill
```

## 这发探针**没有**证明什么（重要）

本次用的是 buffered 配置（真实块到收尾才 flush），静默期间客户端视角是 **pre-content 窗口**，所以验证到的是 **pre-content 升级路径**。`docs/DESIGN.md:306` 明写当前升级是 **pre-content-only**：「首块提交后的无-open窗口只 ping」。**W3（首块已提交、块之间静默）仍是活缺口、仍会在 300s 处死。** 要验 W3 得改 hook 让静默发生在块**之间**，并关掉 buffered。

## 未闭合的问题

- 该测试实例**没开 history**，所以"anchor start / 升级 delta 有没有按 ADR 打 `synthetic` 标记"这一问**尚未验证**。复跑时在 config 里打开 history 即可查。
