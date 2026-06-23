import {
  //
  render,
  screen,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import type { MessageContent } from "@/lib/content/types"

import { ConversationView } from "@/components/detail/ConversationView"

describe("ConversationView", () => {
  it("renders messages with role labels + normalized content", () => {
    const messages = [
      { role: "user", content: "hi there" },
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] },
    ] as Array<MessageContent>
    render(<ConversationView messages={messages} />)
    expect(screen.getByText(/hi there/)).toBeDefined()
    expect(screen.getByText(/Bash/)).toBeDefined()
    expect(screen.getAllByText(/user|assistant/i).length).toBeGreaterThan(0)
  })
  it("empty messages → 无消息 placeholder", () => {
    render(<ConversationView messages={[]} />)
    expect(screen.getByText(/无消息/)).toBeDefined()
  })
})
