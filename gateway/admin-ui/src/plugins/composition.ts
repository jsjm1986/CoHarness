/**
 * Shared per-target plugin composition for the Plugins page: the saved startup
 * state, the observed file state, and the live inventory merged into one row
 * model, with the draft that edits the startup column. The friendly plugin
 * list and the advanced matrix both read and write through this hook so their
 * controls stay consistent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AdminRequestError,
  pluginManagementSaveState, pluginManagementState,
  type PluginDesiredEntry, type PluginDesiredState, type PluginManagementState, type PluginManagementTarget,
} from '../api.ts'
import type { BundleInfo, PluginEntryId, PluginInfo } from '../../../../packages/boot/plugin-manager/src/types.ts'
import { pluginManagementRemote, type PluginManagementRemote } from './transport.ts'
import { resolveLocalized } from './presentation.ts'

/** The three persistent positions an entry can take; 'default' writes no managed row. */
export type EntryChoice = 'on' | 'off' | 'default'
export const ENTRY_CHOICES: readonly EntryChoice[] = ['default', 'on', 'off']

/** A 'default' row means the loader's own default, which is enabled. */
export const effective = (choice: EntryChoice): 'on' | 'off' => choice === 'default' ? 'on' : choice

/** One composition row across the live, file, and saved columns. */
export interface CompositionEntry {
  readonly id: string
  readonly title?: string
  readonly moduleName?: string
  /** Live loader identity and state when the instance answers the inventory. */
  readonly live?: { entryId: PluginEntryId; enabled: boolean; readOnly: boolean }
  readonly observed: EntryChoice
  readonly desired: EntryChoice
}

/** One bundle across the live, file, and saved columns. */
export interface CompositionBundle {
  readonly name: string
  readonly title?: string
  readonly live?: { enabled: boolean; readOnly: boolean }
  readonly observed: boolean
  readonly desired: boolean
}

/** The composition the Plugins page shares between the friendly list and the advanced matrix. */
export interface PluginComposition {
  /** The instance answers live calls. */
  readonly live: boolean
  /** The durable startup state endpoint answered; startup controls stay out without it. */
  readonly persist: boolean
  readonly view: PluginManagementState | null
  readonly plugins: PluginInfo[] | null
  readonly bundles: BundleInfo[] | null
  readonly entries: readonly CompositionEntry[]
  readonly bundleRows: readonly CompositionBundle[]
  readonly error: string
  readonly notice: string
  readonly busy: boolean
  /** Row key of a live write in flight; '' when none. */
  readonly busyRow: string
  readonly draft: PluginDesiredState | null
  readonly dirty: boolean
  /** The saved state is fully applied by the bound instance. */
  readonly applied: boolean
  /** Rows whose saved position would change the file state at the next start. */
  readonly pending: number
  setEntryDesired(id: string, choice: EntryChoice, moduleName?: string): void
  setBundleDesired(name: string, enabled: boolean): void
  /** Run one live write through the bound remote and resynchronize afterwards. */
  applyLive(key: string, call: (remote: PluginManagementRemote) => Promise<{ ok: boolean; error?: { message: string } }>): Promise<void>
  save(state: PluginDesiredState | null): Promise<void>
  discard(): void
  /** Re-read the durable state and the live lists, e.g. after a manager-side write. */
  refresh(): void
}

function entryChoice(entry: PluginDesiredEntry | undefined): EntryChoice {
  if (entry === undefined) return 'default'
  return entry.disabled ? 'off' : 'on'
}

function stateEqual(a: PluginDesiredState | null, b: PluginDesiredState | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Own the composition reads and the startup draft for one target. Live
 * switches apply immediately and write back through the instance; the draft
 * edits the saved composition the next start projects. Target changes reset
 * the whole hook.
 */
export function usePluginComposition(kind: 'user' | 'project', id: number, target: PluginManagementTarget, invalidate?: (message: string) => void): PluginComposition {
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
      const remote = pluginManagementRemote(target, abort.signal, () => {}, invalidate ?? (message => { setError(message) }))
      remoteRef.current = remote
      void remote.pluginManager.listPlugins().then((answer) => { if (answer.ok && !abort.signal.aborted) setPlugins(answer.value) })
      void remote.pluginManager.listBundles().then((answer) => { if (answer.ok && !abort.signal.aborted) setBundles(answer.value) })
    }
    return () => { abort.abort() }
  }, [kind, id, target, live, invalidate])

  const entries = useMemo(() => {
    const merged = new Map<string, CompositionEntry>()
    const put = (entryId: string, patch: Partial<CompositionEntry>) => {
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
      for (const [entryId, row] of merged) {
        if (row.desired === 'default') merged.set(entryId, { ...row, desired: row.observed })
      }
    }
    return [...merged.values()].sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id))
  }, [plugins, view, draft])

  const bundleRows = useMemo(() => {
    const names = new Map<string, CompositionBundle>()
    const put = (name: string, patch: Partial<CompositionBundle>) => {
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

  const dirty = draft !== null && !stateEqual(draft, view?.state ?? null)
  const liveSelection = bundles?.filter(bundle => bundle.enabled).map(bundle => bundle.name)
  /** Materialize the editable draft: seed from the saved state it displays, else from the current composition — never empty. */
  const ensureDraft = (): PluginDesiredState => draft ?? (view?.state != null
    ? { entries: [...view.state.entries], bundles: [...view.state.bundles] }
    : { entries: [], bundles: [...liveSelection ?? view?.observed?.bundles ?? []] })

  const setEntryDesired = (entryId: string, choice: EntryChoice, moduleName?: string) => {
    const next = ensureDraft()
    const nextEntries = next.entries.filter(entry => entry.id !== entryId)
    if (choice !== 'default') nextEntries.push({ id: entryId, ...moduleName === undefined ? {} : { name: moduleName }, disabled: choice === 'off' })
    setDraft({ ...next, entries: nextEntries })
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

  const refresh = useCallback(() => {
    void pluginManagementState(kind, id).then(setView).catch(() => {})
    const remote = remoteRef.current
    if (remote !== null) {
      void remote.pluginManager.listPlugins().then((answer) => { if (answer.ok) setPlugins(answer.value) })
      void remote.pluginManager.listBundles().then((answer) => { if (answer.ok) setBundles(answer.value) })
    }
  }, [kind, id])

  const persist = !storageDown
  const pending = entries.filter(row => effective(row.desired) !== effective(row.observed)).length
    + bundleRows.filter(row => row.desired !== row.observed).length
  const applied = view !== null && view.state !== null && view.appliedRevision === view.revision

  return {
    live, persist, view, plugins, bundles, entries, bundleRows,
    error, notice, busy, busyRow, draft, dirty, applied, pending,
    setEntryDesired, setBundleDesired, applyLive, save,
    discard: () => { setDraft(null) },
    refresh,
  }
}
