/** Registered webhook endpoints, delivery diagnostics, and administrator redispatch. */
import { useEffect, useRef, useState } from 'react'
import { Inbox, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import {
  createWebhookEndpoint, listProjects, listUsers, listWebhookDeliveries, listWebhookEndpoints,
  mutateWebhookEndpoint, redispatchWebhookDelivery, updateWebhookEndpoint,
  type AdminWebhookEndpoint, type AdminWebhookEndpointFields, type AdminWebhookReceipt,
} from '../api.ts'
import {
  Button, ConfirmDialog, Dialog, EmptyState, ErrorBanner, Field, IconButton, LoadingState,
  PageHeader, Section, StatusBadge,
} from '../components/ui.tsx'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : '无法完成 Webhook 操作'

interface EndpointDraft {
  name: string
  source: string
  events: string
  actions: string
  repositories: string
  titleTemplate: string
  promptTemplate: string
  workspacePath: string
  agentPreset: string
  permissionPreset: string
  modelProvider: string
  modelId: string
  modelMaxTokens: string
  executionUserId: string
  runtimeKind: 'user' | 'project'
  runtimePublicId: string
  intakeLimit: string
  intakeWindowMs: string
  replayWindowMs: string
  maxBodyBytes: string
  secret: string
}

const EMPTY_DRAFT: EndpointDraft = {
  name: '', source: 'github', events: '', actions: '', repositories: '',
  titleTemplate: '{{event.name}} · {{payload.repository.full_name}}', promptTemplate: '',
  workspacePath: '', agentPreset: '', permissionPreset: '',
  modelProvider: '', modelId: '', modelMaxTokens: '',
  executionUserId: '', runtimeKind: 'user', runtimePublicId: '',
  intakeLimit: '100', intakeWindowMs: '60000', replayWindowMs: '86400000', maxBodyBytes: '1048576',
  secret: '',
}

const names = (value: string): string[] =>
  value.split(/[,\n]/u).map(entry => entry.trim()).filter(entry => entry !== '')
const text = (value: string) => value.trim() === '' ? null : value.trim()
const limit = (value: string, label: string): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label}必须是正整数`)
  return parsed
}
const optionalLimit = (value: string, label: string): number | null => value.trim() === '' ? null : limit(value, label)

function draftOf(endpoint: AdminWebhookEndpoint): EndpointDraft {
  return {
    name: endpoint.name, source: endpoint.source,
    events: endpoint.events.join(','), actions: endpoint.actions.join(','),
    repositories: endpoint.repositories.join(','),
    titleTemplate: endpoint.titleTemplate, promptTemplate: endpoint.promptTemplate,
    workspacePath: endpoint.workspacePath, agentPreset: endpoint.agentPreset,
    permissionPreset: endpoint.permissionPreset,
    modelProvider: endpoint.modelProvider ?? '', modelId: endpoint.modelId ?? '',
    modelMaxTokens: endpoint.modelMaxTokens === null ? '' : String(endpoint.modelMaxTokens),
    executionUserId: String(endpoint.executionUserId),
    runtimeKind: endpoint.runtimeKind, runtimePublicId: String(endpoint.runtimePublicId),
    intakeLimit: String(endpoint.intakeLimit), intakeWindowMs: String(endpoint.intakeWindowMs),
    replayWindowMs: String(endpoint.replayWindowMs), maxBodyBytes: String(endpoint.maxBodyBytes),
    secret: '',
  }
}

function fieldsOf(draft: EndpointDraft): AdminWebhookEndpointFields {
  const modelProvider = text(draft.modelProvider)
  const modelId = text(draft.modelId)
  if ((modelProvider === null) !== (modelId === null)) throw new Error('模型提供方与模型标识必须同时填写')
  const executionUserId = Number(draft.executionUserId)
  const runtimePublicId = Number(draft.runtimePublicId)
  if (!Number.isSafeInteger(executionUserId) || executionUserId <= 0) throw new Error('必须选择执行账号')
  if (!Number.isSafeInteger(runtimePublicId) || runtimePublicId <= 0) throw new Error('必须选择目标运行时')
  return {
    name: draft.name.trim(), provider: 'github', source: draft.source.trim(),
    events: names(draft.events), actions: names(draft.actions), repositories: names(draft.repositories),
    titleTemplate: draft.titleTemplate.trim(), promptTemplate: draft.promptTemplate,
    workspacePath: draft.workspacePath.trim(), agentPreset: draft.agentPreset.trim(),
    permissionPreset: draft.permissionPreset.trim(),
    modelProvider, modelId, modelMaxTokens: optionalLimit(draft.modelMaxTokens, '模型令牌上限'),
    executionUserId, runtimeKind: draft.runtimeKind, runtimePublicId,
    intakeLimit: limit(draft.intakeLimit, '接收限值'),
    intakeWindowMs: limit(draft.intakeWindowMs, '接收窗口'),
    replayWindowMs: limit(draft.replayWindowMs, '重放窗口'),
    maxBodyBytes: limit(draft.maxBodyBytes, '请求体上限'),
  }
}

const RECEIPT_TONE = { submitted: 'success', ignored: 'neutral', rejected: 'warning', dispatching: 'info', unknown: 'danger' } as const
const RECEIPT_LABEL = { submitted: '已受理', ignored: '已忽略', rejected: '已拒绝', dispatching: '派发中', unknown: '结果未知' } as const

export function WebhooksPage() {
  const [endpoints, setEndpoints] = useState<AdminWebhookEndpoint[] | null>(null)
  const [users, setUsers] = useState<Array<{ id: number; username: string }>>([])
  const [projects, setProjects] = useState<Array<{ id: number; name: string }>>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<{ endpoint: AdminWebhookEndpoint | null; draft: EndpointDraft } | null>(null)
  const [removing, setRemoving] = useState<AdminWebhookEndpoint | null>(null)
  const [deliveries, setDeliveries] = useState<{
    endpoint: AdminWebhookEndpoint; items: AdminWebhookReceipt[]; nextCursor: string | null
  } | null>(null)
  const [acting, setActing] = useState(false)
  const [reload, setReload] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    let disposed = false
    void Promise.all([listWebhookEndpoints(), listUsers(), listProjects()]).then(([listed, userRows, projectRows]) => {
      if (disposed) return
      setEndpoints(listed.endpoints)
      setUsers(userRows.map(user => ({ id: user.id, username: user.username })))
      setProjects(projectRows.map(project => ({ id: project.id, name: project.name })))
      setError('')
    }).catch((cause: unknown) => { if (!disposed) setError(messageOf(cause)) })
    return () => { disposed = true; generation.current++ }
  }, [reload])

  const refresh = () => { setReload(value => value + 1) }
  const patchDraft = (patch: Partial<EndpointDraft>) => {
    setEditing(current => current === null ? current : { ...current, draft: { ...current.draft, ...patch } })
  }
  const runtimeOwner = (endpoint: AdminWebhookEndpoint) => endpoint.runtimeKind === 'user'
    ? users.find(user => user.id === endpoint.runtimePublicId)?.username ?? `#${String(endpoint.runtimePublicId)}`
    : projects.find(project => project.id === endpoint.runtimePublicId)?.name ?? `#${String(endpoint.runtimePublicId)}`

  async function save(): Promise<void> {
    if (editing === null || acting) return
    const attempt = generation.current
    setActing(true); setError(''); setNotice('')
    try {
      const fields = fieldsOf(editing.draft)
      const secret = text(editing.draft.secret)
      if (editing.endpoint === null) {
        if (secret === null) throw new Error('注册时必须填写签名密钥')
        await createWebhookEndpoint({ ...fields, secret })
      } else {
        await updateWebhookEndpoint(editing.endpoint.publicId, editing.endpoint.revision, fields, secret ?? undefined)
      }
      if (attempt !== generation.current) return
      setNotice(editing.endpoint === null ? 'Webhook 端点已注册。' : 'Webhook 端点已更新。')
      setEditing(null); refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  async function toggle(endpoint: AdminWebhookEndpoint): Promise<void> {
    if (acting) return
    const attempt = generation.current
    setActing(true); setError(''); setNotice('')
    try {
      await mutateWebhookEndpoint(endpoint.publicId, endpoint.revision, endpoint.enabled ? 'disable' : 'enable')
      if (attempt !== generation.current) return
      setNotice(endpoint.enabled ? `已停用 ${endpoint.name}。` : `已启用 ${endpoint.name}。`)
      refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  async function remove(): Promise<void> {
    if (removing === null || acting) return
    const attempt = generation.current
    setActing(true); setError(''); setNotice('')
    try {
      await mutateWebhookEndpoint(removing.publicId, removing.revision, 'remove')
      if (attempt !== generation.current) return
      setNotice(`已删除 ${removing.name}。`); setRemoving(null); refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  async function openDeliveries(endpoint: AdminWebhookEndpoint): Promise<void> {
    const attempt = generation.current
    setActing(true); setError('')
    try {
      const page = await listWebhookDeliveries(endpoint.id)
      if (attempt !== generation.current) return
      setDeliveries({ endpoint, items: page.items, nextCursor: page.nextCursor })
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  async function moreDeliveries(): Promise<void> {
    if (deliveries === null || deliveries.nextCursor === null || acting) return
    const attempt = generation.current
    setActing(true); setError('')
    try {
      const page = await listWebhookDeliveries(deliveries.endpoint.id, deliveries.nextCursor)
      if (attempt !== generation.current) return
      setDeliveries({ endpoint: deliveries.endpoint, items: [...deliveries.items, ...page.items], nextCursor: page.nextCursor })
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  async function redispatch(receipt: AdminWebhookReceipt): Promise<void> {
    if (deliveries === null || acting) return
    const attempt = generation.current
    setActing(true); setError(''); setNotice('')
    try {
      const created = await redispatchWebhookDelivery(receipt.id)
      if (attempt !== generation.current) return
      setNotice(`已重新派发 ${receipt.deliveryId}，新回执状态为 ${RECEIPT_LABEL[created.state]}。`)
      await openDeliveries(deliveries.endpoint); refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  return (
    <>
      <PageHeader title="Webhook" description="登记的 Provider 端点、投递回执和管理员重跑。" />
      {error === '' ? null : <ErrorBanner message={error} />}
      {notice === '' ? null : <p role="status">{notice}</p>}
      <Section
        title="接入端点"
        actions={<>
          <IconButton label="刷新" icon={RefreshCw} onClick={refresh} />
          <Button icon={Plus} onClick={() => { setEditing({ endpoint: null, draft: EMPTY_DRAFT }) }}>注册端点</Button>
        </>}
      >
        {endpoints === null ? <LoadingState label="正在加载 Webhook 端点" /> : endpoints.length === 0 ? (
          <EmptyState title="尚无 Webhook 端点" detail="注册端点后，Provider 投递经签名验证、结构化筛选和持久去重，再派发到绑定的运行时创建会话。" />
        ) : (
          <table className="dataTable">
            <thead><tr><th>名称</th><th>来源</th><th>事件筛选</th><th>仓库筛选</th><th>执行账号</th><th>目标运行时</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {endpoints.map(endpoint => (
                <tr key={endpoint.publicId}>
                  <td>{endpoint.name}</td>
                  <td><code>{endpoint.provider}/{endpoint.source}</code></td>
                  <td>{endpoint.events.length === 0 ? '全部' : endpoint.events.join('、')}{endpoint.actions.length === 0 ? '' : `（${endpoint.actions.join('、')}）`}</td>
                  <td>{endpoint.repositories.length === 0 ? '全部' : endpoint.repositories.join('、')}</td>
                  <td>{users.find(user => user.id === endpoint.executionUserId)?.username ?? `#${String(endpoint.executionUserId)}`}</td>
                  <td>{endpoint.runtimeKind === 'user' ? '个人' : '项目'} · {runtimeOwner(endpoint)}</td>
                  <td><StatusBadge tone={endpoint.enabled ? 'success' : 'neutral'}>{endpoint.enabled ? '已启用' : '已停用'}</StatusBadge></td>
                  <td>
                    <IconButton label="投递记录" icon={Inbox} onClick={() => void openDeliveries(endpoint)} />
                    <IconButton label="编辑" icon={Pencil} onClick={() => { setEditing({ endpoint, draft: draftOf(endpoint) }) }} />
                    <Button variant="ghost" onClick={() => void toggle(endpoint)} disabled={acting}>{endpoint.enabled ? '停用' : '启用'}</Button>
                    <IconButton label="删除" icon={Trash2} onClick={() => { setRemoving(endpoint) }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Dialog
        open={editing !== null}
        title={editing === null || editing.endpoint === null ? '注册 Webhook 端点' : `编辑 ${editing.endpoint.name}`}
        description="接入地址为 /webhook/{端点号}；签名密钥只进不出，留空表示不轮换。模板可引用 {{delivery.id}}、{{event.name}}、{{event.action}} 和 {{payload.*}}。"
        onClose={() => { if (!acting) setEditing(null) }}
        footer={<>
          <Button type="button" onClick={() => { setEditing(null) }} disabled={acting}>取消</Button>
          <Button type="button" variant="primary" onClick={() => void save()} disabled={acting}>保存</Button>
        </>}
        wide
      >
        {editing === null ? null : (
          <div className="formGrid">
            <Field label="名称" hint="组织内唯一的管理显示名。"><input className="input" value={editing.draft.name} onChange={event => { patchDraft({ name: event.target.value }) }} /></Field>
            <Field label="来源标识" hint="写入会话来源的部署标识，如 github 组织名。"><input className="input" value={editing.draft.source} onChange={event => { patchDraft({ source: event.target.value }) }} /></Field>
            <Field label="签名密钥" hint={editing.endpoint === null ? 'Provider 端配置的 Webhook Secret。' : '留空保留现有密钥；填写即轮换。'}><input className="input" type="password" value={editing.draft.secret} onChange={event => { patchDraft({ secret: event.target.value }) }} /></Field>
            <Field label="事件筛选" hint="逗号分隔的事件名，如 push, pull_request；留空接收全部。"><input className="input" value={editing.draft.events} onChange={event => { patchDraft({ events: event.target.value }) }} /></Field>
            <Field label="动作筛选" hint="逗号分隔的 payload.action 值；留空不过滤。"><input className="input" value={editing.draft.actions} onChange={event => { patchDraft({ actions: event.target.value }) }} /></Field>
            <Field label="仓库筛选" hint="逗号分隔的 owner/repo 完整名，如 acme/api；留空接收全部仓库。"><input className="input" value={editing.draft.repositories} onChange={event => { patchDraft({ repositories: event.target.value }) }} /></Field>
            <Field label="会话标题模板" hint="支持 {{…}} 占位符。"><input className="input" value={editing.draft.titleTemplate} onChange={event => { patchDraft({ titleTemplate: event.target.value }) }} /></Field>
            <Field label="提示词模板" hint="投递触发会话的首条指令文本。"><textarea className="input" rows={5} value={editing.draft.promptTemplate} onChange={event => { patchDraft({ promptTemplate: event.target.value }) }} /></Field>
            <Field label="工作区路径" hint="会话工作区的绝对路径。"><input className="input" value={editing.draft.workspacePath} onChange={event => { patchDraft({ workspacePath: event.target.value }) }} /></Field>
            <Field label="代理预设"><input className="input" value={editing.draft.agentPreset} onChange={event => { patchDraft({ agentPreset: event.target.value }) }} /></Field>
            <Field label="权限预设"><input className="input" value={editing.draft.permissionPreset} onChange={event => { patchDraft({ permissionPreset: event.target.value }) }} /></Field>
            <Field label="模型提供方" hint="留空使用运行时默认模型。"><input className="input" value={editing.draft.modelProvider} onChange={event => { patchDraft({ modelProvider: event.target.value }) }} /></Field>
            <Field label="模型标识"><input className="input" value={editing.draft.modelId} onChange={event => { patchDraft({ modelId: event.target.value }) }} /></Field>
            <Field label="模型令牌上限"><input className="input" inputMode="numeric" value={editing.draft.modelMaxTokens} onChange={event => { patchDraft({ modelMaxTokens: event.target.value }) }} /></Field>
            <Field label="执行账号" hint="投递创建的会话归属此账号。">
              <select className="input" value={editing.draft.executionUserId} onChange={event => { patchDraft({ executionUserId: event.target.value }) }}>
                <option value="">选择账号</option>
                {users.map(user => <option key={user.id} value={String(user.id)}>{user.username}</option>)}
              </select>
            </Field>
            <Field label="运行时类型">
              <select className="input" value={editing.draft.runtimeKind} onChange={event => { patchDraft({ runtimeKind: event.target.value === 'project' ? 'project' : 'user', runtimePublicId: '' }) }}>
                <option value="user">个人运行时</option>
                <option value="project">项目运行时</option>
              </select>
            </Field>
            <Field label="目标运行时" hint="已运行的实例才会接收派发。">
              <select className="input" value={editing.draft.runtimePublicId} onChange={event => { patchDraft({ runtimePublicId: event.target.value }) }}>
                <option value="">选择目标</option>
                {(editing.draft.runtimeKind === 'user' ? users : projects).map(owner => <option key={owner.id} value={String(owner.id)}>{'username' in owner ? owner.username : owner.name}</option>)}
              </select>
            </Field>
            <Field label="接收限值" hint="每个窗口内接受的新投递数。"><input className="input" inputMode="numeric" value={editing.draft.intakeLimit} onChange={event => { patchDraft({ intakeLimit: event.target.value }) }} /></Field>
            <Field label="接收窗口（毫秒）"><input className="input" inputMode="numeric" value={editing.draft.intakeWindowMs} onChange={event => { patchDraft({ intakeWindowMs: event.target.value }) }} /></Field>
            <Field label="重放窗口（毫秒）" hint="正文相同的换号投递在该窗口内归并到原始回执。"><input className="input" inputMode="numeric" value={editing.draft.replayWindowMs} onChange={event => { patchDraft({ replayWindowMs: event.target.value }) }} /></Field>
            <Field label="请求体上限（字节）"><input className="input" inputMode="numeric" value={editing.draft.maxBodyBytes} onChange={event => { patchDraft({ maxBodyBytes: event.target.value }) }} /></Field>
          </div>
        )}
      </Dialog>
      <Dialog
        open={deliveries !== null}
        title={deliveries === null ? '' : `${deliveries.endpoint.name} 的投递记录`}
        description="回执只保留投递标识、配置代次和结果；已落定的投递可由管理员重跑。"
        onClose={() => { if (!acting) setDeliveries(null) }}
        wide
      >
        {deliveries === null ? null : deliveries.items.length === 0 ? (
          <EmptyState title="尚无投递" />
        ) : (
          <>
            <table className="dataTable">
              <thead><tr><th>投递标识</th><th>配置代次</th><th>状态</th><th>会话</th><th>接收时间</th><th>操作</th></tr></thead>
              <tbody>
                {deliveries.items.map(receipt => (
                  <tr key={receipt.id}>
                    <td><code>{receipt.deliveryId}</code></td>
                    <td>{receipt.configurationRevision}</td>
                    <td><StatusBadge tone={RECEIPT_TONE[receipt.state]}>{RECEIPT_LABEL[receipt.state]}{receipt.errorCode === null ? '' : `（${receipt.errorCode}）`}</StatusBadge></td>
                    <td>{receipt.sessionId === null ? '—' : <code>{receipt.sessionId}</code>}</td>
                    <td>{new Date(receipt.receivedAt).toLocaleString()}</td>
                    <td>
                      {receipt.state === 'submitted' || receipt.state === 'ignored' || receipt.state === 'rejected'
                        ? <Button variant="ghost" onClick={() => void redispatch(receipt)} disabled={acting}>重跑</Button>
                        : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {deliveries.nextCursor === null ? null : <Button onClick={() => void moreDeliveries()} disabled={acting}>加载更多</Button>}
          </>
        )}
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        title={removing === null ? '' : `删除 ${removing.name}`}
        description="删除后端点立即停止接收投递；既有回执保留用于审计。"
        confirmLabel="删除"
        pending={acting}
        onConfirm={() => void remove()}
        onClose={() => { if (!acting) setRemoving(null) }}
      />
    </>
  )
}
