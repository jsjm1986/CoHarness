/** Current-node profile selection around the upstream plugin management workflow. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { listProjects, listUsers, pluginManagementTarget, type PluginManagementTarget } from '../api.ts'
import { ErrorBanner, Field, PageHeader, Button, LoadingState, Section } from '../components/ui.tsx'
import { PluginManagerPage } from '../plugins/PluginManagerPage.tsx'
import { PluginManagerController } from '../plugins/manager-store.ts'
import { pluginManagementRemote } from '../plugins/transport.ts'
import { zh } from '../plugins/locales.ts'
import { ProfileSettingsController } from '../plugins/settings-store.ts'
import { PluginConfiguration, SETTINGS_OWNER_LABELS } from '../plugins/PluginConfiguration.tsx'

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
        ? `${SETTINGS_OWNER_LABELS[view.owner ?? 'deployment']} · ${view.applies === 'restart' ? '保存后需重启' : '即时配置'}`
        : <PluginConfiguration key={view.ns} view={view} controller={settings} />
    }}
    t={(key, parameters) => Object.entries(parameters ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), zh[key])} /></>
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
    <PageHeader title="插件" description="管理当前节点上正在运行的 Profile。操作会影响这个实例中的全部会话；更换范围会取消当前页面的安装请求。" />
    <Section title="目标实例"><div className="sectionBody">
      <ErrorBanner message={error} />
      <Field label="运行范围"><select className="select" aria-label="插件运行范围" value={selected} onChange={event => {
        generation.current++; setBinding(null); setSelected(event.target.value)
      }}><option value="">请选择用户或项目</option>{targets.map(target => <option key={target.key} value={target.key}>{target.label}</option>)}</select></Field>
      <Button onClick={() => { setBinding(null); setReload(value => value + 1) }}>重新读取实例</Button>
      {loading ? <LoadingState label="正在读取插件实例" /> : null}
      {binding === null ? null : <p className="muted">节点 {binding.nodeId} · {binding.generation === null ? '实例未运行；此页面不会启动实例。' : `实例代次 ${binding.generation}`}</p>}
    </div></Section>
    {binding?.generation == null ? null : <div className="adminPluginManager"><Manager key={`${binding.nodeId}:${selected}:${binding.generation}`} target={binding} invalidate={invalidate} /></div>}
  </div>
}
