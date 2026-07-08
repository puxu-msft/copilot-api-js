import {
  //
  useCallback,
  useEffect,
  useRef,
} from "react"

export function useDebouncedCallback<A extends Array<unknown>>(fn: (...a: A) => void, delayMs: number): (...a: A) => void {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current)
    },
    [],
  )
  return useCallback(
    (...a: A) => {
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = setTimeout(() => fnRef.current(...a), delayMs)
    },
    [delayMs],
  )
}
