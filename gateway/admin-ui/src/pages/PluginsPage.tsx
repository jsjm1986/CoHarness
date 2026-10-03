/** Per-owner plugin management: one friendly plugin list over the shared composition, with the entry-level matrix folded below. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AdminRequestError, getPluginPolicy, listProjects, listUsers, pluginManagementTarget, setPluginPolicy, type AdminResourcePolicy, type PluginManagementTarget } from '../api.ts'
import { ErrorBanner, Field, PageHeader, Button, LoadingState, Section, StatusBadge, Switch } from '../components/ui.tsx'
import { adminLanguage } from '../language.ts'
import { PluginManagerPage } from '../plugins/PluginManagerPage.tsx'
import { PluginManagerController } from '../plugins/manager-store.ts'
import { pluginManagementRemote } from '../plugins/transport.ts'
import { PluginMatrix } from '../plugins/PluginMatrix.tsx'
import { usePluginComposition, type PluginComposition } from '../plugins/composition.ts'
import { resolveLocalized, translatePlugin, type Translate } from '../plugins/presentation.ts'
import { ProfileSettingsController } from '../plugins/settings-store.ts'
import { PluginConfiguration, SETTINGS_OWNER_KEYS } from '../plugins/PluginConfiguration.tsx'
import { PluginPermissions } from '../components/PluginPermissions.tsx'

function Manager({ target, invalidate, composition, t }: { target: PluginManagementTarget; invalidate: (message: string) => void; composition: PluginComposition; t: Translate }) {
  const [owner, setOwner] = useState<{ controller: PluginManagerController; settings: ProfileSettingsController; abort: AbortController } | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    const remote = pluginManagementRemote(target, abort.signal, frame => {
      if (frame.type === 'log') controller.appendLog(frame.chunk)
      else if (frame.type === 'progress') controller.installProgress(frame.progress)
    }, invalidate)
    const controller = new PluginManagerController({ remote })
    const settings = new ProfileSettingsController(remote.settings)
    setOwner({ controller, settings, abort })
    const refresh = () => { void controller.load() }
    window.addEventListener('focus', refresh)
    return () => { controller.dispose(); settings.dispose(); abort.abort(); window.removeEventListener('focus', refresh) }
  }, [target, invalidate])
  return owner === null ? <LoadingState label={t('pageConnecting')} /> : <ManagerView controller={owner.controller} settings={owner.settings} composition={composition} t={t} />
}
function ManagerView({ controller, settings, composition, t }: { controller: PluginManagerController; settings: ProfileSettingsController; composition: PluginComposition; t: Translate }) {
  const language = adminLanguage()
  const { hooks, ...actions } = useMemo(() => controller.inject(settings.ledger), [controller, settings])
  const state = useSyncExternalStore(hooks.pluginManager.subscribe, hooks.pluginManager.getSnapshot, hooks.pluginManager.getSnapshot)
  const configuration = useSyncExternalStore(settings.state.subscribe, settings.state.getSnapshot, settings.state.getSnapshot)
  const ledger = useSyncExternalStore(settings.ledger.subscribe, settings.ledger.getSnapshot, settings.ledger.getSnapshot)
  useEffect(() => { if (state.status !== 'idle' && state.status !== 'loading') void settings.load() }, [state.packages, state.status, settings])
  // A manager-side write moves the same composition the matrix and row controls display.
  const compositionRef = useRef(composition)
  useEffect(() => { compositionRef.current = composition })
  useEffect(() => { if (state.busy.length === 0) compositionRef.current.refresh() }, [state.busy])
  return <><ErrorBanner message={configuration.error} />
    {configuration.error ? <Button onClick={() => { void settings.load() }}>{t('configReload')}</Button> : null}
    {configuration.loading ? <LoadingState label={t('configLoading')} /> : null}
    <PluginManagerPage {...actions} composition={composition}
    usePluginManager={selector => selector(state)} useConfigLedger={selector => selector(ledger)} renderSlot={(_name, props, selection) => {
      const view = configuration.namespaces.find(item => item.ns === selection.only)
      if (view === undefined) return <p>{t('configUnavailable')}</p>
      return props.view === 'summary'
        ? t('configOwnerLayer', { owner: t(SETTINGS_OWNER_KEYS[view.owner ?? 'deployment']) })
        : <PluginConfiguration key={view.ns} view={view} controller={settings} />
    }}
    resolveText={text => resolveLocalized(text, language)}
    t={t} /></>
}

/** The selected owner's plugin-management qualification, editable in place. */
function TargetPolicy({ kind, id, t }: { kind: 'user' | 'project'; id: number; t: Translate }) {
  const [policy, setPolicy] = useState<AdminResourcePolicy | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    setPolicy(null); setError(''); setUnavailable(false)
    void getPluginPolicy(kind, id, abort.signal).then((value) => {
      if (abort.signal.aborted) return
      setPolicy(value); setEnabled(value.enabled)
    }).catch((cause: unknown) => {
      // Deployments without the PostgreSQL access store have no policies to show.
      if (abort.signal.aborted) return
      if (cause instanceof AdminRequestError && cause.status === 503) setUnavailable(true)
      else setError(String(cause))
    })
    return () => { abort.abort() }
  }, [kind, id])
  const save = async (next: boolean) => {
    if (policy === null) return
    setSaving(true); setError('')
    try {
      const result = await setPluginPolicy({ ...policy, enabled: next })
      setPolicy(result); setEnabled(result.enabled)
    } catch (cause) {
      const latest = await getPluginPolicy(kind, id).catch(() => null)
      if (latest !== null) { setPolicy(latest); setEnabled(latest.enabled) }
      setError(cause instanceof Error ? `${cause.message}；${t('policySaveReset')}` : String(cause))
    } finally { setSaving(false) }
  }
  if (unavailable) return <p className="muted">{t('policyUnavailable')}</p>
  if (policy === null) return error === '' ? null : <ErrorBanner message={error} />
  return <div className="targetPolicy">
    <div className="targetPolicyRow">
      <Switch
        label={kind === 'user' ? t('policyUserLabel') : t('policyProjectLabel')}
        checked={enabled}
        disabled={saving}
        onChange={next => { void save(next) }} />
      {enabled ? <StatusBadge tone="success">{t('policyGranted')}</StatusBadge> : <StatusBadge>{t('policyDenied')}</StatusBadge>}
    </div>
    <p className="muted">{kind === 'user' ? t('policyUserHint') : t('policyProjectHint')}</p>
    <ErrorBanner message={error} />
  </div>
}

