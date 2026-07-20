import {
  //
  useEffect,
  useState,
} from "react"

/**
 * 每 intervalMs 返回新的 `Date.now()`(仅 active 时启用 interval)——驱动在途 elapsed 实时滴答。
 * 订阅隔离在调用它的子树,不触发无关组件重渲。
 */
export function useNowTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
  return now
}
