/** The cross-space plugin inventory: every space's reported composition, expandable to its bundles and live entries. */
import { ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { pluginInventoryList, type PluginInventoryBundle, type PluginInventoryLocalizedText, type PluginInventoryPlugin, type PluginInventorySpaceRow, type PluginDesiredState } from '../api.ts'
import { Button, ErrorBanner, Section, StatusBadge } from '../components/ui.tsx'
import { adminLanguage } from '../language.ts'
import { packageText, resolveLocalized, rowText, type Translate } from './presentation.ts'
import type { PluginManagerLocaleKey } from './locales.ts'

/** The status badge one reported fiber phase maps to. */
const PHASE_KEYS: Record<string, PluginManagerLocaleKey> = {
  pending: 'rowPhasePending',
  loading: 'rowPhaseLoading',
  active: 'rowPhaseActive',
  failed: 'rowPhaseFailed',
  unloading: 'rowPhaseUnloading',
}

type ResolveInventoryText = (text: PluginInventoryLocalizedText) => string | undefined

/** One reported fiber phase as a badge; unmapped values read verbatim. */
function PhaseBadge({ phase, t }: { readonly phase: string | null; readonly t: Translate }) {
  if (phase === null) return <span className="muted">{t('listNoLiveEntry')}</span>
  const key = PHASE_KEYS[phase]
  return <StatusBadge tone={phase === 'failed' ? 'danger' : phase === 'active' ? 'success' : 'neutral'}>
    {key === undefined ? phase : t(key)}
  </StatusBadge>
}

/** The install-source kind a reported spec reads as: registry, git, local path, or archive. */
function sourceLabel(source: string | undefined, t: Translate): string {
  if (source === undefined) return t('sourceProvided')
  if (/\.(tgz|tar\.gz)(#|$)/u.test(source)) return t('sourceArchive')
  if (/^(?:file|link):/u.test(source) || /^[~/]/u.test(source) || /^[A-Za-z]:[\\/]/u.test(source)) return t('sourceLocal')
  if (/^(?:git[+@:]|github:|gitlab:|bitbucket:|sourcehut:)/u.test(source) || /\.git(?:#|$)/u.test(source)) return t('sourceGit')
  return t('sourceRegistry')
}

/** A reported bundle's install source and version alongside the live phases of its declared rows. */
function BundleCard({ bundle, live, resolveText, t }: {
  readonly bundle: PluginInventoryBundle
  readonly live: ReadonlyMap<string, PluginInventoryPlugin>
  readonly resolveText: ResolveInventoryText
  readonly t: Translate
}) {
  const text = packageText({ name: bundle.name, ...(bundle.meta === undefined ? {} : { meta: bundle.meta }) }, resolveText)
  return <div className="spaceBundle">
    <div className="spaceBundleHead">
      <strong>{text.title}</strong>
      {bundle.version === undefined ? null : <span className="muted">@{bundle.version}</span>}
      <StatusBadge tone="info">{sourceLabel(bundle.source, t)}</StatusBadge>
      {bundle.enabled ? null : <StatusBadge>{t('partOff')}</StatusBadge>}
      {bundle.error === undefined ? null : <StatusBadge tone="danger">{t('statusProblem')}</StatusBadge>}
    </div>
    <div className="muted spaceBundleSub">
      <code>{bundle.name}</code>
      {text.description === undefined ? null : <span>{text.description}</span>}
    </div>
    {bundle.rows.length === 0 ? null : <ul className="spaceBundleRows">
      {bundle.rows.map((row) => {
        const entry = row.entryId === undefined ? undefined : live.get(row.entryId)
        const rowDisplay = rowText({ moduleName: row.moduleName, ...(row.meta === undefined ? {} : { meta: row.meta }) }, resolveText)
        return <li key={row.rowId}>
          <span className="spaceRowTitle" title={row.moduleName}>{rowDisplay.title}</span>
          {entry === undefined ? <span className="muted">{t('listNoLiveEntry')}</span> : <PhaseBadge phase={entry.fiberPhase} t={t} />}
          {entry !== undefined && entry.enabled ? null : entry === undefined ? null : <StatusBadge>{t('partOff')}</StatusBadge>}
        </li>
      })}
    </ul>}
  </div>
}

/** The saved desired-state composition a space shows while it has never reported an inventory. */
function SavedComposition({ desired, t }: { readonly desired: PluginDesiredState; readonly t: Translate }) {
  return <div className="spaceBundle">
    <div className="spaceBundleHead"><StatusBadge tone="warning">{t('spacesSavedOnly')}</StatusBadge></div>
    {desired.bundles.length === 0 ? null : <p className="muted">{t('spacesSavedBundles', { names: desired.bundles.join(t('registryListSeparator')) })}</p>}
    {desired.entries.length === 0 ? null : <ul className="spaceBundleRows">
      {desired.entries.map(entry => <li key={entry.id}>
        <span className="spaceRowTitle">{entry.name ?? entry.id}</span>
        {entry.disabled ? <StatusBadge>{t('partOff')}</StatusBadge> : null}
      </li>)}
    </ul>}
  </div>
}

/** One space's collapsible card: headline summary plus its bundle inventory or saved-state fallback. */
function SpaceCard({ row, resolveText, t, onPick }: {
  readonly row: PluginInventorySpaceRow
  readonly resolveText: ResolveInventoryText
  readonly t: Translate
  readonly onPick: (key: string) => void
}) {
  const inventory = row.inventory
  const failed = inventory?.plugins.filter(plugin => plugin.fiberPhase === 'failed').length ?? 0
  const live = useMemo(() => new Map((inventory?.plugins ?? []).map(plugin => [plugin.entryId, plugin])), [inventory])
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  return <div className="spaceCard">
    <div className="spaceCardHeader">
      <button type="button" className="spaceCardToggle" aria-expanded={expanded} aria-controls={contentId}
        onClick={() => setExpanded(value => !value)}>
        <ChevronRight className="spaceCardChevron" aria-hidden="true" />
        <span className="spaceCardTitle">
          <strong>{row.target.label}</strong>
          <small className="muted">{row.target.kind === 'user' ? t('spacesKindUser') : t('spacesKindProject')}</small>
          {row.target.steward ? <StatusBadge tone="info">{t('spacesSteward')}</StatusBadge> : null}
        </span>
        <span className="spaceCardSummary muted">
          {inventory === null
            ? (row.desired === null ? t('spacesNoReport') : `${t('spacesBundles', { count: `${row.desired.bundles.length}` })} · ${t('spacesSavedOnly')}`)
            : `${t('spacesBundles', { count: `${inventory.bundles.length}` })} · ${t('spacesEntries', { count: `${inventory.plugins.length}` })}${failed === 0 ? '' : ` · ${t('partsCountFailed', { count: `${failed}` })}`}`}
        </span>
        {row.live ? <StatusBadge tone="success">{t('spaceRunning')}</StatusBadge> : <StatusBadge>{t('spaceStopped')}</StatusBadge>}
        {row.reportedAt === null ? null : <time className="muted spaceCardTime" dateTime={row.reportedAt}>{new Date(row.reportedAt).toLocaleString()}</time>}
      </button>
      <Button type="button" variant="ghost" onClick={() => onPick(`${row.target.kind}:${String(row.target.id)}`)}>
        {t('spacesManage')}
      </Button>
    </div>
    <div className="spaceCardBody" id={contentId} hidden={!expanded}>
      {inventory === null
        ? (row.desired === null ? <p className="muted">{t('spacesNoReport')}</p> : <SavedComposition desired={row.desired} t={t} />)
        : <>
            {inventory.bundles.length === 0 ? <p className="muted">{t('spacesNoBundles')}</p> : null}
            {inventory.bundles.map(bundle => <BundleCard key={bundle.name} bundle={bundle} live={live} resolveText={resolveText} t={t} />)}
            <details className="spaceEntries">
              <summary>{t('spacesRuntimeEntries', { count: `${inventory.plugins.length}` })}</summary>
              <ul className="spaceBundleRows">
                {inventory.plugins.map((entry) => {
                  const entryDisplay = rowText({ moduleName: entry.moduleName, ...(entry.meta === undefined ? {} : { meta: entry.meta }) }, resolveText)
                  return <li key={entry.entryId} className={entry.enabled ? undefined : 'spaceRowDim'}>
                    <span className="spaceRowTitle" title={entry.moduleName}>{entryDisplay.title}</span>
                    <PhaseBadge phase={entry.fiberPhase} t={t} />
                    {entry.enabled ? null : <StatusBadge>{t('partOff')}</StatusBadge>}
                  </li>
                })}
              </ul>
            </details>
          </>}
    </div>
  </div>
}

/** Whether a space's label, bundle names, titles, or module names contain the filter needle. */
function spaceMatches(row: PluginInventorySpaceRow, needle: string, resolveText: ResolveInventoryText): boolean {
  const names = [row.target.label]
  for (const bundle of row.inventory?.bundles ?? []) {
    names.push(bundle.name)
    if (bundle.meta?.title !== undefined) {
      const title = resolveText(bundle.meta.title)
      if (title !== undefined) names.push(title)
    }
    for (const rowInfo of bundle.rows) names.push(rowInfo.moduleName)
  }
  for (const plugin of row.inventory?.plugins ?? []) names.push(plugin.moduleName)
  for (const name of row.desired?.bundles ?? []) names.push(name)
  for (const entry of row.desired?.entries ?? []) names.push(entry.id, ...(entry.name === undefined ? [] : [entry.name]))
  return names.some(name => name.toLowerCase().includes(needle))
}

/**
 * The cross-space map: every space with a runtime on this node, the bundles
 * and entries it last reported, and whether the instance is live. The filter
 * matches space labels and plugin names, answering "who installed X" without
 * opening each card. Picking a row binds the target picker below.
 */
export function SpacesInventory({ t, onPick }: { readonly t: Translate; readonly onPick: (key: string) => void }) {
  const [rows, setRows] = useState<PluginInventorySpaceRow[] | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const language = adminLanguage()
  useEffect(() => {
    const abort = new AbortController()
    void pluginInventoryList(abort.signal).then((value) => {
      if (!abort.signal.aborted) setRows(value)
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { abort.abort() }
  }, [])
  const resolveText = useCallback<ResolveInventoryText>(text => resolveLocalized(text, language), [language])
  const needle = filter.trim().toLowerCase()
  const visible = useMemo(
    () => rows === null || needle === '' ? rows : rows.filter(row => spaceMatches(row, needle, resolveText)),
    [rows, needle, resolveText],
  )
  if (error !== '') return <Section title={t('spacesTitle')}><ErrorBanner message={error} /></Section>
  if (rows === null) return null
  return <Section title={t('spacesTitle')}>
    <p className="muted">{t('spacesHint')}</p>
    <input className="input spaceFilter" type="search" value={filter} placeholder={t('spacesFilter')} aria-label={t('spacesFilter')}
      onChange={event => { setFilter(event.target.value) }} />
    {visible === null || visible.length === 0
      ? <p className="muted">{rows.length === 0 ? t('spacesEmpty') : t('spacesFilterEmpty')}</p>
      : <div className="spaceList" role="region" aria-label={t('spacesTitle')}>
          {visible.map(row => <SpaceCard key={`${row.target.kind}:${String(row.target.id)}:${row.target.runtimeId ?? ''}`} row={row} resolveText={resolveText} t={t} onPick={onPick} />)}
        </div>}
  </Section>
}
