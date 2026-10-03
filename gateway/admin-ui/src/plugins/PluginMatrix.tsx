/** Fused plugin composition editor: the live/observed state and the saved startup state in one table. */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AdminRequestError,
  pluginManagementSaveState, pluginManagementState,
  type PluginDesiredEntry, type PluginDesiredState, type PluginManagementState, type PluginManagementTarget,
} from '../api.ts'
import type { BundleInfo, PluginEntryId, PluginInfo } from '../../../../packages/boot/plugin-manager/src/types.ts'
import { Button, ErrorBanner, LoadingState, StatusBadge, Switch } from '../components/ui.tsx'
import { pluginManagementRemote, type PluginManagementRemote } from './transport.ts'
import { resolveLocalized } from './presentation.ts'

/** The three persistent positions an entry can take; 'default' writes no managed row. */
type EntryChoice = 'on' | 'off' | 'default'
const ENTRY_CHOICES: readonly EntryChoice[] = ['default', 'on', 'off']
const ENTRY_LABELS: Record<EntryChoice, string> = { default: '默认', on: '启用', off: '停用' }
/** A 'default' row means the loader's own default, which is enabled. */
const effective = (choice: EntryChoice): 'on' | 'off' => choice === 'default' ? 'on' : choice

interface EntryRow {
  id: string
  title?: string
  moduleName?: string
  /** Live loader identity and state when the instance answers the inventory. */
  live?: { entryId: PluginEntryId; enabled: boolean; readOnly: boolean }
  observed: EntryChoice
  desired: EntryChoice
}

interface BundleRow {
  name: string
  title?: string
  live?: { enabled: boolean; readOnly: boolean }
  observed: boolean
  desired: boolean
}

function entryChoice(entry: PluginDesiredEntry | undefined): EntryChoice {
  if (entry === undefined) return 'default'
  return entry.disabled ? 'off' : 'on'
}

