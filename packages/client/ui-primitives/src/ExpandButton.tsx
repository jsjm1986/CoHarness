// ExpandButton: the head/tail cap toggle shared by the block primitives
// (DiffBlock, ReadBlock, SearchBlock, TerminalBlock). Each block owns the
// surrounding rows and supplies its own `.expand` style; this is the single
// aria/label contract they share.

/** Copy labels consumed by the block expand/collapse toggle. */
export interface ExpandButtonCopy {
  /** Collapse-toggle aria label while expanded. */
  readonly collapseAria: string
  /** Expand-toggle aria label while collapsed, given the hidden row count. */
  readonly expandAria: (hidden: number) => string
  /** Collapse-toggle text while expanded. */
  readonly collapse: string
  /** Expand-toggle text while collapsed, given the hidden row count. */
  readonly expand: (hidden: number) => string
}

/**
 * Render the cap toggle, or nothing when no rows are hidden.
 * @param props.hidden - rows beyond the cap; ≤ 0 renders nothing.
 * @param props.expanded - whether the block is currently expanded.
 * @param props.onToggle - toggle callback.
 * @param props.copy - block-localized toggle labels.
 * @param props.className - the owning block's expand style.
 * @returns the toggle element, or null when nothing is capped.
 */
export function ExpandButton({ hidden, expanded, onToggle, copy, className }: {
  readonly hidden: number
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly copy: ExpandButtonCopy
  readonly className: string | undefined
}) {
  if (hidden <= 0) return null
  return (
    <button
      type="button"
      className={className}
      aria-expanded={expanded}
      aria-label={expanded ? copy.collapseAria : copy.expandAria(hidden)}
      onClick={onToggle}
    >
      {expanded ? copy.collapse : copy.expand(hidden)}
    </button>
  )
}
