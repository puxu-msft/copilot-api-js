import type { StoreChange } from "./active-request-store"
import type { KeyEvent } from "./input/keys"

export type UiState = {
  view: "collapsed" | "panel" | "detail"
  selectedRequestId?: string
  detailRequestId?: string
  scrollOffset: number
  detailScrollOffset: number
  showHelp: boolean
}

export type UiContext = { activeIds: ReadonlyArray<string>; visibleRows: number }

export const INITIAL_UI_STATE: UiState = { view: "collapsed", scrollOffset: 0, detailScrollOffset: 0, showHelp: false }

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

export function selectedIndex(state: UiState, activeIds: ReadonlyArray<string>): number {
  if (activeIds.length === 0) return -1
  if (state.selectedRequestId === undefined) return 0
  const index = activeIds.indexOf(state.selectedRequestId)
  return index === -1 ? 0 : index
}

function scrollToShow(index: number, offset: number, visibleRows: number): number {
  if (index < 0) return 0
  if (index < offset) return index
  if (index >= offset + visibleRows) return index - visibleRows + 1
  return offset
}

export function reduce(state: UiState, key: KeyEvent, ctx: UiContext): UiState {
  if (key.kind === "help") return { ...state, showHelp: !state.showHelp }
  const ids = ctx.activeIds
  const index = selectedIndex(state, ids)

  if (state.view === "collapsed") {
    if (key.kind !== "space" && key.kind !== "tab") return state
    return { ...state, view: "panel", selectedRequestId: ids[Math.max(index, 0)] }
  }

  if (state.view === "panel") {
    if (key.kind === "space" || key.kind === "tab" || key.kind === "escape") return { ...state, view: "collapsed" }
    if (key.kind === "enter") {
      if (index < 0) return state
      const id = ids[index]
      return { ...state, view: "detail", selectedRequestId: id, detailRequestId: id, detailScrollOffset: 0 }
    }
    if (key.kind === "up" || key.kind === "down") {
      if (ids.length === 0) return state
      const nextIndex = clamp(index + (key.kind === "up" ? -1 : 1), 0, ids.length - 1)
      return { ...state, selectedRequestId: ids[nextIndex], scrollOffset: scrollToShow(nextIndex, state.scrollOffset, Math.max(1, ctx.visibleRows)) }
    }
    return state
  }

  if (key.kind === "escape") return { ...state, view: "panel", detailRequestId: undefined, detailScrollOffset: 0 }
  if (key.kind === "home") return { ...state, detailScrollOffset: 0 }
  if (key.kind === "up") return { ...state, detailScrollOffset: Math.max(0, state.detailScrollOffset - 1) }
  if (key.kind === "page-up") return { ...state, detailScrollOffset: Math.max(0, state.detailScrollOffset - Math.max(1, ctx.visibleRows)) }
  if (key.kind === "down") return { ...state, detailScrollOffset: state.detailScrollOffset + 1 }
  if (key.kind === "page-down") return { ...state, detailScrollOffset: state.detailScrollOffset + Math.max(1, ctx.visibleRows) }
  if (key.kind === "end") return { ...state, detailScrollOffset: Number.MAX_SAFE_INTEGER }
  return state
}

/** Reconcile identity before any render/effect after the active list changes. */
export function reconcile(state: UiState, activeIds: ReadonlyArray<string>, change: StoreChange, visibleRows: number): UiState {
  if (activeIds.length === 0)
    return { ...state, view: "collapsed", selectedRequestId: undefined, detailRequestId: undefined, scrollOffset: 0, detailScrollOffset: 0 }

  let selectedRequestId = state.selectedRequestId
  if (selectedRequestId === undefined || !activeIds.includes(selectedRequestId)) {
    const removal = change.removed
    let oldIndex = Math.max(0, change.previousIds.indexOf(selectedRequestId ?? ""))
    if (removal && removal.id === selectedRequestId) oldIndex = removal.index
    selectedRequestId = activeIds[Math.min(oldIndex, activeIds.length - 1)]
  }

  const detailMissing = state.detailRequestId !== undefined && !activeIds.includes(state.detailRequestId)
  const view = detailMissing ? "panel" : state.view
  const detailRequestId = detailMissing ? undefined : state.detailRequestId
  const index = activeIds.indexOf(selectedRequestId)
  const maxOffset = Math.max(0, activeIds.length - Math.max(1, visibleRows))
  const scrollOffset = clamp(scrollToShow(index, state.scrollOffset, Math.max(1, visibleRows)), 0, maxOffset)
  return { ...state, view, selectedRequestId, detailRequestId, scrollOffset, detailScrollOffset: detailMissing ? 0 : state.detailScrollOffset }
}

export function withDetailOffset(state: UiState, offset: number): UiState {
  return offset === state.detailScrollOffset ? state : { ...state, detailScrollOffset: offset }
}
