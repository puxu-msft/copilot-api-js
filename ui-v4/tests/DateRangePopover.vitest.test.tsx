import {
  //
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  //
  describe,
  expect,
  test,
  vi,
} from "vitest"

import { DateRangePopover } from "@/components/requests/DateRangePopover"

/**
 * DateRangePopover 的日界语义验证:点单日 → onChange 收到 [dayStart, dayEnd],
 * 其中 dayEnd - dayStart === 86_399_999(同一天 00:00:00.000 → 23:59:59.999)。
 * Radix Popover 内容经 Portal 落 document.body,故一律用 `screen` 查询(见 docs/radix-styling.md §3/§5)。
 */
describe("DateRangePopover", () => {
  test("empty state shows placeholder trigger", () => {
    render(
      <DateRangePopover
        from={null}
        to={null}
        onChange={() => {}}
      />,
    )
    expect(screen.getByRole("button", { name: /time range/i })).toBeDefined()
  })

  test("selecting a single day yields [startOfDay, endOfDay] with 86_399_999ms span", async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <DateRangePopover
        from={null}
        to={null}
        onChange={onChange}
      />,
    )

    // 打开 popover(Radix Trigger 需真实 pointer+focus 序列 → userEvent,非 fireEvent)。
    await user.click(screen.getByRole("button", { name: /time range/i }))

    // 选中当前月的 15 号(每月都存在;默认不显示邻月 outside days,故文本唯一)。
    await user.click(screen.getByText("15"))

    expect(onChange).toHaveBeenCalledTimes(1)
    const [from, to] = onChange.mock.calls[0] as [number | null, number | null]
    expect(from).not.toBeNull()
    expect(to).not.toBeNull()
    // 日界:同一天 00:00:00.000 → 23:59:59.999 = 86_399_999ms。
    expect((to as number) - (from as number)).toBe(86_399_999)
    // from 落在当天零点、to 落在当天末毫秒。
    const fromDate = new Date(from as number)
    expect([fromDate.getHours(), fromDate.getMinutes(), fromDate.getSeconds(), fromDate.getMilliseconds()]).toEqual([0, 0, 0, 0])
    const toDate = new Date(to as number)
    expect([toDate.getHours(), toDate.getMinutes(), toDate.getSeconds(), toDate.getMilliseconds()]).toEqual([23, 59, 59, 999])
  })
})
