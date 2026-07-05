import {
  //
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

/** CSS class toggled on the target element for a brief visual flash (defined in styles/theme.css). */
const FLASH_CLASS = "toc-flash"
/** How long the transient highlight stays before it is removed (ms). */
const FLASH_DURATION_MS = 1200

interface UseAnchorScroll {
  /** Scroll the element with `anchorId` into view + transiently highlight it; records it as active. */
  scrollTo: (anchorId: string) => void
  /** The last-selected anchor id (for the TOC's `activeAnchor` highlight). */
  activeAnchor: string | undefined
}

/**
 * Scroll-to-anchor + transient highlight for the detail TOC.
 *
 * `scrollTo(id)` looks up the DOM element by id, smooth-scrolls it to the top of
 * the scroll container, flashes a brief outline (auto-removed after
 * {@link FLASH_DURATION_MS}), and records the id as `activeAnchor`. Timers and the
 * flashed element are tracked so a re-invoke clears the prior flash and unmount
 * cleans up — avoiding leaks and setState-after-unmount.
 */
export function useAnchorScroll(): UseAnchorScroll {
  const [activeAnchor, setActiveAnchor] = useState<string | undefined>(undefined)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flashedRef = useRef<Element | undefined>(undefined)

  const clearFlash = useCallback(() => {
    if (timeoutRef.current !== undefined) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = undefined
    }
    flashedRef.current?.classList.remove(FLASH_CLASS)
    flashedRef.current = undefined
  }, [])

  const scrollTo = useCallback(
    (anchorId: string) => {
      // getElementById: robust + no selector escaping needed; querySelector would require
      // CSS.escape (absent in jsdom/older runtimes) to handle ids safely.
      // eslint-disable-next-line unicorn/prefer-query-selector
      const el = document.getElementById(anchorId)
      // Don't record a target that isn't in the DOM — a missing element means the jump no-ops,
      // so marking it active would lie to the TOC highlight.
      if (!el) return
      setActiveAnchor(anchorId)

      // Clear any in-flight flash before starting a new one.
      clearFlash()

      el.scrollIntoView({ block: "start", behavior: "smooth" })
      el.classList.add(FLASH_CLASS)
      flashedRef.current = el
      timeoutRef.current = setTimeout(() => {
        el.classList.remove(FLASH_CLASS)
        flashedRef.current = undefined
        timeoutRef.current = undefined
      }, FLASH_DURATION_MS)
    },
    [clearFlash],
  )

  // Cleanup on unmount: drop any pending timeout + flash class.
  useEffect(() => clearFlash, [clearFlash])

  return { scrollTo, activeAnchor }
}
