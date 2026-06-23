import {
  //
  isRouteErrorResponse,
  useRouteError,
} from "react-router-dom"

/** 提取错误的可读详情(避免嵌套三元)。 */
function errorDetail(error: unknown): string {
  if (isRouteErrorResponse(error)) return typeof error.data === "string" ? error.data : error.statusText
  if (error instanceof Error) return error.message
  return String(error)
}

/** 根路由 errorElement —— 优雅展示路由/渲染错误，取代 React Router 默认丑页。 */
export function RouteError() {
  const error = useRouteError()
  const title = isRouteErrorResponse(error) ? `${String(error.status)} ${error.statusText}` : "Application error"
  return (
    <div className="mono flex h-full flex-col items-start justify-center gap-2 p-6">
      <div className="text-[12px] uppercase tracking-wider text-[var(--color-muted)]">inspector</div>
      <div className="text-lg font-bold text-[var(--color-fail)]">{title}</div>
      <div className="max-w-[60ch] text-[14px] text-[#999]">{errorDetail(error)}</div>
      <a
        href="#/requests"
        className="mt-2 text-[14px] text-[var(--color-primary)] underline"
      >
        ← 回到 Requests
      </a>
    </div>
  )
}
