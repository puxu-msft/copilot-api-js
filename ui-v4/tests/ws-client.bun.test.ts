import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import { createWsClient } from "@/lib/ws-client"

describe("ws-client ref-count", () => {
  it("connects once on first acquire, disconnects on last release", () => {
    let connects = 0
    let closes = 0
    const client = createWsClient({
      url: "ws://test/ws",
      socketFactory: () => {
        connects++
        return { close: () => closes++, addEventListener() {}, removeEventListener() {}, send() {} } as unknown as WebSocket
      },
    })
    const r1 = client.acquire()
    const r2 = client.acquire()
    expect(connects).toBe(1) // 第二次 acquire 复用
    r1()
    expect(closes).toBe(0) // 还有一个引用
    r2()
    expect(closes).toBe(1) // 最后一个释放才关
  })

  it("ignores a stale socket's late close event (StrictMode churn)", () => {
    // StrictMode 同步 mount→unmount→mount，真实 WebSocket.close() 的 close 事件异步触发。
    // S1 release 时 close 入队未发，S2 已建连；若不守卫，S1 stale close 会 clobber S2 + 触发 spurious 重连。
    interface FakeSocket {
      closed: boolean
      fireClose: () => void
    }
    const sockets: Array<FakeSocket> = []
    let connects = 0
    const client = createWsClient({
      url: "ws://test/ws",
      socketFactory: () => {
        connects++
        const listeners: Record<string, (() => void) | undefined> = {}
        const s = {
          closed: false,
          close() {
            this.closed = true
          },
          addEventListener(type: string, fn: () => void) {
            listeners[type] = fn
          },
          removeEventListener() {},
          send() {},
          fireClose() {
            listeners.close?.()
          },
        }
        sockets.push(s as unknown as FakeSocket)
        return s as unknown as WebSocket
      },
    })
    const r1 = client.acquire() // connect S1 (connects=1)
    r1() // release → intentionalClose, S1.close() 入队(未 fire)
    const r2 = client.acquire() // remount → connect S2 (connects=2)
    sockets[0].fireClose() // S1 的 stale close 此刻才 fire
    expect(connects).toBe(2) // 无 spurious 重连 S3
    r2() // final release
    expect(sockets[1].closed).toBe(true) // 活的 S2 被真正关闭(未泄漏)
  })
})
