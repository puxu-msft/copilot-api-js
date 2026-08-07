import {
  //
  expect,
  test,
} from "bun:test"

import { resolveHistoryWorkerUrl } from "~/lib/history/worker/asset-url"

test("History Worker asset URL resolves the sibling bundle and accepts an explicit override", () => {
  expect(resolveHistoryWorkerUrl(undefined, "file:///app/dist/main.mjs").href).toBe("file:///app/dist/history-worker.mjs")
  expect(resolveHistoryWorkerUrl("./fixture-worker.mjs", "file:///tests/runtime.test.mjs").href).toBe("file:///tests/fixture-worker.mjs")
  expect(resolveHistoryWorkerUrl(new URL("file:///explicit/worker.mjs")).href).toBe("file:///explicit/worker.mjs")
})