/** The startup draft shared by every control on the page, with its save and discard actions. */
function DraftBar({ composition, t }: { readonly composition: PluginComposition; readonly t: Translate }) {
  if (!composition.persist || !composition.dirty) return null
  return <div className="draftBar" role="status">
    <span className="draftBarText">{t('draftPending', { count: `${composition.pending}` })}</span>
    <span className="draftBarActions">
      <Button disabled={composition.busy} onClick={() => { void composition.save(composition.draft) }}>{t('draftSave')}</Button>
      <Button variant="secondary" disabled={composition.busy} onClick={() => { composition.discard() }}>{t('draftDiscard')}</Button>
    </span>
  </div>
}

/** The plugin lifecycle as the page teaches it: install code, join the composition, run, then configure. */
function LifecycleLine({ t }: { t: Translate }) {
  return <p className="muted pluginLifecycle">{t('lifecycleLine')}</p>
}

/** The entry-level matrix the friendly list folds away, open by default while the instance is stopped. */
function CompositionView({ composition, open, t }: { readonly composition: PluginComposition; readonly open: boolean; readonly t: Translate }) {
  return <details className="pluginAdvanced" open={open}>
    <summary>{t('advancedTitle')}</summary>
    <PluginMatrix composition={composition} />
    {composition.persist && composition.view?.state != null
      ? <p><Button variant="secondary" disabled={composition.busy} onClick={() => { void composition.save(null) }}>{t('draftClear')}</Button></p>
      : null}
  </details>
}

