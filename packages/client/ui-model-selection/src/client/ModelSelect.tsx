/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * Model catalogs above four entries show search, which retains focus while
 * ↑/↓ cycle the highlighted result; Enter and Tab accept it. Escape and
 * Shift+Tab leave a drilled pane first and otherwise close back to the
 * trigger. Provider headings paint their background only while pinned by
 * scrolling. Model names match a case-insensitive ordered subsequence
 * within each provider group, ranked by prefix, alignment score, then
 * catalog order.
 * Data and submission ride the SAME per-session ModelDirectory as the
 * /model popup; exact-model reasoning metadata and the selected effort come
 * from the Host rather than a client-owned vocabulary. Model rows show the
 * input capability the catalog disclosed. A rejected selection announces
 * through the shared transient Toast anchored to the composer card; the
 * in-menu strip with Retry remains the catalog-load surface.
 */
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconBrainOutline16, IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconChevronLeftOutline14, IconCloseFill14, Input, MenuGroup,
  MobileSheetBackdrop, IconWarningOutline16, observeStickyMenuGroups, rankByName, StateDot, Toast, useMediaQuery,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import { modelInputCapability } from './capabilities.ts'
import { orderModelProviders } from './provider-order.ts'
import css from './ModelSelect.module.css'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'
type Presentation = 'trigger' | 'section'

/** Keep the desktop menu unpainted until its first viewport-relative placement. */
const MEASURE_STYLE = { left: 0, top: 0, visibility: 'hidden' as const }

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/**
 * Backoff schedule for auto-retrying a failed mount-time load. Without it a
 * transient `session.models` failure leaves the trigger on the bare fallback
 * (no model name) until the user opens the menu or the seat remounts.
 */
