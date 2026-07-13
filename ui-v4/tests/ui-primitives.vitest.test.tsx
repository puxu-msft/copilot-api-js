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

import { Badge } from "@/components/ui/badge"
import {
  //
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  //
  Select,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import {
  //
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"

/**
 * C5 smoke gate: the shadcn `components/ui/*` primitives (landed via `shadcn add`
 * on the unified `radix-ui` package) render under jsdom + vitest without shattering
 * and expose the correct ARIA roles. This is the positive sample proving the C5
 * primitives are usable before any consumer wires them (wiring is C6/per-page).
 *
 * Depends on the Radix jsdom stubs in [setup.ts](./setup.ts) (ResizeObserver /
 * pointer-capture) — same prerequisite as `radix-smoke.vitest.test.tsx`.
 */
describe("shadcn ui primitives smoke", () => {
  it("Dialog renders role=dialog (Portal + focus-scope) under jsdom", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>ui dialog smoke</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByRole("dialog")).toBeDefined()
    expect(screen.getByText("ui dialog smoke")).toBeDefined()
  })

  it("Tabs renders horizontal tablist/tab/tabpanel", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Tab A</TabsTrigger>
          <TabsTrigger value="b">Tab B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
        <TabsContent value="b">Panel B</TabsContent>
      </Tabs>,
    )
    const tablist = screen.getByRole("tablist")
    expect(tablist.dataset.orientation).toBe("horizontal")
    expect(screen.getAllByRole("tab")).toHaveLength(2)
    // Only the active panel is mounted with role=tabpanel.
    expect(screen.getByRole("tabpanel")).toBeDefined()
    expect(screen.getByText("Panel A")).toBeDefined()
  })

  it("Select trigger renders role=combobox", () => {
    render(
      <Select>
        <SelectTrigger aria-label="pick">
          <SelectValue placeholder="pick one" />
        </SelectTrigger>
      </Select>,
    )
    expect(screen.getByRole("combobox")).toBeDefined()
  })

  it("Slider renders role=slider thumbs", () => {
    render(
      <Slider
        defaultValue={[25, 75]}
        min={0}
        max={100}
        aria-label="range"
      />,
    )
    expect(screen.getAllByRole("slider")).toHaveLength(2)
  })

  it("Badge + Input render without crashing", () => {
    render(
      <div>
        <Badge>tag</Badge>
        <Input aria-label="field" />
      </div>,
    )
    expect(screen.getByText("tag")).toBeDefined()
    expect(screen.getByLabelText("field")).toBeDefined()
  })
})
