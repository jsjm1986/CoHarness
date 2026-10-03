/** Offline desired-state editor: reads and writes the deployment's saved plugin composition for one runtime owner. */
import { useEffect, useState } from 'react'
import {
  pluginManagementSaveState, pluginManagementState,
  type PluginDesiredEntry, type PluginDesiredState, type PluginManagementState,
} from '../api.ts'
import { AdminRequestError } from '../api.ts'
import { Button, ErrorBanner, LoadingState } from '../components/ui.tsx'

/** The draft's known names: everything the store or the profile files mention. */
function unionNames(saved: readonly string[] | undefined, observed: readonly string[] | undefined): string[] {
  return [...new Set([...saved ?? [], ...observed ?? []])].sort()
}

/** Rows keyed by id so saved and observed entries merge into one editable list. */
function unionEntries(saved: readonly PluginDesiredEntry[] | undefined, observed: readonly PluginDesiredEntry[] | undefined): Map<string, PluginDesiredEntry> {
  const merged = new Map<string, PluginDesiredEntry>()
  for (const entry of [...observed ?? [], ...saved ?? []]) merged.set(entry.id, entry)
  return merged
}

function stateEqual(a: PluginDesiredState | null, b: PluginDesiredState | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Edit the desired plugin state that outlives the instance: saved rows apply
 * at the next start, and a live instance converges to them on its next
 * committed change. `generation` in the header names the running instance;
 * its absence never blocks editing.
 */
export function DesiredStateEditor({ kind, id }: { kind: 'user' | 'project'; id: number }) {
  const [view, setView] = useState<PluginManagementState | null>(null)
  const [draft, setDraft] = useState<PluginDesiredState | null>(null)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const [newBundle, setNewBundle] = useState('')
  const [newEntry, setNewEntry] = useState({ id: '', name: '' })

  useEffect(() => {
    const abort = new AbortController()
    setView(null); setDraft(null); setConflict(false); setError('')
    void pluginManagementState(kind, id, abort.signal).then((next) => {
      if (abort.signal.aborted) return
      setView(next); setDraft(next.state)
    }).catch((cause: unknown) => { if (!abort.signal.aborted) setError(String(cause)) })
    return () => { abort.abort() }
  }, [kind, id])

  const save = async (state: PluginDesiredState | null) => {
    if (view === null) return
    setBusy(true)
    try {
      const next = await pluginManagementSaveState({ target: { kind, id }, revision: view.revision, state })
      setView(next); setDraft(next.state); setConflict(false); setError('')
    } catch (cause) {
      if (cause instanceof AdminRequestError && cause.status === 409) {
        const latest = await pluginManagementState(kind, id).catch(() => null)
        if (latest !== null) { setView(latest); setDraft(latest.state) }
        setConflict(true)
        setError('期望状态已被并发修改；表单已重置为最新版本，请再次保存。')
      } else setError(String(cause))
    } finally { setBusy(false) }
  }

  if (view === null) return error === '' ? <LoadingState label="正在读取期望状态" /> : <ErrorBanner message={error} />

  const applied = view.state === null ? view.appliedRevision === '0' || view.appliedRevision === view.revision : view.appliedRevision === view.revision
  const dirty = !stateEqual(draft, view.state)
  const knownBundles = unionNames(draft?.bundles, view.observed?.bundles)
  const knownEntries = unionEntries(draft?.entries, view.observed?.entries)

  return <div className="desiredStateEditor">
    <ErrorBanner message={error} />
    {conflict ? <ErrorBanner message="并发冲突：表单已重置为最新版本。" /> : null}
    <p className="muted">
      {view.state === null
        ? '尚无期望状态：实例沿用其文件中的插件配置。保存后，此状态在实例下次启动时生效。'
        : applied
          ? `期望状态版本 ${view.revision} · ${view.generation === null ? '实例未运行，将于下次启动时应用' : '实例已应用'}`
          : `期望状态版本 ${view.revision} · 待应用（实例已应用版本 ${view.appliedRevision}）`}
    </p>
    {draft === null
      ? (
        <div className="buttonRow">
          <Button disabled={busy || view.observed === null}
            onClick={() => { setDraft(view.observed ?? { entries: [], bundles: [] }) }}>从文件现状创建</Button>
          <Button disabled={busy} onClick={() => { setDraft({ entries: [], bundles: [] }) }}>创建空白期望状态</Button>
        </div>
      )
      : (
        <>
          {/* Groups of nested checkboxes need a fieldset: Field's wrapping label would forward clicks to the first control. */}
          <fieldset className="field">
            <span className="fieldLabel">启用的 Bundle</span>
            <div className="checkboxList">
              {knownBundles.map(name => (
                <label key={name} className="checkboxItem">
                  <input type="checkbox" checked={draft.bundles.includes(name)} onChange={(event) => {
                    setDraft({ ...draft, bundles: event.target.checked ? [...draft.bundles, name] : draft.bundles.filter(item => item !== name) })
                  }} />
                  <code>{name}</code>
                </label>
              ))}
            </div>
            <div className="inlineFields">
              <input className="input" placeholder="bundle 包名" value={newBundle} onChange={event => { setNewBundle(event.target.value) }} />
              <Button disabled={newBundle.trim() === '' || draft.bundles.includes(newBundle.trim())} onClick={() => {
                const name = newBundle.trim()
                setDraft({ ...draft, bundles: [...draft.bundles, name] })
                setNewBundle('')
              }}>添加</Button>
            </div>
          </fieldset>
          <fieldset className="field">
            <span className="fieldLabel">插件条目启停</span>
            <table className="table">
              <thead><tr><th>条目 ID</th><th>模块</th><th>启用</th><th /></tr></thead>
              <tbody>
                {[...knownEntries.values()].map(entry => (
                  <tr key={entry.id}>
                    <td><code>{entry.id}</code></td>
                    <td><code>{entry.name ?? '—'}</code></td>
                    <td>
                      <input type="checkbox" aria-label={`启用 ${entry.id}`} checked={!entry.disabled} onChange={(event) => {
                        const entries = draft.entries.filter(item => item.id !== entry.id)
                        setDraft({ ...draft, entries: [...entries, { id: entry.id, ...entry.name === undefined ? {} : { name: entry.name }, disabled: !event.target.checked }] })
                      }} />
                    </td>
                    <td>
                      <Button variant="secondary" onClick={() => { setDraft({ ...draft, entries: draft.entries.filter(item => item.id !== entry.id) }) }}>移除</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="inlineFields">
              <input className="input" placeholder="条目 ID" value={newEntry.id} onChange={event => { setNewEntry({ ...newEntry, id: event.target.value }) }} />
              <input className="input" placeholder="模块名（可选）" value={newEntry.name} onChange={event => { setNewEntry({ ...newEntry, name: event.target.value }) }} />
              <Button disabled={newEntry.id.trim() === '' || draft.entries.some(item => item.id === newEntry.id.trim())} onClick={() => {
                const name = newEntry.name.trim()
                setDraft({ ...draft, entries: [...draft.entries, { id: newEntry.id.trim(), ...name === '' ? {} : { name }, disabled: false }] })
                setNewEntry({ id: '', name: '' })
              }}>添加条目</Button>
            </div>
          </fieldset>
          <div className="buttonRow">
            <Button disabled={busy || !dirty} onClick={() => { void save(draft) }}>保存期望状态</Button>
            <Button variant="secondary" disabled={busy || !dirty} onClick={() => { setDraft(view.state) }}>放弃修改</Button>
            {view.state === null ? null : <Button variant="secondary" disabled={busy} onClick={() => { void save(null) }}>清除期望状态</Button>}
          </div>
        </>
      )}
    {view.observed === null ? null : <p className="muted">文件中的当前配置已读取，可作为编辑起点；上方未列出的手写 patch 行不受期望状态管理。</p>}
  </div>
}
