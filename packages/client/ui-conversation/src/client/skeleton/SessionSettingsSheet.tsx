import { useEffect, useId, type ReactNode } from 'react'
import { IconCloseOutline16, MobileSheetBackdrop } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SessionSettingsSheet.module.css'

/** Session-level control section shown by the compact settings sheet. */
export type SessionSettingsSectionId = 'model' | 'reasoning' | 'permission'

/** One section descriptor; the owner keeps domain state in its existing store. */
export interface SessionSettingsSection {
  /** Stable section id used by tabs and aria-controls. */
  id: SessionSettingsSectionId
  /** Localized section label. */
  label: string
  /** Optional current-value summary shown in the section tab. */
  summary?: ReactNode
  /** Whether the section has no selectable value in the current session. */
  disabled?: boolean
  /** Active section content. */
  content: ReactNode
}

/**
 * Render the shared phone surface for session controls.
 * @param props - open state, active section, section descriptors, and close/change callbacks.
 * @returns the sheet and backdrop while open; otherwise null.
 */
export function SessionSettingsSheet({
  open, activeSection, sections, title, closeLabel, onClose, onSectionChange,
}: {
  open: boolean
  activeSection: SessionSettingsSectionId
  sections: readonly SessionSettingsSection[]
  title: string
  closeLabel: string
  onClose: () => void
  onSectionChange: (section: SessionSettingsSectionId) => void
}) {
  const id = useId()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose, open])

  if (!open) return null
  const active = sections.find(section => section.id === activeSection) ?? sections[0]
  if (active === undefined) return null

  return (
    <>
      <MobileSheetBackdrop onClose={onClose} />
      <section
        className={css.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-session-settings-sheet=""
      >
        <div className={css.handle} aria-hidden="true" />
        <header className={css.header}>
          <h2 id={`${id}-title`} className={css.title}>{title}</h2>
          <button type="button" className={css.close} aria-label={closeLabel} autoFocus onClick={onClose}>
            <IconCloseOutline16 size={20} />
          </button>
        </header>
        <nav className={css.tabs} aria-label={title} role="tablist">
          {sections.map(section => (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={section.id === active.id}
              aria-controls={`${id}-${section.id}`}
              disabled={section.disabled}
              className={css.tab}
              onClick={() => { onSectionChange(section.id) }}
            >
              <span className={css.tabLabel}>{section.label}</span>
              {section.summary !== undefined && <span className={css.tabSummary}>{section.summary}</span>}
            </button>
          ))}
        </nav>
        <div id={`${id}-${active.id}`} className={css.body} role="tabpanel" aria-label={active.label}>
          {active.content}
        </div>
      </section>
    </>
  )
}
