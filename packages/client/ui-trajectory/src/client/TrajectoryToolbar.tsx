/** Trajectory toolbar: timeline and ledger fold controls. */

import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconEllipsisOutline16,
  IconSearchOutline16,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { NS } from './locales.ts'
import css from './TrajectoryToolbar.module.css'

export interface TrajectoryToolbarProps {
  /** Whether the frame resolved the compact phone presenter. */
  compact?: boolean
  /** Whether timeline blocks use recorded durations instead of equal widths. */
  actualDuration: boolean
  /** Select recorded-duration or equal-width blocks. */
  onActualDurationChange: (actualDuration: boolean) => void
  /** Whether recorded timing retains idle gaps between operations. */
  actualTime: boolean
  /** Select complete wall-clock timing or idle-compressed timing. */
  onActualTimeChange: (actualTime: boolean) => void
  /** Whether every collapsible turn is currently folded. */
  allTurnsCollapsed: boolean
  /** Fold or expand every collapsible turn. */
  onToggleAllTurns: () => void
  /** Whether every collapsible assistant's tool calls are currently folded. */
  allAssistantsCollapsed: boolean
  /** Fold or expand tool calls under every collapsible assistant. */
  onToggleAllAssistants: () => void
  /** Current live ledger search query. */
  searchQuery: string
  /** Update the live ledger search query. */
  onSearchQueryChange: (query: string) => void
  /** Translate a toolbar dictionary key. */
  t: TranslateNS<typeof NS>
}

/**
 * Render the sticky trajectory toolbar.
 * @param props - rendered counts and whole-list fold state.
 * @returns the toolbar element.
 */
export function TrajectoryToolbar({
  compact = false,
  actualDuration,
  onActualDurationChange,
  actualTime,
  onActualTimeChange,
  allTurnsCollapsed,
  onToggleAllTurns,
  allAssistantsCollapsed,
  onToggleAllAssistants,
  searchQuery,
  onSearchQueryChange,
  t,
}: TrajectoryToolbarProps) {
  const [searchOpen, setSearchOpen] = useState(searchQuery !== '')
  const [menuOpen, setMenuOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const mobileMenuItems: readonly MenuEntry[] = [
    {
      id: 'turns',
      label: allTurnsCollapsed ? t('toolbar.expandTurns') : t('toolbar.collapseTurns'),
    },
    {
      id: 'calls',
      label: allAssistantsCollapsed ? t('toolbar.expandCalls') : t('toolbar.collapseCalls'),
    },
    {
      id: 'actual-time',
      label: t('toolbar.actualTime'),
    },
  ]

  return (
    <div className={css.root} role="toolbar" aria-label={t('toolbar.aria')}>
      <div className={css.inner}>
        {!compact && <div className={css.actions}>
          <button
            type="button"
            className={css.toggle}
            aria-label={t('toolbar.useActualDuration')}
            aria-pressed={actualDuration}
            title={actualDuration ? t('toolbar.useEqualWidth') : t('toolbar.useActualDuration')}
            onClick={() => { onActualDurationChange(!actualDuration) }}
          >
            <svg
              className={css.toggleIcon}
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="5.25" />
              <path d="M8 4.75V8l2.25 1.5" />
            </svg>
            {t('toolbar.duration')}
          </button>
          <button
            type="button"
            className={css.control}
            role="switch"
            aria-checked={actualTime}
            hidden
            onClick={() => { onActualTimeChange(!actualTime) }}
          >
            <span>{t('toolbar.actualTime')}</span>
            <span className={css.controlTrack} data-on={actualTime || undefined} aria-hidden="true">
              <span className={css.controlThumb} />
            </span>
          </button>
          <button
            type="button"
            className={css.action}
            aria-label={allTurnsCollapsed ? t('toolbar.expandTurns') : t('toolbar.collapseTurns')}
            aria-pressed={allTurnsCollapsed}
            title={allTurnsCollapsed ? t('toolbar.expandTurns') : t('toolbar.collapseTurns')}
            onClick={onToggleAllTurns}
          >
            <span className={css.actionIcon} aria-hidden="true">
              {allTurnsCollapsed ? '⊞' : '⊟'}
            </span>
            {t('toolbar.turns')}
          </button>
          <button
            type="button"
            className={css.action}
            aria-label={allAssistantsCollapsed ? t('toolbar.expandCalls') : t('toolbar.collapseCalls')}
            aria-pressed={allAssistantsCollapsed}
            title={allAssistantsCollapsed ? t('toolbar.expandCalls') : t('toolbar.collapseCalls')}
            onClick={onToggleAllAssistants}
          >
            <span className={css.actionIcon} aria-hidden="true">
              {allAssistantsCollapsed ? '⊞' : '⊟'}
            </span>
            {t('toolbar.calls')}
          </button>
        </div>}
        {!compact && <div className={css.search}>
          <IconSearchOutline16 size={11} className={css.searchIcon} />
          <input
            type="search"
            className={css.searchInput}
            aria-label={t('toolbar.search')}
            placeholder={t('toolbar.searchPlaceholder')}
            value={searchQuery}
            onChange={(event) => { onSearchQueryChange(event.currentTarget.value) }}
          />
        </div>}
        {compact && <div className={css.mobileControls}>
          {searchOpen ? (
            <div className={css.mobileSearch}>
              <IconSearchOutline16 size={16} className={css.searchIcon} />
              <input
                ref={searchInputRef}
                type="search"
                className={css.searchInput}
                aria-label={t('toolbar.search')}
                placeholder={t('toolbar.searchPlaceholder')}
                value={searchQuery}
                onChange={(event) => { onSearchQueryChange(event.currentTarget.value) }}
              />
              <button
                type="button"
                className={css.mobileClose}
                aria-label={t('toolbar.closeSearch')}
                onClick={() => {
                  setSearchOpen(false)
                  onSearchQueryChange('')
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className={css.mobileIconButton}
                aria-label={t('toolbar.search')}
                aria-expanded={false}
                onClick={() => { setSearchOpen(true) }}
              >
                <IconSearchOutline16 size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={css.mobileIconButton}
                aria-label={actualDuration ? t('toolbar.useEqualWidth') : t('toolbar.useActualDuration')}
                aria-pressed={actualDuration}
                onClick={() => { onActualDurationChange(!actualDuration) }}
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="5.25" />
                  <path d="M8 4.75V8l2.25 1.5" />
                </svg>
              </button>
              <Menu
                open={menuOpen}
                compact
                anchor={(
                  <button
                    type="button"
                    className={css.mobileIconButton}
                    aria-label={t('toolbar.more')}
                    aria-expanded={menuOpen}
                    onClick={() => { setMenuOpen(open => !open) }}
                  >
                    <IconEllipsisOutline16 size={16} aria-hidden="true" />
                  </button>
                )}
                items={mobileMenuItems}
                onClose={() => { setMenuOpen(false) }}
                onSelect={(id) => {
                  if (id === 'turns') onToggleAllTurns()
                  else if (id === 'calls') onToggleAllAssistants()
                  else if (id === 'actual-time') onActualTimeChange(!actualTime)
                  setMenuOpen(false)
                }}
                className={css.mobileMenu}
              />
            </>
          )}
        </div>}
      </div>
    </div>
  )
}
