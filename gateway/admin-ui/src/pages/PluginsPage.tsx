/** Per-owner plugin management: one friendly plugin list over the shared composition, with the entry-level matrix folded below. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AdminRequestError, getPluginPolicy, listProjects, listUsers, pluginManagementTarget, setPluginPolicy, type AdminResourcePolicy, type PluginManagementTarget } from '../api.ts'
import { ErrorBanner, Field, PageHeader, Button, LoadingState, Section, StatusBadge, Switch } from '../components/ui.tsx'
import { PluginManagerPage } from '../plugins/PluginManagerPage.tsx'
import { PluginManagerController } from '../plugins/manager-store.ts'
import { pluginManagementRemote } from '../plugins/transport.ts'
import { PluginMatrix } from '../plugins/PluginMatrix.tsx'
import { usePluginComposition, type PluginComposition } from '../plugins/composition.ts'
import { resolveLocalized } from '../plugins/presentation.ts'
import { zh } from '../plugins/locales.ts'
import { ProfileSettingsController } from '../plugins/settings-store.ts'
import { PluginConfiguration, SETTINGS_OWNER_LABELS } from '../plugins/PluginConfiguration.tsx'
import { PluginPermissions } from '../components/PluginPermissions.tsx'

function Manager({ target, invalidate, composition }: { target: PluginManagementTarget; invalidate: (message: string) => void; composition: PluginComposition }) {
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
  return owner === null ? <LoadingState label="正在连接插件管理" /> : <ManagerView controller={owner.controller} settings={owner.settings} composition={composition} />
}
function ManagerView({ controller, settings, composition }: { controller: PluginManagerController; settings: ProfileSettingsController; composition: PluginComposition }) {
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
    {configuration.error ? <Button onClick={() => { void settings.load() }}>重新读取配置</Button> : null}
    {configuration.loading ? <LoadingState label="正在读取插件配置" /> : null}
    <PluginManagerPage {...actions} composition={composition}
    usePluginManager={selector => selector(state)} useConfigLedger={selector => selector(ledger)} renderSlot={(_name, props, selection) => {
      const view = configuration.namespaces.find(item => item.ns === selection.only)
      if (view === undefined) return <p>此配置已不可用，请重新读取实例。</p>
      return props.view === 'summary'
        ? `${SETTINGS_OWNER_LABELS[view.owner ?? 'deployment']}层配置`
        : <PluginConfiguration key={view.ns} view={view} controller={settings} />
    }}
    resolveText={resolveLocalized}
    t={(key, parameters) => Object.entries(parameters ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), zh[key])} /></>
}

/** The selected owner's plugin-management qualification, editable in place. */
function TargetPolicy({ kind, id }: { kind: 'user' | 'project'; id: number }) {
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
      setError(cause instanceof Error ? `${cause.message}；授权已重置为最新版本。` : String(cause))
    } finally { setSaving(false) }
  }
  if (unavailable) return <p className="muted">此部署未启用授权策略存储，无法在此管理插件资格。</p>
  if (policy === null) return error === '' ? null : <ErrorBanner message={error} />
  return <div className="targetPolicy">
    <div className="targetPolicyRow">
      <Switch
        label={kind === 'user' ? '允许此用户在个人空间管理插件' : '允许此项目空间的插件管理'}
        checked={enabled}
        disabled={saving}
        onChange={next => { void save(next) }} />
      {enabled ? <StatusBadge tone="success">已授权</StatusBadge> : <StatusBadge>未授权</StatusBadge>}
    </div>
    <p className="muted">{kind === 'user'
      ? '项目空间中的插件管理另需对应项目授权（页面底部）。'
      : '项目成员还需各自的插件管理资格（在「用户」详情页授予）；实例运行中的撤销立即生效。'}</p>
    <ErrorBanner message={error} />
  </div>
}

/** The startup draft shared by every control on the page, with its save and discard actions. */
function DraftBar({ composition }: { readonly composition: PluginComposition }) {
  if (!composition.persist || !composition.dirty) return null
  return <div className="draftBar" role="status">
    <span className="draftBarText">启动时 · {composition.pending} 项变更待保存</span>
    <span className="draftBarActions">
      <Button disabled={composition.busy} onClick={() => { void composition.save(composition.draft) }}>保存插件组成</Button>
      <Button variant="secondary" disabled={composition.busy} onClick={() => { composition.discard() }}>放弃修改</Button>
    </span>
  </div>
}

