/** Advanced composition view: the live/observed state and the saved startup state in one entry-level table. */
import { useState } from 'react'
import type { PluginManagementState } from '../api.ts'
import { Button, ErrorBanner, LoadingState, StatusBadge, Switch } from '../components/ui.tsx'
import { effective, ENTRY_CHOICES, type EntryChoice, type PluginComposition } from './composition.ts'

const ENTRY_LABELS: Record<EntryChoice, string> = { default: '默认', on: '启用', off: '停用' }

/** The saved-state facts the intro line reads out of the snapshot. */
function statusLine(view: PluginManagementState | null, applied: boolean, live: boolean): string {
  const saved = view === null || view.state === null
    ? '尚无保存的启动配置：实例沿用其文件中的插件组成。下方「启动时」列编辑并保存后，下次启动生效。'
    : `已存启动配置 · 版本 ${view.revision}${applied ? (view.generation === null ? ' · 将于下次启动应用' : ' · 实例已应用') : ` · 待应用（实例已应用版本 ${view.appliedRevision}）`}`
  return saved + (live ? ' 「当前」列开关立即生效并写回配置；「启动时」列保存下次启动的组成。' : ' 实例未运行：「当前」列为文件中的配置，启动配置保存后将于下次启动应用。')
}

/**
 * The entry-level editor over the shared composition. The friendly list
 * covers plugin-level management; this table keeps the raw rows — cordis
 * entries and bundle selections — for administrators and plugin developers.
 */
export function PluginMatrix({ composition }: { composition: PluginComposition }) {
  const { view, persist, entries, bundleRows, live } = composition
  const storageDown = !persist
  const [filter, setFilter] = useState('')
  const [newBundle, setNewBundle] = useState('')
  const [newEntry, setNewEntry] = useState({ id: '', name: '' })

  if (view === null && !storageDown) return composition.error === '' ? <LoadingState label="正在读取插件组成" /> : <ErrorBanner message={composition.error} />

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
    <p className="muted">{storageDown ? '此部署未启用启动配置存储；「当前」列仍可直接管理运行中的实例。' : statusLine(view ?? null, composition.applied, live)}</p>
    {entries.length + bundleRows.length > 8 ? <input className="input matrixFilter" placeholder="筛选插件" aria-label="筛选插件" value={filter} onChange={event => { setFilter(event.target.value) }} /> : null}
    <div className="tableWrap">
      <table className="dataTable">
        <thead><tr><th>插件</th><th>当前</th>{persist ? <><th>启动时</th><th /></> : null}</tr></thead>
        <tbody>
          {shownBundles.length === 0 ? null : <>
            <tr className="matrixGroup"><td colSpan={columns}>功能包</td></tr>
            {shownBundles.map(row => <tr key={`bundle:${row.name}`}>
              <td>{nameCell(row)}</td>
              <td>{row.live === undefined
                ? <span className="muted">{row.observed ? '已启用' : '未启用'}</span>
                : <Switch ariaLabel={`当前启用 ${row.name}`} checked={row.live.enabled} disabled={composition.busyRow !== '' || row.live.readOnly}
                  onChange={checked => { void composition.applyLive(`bundle:${row.name}`, remote => remote.pluginManager.setBundleEnabled(row.name, checked)) }} />}</td>
              {persist ? <>
                <td><input type="checkbox" aria-label={`启动时启用 ${row.name}`} checked={row.desired}
                  onChange={event => { composition.setBundleDesired(row.name, event.target.checked) }} /></td>
                <td>{row.desired === row.observed ? null : <StatusBadge tone="warning">将变更</StatusBadge>}</td>
              </> : null}
            </tr>)}
          </>}
          {shownRows.length === 0 ? null : <>
            <tr className="matrixGroup"><td colSpan={columns}>插件条目</td></tr>
            {shownRows.map((row) => {
              const liveRow = row.live
              return <tr key={`entry:${row.id}`}>
              <td>{nameCell(row)}</td>
              <td>{liveRow === undefined
                ? <span className="muted">{row.observed === 'default' ? '默认（启用）' : ENTRY_LABELS[row.observed]}{composition.plugins !== null && live ? '（未装载）' : ''}</span>
                : <Switch ariaLabel={`当前启用 ${row.id}`} checked={liveRow.enabled} disabled={composition.busyRow !== '' || liveRow.readOnly}
                  onChange={checked => { void composition.applyLive(`entry:${row.id}`, remote => remote.pluginManager.setPluginEnabled(liveRow.entryId, checked)) }} />}</td>
              {persist ? <>
                <td>
                  <select className="select selectCompact" aria-label={`启动时 ${row.id}`} value={row.desired}
                    onChange={event => { composition.setEntryDesired(row.id, event.target.value as EntryChoice, row.moduleName) }}>
                    {ENTRY_CHOICES.map(choice => <option key={choice} value={choice}>{ENTRY_LABELS[choice]}</option>)}
                  </select>
                </td>
                <td>{effective(row.desired) === effective(row.observed) ? null : <StatusBadge tone="warning">将变更</StatusBadge>}</td>
              </> : null}
            </tr>
            })}
          </>}
          {shownRows.length === 0 && shownBundles.length === 0 ? <tr><td colSpan={columns}><span className="muted">没有匹配的插件。</span></td></tr> : null}
        </tbody>
      </table>
    </div>
    {persist ? <details className="matrixAdvanced">
      <summary>手动添加条目或 Bundle</summary>
      <div className="inlineFields">
        <input className="input" placeholder="条目 ID" value={newEntry.id} onChange={event => { setNewEntry({ ...newEntry, id: event.target.value }) }} />
        <input className="input" placeholder="模块名（可选）" value={newEntry.name} onChange={event => { setNewEntry({ ...newEntry, name: event.target.value }) }} />
        <Button disabled={newEntry.id.trim() === '' || knownEntries.some(item => item.id === newEntry.id.trim())} onClick={() => {
          const name = newEntry.name.trim()
          composition.setEntryDesired(newEntry.id.trim(), 'on', name === '' ? undefined : name)
          setNewEntry({ id: '', name: '' })
        }}>添加条目</Button>
      </div>
      <div className="inlineFields">
        <input className="input" placeholder="bundle 包名" value={newBundle} onChange={event => { setNewBundle(event.target.value) }} />
        <Button disabled={newBundle.trim() === '' || bundleRows.some(row => row.name === newBundle.trim() && row.desired)} onClick={() => {
          composition.setBundleDesired(newBundle.trim(), true)
          setNewBundle('')
        }}>添加 Bundle</Button>
      </div>
    </details> : null}
  </div>
}
