import { useId, useState } from 'react'
import { IconBrowseOutline16, IconFolderClose16, IconSearchOutline16, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './DocumentDestinationPicker.module.css'

interface DestinationOption {
  value: string
  label: string
  description?: string
  kind?: 'folder' | 'scope'
}

/**
 * Present already-authorized destinations without changing their values or order.
 * Search filters visible labels and retains the selected destination.
 * @param props - Controlled selection, optional controlled search, and localized labels.
 * @returns A keyboard-operable destination group with complete option names.
 */
export function DocumentDestinationPicker({
  label, options, value, onChange, disabled = false, searchPlaceholder, emptyLabel,
  selectedLabel, query: controlledQuery, onQueryChange, searchable = options.length > 5,
}: {
  label: string
  options: readonly DestinationOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  searchPlaceholder: string
  emptyLabel: string
  selectedLabel: (name: string) => string
  query?: string
  onQueryChange?: (query: string) => void
  searchable?: boolean
}) {
  const id = useId()
  const [localQuery, setLocalQuery] = useState('')
  const query = controlledQuery ?? localQuery
  const needle = query.trim().toLocaleLowerCase()
  const visible = options.filter(option => needle === '' || option.label.toLocaleLowerCase().includes(needle))
  const selected = options.find(option => option.value === value)
  return (
    <fieldset className={css.picker} disabled={disabled} role="radiogroup" aria-labelledby={`${id}-label`}>
      <legend id={`${id}-label`} className={css.label}>{label}</legend>
      {searchable && <Input className={css.search as string} icon={<IconSearchOutline16 size={16} />} aria-label={searchPlaceholder}
        placeholder={searchPlaceholder} value={query} onChange={(event) => {
          if (onQueryChange !== undefined) onQueryChange(event.currentTarget.value)
          else setLocalQuery(event.currentTarget.value)
        }} />}
      <div className={css.options}>
        {visible.length === 0 ? <p className={css.empty} role="status">{emptyLabel}</p> : visible.map(option => (
          <label key={option.value} className={css.option}>
            <input type="radio" name={id} value={option.value} checked={value === option.value}
              onChange={() => { onChange(option.value) }} />
            <span className={css.icon} aria-hidden="true">
              {option.kind === 'scope' ? <IconBrowseOutline16 size={18} /> : <IconFolderClose16 size={18} />}
            </span>
            <span className={css.copy}>
              <span>{option.label}</span>{option.description !== undefined && <small>{option.description}</small>}
            </span>
          </label>
        ))}
      </div>
      {selected !== undefined && <p className={css.selected}>{selectedLabel(selected.label)}</p>}
    </fieldset>
  )
}
