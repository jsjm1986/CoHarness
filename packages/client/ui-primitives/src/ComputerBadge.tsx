/** Quiet computer identity; explicit resource actions add a keyboard-accessible menu. */
import { useState } from 'react'
import { IconFollowsystemOutline16 } from './icons/index.tsx'
import { Menu, type MenuEntry } from './Menu.tsx'
import { Tooltip } from './Tooltip.tsx'
import css from './ComputerBadge.module.css'

/** Localized fact or explicit action supplied by the owning resource surface. */
export interface ComputerBadgeProps {
  name: string
  label: string
  details?: readonly { label: string; value: string }[]
  actions?: readonly { id: string; label: string; disabled?: boolean; run(): void }[]
}

/**
 * Display a resource's computer without changing any application-wide selection.
 * @param props - authenticated display metadata and explicitly scoped actions.
 * @returns a passive computer name, or a compact trigger when resource details or actions are supplied.
 */
export function ComputerBadge({ name, label, details = [], actions = [] }: ComputerBadgeProps) {
  const [open, setOpen] = useState(false)
  if (details.length === 0 && actions.length === 0) return <Tooltip label={`${label}: ${name}`}>
    <span className={css.identity} role="group" aria-label={label}>
      <IconFollowsystemOutline16 size={14} /><span className={css.name}>{name}</span>
    </span>
  </Tooltip>
  const entries: MenuEntry[] = [
    { type: 'label', id: 'computer', text: name },
    ...details.map((detail, index) => ({ type: 'label' as const, id: `detail:${index}`, text: `${detail.label}: ${detail.value}` })),
    ...(actions.length === 0 ? [] : [{ type: 'separator' as const, id: 'actions' }, ...actions.map(action => ({
      id: action.id, label: action.label, ...(action.disabled === undefined ? {} : { disabled: action.disabled }),
    }))]),
  ]
  return <Menu open={open} onClose={() => { setOpen(false) }} portal dense align="end" listClassName={css.card} items={entries}
    onSelect={(id) => { setOpen(false); actions.find(action => action.id === id)?.run() }}
    anchor={<button type="button" className={`${css.identity} ${css.trigger}`} aria-label={`${label}: ${name}`}
      aria-haspopup="menu" aria-expanded={open} onClick={(event) => { event.stopPropagation(); setOpen(value => !value) }}>
      <IconFollowsystemOutline16 size={14} /><span className={css.name}>{name}</span>
    </button>} />
}
