/** Per-owner plugin composition and live instance management around the upstream plugin workflow. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AdminRequestError, getPluginPolicy, listProjects, listUsers, pluginManagementTarget, setPluginPolicy, type AdminResourcePolicy, type PluginManagementTarget } from '../api.ts'
import { ErrorBanner, Field, PageHeader, Button, LoadingState, Section, StatusBadge, Switch } from '../components/ui.tsx'
import { PluginManagerPage } from '../plugins/PluginManagerPage.tsx'
import { PluginManagerController } from '../plugins/manager-store.ts'
import { pluginManagementRemote } from '../plugins/transport.ts'
import { PluginMatrix } from '../plugins/PluginMatrix.tsx'
import { resolveLocalized } from '../plugins/presentation.ts'
import { zh } from '../plugins/locales.ts'
import { ProfileSettingsController } from '../plugins/settings-store.ts'
import { PluginConfiguration, SETTINGS_OWNER_LABELS } from '../plugins/PluginConfiguration.tsx'
import { PluginPermissions } from '../components/PluginPermissions.tsx'

function Manager({ target, invalidate }: { target: PluginManagementTarget; invalidate: (message: string) => void }) {
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
  return owner === null ? <LoadingState label="正在连接插件管理" /> : <ManagerView controller={owner.controller} settings={owner.settings} />
}
function ManagerView({ controller, settings }: { controller: PluginManagerController; settings: ProfileSettingsController }) {
  const { hooks, ...actions } = useMemo(() => controller.inject(settings.ledger), [controller, settings])
  const state = useSyncExternalStore(hooks.pluginManager.subscribe, hooks.pluginManager.getSnapshot, hooks.pluginManager.getSnapshot)
  const configuration = useSyncExternalStore(settings.state.subscribe, settings.state.getSnapshot, settings.state.getSnapshot)
  const ledger = useSyncExternalStore(settings.ledger.subscribe, settings.ledger.getSnapshot, settings.ledger.getSnapshot)
  useEffect(() => { if (state.status !== 'idle' && state.status !== 'loading') void settings.load() }, [state.packages, state.status, settings])
  return <><ErrorBanner message={configuration.error} />
    {configuration.error ? <Button onClick={() => { void settings.load() }}>重新读取配置</Button> : null}
    {configuration.loading ? <LoadingState label="正在读取插件配置" /> : null}
    <PluginManagerPage {...actions}
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
    <PageHeader title="插件" description="为用户或项目配置插件组成与授权。「当前」列反映运行或文件中的状态并可即时启停；「启动时」列保存下次启动的插件组成。" />
    <Section title="管理对象"><div className="sectionBody">
      <ErrorBanner message={error} />
      <Field label="用户或项目"><select className="select" aria-label="插件管理对象" value={selected} onChange={event => {
        generation.current++; setBinding(null); setSelected(event.target.value)
      }}><option value="">请选择用户或项目</option>{targets.map(target => <option key={target.key} value={target.key}>{target.label}</option>)}</select></Field>
      <Button onClick={() => { setBinding(null); setReload(value => value + 1) }}>重新读取</Button>
      {loading ? <LoadingState label="正在读取插件实例" /> : null}
      {binding === null ? null : <p className="muted">
        {binding.generation === null
          ? '实例未运行：「当前」列为其文件中的插件组成，此页面不会启动实例。'
          : `实例运行中 · 代次 ${binding.generation}`}
      </p>}
      {binding === null ? null : <TargetPolicy kind={binding.target.kind} id={binding.target.id} />}
    </div></Section>
    {binding === null ? null : (
      <Section title="插件组成">
        <div className="sectionBody">
          <PluginMatrix key={`${binding.target.kind}:${binding.target.id}:${binding.generation ?? 'stopped'}`} kind={binding.target.kind} id={binding.target.id} target={binding} />
        </div>
      </Section>
    )}
    {binding === null ? null : binding.generation === null ? (
      <Section title="安装与实例详情">
        <div className="sectionBody"><p className="muted">实例未运行：安装、移除与插件详情需实例启动后可用。上方保存的插件组成将于下次启动生效。</p></div>
      </Section>
    ) : (
      <Section title="安装与实例详情">
        <div className="sectionBody">
          <div className="adminPluginManager"><Manager key={`${binding.nodeId}:${selected}:${binding.generation}`} target={binding} invalidate={invalidate} /></div>
        </div>
      </Section>
    )}
    <PluginPermissions />
  </div>
}