export function PluginsPage() {
  const t = useMemo(() => translatePlugin(adminLanguage()), [])
  const [targets, setTargets] = useState<Array<{ key: string; kind: 'user' | 'project'; id: number; label: string }>>([])
  const [selected, setSelected] = useState('')
  const [binding, setBinding] = useState<PluginManagementTarget | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reload, setReload] = useState(0)
  const generation = useRef(0)
  const invalidate = useCallback((message: string) => {
    generation.current++; setBinding(null); setLoading(false); setError(message)
  }, [])
  useEffect(() => {
    let disposed = false
    void Promise.all([listUsers(), listProjects()]).then(([users, projects]) => {
      if (disposed) return
      setTargets([...users.map(user => ({ key: `user:${user.id}`, kind: 'user' as const, id: user.id, label: t('targetUser', { name: user.displayName }) })),
        ...projects.map(project => ({ key: `project:${project.id}`, kind: 'project' as const, id: project.id, label: t('targetProject', { name: project.name }) }))])
    }).catch(cause => { if (!disposed) setError(String(cause)) })
    return () => { disposed = true }
  }, [reload, t])
  useEffect(() => {
    const target = targets.find(item => item.key === selected)
    if (target === undefined) return
    const attempt = ++generation.current, abort = new AbortController()
    setLoading(true); setBinding(null); setError('')
    void pluginManagementTarget(target.kind, target.id, abort.signal).then(value => {
      if (attempt !== generation.current) return
      if (value.target.kind !== target.kind || value.target.id !== target.id) throw new Error(t('targetMismatch'))
      setBinding(value)
    }).catch(cause => { if (attempt === generation.current) setError(String(cause)) })
      .finally(() => { if (attempt === generation.current) setLoading(false) })
    return () => { generation.current++; abort.abort() }
  }, [selected, targets, t])
  return <div className="page">
    <PageHeader title={t('title')} description={t('pageDescription')} />
    <Section title={t('targetSection')}><div className="sectionBody">
      <ErrorBanner message={error} />
      <Field label={t('targetField')}><select className="select" aria-label={t('targetAria')} value={selected} onChange={event => {
        generation.current++; setBinding(null); setSelected(event.target.value)
      }}><option value="">{t('targetPlaceholder')}</option>{targets.map(target => <option key={target.key} value={target.key}>{target.label}</option>)}</select></Field>
      <Button onClick={() => { setBinding(null); setReload(value => value + 1) }}>{t('pageReload')}</Button>
      {loading ? <LoadingState label={t('targetLoading')} /> : null}
      {binding === null ? null : <p className="muted">
        {binding.generation === null ? t('instanceStopped') : t('instanceRunning', { generation: `${binding.generation}` })}
      </p>}
      {binding === null ? null : <TargetPolicy kind={binding.target.kind} id={binding.target.id} t={t} />}
    </div></Section>
    {binding === null ? null : <BoundPlugins key={`${binding.target.kind}:${binding.target.id}:${binding.generation ?? 'stopped'}`} binding={binding} invalidate={invalidate} t={t} />}
    <PluginPermissions />
  </div>
}

/** The plugins section once a target binds: the friendly list, the shared draft bar, and the folded composition view. */
function BoundPlugins({ binding, invalidate, t }: { readonly binding: PluginManagementTarget; readonly invalidate: (message: string) => void; readonly t: Translate }) {
  const composition = usePluginComposition(binding.target.kind, binding.target.id, binding, invalidate)
  const stopped = binding.generation === null
  return <Section title={t('title')}>
    <div className="sectionBody">
      <LifecycleLine t={t} />
      <ErrorBanner message={composition.error} />
      {composition.notice === '' ? null : <p role="status" className="muted">{composition.notice}</p>}
      {stopped
        ? <p className="muted">{t('stoppedManagerNotice')}</p>
        : <div className="adminPluginManager"><Manager target={binding} invalidate={invalidate} composition={composition} t={t} /></div>}
      <DraftBar composition={composition} t={t} />
      <CompositionView composition={composition} open={stopped} t={t} />
    </div>
  </Section>
}
