/** Desired and effective deployment settings for the server-confirmed current node. */
import { useEffect, useState } from 'react'
import { NODE_CONFIG_FIELDS } from '../../../src/node-config-fields.ts'
import { getNodeConfiguration, mutateNodeConfiguration, type NodeConfigurationView, type NodeSettingValues } from '../api.ts'
import { Button, Dialog, ErrorBanner, Field, LoadingState, Section, StatusBadge } from '../components/ui.tsx'

const GROUPS = { network: '访问与监听', paths: '受管目录', credentials: '凭据位置', runtime: '实例生命周期与资源' } as const
const STATUS = { pending: '等待独立应用器', applying: '正在应用与验证', completed: '应用完成', failed: '应用失败' } as const

function configurationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const descriptions: Record<string, string> = {
    'node-configuration-revision-conflict': '配置已被其他操作更新，请重新读取并核对后再提交。',
    'node-configuration-identity-mismatch': '表单所属节点已变化，请重新读取当前节点配置。',
    'node-configuration-apply-in-progress': '已有配置正在等待应用或执行，请待其完成后再修改。',
    'deployment-data-operation-already-running': '节点正在备份、恢复或应用配置，请待该操作结束后再试。',
    'configuration-requires-quiesced-maintenance': '请先进入维护窗口，并停止全部运行时实例。',
    'node-configuration-request-predates-restored-data': '数据已经恢复到新的代次，请核对配置后重新发起应用。',
    'gateway-service-restart-failed': 'Gateway 服务重启失败，请检查本机服务日志。',
    'gateway-did-not-confirm-configured-revision': 'Gateway 未确认期望的配置版本，请检查新监听地址和本机服务。',
    'previous-configuration-restored': '上一可用配置已恢复。',
  }
  return message.split('; ').map(part => descriptions[part] ?? part).join(' ')
}

