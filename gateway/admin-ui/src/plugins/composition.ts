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
import type { BundleInfo, PluginEntryId, PluginInfo, PluginManagementCatalog } from '../../../../packages/boot/plugin-manager/src/types.ts'
import { pluginManagementRemote, type PluginManagementRemote } from './transport.ts'
import { resolveLocalized, translatePlugin } from './presentation.ts'
import { adminLanguage } from '../language.ts'

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
  /** Accept the live manager's generation-checked catalog for this target. */
  acceptCatalog(this: void, catalog: PluginManagementCatalog): void
  /** Bind the live owner's catalog refresh; disposal removes only this registration. */
  bindLiveRefresh(this: void, refresh: () => Promise<void>): () => void
  /** Re-read durable startup state after a manager-side write. */
  refresh(this: void): void
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
  const lifetimeRef = useRef<AbortController | null>(null)
  const liveRefreshRef = useRef<(() => Promise<void>) | null>(null)
  const stateRead = useRef(0)
  const language = adminLanguage()
  const t = translatePlugin(language)

  useEffect(() => {
    setView(null); setStorageDown(false); setDraft(null); setPlugins(null); setBundles(null); setError(''); setNotice(''); setBusy(false); setBusyRow('')
    remoteRef.current = null
    const abort = new AbortController()
    lifetimeRef.current = abort
    const read = ++stateRead.current
    void pluginManagementState(kind, id, abort.signal).then((next) => {
      if (!abort.signal.aborted && read === stateRead.current) setView(next)
    }).catch((cause: unknown) => {
      // Deployments without the PostgreSQL store still manage live instances; degrade instead of failing the page.
      if (!abort.signal.aborted && read === stateRead.current) {
        if (cause instanceof AdminRequestError && cause.status === 503) setStorageDown(true)
        else setError(String(cause))
      }
    })
    if (live) {
      const remote = pluginManagementRemote(target, abort.signal, () => {}, invalidate ?? (message => { setError(message) }))
      remoteRef.current = remote
    }
    return () => { abort.abort() }
  }, [kind, id, target, live, invalidate])

  const acceptCatalog = useCallback((catalog: PluginManagementCatalog) => {
    if (lifetimeRef.current === null || lifetimeRef.current.signal.aborted) return
    setPlugins(catalog.managementAvailable ? catalog.plugins : null)
    setBundles(catalog.managementAvailable ? catalog.bundles : null)
  }, [])
  const bindLiveRefresh = useCallback((refresh: () => Promise<void>) => {
    liveRefreshRef.current = refresh
    return () => { if (liveRefreshRef.current === refresh) liveRefreshRef.current = null }
  }, [])

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
        title: plugin.meta?.title === undefined ? undefined : resolveLocalized(plugin.meta.title, language),
        live: { entryId: plugin.entryId, enabled: plugin.enabled, readOnly: false },
      })
    }
    for (const entry of view?.observed?.entries ?? []) {
      const meta = view?.meta?.entries[entry.id]
      put(entry.id, { moduleName: entry.name, observed: entryChoice(entry),
        ...(meta?.title === undefined ? {} : { title: resolveLocalized(meta.title, language) }) })
    }
    for (const entry of draft?.entries ?? view?.state?.entries ?? []) {
      const meta = view?.meta?.entries[entry.id]
      put(entry.id, { moduleName: entry.name, desired: entryChoice(entry),
        ...(meta?.title === undefined ? {} : { title: resolveLocalized(meta.title, language) }) })
    }
    // With nothing saved, the startup column mirrors the current composition so the administrator edits a visible baseline.
    if (draft === null && (view === null || view.state === null)) {
      for (const [entryId, row] of merged) {
        if (row.desired === 'default') merged.set(entryId, { ...row, desired: row.observed })
      }
    }
    return [...merged.values()].sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id))
  }, [plugins, view, draft, language])

  const bundleRows = useMemo(() => {
    const names = new Map<string, CompositionBundle>()
    const put = (name: string, patch: Partial<CompositionBundle>) => {
      const row = names.get(name) ?? { name, observed: false, desired: false }
      names.set(name, { ...row, ...patch })
    }
    for (const bundle of bundles ?? []) {
      put(bundle.name, {
        title: bundle.meta?.title === undefined ? undefined : resolveLocalized(bundle.meta.title, language),
        live: { enabled: bundle.enabled, readOnly: bundle.readOnlyReason !== undefined },
        observed: bundle.enabled,
      })
    }
    for (const name of view?.observed?.bundles ?? []) {
      const meta = view?.meta?.bundles[name]
      put(name, { observed: true, ...(meta?.title === undefined ? {} : { title: resolveLocalized(meta.title, language) }) })
    }
    const desiredSet = draft?.bundles ?? view?.state?.bundles ?? view?.observed?.bundles
    for (const name of desiredSet ?? []) {
      const meta = view?.meta?.bundles[name]
      put(name, { desired: true, ...(meta?.title === undefined ? {} : { title: resolveLocalized(meta.title, language) }) })
    }
    return [...names.values()].sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name))
  }, [bundles, view, draft, language])

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
    const lifetime = lifetimeRef.current
    if (remote === null || lifetime === null || lifetime.signal.aborted) return
    setBusyRow(key); setError(''); setNotice('')
    try {
      const answer = await call(remote)
      if (lifetime !== lifetimeRef.current || lifetime.signal.aborted) return
      if (!answer.ok) { setError(answer.error?.message ?? t('wireUnconfirmed')); return }
      const hadDraft = dirty
      // The live change already applied; a refresh failure must not mask that fact.
      const read = ++stateRead.current
      const nextView = await pluginManagementState(kind, id, lifetime.signal).catch((cause: unknown) => {
        if (lifetime !== lifetimeRef.current || lifetime.signal.aborted || read !== stateRead.current) return null
        if (!(cause instanceof AdminRequestError && cause.status === 503)) setError(String(cause))
        return null
      })
      if (lifetime !== lifetimeRef.current || lifetime.signal.aborted) return
      if (nextView !== null && read === stateRead.current) setView(nextView)
      setDraft(null)
      await liveRefreshRef.current?.()
      if (lifetime !== lifetimeRef.current || lifetime.signal.aborted) return
      setNotice(hadDraft ? t('compositionAppliedReset') : t('compositionApplied'))
    } finally { if (lifetime === lifetimeRef.current && !lifetime.signal.aborted) setBusyRow('') }
  }

  const save = async (state: PluginDesiredState | null) => {
    const lifetime = lifetimeRef.current
    if (view === null || lifetime === null || lifetime.signal.aborted) return
    setBusy(true)
    try {
      const next = await pluginManagementSaveState({ target: { kind, id }, revision: view.revision, state })
      if (lifetime !== lifetimeRef.current || lifetime.signal.aborted) return
      stateRead.current++
      setView(next); setDraft(null); setError('')
      setNotice(state === null ? t('compositionCleared') : t('compositionSaved', { revision: next.revision }))
    } catch (cause) {
      if (lifetime !== lifetimeRef.current || lifetime.signal.aborted) return
      if (cause instanceof AdminRequestError && cause.status === 409) {
        const read = ++stateRead.current
        const latest = await pluginManagementState(kind, id, lifetime.signal).catch(() => null)
        if (lifetime !== lifetimeRef.current || lifetime.signal.aborted) return
        if (latest !== null && read === stateRead.current) { setView(latest); setDraft(null) }
        setError(t('compositionConflict'))
      } else setError(String(cause))
    } finally { if (lifetime === lifetimeRef.current && !lifetime.signal.aborted) setBusy(false) }
  }

  const refresh = useCallback(() => {
    const lifetime = lifetimeRef.current
    if (lifetime === null || lifetime.signal.aborted) return
    const read = ++stateRead.current
    void pluginManagementState(kind, id, lifetime.signal).then(next => {
      if (lifetime === lifetimeRef.current && !lifetime.signal.aborted && read === stateRead.current) setView(next)
    }).catch(() => { /* A background state refresh leaves the current startup draft available. */ })
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
    acceptCatalog, bindLiveRefresh, refresh,
  }
}
