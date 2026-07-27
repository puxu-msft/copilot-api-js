# PoC：Anthropic 上游 assistant 消息内 thinking 布局的三条约束

结论文档见 [docs/spec/2026-07-26-thinking-terminal-block-layout.md](../../docs/spec/2026-07-26-thinking-terminal-block-layout.md)。本目录只留可复跑的探针。

## 脚本

| 脚本 | 用途 | 成本 |
|---|---|---|
| `replay-400.py` | 重放生产 payload 的排列变体，最初确立 C1/C2/C3 | ~90k input token/发 |
| `verify-fix-e2e.py` | 修复后端到端复验（客户端原始 payload → 200 + wire 布局断言） | ~90k/发 |
| `bisect-c2.py` | **加法**二分：从 200 的最小构造逐项加生产特征 | 几 KB/发 |
| `bisect-c2-sub.py` | **减法**二分：从 400 的生产 payload 截断历史 | 递减，最小 14KB |
| `confirm-c2-precondition.py` | 四变体对照，钉死 C2 的触发前提 | 几 KB/发 |
| `probe-remote-c3-regression.ts` | 把导出的 history entry 的**客户端 payload** 灌进当前 sanitize 管线，打印三腿形态（客户端发来 / 那台实例发上游 / 当前 master 产出）+ 全消息 C1/C2/C3 审计 | 0（离线，不打上游） |

`probe-remote-c3-regression.ts` 是判「某台实例的 400 是我方哪一版代码造的」的离线首选：
`bun run exp/thinking-terminal-block/probe-remote-c3-regression.ts <解压后的 entry.json>`（entry 从 History UI 导出的 `.json.zst` 用 `zstd -d` 解开）。

## C2 的最小复现（先看这个，几乎不花钱）

`confirm-c2-precondition.py` 的变体 2：五条消息即可 400。

```
user            "Say hi."
assistant       [tool_use]
user            [tool_result]
assistant       [thinking, tool_use, thinking]   <- C2 违规
user            [tool_result]
```

把违规消息挪到**首个** assistant 位置（变体 4，其余完全不变）→ **200**。这就是 C2 的前提：**只对非首个 assistant 消息校验**。

## 为什么一度以为"必须打真上游全量 payload"

最初用「两个真 thinking 块 + 一个 tool_use」拼的**最小**对话，`[T, tool, T]` 返回 **200**——据此差点得出「C2 不存在」。当时的结论是「最小构造的阴性结果没有裁决力，必须重放完整 payload」。

**后来二分证明这个结论下早了**：真正的原因不是「payload 不完整」，而是最小构造把违规消息放在了**首个 assistant 位置**，恰好落进上游的豁免区。加法路线逐一证伪了所有"规模/完整性"假说——内联 system、顶层 system、29 个 tools、26 条冗余轮次、**四者全加 136KB** 全部 200；减法二分则一路收缩到 5 条消息仍 400。

所以正确的教训是：**最小构造要保留被测对象的结构性处境（它是第几个同类消息），而不只是它自身的形状。**

## 复跑

```bash
# 1) 取一条真实的、含 thinking 的失败请求（只读探针，别动 4141）
curl -s "localhost:4141/history/api/entries/<id>" -o /tmp/e-896.json
python3 -c "
import json; d=json.load(open('/tmp/e-896.json'))
blk=d['attempts'][0]['upstreamRequest']['body']['messages'][28]['content']
json.dump({'T1':blk[0],'TOOL':blk[1],'T2':blk[2]}, open('/tmp/probe-blocks.json','w'))"

# 2) 起隔离测试服务器（skill live-ghc-e2e-verification 的配方）
#    验「上游对某个排列怎么反应」时必须配 passthrough，否则我方 L1 会改写你的排列。
TESTDATA=/tmp/copilot-test-4142
mkdir -p "$TESTDATA/copilot-api"
cp ~/.local/share/copilot-api/{github_token,config.yaml} "$TESTDATA/copilot-api/"
printf '\nanthropic:\n  thinking_destack_strategy: passthrough\n  strip_thinking_on_reject: false\n' >> "$TESTDATA/copilot-api/config.yaml"
XDG_DATA_HOME=$TESTDATA NODE_ENV=production bun run ./packages/cli/src/main.ts start --port 4142 > $TESTDATA/server.log 2>&1 &

# 3) 先跑便宜的（够用就别烧 90k）
python3 confirm-c2-precondition.py 4142
python3 bisect-c2.py 4142 baseline plus-all

# 4) 真要重放全量时才用这两个
python3 replay-400.py 4142 replay-asis sep-mid-tool-end
python3 verify-fix-e2e.py 4143     # 4143 = 跑默认 move_blocks 的服务器
```

## 坑

- **重放 upstream body 会撞 "Tool names must be unique"**：我方会注入 `Grep`/`Glob`/`Task`/`KillShell`/`tool_search_tool_regex`（客户端把它们声明为 deferred，实际定义由我方补），把已注入过的 body 再喂回去就重复了。脚本按名字剔除这批再发（`INJECTED` 集合）。**这是重放伪影，不是缺陷**——实测客户端发 24 个 + 注入 5 个 = 29 个，无重名。
- **上游报的 messages 索引不可信**：同一约束在不同 payload 下偏 −1、偏 +1、甚至越界（5 条消息报 `messages.5`）。按形状定位。
- **别用 4141 主服务器做这些实验**：它是用户的实时实例，且默认配置会 de-stack 掉你要测的排列。
