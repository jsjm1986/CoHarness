import { useId, useState } from 'react'
import { Button, IconChevronDownOutline14, IconChevronsUpDownOutline16, Menu, useMediaQuery } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DocumentSort, DocumentSortKey } from './listing.ts'
import type { DocumentsKey } from './locales.ts'
import css from './DocumentSortControl.module.css'

const fields: readonly DocumentSortKey[] = ['date', 'name', 'size']
const fieldLabels = { date: 'sort.field.date', name: 'sort.field.name', size: 'sort.field.size' } as const
const directions = {
  date: { desc: 'sort.date.desc', asc: 'sort.date.asc' },
  name: { asc: 'sort.name.asc', desc: 'sort.name.desc' },
  size: { desc: 'sort.size.desc', asc: 'sort.size.asc' },
} as const

/**
 * Present the existing six document sort values as field and direction groups.
 * @param props.sort - current listing order.
 * @param props.onChange - receives the unchanged key:direction value.
 * @param props.t - document translations.
 * @param props.inline - place the groups inside the compact controls sheet.
 * @param props.disabled - prevent changes while a document operation is pending.
 * @returns the sort menu trigger or inline radio groups.
 */
export function DocumentSortControl({ sort, onChange, t, inline = false, disabled = false }: {
  sort: DocumentSort
  onChange: (value: string) => void
  t: (key: DocumentsKey) => string
  inline?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const touch = useMediaQuery('(pointer: coarse)')
  const valueId = useId()
  const chooseField = (key: DocumentSortKey) => { onChange(`${key}:${key === 'name' ? 'asc' : 'desc'}`) }
  const orderedDirections = sort.key === 'name' ? ['asc', 'desc'] as const : ['desc', 'asc'] as const
  if (inline) return <div className={css.groups}>
    <fieldset disabled={disabled}><legend>{t('sort.field')}</legend><div className={css.choices}>
      {fields.map(key => <label key={key}><input type="radio" name="documents-sort-field" checked={sort.key === key} onChange={() => { chooseField(key) }} /><span>{t(fieldLabels[key])}</span></label>)}
    </div></fieldset>
    <fieldset disabled={disabled}><legend>{t('sort.direction')}</legend><div className={css.choices}>
      {orderedDirections.map(dir => <label key={dir}><input type="radio" name="documents-sort-direction" checked={sort.dir === dir} onChange={() => { onChange(`${sort.key}:${dir}`) }} /><span>{t(directions[sort.key][dir])}</span></label>)}
    </div></fieldset>
  </div>
  return <Menu open={open} onClose={() => { setOpen(false) }} portal autoFocus compact={!touch} align="end"
    anchor={<Button className={css.trigger} size="toolbar" variant="ghost" type="button" disabled={disabled} aria-label={t('modal.sort')} aria-describedby={valueId} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open) }} icon={<IconChevronsUpDownOutline16 size={16} />}><span id={valueId}>{t(fieldLabels[sort.key])} · {t(directions[sort.key][sort.dir])}</span><IconChevronDownOutline14 size={12} /></Button>}
    selectedIds={[`field:${sort.key}`, `direction:${sort.dir}`]}
    items={[
      { type: 'label', id: 'field-label', text: t('sort.field') },
      ...fields.map(key => ({ id: `field:${key}`, label: t(fieldLabels[key]) })),
      { type: 'separator', id: 'direction-separator' },
      { type: 'label', id: 'direction-label', text: t('sort.direction') },
      ...orderedDirections.map(dir => ({ id: `direction:${dir}`, label: t(directions[sort.key][dir]) })),
    ]}
    onSelect={(id) => {
      const key = fields.find(field => id === `field:${field}`)
      if (key !== undefined) chooseField(key)
      else onChange(`${sort.key}:${id === 'direction:asc' ? 'asc' : 'desc'}`)
      setOpen(false)
    }} />
}
