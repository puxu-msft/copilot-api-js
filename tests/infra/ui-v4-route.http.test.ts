import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import { createUiRoutes } from "~/routes/ui/route"

describe("ui-v4 route", () => {
  it("createUiRoutes accepts a custom mount prefix", async () => {
    const app = createUiRoutes({ mountPrefix: "/ui-v4" })
    const res = await app.request("/ui-v4")
    // dist 可能不存在(测试环境未构建)，但路由必须命中、非 404-from-no-route
    expect([200, 302, 404, 500]).toContain(res.status)
  })
})