const MOUNT_LOAD_RETRY_DELAYS = [1_000, 3_000, 8_000] as const

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  {
    locked, available, directory, load, select, t,
    presentation = 'trigger', settingsSection = 'model', onOpenSettings,
  }:
  ModelSelectInjected & {
    locked: boolean
    presentation?: Presentation
    settingsSection?: 'model' | 'reasoning' | 'permission'
    onOpenSettings?: (section: 'model' | 'reasoning' | 'permission') => void
  } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const retryAttemptRef = useRef(0)
  const [mountRetryTick, setMountRetryTick] = useState(0)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [selectionFocus, setSelectionFocus] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const paneFocus = useRef<'drill' | 'model' | 'effort' | null>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  const id = useId()
  const phone = useMediaQuery('(max-width: 767px)')

  const groups = useMemo(() => orderModelProviders(state.groups), [state.groups])
  const choices = useMemo(() => groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [groups])
  const showSearch = choices.length > 4
  const filteredGroups = useMemo(() => groups.map(group => ({
    ...group, models: rankByName(group.models, showSearch ? query.trim() : ''),
  })).filter(group => group.models.length > 0), [groups, query, showSearch])
  const visibleModels = useMemo(() => filteredGroups.flatMap(group => group.models.map(model => ({
    provider: group.id, model: model.id,
  }))), [filteredGroups])
  const currentVisibleIndex = visibleModels.findIndex(model =>
    model.provider === state.current?.provider && model.model === state.current.model)
  const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1)
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // Mount-time load resolves the trigger label; every open refreshes. A
  // failed load bumps mountRetryTick to re-run it after the backoff delay.
  useEffect(() => {
    if (!available || presentation === 'section') return
    lastActionRef.current = 'load'
    load()
  }, [available, load, presentation, mountRetryTick])

  // Auto-retry a failed mount-time load with backoff. A load failure is only
  // surfaced on the store (the injected load is fire-and-forget), and the
  // trigger must not sit model-less until the user happens to open the menu.
  // Only the load action retries; a rejected selection owns its toast.
  useEffect(() => {
    if (!available || presentation === 'section') return
    if (state.status === 'ready') {
      retryAttemptRef.current = 0
      return
    }
    if (state.status !== 'error' || lastActionRef.current !== 'load') return
    const attempt = retryAttemptRef.current
    if (attempt >= MOUNT_LOAD_RETRY_DELAYS.length) return
    retryAttemptRef.current = attempt + 1
    const timer = setTimeout(() => { setMountRetryTick(t => t + 1) }, MOUNT_LOAD_RETRY_DELAYS[attempt])
    return () => { clearTimeout(timer) }
  }, [available, presentation, state.status, mountRetryTick])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true
        || menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useEffect(() => {
    if (available && !locked) return
    paneFocus.current = null
    setOpen(false)
    setPane('root')
    setToast(null)
  }, [available, locked])

  useLayoutEffect(() => {
    if (!showSearch) {
      setQuery('')
      setHighlightedIndex(null)
    }
  }, [showSearch])

  // Pane switches unmount the focused row; restore focus inside the menu so
  // keyboard navigation remains available. A catalog shrinking past the
  // search threshold while on the model pane also re-seats focus.
  const previousShowSearch = useRef(showSearch)
  useEffect(() => {
    const changedSearchMode = previousShowSearch.current !== showSearch
    previousShowSearch.current = showSearch
    const intent = paneFocus.current ?? (changedSearchMode && pane === 'model' ? 'drill' : null)
    paneFocus.current = null
    if (!open || intent === null) return
    if (intent === 'drill') {
      if (pane === 'model' && showSearch) {
        searchRef.current?.focus()
        return
      }
      const rows = liveItems()
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ;(checked ?? rows.find(item => !item.disabled) ?? triggerRef.current)?.focus()
      return
    }
    const rows = liveItems()
    const cell = rows[intent === 'effort' ? 1 : 0]
    ;(cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus()
  }, [open, pane, showSearch])

  useEffect(() => {
    const viewport = groupsRef.current
    if (viewport === null) return
    return observeStickyMenuGroups(viewport)
  }, [available, open, pane, filteredGroups, presentation])

  useLayoutEffect(() => {
    if (open && pane === 'model' && activeModelIndex >= 0) {
      liveItems()[activeModelIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, pane, activeModelIndex, visibleModels])

  /* jscpd:ignore-start -- the upstream model menu aligns right edges; useAnchoredPosition owns left-edge alignment. */
  useLayoutEffect(() => {
    if (!open || phone) { setMenuPos(null); return }
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const margin = 12
      const width = menuRef.current?.offsetWidth ?? 0
      const height = menuRef.current?.offsetHeight ?? 0
      let left = rect.right - width
      let top = rect.top - 8 - height
      if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
      if (height > 0) top = Math.min(Math.max(top, margin), window.innerHeight - height - margin)
      setMenuPos({ left, top })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, phone, state, query])
  /* jscpd:ignore-end */

  if (!available) return null

  const show = (): void => {
    if (phone && onOpenSettings !== undefined) {
      onOpenSettings('model')
      return
    }
    setSelectionFocus(false)
    triggerRef.current?.focus()
    setQuery('')
    setHighlightedIndex(null)
    if (!phone && state.current === null) paneFocus.current = 'drill'
    // Phones have no room for a two-step settings-like root row. Open the
    // actual model list first; effort remains a secondary drill-in from the
    // model trigger when it is available.
    setPane(phone || state.current === null ? 'model' : 'root')
    setOpen(true)
    reload()
  }

  const changeQuery = (next: string): void => {
    setQuery(next)
    setHighlightedIndex(0)
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const closeAfterSelection = (): void => {
    setSelectionFocus(true)
    close(presentation === 'trigger')
  }

  const drill = (next: Pane): void => {
    setQuery('')
    setHighlightedIndex(null)
    paneFocus.current = 'drill'
    setPane(next)
  }

  const back = (from: Exclude<Pane, 'root'>): void => {
    paneFocus.current = from
    setPane('root')
  }

  /** Rows attached to the live pane; detached leftovers from switched panes are excluded. */
  const liveItems = (): HTMLButtonElement[] => itemRefs.current
    .filter((item): item is HTMLButtonElement => item !== null && item.isConnected)

  const moveFocus = (offset: number): void => {
    const items = liveItems()
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = active === -1 ? (offset > 0 ? 0 : items.length - 1) : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root' && !(phone && pane === 'model')) back(pane)
      else close(true)
      return
    }
    if (!open) return
    if (pane === 'model' && showSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!busy && visibleModels.length > 0) {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setHighlightedIndex((activeModelIndex + direction + visibleModels.length) % visibleModels.length)
        searchRef.current?.focus()
      }
      return
    }
    if (pane === 'model' && showSearch && event.target instanceof HTMLInputElement
      && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
      if (event.key === 'Tab' && visibleModels.length === 0) return
      event.preventDefault()
      const highlighted = visibleModels[activeModelIndex]
      if (!busy && highlighted !== undefined) choose(highlighted)
      return
    }
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        if (pane !== 'root' && !(phone && pane === 'model')) back(pane)
        else close(true)
        return
      }
      const focused = document.activeElement
      const rows = liveItems()
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      if (pane === 'model' && showSearch) {
        setHighlightedIndex(null)
        searchRef.current?.focus()
        return
      }
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      const target = checked ?? rows.find(item => !item.disabled)
      if (target === undefined) return
      target.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node
      && (rootRef.current?.contains(event.relatedTarget) === true || menuRef.current?.contains(event.relatedTarget) === true)) return
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (presentation === 'trigger' && rootRef.current !== null) closeAfterSelection()
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const submit = (selection: ModelSelection): void => {
    lastActionRef.current = 'select'
    // Disabled option rows cannot retain focus while a selection is pending.
    setSelectionFocus(true)
    triggerRef.current?.focus()
    void select(selection).then(settleSelection)
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      if (presentation === 'trigger') closeAfterSelection()
      return
    }
    submit(selection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      if (presentation === 'trigger') closeAfterSelection()
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    submit(selection)
  }

  const modelLabel = currentChoice?.model.name
    ?? (state.status === 'loading' ? t('trigger.loading') : t('trigger.fallback'))
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : effortLabel === undefined
      ? t('trigger.aria', { model: modelLabel })
      : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  // No render-time reset of itemRefs: a discarded concurrent render would
  // leave the array empty while committed rows still hold live refs.
  let itemIndex = 0
  let modelIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  const catalogStatus = (
    <>
      {state.status === 'loading' && <div className={css.status}>{t('status.loading')}</div>}
      {state.error !== null && lastActionRef.current === 'load' && (
        <div className={css.error}>
          <span>{t('error.action', { message: state.error })}</span>
          <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
        </div>
      )}
      {state.failures.map(failure => (
        <div className={css.warning} key={failure.id}>
          <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
          <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
        </div>
      ))}
    </>
  )

  const searchRow = showSearch && (
    <div className={css.searchRow}>
      <Input
        ref={searchRef}
        className={clsx(css.search, query !== '' && css.searchWithQuery)}
        type="text"
        role="searchbox"
        aria-label={t('search.placeholder')}
        aria-controls={`${id}-models`}
        aria-activedescendant={activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`}
        placeholder={t('search.placeholder')}
        value={query}
        readOnly={busy}
        onChange={(event) => { changeQuery(event.target.value) }}
      />
      {query !== '' && (
        <button
          type="button"
          className={css.searchClear}
          aria-label={t('search.clear')}
          disabled={busy}
          onClick={() => {
            changeQuery('')
            searchRef.current?.focus()
          }}
        >
          <IconCloseFill14 />
        </button>
      )}
    </div>
  )

  const modelOptions = (
    <>
      {searchRow}
      <div
        ref={groupsRef}
        id={`${id}-models`}
        className={clsx(css.groups, css.sectionGroups, 'scrollable')}
        role="menu"
        aria-label={t('menu.model')}
        hidden={filteredGroups.length === 0}
      >
        {filteredGroups.map((group) => {
          return (
            <MenuGroup key={group.id} label={group.name}>
              {group.models.map((model) => {
                const index = modelIndex++
                const selected = state.current?.provider === group.id && state.current.model === model.id
                const capability = modelInputCapability(model)
                const capabilityLabel = capability === 'image'
                  ? t('capability.image')
                  : capability === 'text'
                    ? t('capability.text')
                    : undefined
                const pending = state.pending?.provider === group.id && state.pending.model === model.id
                return (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    id={`${id}-model-${index}`}
                    tabIndex={showSearch ? -1 : 0}
                    onFocus={() => { setHighlightedIndex(index) }}
                    data-highlighted={index === activeModelIndex ? '' : undefined}
                    className={clsx(
                      css.option, css.modelOption, selected && css.selected, index === activeModelIndex && css.optionActive,
                    )}
                    onMouseMove={busy || index === activeModelIndex ? undefined : () => {
                      if (showSearch) setHighlightedIndex(index)
                      else itemRefs.current[index]?.focus()
                    }}
                    key={model.id}
                    title={model.name}
                    disabled={locked || busy}
                    onClick={() => { choose({ provider: group.id, model: model.id }) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{model.name}</span>
                      {capabilityLabel !== undefined && (
                        <span className={css.capability}>{capabilityLabel}</span>
                      )}
                    </span>
                    <span className={css.check}>
                      {pending ? <StateDot state="ongoing" /> : selected ? <IconCheckOutline16 /> : null}
                    </span>
                  </button>
                )
              })}
            </MenuGroup>
          )
        })}
      </div>
      {state.status === 'ready' && filteredGroups.length === 0 && (
        <div className={css.empty} role="status">{t(choices.length === 0 ? 'empty.models' : 'search.empty')}</div>
      )}
    </>
  )

  const effortOptions = reasoning === undefined || effortChoices.length === 0
    ? <div className={css.empty}>{t('empty.efforts')}</div>
    : (
      <div className={css.sectionGroups}>
        {effortChoices.map(level => (
          <button
            ref={itemRef()}
            type="button"
            role="menuitemradio"
            aria-checked={effectiveEffort === level.effort}
            className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
            key={level.key}
            disabled={locked || busy}
            onClick={() => { chooseEffort(level.effort) }}
          >
            <span className={css.optionCopy}>
              <span className={css.modelName}>{level.label}</span>
            </span>
            <span className={css.check}>
              {state.pending !== null && state.current !== null
                && state.pending.provider === state.current.provider
                && state.pending.model === state.current.model
                && state.pending.reasoningEffort === level.effort
                ? <StateDot state="ongoing" />
                : effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}
            </span>
          </button>
        ))}
      </div>
    )

  if (presentation === 'section') {
    return (
      <div className={css.sectionContent} data-model-settings-section={settingsSection}>
        {settingsSection === 'reasoning' ? <>{catalogStatus}{effortOptions}</> : <>{catalogStatus}{modelOptions}</>}
      </div>
    )
  }

  const menu = (
    <div
      ref={menuRef}
      id={`${id}-menu`}
      className={css.menu}
      style={phone ? undefined : menuPos ?? MEASURE_STYLE}
      role={pane === 'model' ? 'group' : 'menu'}
      aria-label={t('menu.aria')}
      aria-busy={state.status === 'loading' || busy}
    >
      {phone && pane !== 'root' && (
        <button
          type="button"
          className={css.back}
          aria-label={t('menu.back')}
          onClick={() => { back(pane) }}
        >
          <IconChevronLeftOutline14 size={16} />
          <span>{t('menu.back')}</span>
          <span className={css.backTitle}>{pane === 'model' ? t('menu.model') : t('menu.effort')}</span>
        </button>
      )}
      {pane === 'root' && (
        <>
          <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('model') }}>
            <span className={css.cellLabel}>{t('menu.model')}</span>
            <span className={css.cellValue}>{modelLabel}</span>
            <IconChevronRightOutline14 className={css.cellChevron} />
          </button>
          {reasoning !== undefined && (
            <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('effort') }}>
              <span className={css.cellLabel}>{t('menu.effort')}</span>
              <span className={css.cellValue}>{effortLabel}</span>
              <IconChevronRightOutline14 className={css.cellChevron} />
            </button>
          )}
        </>
      )}

      {pane === 'model' && (
        <>
          {catalogStatus}
          {modelOptions}
        </>
      )}

      {pane === 'effort' && (
        <>
          {catalogStatus}
          {effortOptions}
        </>
      )}
    </div>
  )

  return (
    <div ref={rootRef} className={css.root} data-model-select="" onKeyDown={onRootKeyDown} onBlur={onBlur}
      onMouseDown={(event) => {
        // WebKit blurs a focused row before click unless the button's mousedown keeps focus.
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        data-model-trigger=""
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        aria-busy={state.status === 'loading' || busy}
        data-selection-focus={selectionFocus ? '' : undefined}
        onBlur={() => { setSelectionFocus(false) }}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        {/* The glyph is the narrow-container fallback: the row's anonymous
            inline-size container collapses the label below the readable
            width, leaving icon + chevron; the title still names the model.
            On the compact phone row the trigger is this glyph alone. */}
        <span className={css.triggerGlyph} aria-hidden><IconBrainOutline16 /></span>
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>

      {open && (
        <>
          <MobileSheetBackdrop onClose={() => { close(true) }} />
          {phone ? menu : createPortal(menu, document.body)}
        </>
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