/** The plugin lifecycle as the page teaches it: install code, join the composition, run, then configure. */
function LifecycleLine() {
  return <p className="muted pluginLifecycle">插件的生命周期：安装 → 启用 → 运行 → 配置。「当前」开关立即生效并写回文件；「启动时」草稿保存后于下次启动生效。</p>
}

/** The entry-level matrix the friendly list folds away, open by default while the instance is stopped. */
function CompositionView({ composition, open }: { readonly composition: PluginComposition; readonly open: boolean }) {
  return <details className="pluginAdvanced" open={open}>
    <summary>高级：组成视图（条目级）</summary>
    <PluginMatrix composition={composition} />
    {composition.persist && composition.view?.state != null
      ? <p><Button variant="secondary" disabled={composition.busy} onClick={() => { void composition.save(null) }}>清除启动配置</Button></p>
      : null}
  </details>
}

export function PluginsPage() {
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
      setTargets([...users.map(user => ({ key: `user:${user.id}`, kind: 'user' as const, id: user.id, label: `用户 · ${user.displayName}` })),
        ...projects.map(project => ({ key: `project:${project.id}`, kind: 'project' as const, id: project.id, label: `项目 · ${project.name}` }))])
    }).catch(cause => { if (!disposed) setError(String(cause)) })
    return () => { disposed = true }
  }, [reload])
  useEffect(() => {
    const target = targets.find(item => item.key === selected)
    if (target === undefined) return
    const attempt = ++generation.current, abort = new AbortController()
    setLoading(true); setBinding(null); setError('')
    void pluginManagementTarget(target.kind, target.id, abort.signal).then(value => {
      if (attempt !== generation.current) return
      if (value.target.kind !== target.kind || value.target.id !== target.id) throw new Error('插件管理实例与所选范围不一致。')
      setBinding(value)
    }).catch(cause => { if (attempt === generation.current) setError(String(cause)) })
      .finally(() => { if (attempt === generation.current) setLoading(false) })
    return () => { generation.current++; abort.abort() }
  }, [selected, targets])
  return <div className="page">
    <PageHeader title="插件" description="为用户或项目安装、启用并配置插件。「当前」开关立即生效；「启动时」草稿保存后于下次启动生效。" />
    <Section title="管理对象"><div className="sectionBody">
      <ErrorBanner message={error} />
      <Field label="用户或项目"><select className="select" aria-label="插件管理对象" value={selected} onChange={event => {
        generation.current++; setBinding(null); setSelected(event.target.value)
      }}><option value="">请选择用户或项目</option>{targets.map(target => <option key={target.key} value={target.key}>{target.label}</option>)}</select></Field>
      <Button onClick={() => { setBinding(null); setReload(value => value + 1) }}>重新读取</Button>
      {loading ? <LoadingState label="正在读取插件实例" /> : null}
      {binding === null ? null : <p className="muted">
        {binding.generation === null
          ? '实例未运行：下方显示其文件中的插件组成，此页面不会启动实例。'
          : `实例运行中 · 代次 ${binding.generation}`}
      </p>}
      {binding === null ? null : <TargetPolicy kind={binding.target.kind} id={binding.target.id} />}
    </div></Section>
    {binding === null ? null : <BoundPlugins key={`${binding.target.kind}:${binding.target.id}:${binding.generation ?? 'stopped'}`} binding={binding} invalidate={invalidate} />}
    <PluginPermissions />
  </div>
}

/** The plugins section once a target binds: the friendly list, the shared draft bar, and the folded composition view. */
function BoundPlugins({ binding, invalidate }: { readonly binding: PluginManagementTarget; readonly invalidate: (message: string) => void }) {
  const composition = usePluginComposition(binding.target.kind, binding.target.id, binding, invalidate)
  const stopped = binding.generation === null
  return <Section title="插件">
    <div className="sectionBody">
      <LifecycleLine />
      <ErrorBanner message={composition.error} />
      {composition.notice === '' ? null : <p role="status" className="muted">{composition.notice}</p>}
      {stopped
        ? <p className="muted">实例未运行：安装、卸载、当前启停与详情需实例启动后可用；下方「启动时」仍可编辑并于下次启动生效。</p>
        : <div className="adminPluginManager"><Manager target={binding} invalidate={invalidate} composition={composition} /></div>}
      <DraftBar composition={composition} />
      <CompositionView composition={composition} open={stopped} />
    </div>
  </Section>
}
