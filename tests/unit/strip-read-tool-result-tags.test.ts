import { describe, expect, it } from "bun:test"

import type { MessageParam } from "~/types/api/anthropic"

import { stripReadToolResultTags } from "~/lib/anthropic/sanitize"

/** Helper: create an assistant message with a Read tool_use */
function assistantRead(id: string, filePath: string): MessageParam {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "Read", input: { file_path: filePath } }],
  } as MessageParam
}

/** Helper: create a user message with a tool_result */
function userResult(toolUseId: string, content: string | Array<{ type: string; text?: string }>): MessageParam {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
  } as MessageParam
}

/** Helper: create an assistant message with a non-Read tool_use */
function assistantTool(id: string, name: string, input: Record<string, unknown>): MessageParam {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
  } as MessageParam
}

describe("stripReadToolResultTags", () => {
  it("should not modify messages without system-reminder tags", () => {
    const messages: Array<MessageParam> = [
      assistantRead("tu_1", "/a.ts"),
      userResult("tu_1", "     1\tconst x = 1\n     2\tconst y = 2"),
    ]

    const result = stripReadToolResultTags(messages)
    expect(result.strippedCount).toBe(0)
    expect(result.messages).toBe(messages) // Same reference
  })

  it("should strip trailing system-reminder tags from Read results", () => {
    const fileContent = "     1\tconst x = 1\n     2\tconst y = 2"
    const taggedContent = `${fileContent}\n<system-reminder>\nTodoWrite reminder content here\n</system-reminder>`

    const messages: Array<MessageParam> = [assistantRead("tu_1", "/a.ts"), userResult("tu_1", taggedContent)]

    const result = stripReadToolResultTags(messages)
    expect(result.strippedCount).toBe(1)
    expect(result.messages.length).toBe(2)

    // The tool_result content should have the tag stripped
    const userMsg = result.messages[1]
    const block = (userMsg.content as Array<{ type: string; content?: string }>)[0]
    expect(block.content).toBe(fileContent)
  })

  it("should strip leading system-reminder tags from Read results", () => {
    const fileContent = "     1\tconst x = 1\n     2\tconst y = 2"
    const taggedContent = `<system-reminder>\nPlan mode reminder\n</system-reminder>\n${fileContent}`

    const messages: Array<MessageParam> = [assistantRead("tu_1", "/a.ts"), userResult("tu_1", taggedContent)]

    const result = stripReadToolResultTags(messages)
    expect(result.strippedCount).toBe(1)

    const userMsg = result.messages[1]
    const block = (userMsg.content as Array<{ type: string; content?: string }>)[0]
    expect(block.content).toBe(fileContent)
  })

  it("should strip multiple tags (both leading and trailing)", () => {
    const fileContent = "     1\timport foo from 'bar'"
    const taggedContent =
      `<system-reminder>\nLeading tag 1\n</system-reminder>\n`
      + fileContent
      + `\n<system-reminder>\nTrailing tag 1\n</system-reminder>`
      + `\n<system-reminder>\nTrailing tag 2\n</system-reminder>`

    const messages: Array<MessageParam> = [assistantRead("tu_1", "/a.ts"), userResult("tu_1", taggedContent)]

    const result = stripReadToolResultTags(messages)
    expect(result.strippedCount).toBe(3)

    const userMsg = result.messages[1]
    const block = (userMsg.content as Array<{ type: string; content?: string }>)[0]
    expect(block.content).toBe(fileContent)
  })

  it("should not affect non-Read tool results", () => {
    const taggedContent = "some output\n<system-reminder>\nReminder\n</system-reminder>"

    const messages: Array<MessageParam> = [
      assistantTool("tu_1", "Bash", { command: "ls" }),
      userResult("tu_1", taggedContent),
    ]

    const result = stripReadToolResultTags(messages)
    expect(result.strippedCount).toBe(0)
    expect(result.messages).toBe(messages) // Same reference — unmodified
  })

  it("should handle mixed Read and non-Read tools", () => {
    const readContent = "file content\n<system-reminder>\nReminder\n</system-reminder>"
    const bashContent = "bash output\n<system-reminder>\nReminder\n</system-reminder>"

    const messages: Array<MessageParam> = [
      assistantRead("tu_1", "/a.ts"),
      userResult("tu_1", readContent),
      assistantTool("tu_2", "Bash", { command: "ls" }),
      userResult("tu_2", bashContent),
    ]

    const result = stripReadToolResultTags(messages)
    expect(result.strippedCount).toBe(1) // Only Read result stripped

    // Read result should be clean
    const readBlock = (result.messages[1].content as Array<{ type: string; content?: string }>)[0]
    expect(readBlock.content).toBe("file content")

    // Bash result should be unchanged
    const bashBlock = (result.messages[3].content as Array<{ type: string; content?: string }>)[0]
    expect(bashBlock.content).toBe(bashContent)
  })

  it("should handle Array content form in tool_result", () => {
    const fileContent = "     1\tconst x = 1"
    const taggedContent = `${fileContent}\n<system-reminder>\nReminder text\n</system-reminder>`

    const messages: Array<MessageParam> = [
      assistantRead("tu_1", "/a.ts"),
      userResult("tu_1", [{ type: "text", text: taggedContent }]),
    ]

    const result = stripReadToolResultTags(messages)
    expect(result.strippedCount).toBe(1)

    const userMsg = result.messages[1]
    const block = (userMsg.content as Array<{ type: string; content?: unknown }>)[0]
    const innerContent = block.content as Array<{ type: string; text?: string }>
    expect(innerContent[0].text).toBe(fileContent)
  })

  it("should return same reference when no Read tool_use blocks exist", () => {
    const messages: Array<MessageParam> = [
      { role: "user", content: "Hello" } as MessageParam,
      { role: "assistant", content: [{ type: "text", text: "Hi!" }] } as MessageParam,
    ]

    const result = stripReadToolResultTags(messages)
    expect(result.strippedCount).toBe(0)
    expect(result.messages).toBe(messages)
  })
})