function stateEqual(a: PluginDesiredState | null, b: PluginDesiredState | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Compose the saved startup state with what the files and the live instance
 * report, so the administrator edits both columns in one table. Live switches
 * apply immediately and write back through the instance; the startup column
 * drafts the saved composition the next start projects.
 */
export function PluginMatrix({ kind, id, target }: { kind: 'user' | 'project'; id: number; target: PluginManagementTarget }) {
  const live = target.generation !== null
  const [view, setView] = useState<PluginManagementState | null>(null)
  const [storageDown, setStorageDown] = useState(false)
  const [draft, setDraft] = useState<PluginDesiredState | null>(null)
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [bundles, setBundles] = useState<BundleInfo[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyRow, setBusyRow] = useState('')
  const [filter, setFilter] = useState('')
  const [newBundle, setNewBundle] = useState('')
  const [newEntry, setNewEntry] = useState({ id: '', name: '' })
  const remoteRef = useRef<PluginManagementRemote | null>(null)

  useEffect(() => {
    setView(null); setStorageDown(false); setDraft(null); setPlugins(null); setBundles(null); setError(''); setNotice('')
    remoteRef.current = null
    const abort = new AbortController()
    void pluginManagementState(kind, id, abort.signal).then((next) => {
      if (!abort.signal.aborted) setView(next)
    }).catch((cause: unknown) => {
      // Deployments without the PostgreSQL store still manage live instances; degrade instead of failing the page.
      if (!abort.signal.aborted) {
        if (cause instanceof AdminRequestError && cause.status === 503) setStorageDown(true)
        else setError(String(cause))
      }
    })
    if (live) {
      const remote = pluginManagementRemote(target, abort.signal, () => {}, message => { setError(message) })
      remoteRef.current = remote
      void remote.pluginManager.listPlugins().then((answer) => { if (answer.ok && !abort.signal.aborted) setPlugins(answer.value) })
      void remote.pluginManager.listBundles().then((answer) => { if (answer.ok && !abort.signal.aborted) setBundles(answer.value) })
    }
    return () => { abort.abort() }
  }, [kind, id, target, live])

  const rows = useMemo(() => {
    const merged = new Map<string, EntryRow>()
    const put = (entryId: string, patch: Partial<EntryRow>) => {
      const row = merged.get(entryId) ?? { id: entryId, observed: 'default' as const, desired: 'default' as const }
      merged.set(entryId, { ...row, ...patch })
    }
    for (const plugin of plugins ?? []) {
      if (plugin.patchId === undefined) continue
      put(plugin.patchId, {
        moduleName: plugin.moduleName,
        title: plugin.meta?.title === undefined ? undefined : resolveLocalized(plugin.meta.title),
        live: { entryId: plugin.entryId, enabled: plugin.enabled, readOnly: false },
      })
    }
    for (const entry of view?.observed?.entries ?? []) {
      put(entry.id, { moduleName: entry.name, observed: entryChoice(entry) })
    }
    for (const entry of draft?.entries ?? view?.state?.entries ?? []) {
      put(entry.id, { moduleName: entry.name, desired: entryChoice(entry) })
    }
    // With nothing saved, the startup column mirrors the current composition so the administrator edits a visible baseline.
    if (draft === null && (view === null || view.state === null)) {
      for (const row of merged.values()) if (row.desired === 'default') row.desired = row.observed
    }
    return [...merged.values()].sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id))
  }, [plugins, view, draft])

  const bundleRows = useMemo(() => {
    const names = new Map<string, BundleRow>()
    const put = (name: string, patch: Partial<BundleRow>) => {
      const row = names.get(name) ?? { name, observed: false, desired: false }
      names.set(name, { ...row, ...patch })
    }
    for (const bundle of bundles ?? []) {
      put(bundle.name, {
        title: bundle.meta?.title === undefined ? undefined : resolveLocalized(bundle.meta.title),
        live: { enabled: bundle.enabled, readOnly: bundle.readOnlyReason !== undefined },
        observed: bundle.enabled,
      })
    }
    for (const name of view?.observed?.bundles ?? []) put(name, { observed: true })
    const desiredSet = draft?.bundles ?? view?.state?.bundles ?? view?.observed?.bundles
    for (const name of desiredSet ?? []) put(name, { desired: true })
    return [...names.values()].sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name))
  }, [bundles, view, draft])

  if (view === null && !storageDown) return error === '' ? <LoadingState label="正在读取插件组成" /> : <ErrorBanner message={error} />

  const dirty = draft !== null && !stateEqual(draft, view?.state ?? null)
  const liveSelection = bundles?.filter(bundle => bundle.enabled).map(bundle => bundle.name)
  /** Materialize the editable draft: seed from the saved state it displays, else from the current composition — never empty. */
  const ensureDraft = (): PluginDesiredState => draft ?? (view?.state != null
    ? { entries: [...view.state.entries], bundles: [...view.state.bundles] }
    : { entries: [], bundles: [...liveSelection ?? view?.observed?.bundles ?? []] })

  const setEntryDesired = (entryId: string, choice: EntryChoice, moduleName?: string) => {
    const next = ensureDraft()
    const entries = next.entries.filter(entry => entry.id !== entryId)
    if (choice !== 'default') entries.push({ id: entryId, ...moduleName === undefined ? {} : { name: moduleName }, disabled: choice === 'off' })
    setDraft({ ...next, entries })
  }
  const setBundleDesired = (name: string, enabled: boolean) => {
    const next = ensureDraft()
    setDraft({ ...next, bundles: enabled ? [...new Set([...next.bundles, name])] : next.bundles.filter(item => item !== name) })
  }

  const applyLive = async (key: string, call: (remote: PluginManagementRemote) => Promise<{ ok: boolean; error?: { message: string } }>) => {
    const remote = remoteRef.current
    if (remote === null) return
    setBusyRow(key); setError(''); setNotice('')
    try {
      const answer = await call(remote)
      if (!answer.ok) { setError(answer.error?.message ?? '插件操作未确认，请刷新后核对结果。'); return }
      const hadDraft = dirty
      // The live change already applied; a refresh failure must not mask that fact.
      const nextView = await pluginManagementState(kind, id).catch((cause: unknown) => {
        if (!(cause instanceof AdminRequestError && cause.status === 503)) setError(String(cause))
        return null
      })
      if (nextView !== null) setView(nextView)
      setDraft(null)
      // The runtime already reloaded its inventory; the columns resync on the next paint.
      void remote.pluginManager.listPlugins().then((answer) => { if (answer.ok) setPlugins(answer.value) })
      setNotice(hadDraft ? '实例已应用改动并写回插件组成；未保存的「启动时」修改已重置。' : '实例已应用改动并写回插件组成。')
    } finally { setBusyRow('') }
  }

  const save = async (state: PluginDesiredState | null) => {
    if (view === null) return
    setBusy(true)
    try {
      const next = await pluginManagementSaveState({ target: { kind, id }, revision: view.revision, state })
      setView(next); setDraft(null); setError('')
      setNotice(state === null ? '已清除保存的启动配置；实例恢复沿用其文件中的插件组成。' : `插件组成已保存为版本 ${next.revision}；实例下次启动时生效，运行中的实例在其下一次变更时收敛。`)
    } catch (cause) {
      if (cause instanceof AdminRequestError && cause.status === 409) {
        const latest = await pluginManagementState(kind, id).catch(() => null)
        if (latest !== null) { setView(latest); setDraft(null) }
        setError('插件组成已被并发修改；表单已重置为最新版本，请再次保存。')
      } else setError(String(cause))
    } finally { setBusy(false) }
  }

  const applied = view !== null && view.state !== null && view.appliedRevision === view.revision
  const needle = filter.trim().toLowerCase()
  const shownRows = needle === '' ? rows : rows.filter(row =>
    row.id.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle) || (row.moduleName ?? '').toLowerCase().includes(needle))
  const shownBundles = needle === '' ? bundleRows : bundleRows.filter(row =>
    row.name.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle))
  const knownEntries = draft?.entries ?? view?.state?.entries ?? []
  // Without the durable store the table carries live state only; startup cells stay out entirely.
  const persist = !storageDown
  const columns = persist ? 4 : 2

  const nameCell = (row: { id?: string; name?: string; title?: string; moduleName?: string }) => {
    const label = row.title ?? row.name ?? row.id ?? ''
    const sub = row.id !== undefined && row.id !== label ? row.id : row.moduleName
    return <div className="matrixName">
      {row.title === undefined && row.name === undefined ? <code>{label}</code> : <>{label}{sub === undefined ? null : <> <code className="muted">{sub}</code></>}</>}
    </div>
  }

  return <div className="pluginMatrix">
    <ErrorBanner message={error} />
    <p className="muted">
      {storageDown
        ? '此部署未启用启动配置存储；「当前」列仍可直接管理运行中的实例。'
        : view === null || view.state === null
          ? '尚无保存的启动配置：实例沿用其文件中的插件组成。下方「启动时」列编辑并保存后，下次启动生效。'
          : `已存启动配置 · 版本 ${view.revision}${applied ? (view.generation === null ? ' · 将于下次启动应用' : ' · 实例已应用') : ` · 待应用（实例已应用版本 ${view.appliedRevision}）`}`}
      {storageDown ? '' : live ? ' 「当前」列开关立即生效并写回配置；「启动时」列保存下次启动的组成。' : ' 实例未运行：「当前」列为文件中的配置，启动配置保存后将于下次启动应用。'}
    </p>
    {notice === '' ? null : <p role="status" className="muted">{notice}</p>}
    {rows.length + bundleRows.length > 8 ? <input className="input matrixFilter" placeholder="筛选插件" aria-label="筛选插件" value={filter} onChange={event => { setFilter(event.target.value) }} /> : null}
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
                : <Switch ariaLabel={`当前启用 ${row.name}`} checked={row.live.enabled} disabled={busyRow !== '' || row.live.readOnly}
                  onChange={checked => { void applyLive(`bundle:${row.name}`, remote => remote.pluginManager.setBundleEnabled(row.name, checked)) }} />}</td>
              {persist ? <>
                <td><input type="checkbox" aria-label={`启动时启用 ${row.name}`} checked={row.desired}
                  onChange={event => { setBundleDesired(row.name, event.target.checked) }} /></td>
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
                ? <span className="muted">{row.observed === 'default' ? '默认（启用）' : ENTRY_LABELS[row.observed]}{plugins !== null && live ? '（未装载）' : ''}</span>
                : <Switch ariaLabel={`当前启用 ${row.id}`} checked={liveRow.enabled} disabled={busyRow !== '' || liveRow.readOnly}
                  onChange={checked => { void applyLive(`entry:${row.id}`, remote => remote.pluginManager.setPluginEnabled(liveRow.entryId, checked)) }} />}</td>
              {persist ? <>
                <td>
                  <select className="select selectCompact" aria-label={`启动时 ${row.id}`} value={row.desired}
                    onChange={event => { setEntryDesired(row.id, event.target.value as EntryChoice, row.moduleName) }}>
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
          setEntryDesired(newEntry.id.trim(), 'on', name === '' ? undefined : name)
          setNewEntry({ id: '', name: '' })
        }}>添加条目</Button>
      </div>
      <div className="inlineFields">
        <input className="input" placeholder="bundle 包名" value={newBundle} onChange={event => { setNewBundle(event.target.value) }} />
        <Button disabled={newBundle.trim() === '' || bundleRows.some(row => row.name === newBundle.trim() && row.desired)} onClick={() => {
          setBundleDesired(newBundle.trim(), true)
          setNewBundle('')
        }}>添加 Bundle</Button>
      </div>
    </details> : null}
    {persist ? <div className="buttonRow">
      <Button disabled={busy || !dirty} onClick={() => { void save(draft) }}>保存插件组成</Button>
      <Button variant="secondary" disabled={busy || !dirty} onClick={() => { setDraft(null) }}>放弃修改</Button>
      {view?.state == null ? null : <Button variant="secondary" disabled={busy} onClick={() => { void save(null) }}>清除启动配置</Button>}
    </div> : null}
  </div>
}
