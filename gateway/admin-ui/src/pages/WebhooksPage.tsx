/** Registered webhook endpoints, delivery diagnostics, and administrator redispatch. */
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as copyZh, en as copyEn, type WebhooksCopyKey } from './webhooks.copy.ts'

const messageOf = (error: unknown): string => error instanceof Error
  ? error.message
  : translateCopy(adminLanguage(), { zh: copyZh, en: copyEn })('operationFailed')

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
  projectVisibility: 'project' | 'private'
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
  workspacePath: '', agentPreset: '', permissionPreset: '', projectVisibility: 'project',
  modelProvider: '', modelId: '', modelMaxTokens: '',
  executionUserId: '', runtimeKind: 'user', runtimePublicId: '',
  intakeLimit: '100', intakeWindowMs: '60000', replayWindowMs: '86400000', maxBodyBytes: '1048576',
  secret: '',
}

const names = (value: string): string[] =>
  value.split(/[,\n]/u).map(entry => entry.trim()).filter(entry => entry !== '')
const text = (value: string) => value.trim() === '' ? null : value.trim()
const limit = (value: string, label: string, max?: number): number => {
  const t = translateCopy(adminLanguage(), { zh: copyZh, en: copyEn })
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(t('validationPositiveInteger', { label }))
  if (max !== undefined && parsed > max) throw new Error(t('validationMax', { label, max: String(max) }))
  return parsed
}
const optionalLimit = (value: string, label: string): number | null => value.trim() === '' ? null : limit(value, label)
const boundedText = (value: string, label: string, max: number): string => {
  const t = translateCopy(adminLanguage(), { zh: copyZh, en: copyEn })
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(t('validationRequired', { label }))
  if (trimmed.length > max) throw new Error(t('validationMaxChars', { label, max: String(max) }))
  return trimmed
}
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

