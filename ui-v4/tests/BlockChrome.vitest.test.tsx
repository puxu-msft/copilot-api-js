import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import type { ContentBlock } from "@/lib/content/types"

import { BlockChrome } from "@/components/detail/BlockChrome"

const BLOCK: ContentBlock = { type: "text", text: "hi" }

describe("BlockChrome", () => {
  it("renders its children", () => {
    render(
      <BlockChrome block={BLOCK}>
        <div>rendered body</div>
      </BlockChrome>,
    )
    expect(screen.getByText("rendered body")).toBeDefined()
  })

  it("exposes a JSON affordance and no modal until clicked", () => {
    render(
      <BlockChrome block={BLOCK}>
        <div>body</div>
      </BlockChrome>,
    )
    expect(screen.getByLabelText("View block JSON")).toBeDefined()
    expect(screen.queryByText("text JSON")).toBeNull()
  })

  it("opens the block JSON modal on click", () => {
    render(
      <BlockChrome block={BLOCK}>
        <div>body</div>
      </BlockChrome>,
    )
    fireEvent.click(screen.getByLabelText("View block JSON"))
    expect(screen.getByText("text JSON")).toBeDefined()
  })

  it("forwards its id to the container for anchor scrolling", () => {
    const { container } = render(
      <BlockChrome
        block={BLOCK}
        id="convo-msg-0-blk-1"
      >
        <div>body</div>
      </BlockChrome>,
    )
    expect(container.querySelector("#convo-msg-0-blk-1")).not.toBeNull()
  })
})
