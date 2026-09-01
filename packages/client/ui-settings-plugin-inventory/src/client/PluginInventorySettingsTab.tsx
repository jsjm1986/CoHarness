import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconChevronDownOutline14,
  IconSearchOutline16,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './PluginInventorySettingsTab.module.css'

/** Registration-side Remote face used by the section. */
export interface PluginInventorySettingsTabInjected {
  /** Read a current Host inventory snapshot. */
  list: () => Promise<PluginInventorySnapshot>
  /** Resolve a preset's display name in the active browser locale. */
  presetName?: (preset: PresetGroup) => string
}

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']
type PresetGroup = NonNullable<PluginInventorySnapshot['agentPresets']>[number]
type PresetName = (preset: PresetGroup) => string

/** Full component props assembled by the Settings slot renderer. */
export type PluginInventorySettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PluginInventoryLocaleKey>

/** Localized accessible label for one root Fiber phase. */
function phaseLabel(
  phase: PluginFiberPhase,
  t: PluginInventorySettingsTabProps['t'],
): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '')
}

/** Whether an inventory row matches the local catalog query. */
function matches(entry: PluginInventoryEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [entry.moduleName, entry.entryId]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/** The roster row shown when the picker has no explicit choice. */
function fallbackPreset(presets: readonly PresetGroup[]): PresetGroup | undefined {
  return presets.find(preset => preset.isDefault) ?? presets[0]
}

/** Resolve the switcher label while preserving user-authored metadata. */
function presetLabel(
  preset: PresetGroup,
  t: PluginInventorySettingsTabProps['t'],
  presetName: PresetName,
): string {
  const name = presetName(preset)
  if (preset.broken !== undefined) return t('presetOptionBroken', { name })
  if (preset.isDefault) return t('presetOptionDefault', { name })
  return name
}

function matchesRow(moduleName: string, entryId: string | null, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [moduleName, ...(entryId === null ? [] : [entryId])]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/** Render one compact disclosure card shared by preset and global groups. */
function InventoryCard({
  keyValue, moduleName, entryId, label, phase, expanded, onToggle, t, details,
}: {
  keyValue: string
  moduleName: string
  entryId: string | null
  label: string
  phase: PluginFiberPhase
  expanded: string | null
  onToggle: (key: string) => void
  t: PluginInventorySettingsTabProps['t']
  details: readonly (readonly [string, ReactNode])[]
}): ReactNode {
  const open = expanded === keyValue
  const detailId = `plugin-details-${encodeURIComponent(keyValue)}`
  const status = phaseLabel(phase, t)
  return (
    <li className={css.card} key={keyValue} data-plugin-entry={entryId ?? undefined} data-plugin-module={moduleName} data-failed={phase === 'failed' ? 'true' : undefined} data-open={open ? 'true' : undefined}>
      <button
        className={css.cardContent}
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={`${moduleShortName(moduleName)}, ${label}`}
        onClick={() => { onToggle(keyValue) }}
      >
        <strong className={css.cardTitle} title={moduleName}>{moduleShortName(moduleName)}</strong>
        <span className={css.cardTrailing}>
          {phase !== null && phase !== 'failed' && <span className={css.statusDot} data-phase={phase} role="img" aria-label={status} title={status} />}
          <span className={css.configTag} data-kind={label === t('presetEnabledTag') ? 'preset' : label === t('conditionalTag') ? 'conditional' : label === t('failedTag') ? 'failed' : label === t('enabledTag') ? 'enabled' : 'disabled'}>{label}</span>
          <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
        </span>
      </button>
      {open && (
        <div className={css.cardDetails} id={detailId}>
          {entryId !== null && <code className={css.entryValue} data-loader-entry>{entryId}</code>}
          <dl className={css.details}>
            <div><dt>{t('moduleLabel')}</dt><dd>{moduleName}</dd></div>
            {details.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
          </dl>
        </div>
      )}
    </li>
  )
}

/** Grouped preset/global view used when the Host supplies composition rows. */
function GroupedInventory({
  snapshot, normalizedQuery, expanded, onToggle, presetName, sectionId, t,
}: {
  snapshot: PluginInventorySnapshot
  normalizedQuery: string
  expanded: string | null
  onToggle: (key: string) => void
  presetName: PresetName
  sectionId: string
  t: PluginInventorySettingsTabProps['t']
}): ReactNode {
  const presets = snapshot.agentPresets ?? []
  const [chosenPreset, setChosenPreset] = useState<string | null>(null)
  const [presetOpen, setPresetOpen] = useState<boolean | null>(null)
  const [globalOpen, setGlobalOpen] = useState<boolean | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const selected = presets.find(item => item.id === chosenPreset) ?? fallbackPreset(presets)
  const searching = normalizedQuery.length > 0
  const selectedRows = selected?.rows.filter(row => matchesRow(row.moduleName, row.entryId, normalizedQuery)) ?? []
  const enabledIn = useMemo(() => {
    const result = new Map<string, PresetGroup[]>()
    for (const preset of presets) {
      for (const row of preset.rows) {
        if (row.enabled !== true) continue
        const values = result.get(row.moduleName) ?? []
        if (!values.includes(preset)) values.push(preset)
        result.set(row.moduleName, values)
      }
    }
    return result
  }, [presets])
  const failed = snapshot.entries.filter(entry => entry.fiberPhase === 'failed' && matches(entry, normalizedQuery))
  const regular = snapshot.entries.filter(entry => entry.fiberPhase !== 'failed' && matches(entry, normalizedQuery))
  const global = [...failed, ...regular]
  const otherMatches = searching
    ? presets.filter(preset => preset !== selected && preset.rows.some(row => matchesRow(row.moduleName, row.entryId, normalizedQuery)))
    : []
  const otherMatchCount = otherMatches.reduce(
    (count, preset) => count + preset.rows.filter(row => matchesRow(row.moduleName, row.entryId, normalizedQuery)).length,
    0,
  )
  const presetExpanded = searching || (presetOpen ?? true)
  const globalExpanded = searching || (globalOpen ?? presets.length === 0)
  return (
    <>
      {selected !== undefined && (
        <section className={css.group} data-plugin-scope="preset" data-preset-id={selected.id}>
          <div className={css.groupTitleRow}>
            <button type="button" className={css.groupToggle} aria-expanded={presetExpanded} aria-controls={`${sectionId}-preset`} onClick={() => { setPresetOpen(!presetExpanded) }}>
              <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
              <span className={css.groupTitle}>{t('presetTitle')}</span>
            </button>
            <div className={css.headerEnd}>
              <Menu
                open={switcherOpen}
                onClose={() => { setSwitcherOpen(false) }}
                items={presets.map(preset => ({
                  id: preset.id,
                  label: presetLabel(preset, t, presetName),
                }))}
                selectedId={selected.id}
                onSelect={(id) => { setSwitcherOpen(false); setChosenPreset(id) }}
                align="end"
                portal
                anchor={<button type="button" className={css.switcher} aria-label={t('switcherLabel')} aria-haspopup="menu" aria-expanded={switcherOpen} onClick={() => { setSwitcherOpen(value => !value) }}><span className={css.switcherLabel}>{presetLabel(selected, t, presetName)}</span><IconChevronDownOutline14 className={css.chevron} aria-hidden="true" /></button>}
              />
            </div>
          </div>
          <p className={css.groupSub}>{t('presetSubtitle')}<span data-preset-plugin-count={selectedRows.length}>{` · ${String(selectedRows.length)} ${t('countUnit')}`}</span></p>
          {presetExpanded && <div className={css.groupBody} id={`${sectionId}-preset`}>
            {selected.broken !== undefined && <p className={css.brokenNote} role="alert">{selected.broken}</p>}
            {selectedRows.length > 0 && <ul className={css.cards}>{selectedRows.map((row, index) => {
              const label = row.enabled === true ? (row.fiberPhase === 'failed' ? t('failedTag') : t('enabledTag')) : row.enabled === false ? t('disabledTag') : t('conditionalTag')
              return <InventoryCard key={`preset:${selected.id}:${String(index)}`} keyValue={`preset:${selected.id}:${String(index)}`} moduleName={row.moduleName} entryId={row.entryId} label={label} phase={row.fiberPhase} expanded={expanded} onToggle={onToggle} t={t} details={[[t('fromPreset'), presetName(selected)], [t('configuration'), label], ...(row.fiberPhase === null ? [] : [[t('runtime'), phaseLabel(row.fiberPhase, t)] as const]), ...(row.condition === undefined ? [] : [[t('condition'), row.condition] as const])]} />
            })}</ul>}
            {otherMatchCount > 0 && <p className={css.hint}>{t('matchesInOtherPresets', { count: String(otherMatchCount) })}{otherMatches.map(preset => <button key={preset.id} type="button" className={css.jumpLink} onClick={() => { setChosenPreset(preset.id) }}>{presetName(preset)}</button>)}</p>}
          </div>}
        </section>
      )}
      {snapshot.entries.length > 0 && <section className={css.group} data-plugin-scope="global">
        <div className={css.groupTitleRow}><button type="button" className={css.groupToggle} aria-expanded={globalExpanded} aria-controls={`${sectionId}-global`} onClick={() => { setGlobalOpen(!globalExpanded) }}><IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" /><span className={css.groupTitle}>{t('globalTitle')}</span></button></div>
        <p className={css.groupSub}>{t('globalSubtitle')}<span data-plugin-count={global.length}>{` · ${String(global.length)} ${t('countUnit')}`}</span>{failed.length > 0 && <span className={css.failedCount}>{`${String(failed.length)} ${t('failedCountLabel')}`}</span>}</p>
        {globalExpanded && global.length > 0 && <ul className={css.cards} id={`${sectionId}-global`}>{global.map((entry) => {
          const providers = entry.enabled ? undefined : enabledIn.get(entry.moduleName)
          const label = entry.fiberPhase === 'failed' ? t('failedTag') : providers !== undefined ? t('presetEnabledTag') : entry.enabled ? t('enabledTag') : t('disabledTag')
          return <InventoryCard key={`global:${entry.entryId}`} keyValue={`global:${entry.entryId}`} moduleName={entry.moduleName} entryId={entry.entryId} label={label} phase={entry.fiberPhase} expanded={expanded} onToggle={onToggle} t={t} details={providers === undefined ? [[t('configuration'), label], ...(entry.enabled ? [[t('runtime'), phaseLabel(entry.fiberPhase, t)] as const] : [])] : [[t('configuration'), t('presetProvidedDetail')], [t('enabledIn'), <span className={css.enabledIn}><span>{providers.map(preset => presetName(preset)).join(' · ')}</span><button type="button" className={css.jumpLink} onClick={() => { const first = providers[0]; if (first !== undefined) setChosenPreset(first.id) }}>{t('viewInPreset')}</button></span>]]} />
        })}</ul>}
      </section>}
      {searching && selectedRows.length === 0 && global.length === 0 && otherMatches.length === 0
        && <p className={css.status}>{t('emptySearch')}</p>}
    </>
  )
}

/** Render the read-only current Loader inventory. */
export function PluginInventorySettingsTab({
  list,
  presetName: suppliedPresetName,
  t,
}: PluginInventorySettingsTabProps): ReactNode {
  const presetName: PresetName = suppliedPresetName ?? (preset => preset.name ?? preset.id)
  const catalogId = useId()
  const sectionId = `${catalogId}-groups`
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredEntries = useMemo(
    () => state.status === 'ready'
      ? state.snapshot.entries.filter(entry => matches(entry, normalizedQuery))
      : [],
    [normalizedQuery, state],
  )

  useEffect(() => {
    // Grouped cards use a scoped key (`preset:`/`global:`); their expansion is
    // owned by the grouped view and must not be cleared by the flat-entry
    // filter below.
    if (state.status === 'ready' && (state.snapshot.agentPresets?.length ?? 0) > 0) return
    if (expanded !== null && !filteredEntries.some(entry => entry.entryId === expanded)) {
      setExpanded(null)
    }
  }, [expanded, filteredEntries, state])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <div className={css.catalog}>
          <label className={css.search}>
            <IconSearchOutline16 aria-hidden="true" />
            <span className={css.visuallyHidden}>{t('search')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('search')}
              aria-label={t('search')}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
          {state.snapshot.agentPresets !== undefined && state.snapshot.agentPresets.length > 0 ? (
            <GroupedInventory
              snapshot={state.snapshot}
              normalizedQuery={normalizedQuery}
              expanded={expanded}
              onToggle={(key) => { setExpanded(current => current === key ? null : key) }}
              presetName={presetName}
              sectionId={sectionId}
              t={t}
            />
          ) : (
            <>
              <div className={css.catalogHeading}>
                <h3>{t('catalog')}</h3>
                <span data-plugin-count={filteredEntries.length}>{filteredEntries.length}</span>
              </div>
              {state.snapshot.entries.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
              {state.snapshot.entries.length > 0 && filteredEntries.length === 0
                ? <p className={css.status}>{t('emptySearch')}</p>
                : null}
              {filteredEntries.length > 0 ? (
                <ul className={css.cards}>
                  {filteredEntries.map((entry) => {
                    const status = phaseLabel(entry.fiberPhase, t)
                    const title = moduleShortName(entry.moduleName)
                    const configuration = t(entry.enabled ? 'enabledTag' : 'disabledTag')
                    const open = expanded === entry.entryId
                    const detailId = `${catalogId}-details-${encodeURIComponent(entry.entryId)}`
                    return (
                      <li
                        className={css.card}
                        key={entry.entryId}
                        data-plugin-entry={entry.entryId}
                        data-open={open ? 'true' : undefined}
                      >
                        <button
                          className={css.cardContent}
                          type="button"
                          aria-expanded={open}
                          aria-controls={detailId}
                          aria-label={entry.enabled ? `${title}, ${status}, ${configuration}` : `${title}, ${configuration}`}
                          onClick={() => {
                            setExpanded(current => current === entry.entryId ? null : entry.entryId)
                          }}
                        >
                          <strong className={css.cardTitle} title={entry.moduleName}>{title}</strong>
                          <span className={css.cardTrailing}>
                            {entry.enabled ? (
                              <span
                                className={css.statusDot}
                                data-phase={entry.fiberPhase ?? 'unobserved'}
                                role="img"
                                aria-label={status}
                                title={status}
                              />
                            ) : null}
                            <span className={css.configTag} data-enabled={entry.enabled ? 'true' : 'false'}>
                              {configuration}
                            </span>
                            <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                          </span>
                        </button>
                        {open ? (
                          <div className={css.cardDetails} id={detailId}>
                            <code className={css.entryValue} data-loader-entry>{entry.entryId}</code>
                            <dl className={css.details}>
                              <div>
                                <dt>{t('configuration')}</dt>
                                <dd>{configuration}</dd>
                              </div>
                              {entry.enabled ? (
                                <div>
                                  <dt>{t('cordis')}</dt>
                                  <dd>{status}</dd>
                                </div>
                              ) : null}
                            </dl>
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
