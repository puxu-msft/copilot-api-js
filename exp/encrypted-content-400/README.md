# encrypted-content 400 排查与修复

## 报错
```
400 POST /v1/messages claude-opus-4.8: HTTP 400: messages.17.content.0: Invalid `encrypted_content` in `search_result` block
```

## 根因（已实证 req_1783080609827_137）
web_search 双跳合成的 `web_search_tool_result` 块（`src/lib/anthropic/web-search/synthesize.ts:68` 硬编码 `encrypted_content: ""`）发给客户端 → 客户端存历史 → 下轮原样回传 → 上游 GHC 校验 `web_search_result.encrypted_content` 拒绝 → 400。web_search 现已关（enabled=false）但历史残留每轮回传，400 baked 进会话。GHC 把 `web_search_result` 项称 "search_result block"，`messages.17` 是其内部转换索引。

## 关键实测：上游校验语义（req_empty.json / req_placeholder.json / req_errorshaped.json / req_null.json）
| encrypted_content / 形态 | 结果 |
|---|---|
| `""` 空串 | 400 `Invalid encrypted_content` |
| `"redacted"` 非空占位 | **仍 400**（占位无效） |
| `null` | 400 `Input should be a valid string` |
| 字段缺失（undefined） | 400（等价空） |
| **error-shaped**（`web_search_tool_result_error`，results 空时合成、content 是对象） | **HTTP 200**（上游接受，故意豁免不降级） |

**上游要求真实有效非空 string**（`""`/`null`/占位/缺失全拒）→ 兜底判空 = `typeof !== "string" || === ""`；error-shaped 上游 200 → 不碰（降级它是误伤）。唯一可行修复 = 降级为普通 tool_use/tool_result。

## 不误伤论证
我们 wire 上的 `web_search_tool_result` **只可能是自己合成的**（GHC Copilot 不原生支持 Anthropic web_search server tool，双跳因此存在）。真实上游 web_search 结果不走这条路。故"encrypted_content 空 → 降级"零误伤真实结果；保守只在**空**时触发。

## downgrade 探针（probe.ts）
`rewriteServerToolHistory([msg1392], "downgrade")` → encrypted_content 与 web_search_tool_result 全消失，assistant(tool_use+text) + user(tool_result)，tool_result stringify 成可读文本。✅

## 修复方案（用户选 C：配置 + 独立兜底）
1. 开 `anthropic.tool_rewrite_history_server: "downgrade"`（立即脱困）
2. 新增默认生效、只针对空 encrypted_content 的窄触发降级（正交防线，复用 downgrade primitive）
