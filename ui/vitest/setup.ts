import { vi } from "vitest"

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  value: ResizeObserverMock,
  configurable: true,
})

Object.defineProperty(globalThis, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

Object.defineProperty(globalThis, "scrollTo", {
  value: vi.fn(),
  configurable: true,
})

Object.defineProperty(Element.prototype, "scrollIntoView", {
  value: vi.fn(),
  configurable: true,
})

Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0),
  configurable: true,
})

Object.defineProperty(globalThis, "cancelAnimationFrame", {
  value: (id: number) => clearTimeout(id),
  configurable: true,
})

Object.defineProperty(globalThis, "confirm", {
  value: vi.fn(() => true),
  configurable: true,
})
