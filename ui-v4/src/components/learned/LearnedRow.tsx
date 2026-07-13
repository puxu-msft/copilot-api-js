import type { useLearned } from "@/hooks/useLearned"
import type { LearnedEntryView } from "@/types"

import { StatusBadge } from "@/components/learned/StatusBadge"
import {
  //
  displayValue,
  relativeTime,
} from "@/lib/learned"

const BTN = "border px-1.5 py-0.5 text-[11px] disabled:opacity-40"

export function LearnedRow({ entry, actions }: { entry: LearnedEntryView; actions: ReturnType<typeof useLearned> }) {
  // ref carries the RAW value (endpoint-scoped modelKey for some categories) — the
  // mutation round-trip must match the backend key exactly, so never use displayValue here.
  const ref = { category: entry.category, key: entry.key, value: entry.value }
  const shown = displayValue(entry.category, entry.value)
  const busy = actions.renew.isPending || actions.expire.isPending || actions.setPin.isPending || actions.remove.isPending
  return (
    <div className="mono flex flex-wrap items-center gap-2 border-b border-[var(--surface-border)] px-2 py-1 text-[12px]">
      <span
        className="text-[var(--content-value)]"
        title={entry.value}
      >
        {shown}
      </span>
      {entry.key ?
        <span className="text-[var(--content-muted)]">[{entry.key}]</span>
      : null}
      <StatusBadge status={entry.status} />
      {entry.migrated ?
        <span
          className="text-[10px] text-[var(--content-muted)]"
          title="迁移记录，首次学到时间未知"
        >
          迁移
        </span>
      : null}
      <span className="text-[10px] text-[var(--content-muted)]">
        学于 {relativeTime(entry.firstLearnedAt)} · 确认 {relativeTime(entry.lastConfirmedAt)}
        {entry.expiresAt !== null ? ` · 过期 ${new Date(entry.expiresAt).toLocaleString()}` : " · 永不过期"}
      </span>
      <span className="ml-auto flex gap-1">
        <button
          type="button"
          className={`${BTN} border-[var(--signal-ok)] text-[var(--signal-ok)]`}
          disabled={busy}
          onClick={() => actions.renew.mutate(ref)}
        >
          续约
        </button>
        <button
          type="button"
          className={`${BTN} border-[var(--signal-muted)] text-[var(--signal-muted)]`}
          disabled={busy}
          onClick={() => actions.expire.mutate(ref)}
        >
          立即失效
        </button>
        <button
          type="button"
          className={`${BTN} border-[var(--content-accent)] text-[var(--content-accent)]`}
          disabled={busy}
          onClick={() => actions.setPin.mutate({ ...ref, pinned: !entry.pinned })}
        >
          {entry.pinned ? "取消固定" : "固定"}
        </button>
        <button
          type="button"
          className={`${BTN} border-[var(--signal-fail)] text-[var(--signal-fail)]`}
          disabled={busy}
          onClick={() => {
            if (confirm(`删除该记录？\n${entry.category} / ${shown}`)) actions.remove.mutate(ref)
          }}
        >
          删除
        </button>
      </span>
    </div>
  )
}