export function NodeConfigurationSection() {
  const [view, setView] = useState<NodeConfigurationView | null>(null)
  const [draft, setDraft] = useState<NodeSettingValues | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [filter, setFilter] = useState('')
  const applying = view?.operation?.status === 'pending' || view?.operation?.status === 'applying'
  const dirty = draft !== null && view !== null && NODE_CONFIG_FIELDS.some(field => draft[field.key] !== view.desired[field.key])
  useEffect(() => {
    const lifetime = new AbortController()
    void getNodeConfiguration(lifetime.signal).then(value => { setView(value); setDraft(value.desired) })
      .catch((cause: unknown) => { if (!lifetime.signal.aborted) setError(configurationMessage(cause)) })
    return () => { lifetime.abort() }
  }, [])
  useEffect(() => {
    if (!applying) return
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try { setView(await getNodeConfiguration(lifetime.signal)); setError('') }
      catch (cause) { if (!lifetime.signal.aborted) setError(configurationMessage(cause)) }
      finally { if (!lifetime.signal.aborted) timer = setTimeout(() => { void read() }, 5000) }
    }
    timer = setTimeout(() => { void read() }, 1000)
    return () => { lifetime.abort(); clearTimeout(timer) }
  }, [applying])

  async function mutate(action: 'save' | 'apply') {
    if (view === null || draft === null) return
    setBusy(true); setError(''); setSaved('')
    try {
      const next = await mutateNodeConfiguration({ action, organizationId: view.organizationId, nodeId: view.nodeId,
        revision: view.revision, ...(action === 'save' ? { values: draft } : {}) })
      setView(next); setDraft(next.desired); setConfirm(false)
      setSaved(action === 'save' ? '已保存待应用配置；当前进程仍使用原值。' : '应用请求已登记，等待独立应用器预检和重启验证。')
    } catch (cause) { setError(configurationMessage(cause)) }
    finally { setBusy(false) }
  }

  return <Section title="当前节点配置" meta={view === null ? '读取服务器确认的组织与节点' : `节点 ${view.nodeId} · 配置版本 ${view.revision} · 运行版本 ${view.runningRevision}`}>
    {view === null || draft === null ? <><ErrorBanner message={error} />{error === '' ? <LoadingState label="正在读取节点配置" /> : null}</> : <>
      <p>普通保存不重启服务。应用前请进入维护窗口、停止实例，并准备外部反向代理和目标目录。所有设置经独立应用器验证后重启生效。</p>
      <StatusBadge tone={applying ? 'warning' : view.operation?.status === 'failed' ? 'danger' : 'neutral'}>
        {view.operation === null || view.operation.revision !== view.revision ? (view.revision === view.runningRevision ? '当前配置已生效' : '有待应用配置') : STATUS[view.operation.status]}
      </StatusBadge>
      {view.operation?.error === null || view.operation === null ? null : <ErrorBanner message={`配置版本 ${view.operation.revision}：${configurationMessage(view.operation.error)}`} />}
      {!confirm ? <ErrorBanner message={error} /> : null}
      {saved === '' ? null : <p role="status">{saved}</p>}
      <Field label="筛选节点设置"><input className="input" value={filter} onChange={event => { setFilter(event.target.value) }} placeholder="名称、用途或变量名" /></Field>
      {Object.entries(GROUPS).map(([group, title]) => {
        const fields = NODE_CONFIG_FIELDS.filter(field => field.group === group && `${field.label} ${field.help} ${field.key}`.toLowerCase().includes(filter.toLowerCase()))
        if (fields.length === 0) return null
        return <details key={group} className="nodeConfigurationGroup" open={filter !== '' || group === 'network'}>
          <summary>{title}</summary>
          <fieldset className="nodeConfigurationFields" aria-label={title} disabled={busy || applying}>
          {fields.map(field => <Field key={field.key} label={`${field.label}${field.unit === '' ? '' : `（${field.unit}）`}`}>
            <input className="input" value={draft[field.key]} inputMode={field.kind === 'integer' ? 'numeric' : 'text'}
              aria-label={`${field.label}${field.unit === '' ? '' : `（${field.unit}）`}`} aria-describedby={`node-setting-help-${field.key} node-setting-current-${field.key}`}
              onChange={event => { setDraft(current => current === null ? null : { ...current, [field.key]: event.target.value }); setSaved('') }} />
            <p id={`node-setting-help-${field.key}`}>{field.help}</p>
            <small id={`node-setting-current-${field.key}`}>当前生效：{view.effective[field.key] === '' ? '未设置' : view.effective[field.key]} · 来源：{view.runningRevision === 0 ? '启动配置' : `受管配置版本 ${view.runningRevision}`}</small>
          </Field>)}
          </fieldset>
        </details>
      })}
      <div className="formActions">
        <Button variant="primary" disabled={!dirty || applying} loading={busy} onClick={() => { void mutate('save') }}>保存待应用配置</Button>
        <Button disabled={busy || dirty || applying || view.revision === view.runningRevision} onClick={() => { setError(''); setConfirm(true) }}>应用并重启</Button>
        <Button disabled={busy || applying} onClick={() => {
          setBusy(true)
          void getNodeConfiguration().then(next => { setView(next); setDraft(next.desired); setError(''); setSaved('') })
            .catch((cause: unknown) => { setError(configurationMessage(cause)) }).finally(() => { setBusy(false) })
        }}>重新读取</Button>
      </div>
      <p>本机配置文件：<code>{view.configFile}</code>。Web 失联时，在同一启动环境运行 <code>node gateway/lib/node-config-cli.js status</code> 查看状态，运行 <code>recover</code> 验证并恢复上一可用配置。</p>
      <Dialog open={confirm} title="应用节点配置并重启" description="独立应用器先核验维护状态、端口、数据库及数据目录，再重启当前节点 Gateway。连接会暂时中断；修改公开地址或端口前须先配置外部入口。失败时尝试恢复上一可用配置，失败证据保留。"
        onClose={() => { if (!busy) setConfirm(false) }} footer={<>
          <Button disabled={busy} onClick={() => { setConfirm(false) }}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => { void mutate('apply') }}>确认应用并重启</Button>
        </>}>
          <ErrorBanner message={confirm ? error : ''} />
          <p>将应用配置版本 {view.revision}，节点 {view.nodeId}。</p>
          <div className="tableWrap" role="region" aria-label="待应用配置变化" tabIndex={0}>
            <table className="dataTable"><thead><tr><th>设置</th><th>当前生效值</th><th>待应用值</th></tr></thead><tbody>
              {NODE_CONFIG_FIELDS.filter(field => view.desired[field.key] !== view.effective[field.key]).map(field => <tr key={field.key}>
                <td>{field.label}</td><td>{view.effective[field.key] || '未设置'}</td><td>{view.desired[field.key] || '未设置'}</td>
              </tr>)}
            </tbody></table>
          </div>
        </Dialog>
    </>}
  </Section>
}
