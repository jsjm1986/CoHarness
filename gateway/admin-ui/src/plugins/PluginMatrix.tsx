/** Advanced composition view: the live/observed state and the saved startup state in one entry-level table. */
import { useMemo, useState } from 'react'
import type { PluginManagementState } from '../api.ts'
import { Button, ErrorBanner, LoadingState, StatusBadge, Switch } from '../components/ui.tsx'
import { adminLanguage } from '../language.ts'
import { translatePlugin, type Translate } from './presentation.ts'
import { effective, ENTRY_CHOICES, type EntryChoice, type PluginComposition } from './composition.ts'
import type { PluginManagerLocaleKey } from './locales.ts'

const ENTRY_KEYS: Record<EntryChoice, PluginManagerLocaleKey> = { default: 'listStartupDefault', on: 'listStartupOn', off: 'listStartupOff' }

/** The saved-state facts the intro line reads out of the snapshot. */
function statusLine(view: PluginManagementState | null, applied: boolean, live: boolean, t: Translate): string {
  const saved = view === null || view.state === null
    ? t('matrixStatusUnsaved')
    : t('matrixStatusSaved', { revision: `${view.revision}` }) + (applied
      ? ` · ${view.generation === null ? t('matrixStatusApplyNext') : t('matrixStatusApplied')}`
      : ` · ${t('matrixStatusPending', { revision: `${view.appliedRevision}` })}`)
  return saved + (live ? ` ${t('matrixLiveHint')}` : ` ${t('matrixStoppedHint')}`)
}

/**
 * The entry-level editor over the shared composition. The friendly list
 * covers plugin-level management; this table keeps the raw rows — cordis
 * entries and bundle selections — for administrators and plugin developers.
 */
