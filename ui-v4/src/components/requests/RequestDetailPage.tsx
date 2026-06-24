import { useNavigate } from "react-router-dom"

import { DetailPanel } from "@/components/detail/DetailPanel"

/** Requests 详情全屏页(Plan 08 §2):返回列表按钮 + DetailPanel 占满主内容区。 */
export function RequestDetailPage() {
  const navigate = useNavigate()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <button
        type="button"
        onClick={() => navigate("/requests")}
        className="mono shrink-0 border-b border-[var(--color-border)] px-2 py-1 text-left text-[12px] text-[var(--color-primary)]"
      >
        ‹ 返回列表
      </button>
      <div className="flex min-h-0 flex-1 flex-col">
        <DetailPanel />
      </div>
    </div>
  )
}
