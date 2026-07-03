/**
 * 离线整链探针：喂真实 messages[1392]（含空 encrypted_content 的 web_search_tool_result）
 * 走完整 sanitizeAnthropicMessages（config downgrade=false，即用户当前生产配置），
 * 验证 always-on 兜底在真实链里消除了 encrypted_content / web_search_tool_result。
 */
import { readFileSync } from "node:fs"

import { sanitizeAnthropicMessages } from "~/lib/anthropic/sanitize"
import { setStateForTests } from "~/lib/state"
import type { MessageParam, MessagesPayload } from "~/types/api/anthropic"

const msg1392 = JSON.parse(readFileSync(`${import.meta.dirname}/msg1392.json`, "utf8")) as MessageParam

// 复刻用户生产配置：downgrade 关（config gate off），验证兜底独立生效
setStateForTests({ rewriteHistoryServerTools: false })

const payload = {
  model: "claude-opus-4.8",
  max_tokens: 1024,
  messages: [{ role: "user", content: "search" } as unknown as MessageParam, msg1392, { role: "user", content: "继续" } as unknown as MessageParam],
} as unknown as MessagesPayload

const out = sanitizeAnthropicMessages(payload).payload
const wire = JSON.stringify(out.messages)

console.log("config rewriteHistoryServerTools:", false)
console.log("web_search_tool_result present:", wire.includes("web_search_tool_result"), wire.includes("web_search_tool_result") ? "❌" : "✅ gone")
console.log("encrypted_content present:", wire.includes("encrypted_content"), wire.includes("encrypted_content") ? "❌" : "✅ gone")
console.log("server_tool_use present:", wire.includes('"server_tool_use"'), wire.includes('"server_tool_use"') ? "❌" : "✅ gone")
console.log(
  "downgraded tool_use present:",
  out.messages.some((m) => typeof m.content !== "string" && m.content.some((b) => (b as { type: string }).type === "tool_use")) ? "✅" : "❌",
)