export function PluginMatrix({ composition }: { composition: PluginComposition }) {
  const t = useMemo(() => translatePlugin(adminLanguage()), [])
  const { view, persist, entries, bundleRows, live } = composition
  const storageDown = !persist
  const [filter, setFilter] = useState('')
  const [newBundle, setNewBundle] = useState('')
  const [newEntry, setNewEntry] = useState({ id: '', name: '' })

  if (view === null && !storageDown) return composition.error === '' ? <LoadingState label={t('matrixLoading')} /> : <ErrorBanner message={composition.error} />

  const needle = filter.trim().toLowerCase()
  const shownRows = needle === '' ? entries : entries.filter(row =>
    row.id.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle) || (row.moduleName ?? '').toLowerCase().includes(needle))
  const shownBundles = needle === '' ? bundleRows : bundleRows.filter(row =>
    row.name.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle))
  const knownEntries = composition.draft?.entries ?? view?.state?.entries ?? []
  const columns = persist ? 4 : 2

  const nameCell = (row: { id?: string; name?: string; title?: string; moduleName?: string }) => {
    const label = row.title ?? row.name ?? row.id ?? ''
    const sub = row.id !== undefined && row.id !== label ? row.id : row.moduleName
    return <div className="matrixName">
      {row.title === undefined && row.name === undefined ? <code>{label}</code> : <>{label}{sub === undefined ? null : <> <code className="muted">{sub}</code></>}</>}
    </div>
  }

  return <div className="pluginMatrix">
    <p className="muted">{storageDown ? t('matrixStorageDown') : statusLine(view ?? null, composition.applied, live, t)}</p>
    {entries.length + bundleRows.length > 8 ? <input className="input matrixFilter" placeholder={t('matrixFilter')} aria-label={t('matrixFilter')} value={filter} onChange={event => { setFilter(event.target.value) }} /> : null}
    <div className="tableWrap">
      <table className="dataTable">
        <thead><tr><th>{t('title')}</th><th>{t('listCurrent')}</th>{persist ? <><th>{t('listStartup')}</th><th /></> : null}</tr></thead>
        <tbody>
          {shownBundles.length === 0 ? null : <>
            <tr className="matrixGroup"><td colSpan={columns}>{t('listKindBundle')}</td></tr>
            {shownBundles.map(row => <tr key={`bundle:${row.name}`}>
              <td>{nameCell(row)}</td>
              <td>{row.live === undefined
                ? <span className="muted">{row.observed ? t('listEnabled') : t('listIdle')}</span>
                : <Switch ariaLabel={t('listCurrentEnable', { name: row.name })} checked={row.live.enabled} disabled={composition.busyRow !== '' || row.live.readOnly}
                  onChange={checked => { void composition.applyLive(`bundle:${row.name}`, remote => remote.pluginManager.setBundleEnabled(row.name, checked)) }} />}</td>
              {persist ? <>
                <td><input type="checkbox" aria-label={t('listStartupBundle', { name: row.name })} checked={row.desired}
                  onChange={event => { composition.setBundleDesired(row.name, event.target.checked) }} /></td>
                <td>{row.desired === row.observed ? null : <StatusBadge tone="warning">{t('listPending')}</StatusBadge>}</td>
              </> : null}
            </tr>)}
          </>}
          {shownRows.length === 0 ? null : <>
            <tr className="matrixGroup"><td colSpan={columns}>{t('matrixEntries')}</td></tr>
            {shownRows.map((row) => {
              const liveRow = row.live
              return <tr key={`entry:${row.id}`}>
              <td>{nameCell(row)}</td>
              <td>{liveRow === undefined
                ? <span className="muted">{row.observed === 'default' ? t('matrixDefaultEnabled') : t(ENTRY_KEYS[row.observed])}{composition.plugins !== null && live ? t('matrixNotLoaded') : ''}</span>
                : <Switch ariaLabel={t('listCurrentEnable', { name: row.id })} checked={liveRow.enabled} disabled={composition.busyRow !== '' || liveRow.readOnly}
                  onChange={checked => { void composition.applyLive(`entry:${row.id}`, remote => remote.pluginManager.setPluginEnabled(liveRow.entryId, checked)) }} />}</td>
              {persist ? <>
                <td>
                  <select className="select selectCompact" aria-label={t('listStartupEntry', { name: row.id })} value={row.desired}
                    onChange={event => { composition.setEntryDesired(row.id, event.target.value as EntryChoice, row.moduleName) }}>
                    {ENTRY_CHOICES.map(choice => <option key={choice} value={choice}>{t(ENTRY_KEYS[choice])}</option>)}
                  </select>
                </td>
                <td>{effective(row.desired) === effective(row.observed) ? null : <StatusBadge tone="warning">{t('listPending')}</StatusBadge>}</td>
              </> : null}
            </tr>
            })}
          </>}
          {shownRows.length === 0 && shownBundles.length === 0 ? <tr><td colSpan={columns}><span className="muted">{t('listEmptyFiltered')}</span></td></tr> : null}
        </tbody>
      </table>
    </div>
    {persist ? <details className="matrixAdvanced">
      <summary>{t('matrixManualAdd')}</summary>
      <div className="inlineFields">
        <input className="input" placeholder={t('matrixEntryId')} value={newEntry.id} onChange={event => { setNewEntry({ ...newEntry, id: event.target.value }) }} />
        <input className="input" placeholder={t('matrixModuleName')} value={newEntry.name} onChange={event => { setNewEntry({ ...newEntry, name: event.target.value }) }} />
        <Button disabled={newEntry.id.trim() === '' || knownEntries.some(item => item.id === newEntry.id.trim())} onClick={() => {
          const name = newEntry.name.trim()
          composition.setEntryDesired(newEntry.id.trim(), 'on', name === '' ? undefined : name)
          setNewEntry({ id: '', name: '' })
        }}>{t('matrixAddEntry')}</Button>
      </div>
      <div className="inlineFields">
        <input className="input" placeholder={t('matrixBundleName')} value={newBundle} onChange={event => { setNewBundle(event.target.value) }} />
        <Button disabled={newBundle.trim() === '' || bundleRows.some(row => row.name === newBundle.trim() && row.desired)} onClick={() => {
          composition.setBundleDesired(newBundle.trim(), true)
          setNewBundle('')
        }}>{t('matrixAddBundle')}</Button>
      </div>
    </details> : null}
  </div>
}
