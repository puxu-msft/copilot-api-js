/** Small inline button that scrolls to a paired tool block. `label` is the visible arrow text;
 *  `ariaLabel` names the action for assistive tech / tests. Rendered only when a counterpart exists. */
export function ToolJumpButton({ label, ariaLabel, onJump }: { label: string; ariaLabel: string; onJump: () => void }) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onJump}
      className="mono border border-[var(--surface-border)] px-1 text-[11px] leading-tight text-[var(--content-muted)] hover:text-[var(--content-accent)]"
    >
      {label}
    </button>
  )
}