function draftOf(endpoint: AdminWebhookEndpoint): EndpointDraft {
  return {
    name: endpoint.name, source: endpoint.source,
    events: endpoint.events.join(','), actions: endpoint.actions.join(','),
    repositories: endpoint.repositories.join(','),
    titleTemplate: endpoint.titleTemplate, promptTemplate: endpoint.promptTemplate,
    workspacePath: endpoint.workspacePath, agentPreset: endpoint.agentPreset,
    permissionPreset: endpoint.permissionPreset, projectVisibility: endpoint.projectVisibility,
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
  const t = translateCopy(adminLanguage(), { zh: copyZh, en: copyEn })
  const modelProvider = text(draft.modelProvider)
  const modelId = text(draft.modelId)
  if ((modelProvider === null) !== (modelId === null)) throw new Error(t('validationModelPair'))
  const executionUserId = Number(draft.executionUserId)
  if (!Number.isSafeInteger(executionUserId) || executionUserId <= 0) throw new Error(t('validationExecutionUser'))
  // 个人运行时的目标固定为执行账号本人；服务端按此约束校验每次投递。
  const runtimePublicId = draft.runtimeKind === 'user' ? executionUserId : Number(draft.runtimePublicId)
  if (draft.runtimeKind === 'project' && (!Number.isSafeInteger(runtimePublicId) || runtimePublicId <= 0)) {
    throw new Error(t('validationRuntimeTarget'))
  }
  const events = names(draft.events)
  const actions = names(draft.actions)
  const repositories = names(draft.repositories)
  if (events.length > 64 || actions.length > 64 || repositories.length > 64) throw new Error(t('validationFilterCount'))
  if (events.some(entry => entry.length > 128) || actions.some(entry => entry.length > 128)) {
    throw new Error(t('validationFilterChars'))
  }
  if (repositories.some(entry => !REPOSITORY_NAME.test(entry))) throw new Error(t('validationRepository'))
  return {
    name: boundedText(draft.name, t('fieldName'), 128), provider: 'github', source: boundedText(draft.source, t('fieldSource'), 128),
    events, actions, repositories,
    titleTemplate: boundedText(draft.titleTemplate, t('fieldTitleTemplate'), 512),
    promptTemplate: boundedText(draft.promptTemplate, t('fieldPromptTemplate'), 16_384),
    workspacePath: boundedText(draft.workspacePath, t('fieldWorkspacePath'), 1024),
    agentPreset: boundedText(draft.agentPreset, t('fieldAgentPreset'), 128),
    permissionPreset: boundedText(draft.permissionPreset, t('fieldPermissionPreset'), 128),
    projectVisibility: draft.projectVisibility,
    modelProvider, modelId, modelMaxTokens: optionalLimit(draft.modelMaxTokens, t('fieldModelMaxTokens')),
    executionUserId, runtimeKind: draft.runtimeKind, runtimePublicId,
    intakeLimit: limit(draft.intakeLimit, t('fieldIntakeLimit'), 1_000_000),
    intakeWindowMs: limit(draft.intakeWindowMs, t('labelIntakeWindow'), 86_400_000),
    replayWindowMs: limit(draft.replayWindowMs, t('labelReplayWindow'), 2_592_000_000),
    maxBodyBytes: limit(draft.maxBodyBytes, t('labelMaxBodyBytes'), 1_048_576),
  }
}

const RECEIPT_TONE = { submitted: 'success', ignored: 'neutral', rejected: 'warning', dispatching: 'info', unknown: 'danger' } as const
const RECEIPT_LABEL: Record<keyof typeof RECEIPT_TONE, WebhooksCopyKey> = {
  submitted: 'receiptSubmitted', ignored: 'receiptIgnored', rejected: 'receiptRejected',
  dispatching: 'receiptDispatching', unknown: 'receiptUnknown',
}

export function WebhooksPage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: copyZh, en: copyEn }), [])
  const [endpoints, setEndpoints] = useState<AdminWebhookEndpoint[] | null>(null)
  const [users, setUsers] = useState<Array<{ id: number; username: string; active: boolean }>>([])
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
      setUsers(userRows.map(user => ({ id: user.id, username: user.username, active: user.status === 'active' })))
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
        if (secret === null) throw new Error(t('validationSecret'))
        await createWebhookEndpoint({ ...fields, secret })
      } else {
        await updateWebhookEndpoint(editing.endpoint.publicId, editing.endpoint.revision, fields, secret ?? undefined)
      }
      if (attempt !== generation.current) return
      setNotice(editing.endpoint === null ? t('noticeRegistered') : t('noticeUpdated'))
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
      setNotice(endpoint.enabled ? t('noticeDisabled', { name: endpoint.name }) : t('noticeEnabled', { name: endpoint.name }))
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
      setNotice(t('noticeDeleted', { name: removing.name })); setRemoving(null); refresh()
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
      setNotice(t('noticeRedispatched', { delivery: receipt.deliveryId, state: t(RECEIPT_LABEL[created.state]) }))
      await openDeliveries(deliveries.endpoint); refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  return (
    <>
      <PageHeader title="Webhook" description={t('pageDescription')} />
      {error === '' ? null : <ErrorBanner message={error} />}
      {notice === '' ? null : <p role="status">{notice}</p>}
      <Section
        title={t('sectionEndpoints')}
        actions={<>
          <IconButton label={t('refresh')} icon={RefreshCw} onClick={refresh} />
          <Button icon={Plus} onClick={() => { setError(''); setEditing({ endpoint: null, draft: EMPTY_DRAFT }) }}>{t('registerEndpoint')}</Button>
        </>}
      >
        {endpoints === null ? <LoadingState label={t('loadingEndpoints')} /> : endpoints.length === 0 ? (
          <EmptyState title={t('endpointsEmptyTitle')} detail={t('endpointsEmptyDetail')} />
        ) : (
          <div className="tableWrap" role="region" aria-label={t('endpointsTableAria')} tabIndex={0}>
            <table className="dataTable">
              <thead><tr><th>{t('fieldName')}</th><th>{t('columnSource')}</th><th>{t('fieldEvents')}</th><th>{t('fieldRepositories')}</th><th>{t('fieldExecutionUser')}</th><th>{t('fieldRuntimeTarget')}</th><th>{t('columnStatus')}</th><th>{t('columnActions')}</th></tr></thead>
              <tbody>
                {endpoints.map(endpoint => (
                  <tr key={endpoint.publicId}>
                    <td>{endpoint.name}</td>
                    <td><code>{endpoint.provider}/{endpoint.source}</code></td>
                    <td>{endpoint.events.length === 0 ? t('filterAll') : endpoint.events.join(t('listSeparator'))}{endpoint.actions.length === 0 ? '' : t('parenthesized', { value: endpoint.actions.join(t('listSeparator')) })}</td>
                    <td>{endpoint.repositories.length === 0 ? t('filterAll') : endpoint.repositories.join(t('listSeparator'))}</td>
                    <td>{users.find(user => user.id === endpoint.executionUserId)?.username ?? `#${String(endpoint.executionUserId)}`}</td>
                    <td>{endpoint.runtimeKind === 'user' ? t('runtimeKindUser') : t('runtimeKindProject')} · {runtimeOwner(endpoint)}</td>
                    <td><StatusBadge tone={endpoint.enabled ? 'success' : 'neutral'}>{endpoint.enabled ? t('statusEnabled') : t('statusDisabled')}</StatusBadge></td>
                    <td>
                      <IconButton label={t('deliveriesLabel')} icon={Inbox} onClick={() => void openDeliveries(endpoint)} />
                      <IconButton label={t('edit')} icon={Pencil} onClick={() => { setError(''); setEditing({ endpoint, draft: draftOf(endpoint) }) }} />
                      <Button variant="ghost" onClick={() => void toggle(endpoint)} disabled={acting}>{endpoint.enabled ? t('disable') : t('enable')}</Button>
                      <IconButton label={t('delete')} icon={Trash2} onClick={() => { setRemoving(endpoint) }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Dialog
        open={editing !== null}
        title={editing === null || editing.endpoint === null ? t('dialogRegisterTitle') : t('dialogEditTitle', { name: editing.endpoint.name })}
        description={t('dialogDescription')}
        onClose={() => { if (!acting) setEditing(null) }}
        footer={<>
          <Button type="button" onClick={() => { setEditing(null) }} disabled={acting}>{t('cancel')}</Button>
          <Button type="button" variant="primary" onClick={() => void save()} disabled={acting}>{t('save')}</Button>
        </>}
        wide
      >
        {editing === null ? null : (
          <div className="formGrid">
            <div className="formSpanFull"><ErrorBanner message={error} /></div>
            <Field label={t('fieldName')} hint={t('hintName')}><input className="input" value={editing.draft.name} onChange={event => { patchDraft({ name: event.target.value }) }} /></Field>
            <Field label={t('fieldSource')} hint={t('hintSource')}><input className="input" value={editing.draft.source} onChange={event => { patchDraft({ source: event.target.value }) }} /></Field>
            <Field label={t('fieldSecret')} hint={editing.endpoint === null ? t('hintSecretRegister') : t('hintSecretEdit')}><input className="input" type="password" value={editing.draft.secret} onChange={event => { patchDraft({ secret: event.target.value }) }} /></Field>
            <Field label={t('fieldEvents')} hint={t('hintEvents')}><input className="input" value={editing.draft.events} onChange={event => { patchDraft({ events: event.target.value }) }} /></Field>
            <Field label={t('fieldActions')} hint={t('hintActions')}><input className="input" value={editing.draft.actions} onChange={event => { patchDraft({ actions: event.target.value }) }} /></Field>
            <Field label={t('fieldRepositories')} hint={t('hintRepositories')}><input className="input" value={editing.draft.repositories} onChange={event => { patchDraft({ repositories: event.target.value }) }} /></Field>
            <Field label={t('fieldTitleTemplate')} hint={t('hintTitleTemplate')}><input className="input" value={editing.draft.titleTemplate} onChange={event => { patchDraft({ titleTemplate: event.target.value }) }} /></Field>
            <Field label={t('fieldPromptTemplate')} hint={t('hintPromptTemplate')}><textarea className="input" rows={5} value={editing.draft.promptTemplate} onChange={event => { patchDraft({ promptTemplate: event.target.value }) }} /></Field>
            <Field label={t('fieldWorkspacePath')} hint={t('hintWorkspacePath')}><input className="input" value={editing.draft.workspacePath} onChange={event => { patchDraft({ workspacePath: event.target.value }) }} /></Field>
            <Field label={t('fieldAgentPreset')}><input className="input" value={editing.draft.agentPreset} onChange={event => { patchDraft({ agentPreset: event.target.value }) }} /></Field>
            <Field label={t('fieldPermissionPreset')}><input className="input" value={editing.draft.permissionPreset} onChange={event => { patchDraft({ permissionPreset: event.target.value }) }} /></Field>
            <Field label={t('fieldModelProvider')} hint={t('hintModelProvider')}><input className="input" value={editing.draft.modelProvider} onChange={event => { patchDraft({ modelProvider: event.target.value }) }} /></Field>
            <Field label={t('fieldModelId')}><input className="input" value={editing.draft.modelId} onChange={event => { patchDraft({ modelId: event.target.value }) }} /></Field>
            <Field label={t('fieldModelMaxTokens')}><input className="input" inputMode="numeric" value={editing.draft.modelMaxTokens} onChange={event => { patchDraft({ modelMaxTokens: event.target.value }) }} /></Field>
            <Field label={t('fieldExecutionUser')} hint={t('hintExecutionUser')}>
              <select className="input" value={editing.draft.executionUserId} onChange={event => { patchDraft({ executionUserId: event.target.value }) }}>
                <option value="">{t('optionSelectAccount')}</option>
                {users.filter(user => user.active).map(user => <option key={user.id} value={String(user.id)}>{user.username}</option>)}
              </select>
            </Field>
            <Field label={t('fieldRuntimeKind')}>
              <select className="input" value={editing.draft.runtimeKind} onChange={event => { patchDraft({ runtimeKind: event.target.value === 'project' ? 'project' : 'user', runtimePublicId: '' }) }}>
                <option value="user">{t('optionRuntimeUser')}</option>
                <option value="project">{t('optionRuntimeProject')}</option>
              </select>
            </Field>
            {editing.draft.runtimeKind === 'project' && (
              <Field label={t('fieldRuntimeTarget')} hint={t('hintRuntimeTarget')}>
                <select className="input" value={editing.draft.runtimePublicId} onChange={event => { patchDraft({ runtimePublicId: event.target.value }) }}>
                  <option value="">{t('optionSelectTarget')}</option>
                  {projects.map(project => <option key={project.id} value={String(project.id)}>{project.name}</option>)}
                </select>
              </Field>
            )}
            {editing.draft.runtimeKind === 'project' && (
              <Field label={t('fieldVisibility')} hint={t('hintVisibility')}>
                <select className="input" value={editing.draft.projectVisibility} onChange={event => { patchDraft({ projectVisibility: event.target.value === 'private' ? 'private' : 'project' }) }}>
                  <option value="project">{t('optionVisibilityProject')}</option>
                  <option value="private">{t('optionVisibilityPrivate')}</option>
                </select>
              </Field>
            )}
            <Field label={t('fieldIntakeLimit')} hint={t('hintIntakeLimit')}><input className="input" inputMode="numeric" value={editing.draft.intakeLimit} onChange={event => { patchDraft({ intakeLimit: event.target.value }) }} /></Field>
            <Field label={t('fieldIntakeWindowMs')}><input className="input" inputMode="numeric" value={editing.draft.intakeWindowMs} onChange={event => { patchDraft({ intakeWindowMs: event.target.value }) }} /></Field>
            <Field label={t('fieldReplayWindowMs')} hint={t('hintReplayWindow')}><input className="input" inputMode="numeric" value={editing.draft.replayWindowMs} onChange={event => { patchDraft({ replayWindowMs: event.target.value }) }} /></Field>
            <Field label={t('fieldMaxBodyBytes')}><input className="input" inputMode="numeric" value={editing.draft.maxBodyBytes} onChange={event => { patchDraft({ maxBodyBytes: event.target.value }) }} /></Field>
          </div>
        )}
      </Dialog>
      <Dialog
        open={deliveries !== null}
        title={deliveries === null ? '' : t('deliveriesTitle', { name: deliveries.endpoint.name })}
        description={t('deliveriesDescription')}
        onClose={() => { if (!acting) setDeliveries(null) }}
        wide
      >
        {deliveries === null ? null : deliveries.items.length === 0 ? (
          <EmptyState title={t('deliveriesEmpty')} />
        ) : (
          <>
            <div className="tableWrap" role="region" aria-label={t('deliveriesTableAria')} tabIndex={0}>
              <table className="dataTable">
                <thead><tr><th>{t('columnDeliveryId')}</th><th>{t('columnRevision')}</th><th>{t('columnStatus')}</th><th>{t('columnSession')}</th><th>{t('columnReceivedAt')}</th><th>{t('columnActions')}</th></tr></thead>
                <tbody>
                  {deliveries.items.map(receipt => (
                    <tr key={receipt.id}>
                      <td><code>{receipt.deliveryId}</code></td>
                      <td>{receipt.configurationRevision}</td>
                      <td><StatusBadge tone={RECEIPT_TONE[receipt.state]}>{t(RECEIPT_LABEL[receipt.state])}{receipt.errorCode === null ? '' : t('parenthesized', { value: receipt.errorCode })}</StatusBadge></td>
                      <td>{receipt.sessionId === null ? '—' : <code>{receipt.sessionId}</code>}</td>
                      <td>{new Date(receipt.receivedAt).toLocaleString()}</td>
                      <td>
                        {receipt.state === 'submitted' || receipt.state === 'ignored' || receipt.state === 'rejected'
                          ? <Button variant="ghost" onClick={() => void redispatch(receipt)} disabled={acting}>{t('redispatch')}</Button>
                          : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {deliveries.nextCursor === null ? null : <Button onClick={() => void moreDeliveries()} disabled={acting}>{t('loadMore')}</Button>}
          </>
        )}
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        title={removing === null ? '' : t('deleteTitle', { name: removing.name })}
        description={t('deleteDescription')}
        confirmLabel={t('delete')}
        pending={acting}
        onConfirm={() => void remove()}
        onClose={() => { if (!acting) setRemoving(null) }}
      />
    </>
  )
}
