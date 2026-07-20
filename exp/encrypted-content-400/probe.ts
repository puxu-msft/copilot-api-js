/**
 * 独立探针：把真实的 messages[1392]（含 web_search 双跳合成的
 * web_search_tool_result，encrypted_content="") 喂进 rewriteServerToolHistory
 * 的 "downgrade" 模式，验证输出是否消除了空 encrypted_content 块。
 *
 * 判据（独立 oracle，非自洽）：downgrade 后 wire messages 中
 *   1. 不再出现任何 web_search_tool_result 块
 *   2. 不再出现任何 encrypted_content 字段
 *   3. server_tool_use → tool_use、web_search_tool_result → user-side tool_result
 */
import { readFileSync } from "node:fs"

import { rewriteServerToolHistory } from "~/lib/anthropic/sanitize/rewrite-server-tool-history"
import type { MessageParam } from "~/types/api/anthropic"

const msg1392 = JSON.parse(readFileSync(`${import.meta.dirname}/msg1392.json`, "utf8")) as MessageParam

// 真实自毒化序列：assistant(server_tool_use + web_search_tool_result + text)
const input: Array<MessageParam> = [msg1392]

const before = JSON.stringify(input)
const hasEncryptedBefore = before.includes("encrypted_content")
const hasWstrBefore = before.includes("web_search_tool_result")

const { messages: after, rewroteCount } = rewriteServerToolHistory(input, "downgrade")

const afterStr = JSON.stringify(after)
const hasEncryptedAfter = afterStr.includes("encrypted_content")
const hasWstrAfter = afterStr.includes("web_search_tool_result")

console.log("=== BEFORE ===")
console.log("  encrypted_content present:", hasEncryptedBefore)
console.log("  web_search_tool_result present:", hasWstrBefore)
console.log("  message count:", input.length, "roles:", input.map((m) => m.role))
console.log("=== AFTER downgrade ===")
console.log("  rewroteCount:", rewroteCount)
console.log("  encrypted_content present:", hasEncryptedAfter, hasEncryptedAfter ? "❌ STILL POISONED" : "✅ gone")
console.log("  web_search_tool_result present:", hasWstrAfter, hasWstrAfter ? "❌ STILL PRESENT" : "✅ gone")
console.log("  message count:", after.length, "roles:", after.map((m) => m.role))
console.log("=== AFTER structure (block types per message) ===")
for (const [i, m] of after.entries()) {
  const types = typeof m.content === "string" ? ["<string>"] : m.content.map((b) => (b as { type: string }).type)
  console.log(`  [${i}] ${m.role}:`, types)
}
console.log("=== downgraded tool_result text (first 200 chars) ===")
const userMsg = after.find((m) => m.role === "user")
if (userMsg && typeof userMsg.content !== "string") {
  const tr = userMsg.content.find((b) => (b as { type: string }).type === "tool_result") as { content?: unknown } | undefined
  console.log("  ", typeof tr?.content === "string" ? tr.content.slice(0, 200) : tr?.content)
}
