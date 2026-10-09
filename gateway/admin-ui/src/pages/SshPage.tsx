/** Registered SSH targets, project sharing, and account qualification. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pencil, Plus, RefreshCw, Share2, Trash2 } from 'lucide-react'
import {
  createSshTarget, listProjects, listSshTargets, mutateSshTarget, shareSshTarget, updateSshTarget,
  type AdminSshTarget, type AdminSshTargetFields,
} from '../api.ts'
import {
  Button, ConfirmDialog, Dialog, EmptyState, ErrorBanner, Field, IconButton, LoadingState,
  PageHeader, Section, StatusBadge, Switch,
} from '../components/ui.tsx'
import { SshPermissions } from '../components/SshPermissions.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as sshZh, en as sshEn } from './ssh.copy.ts'

const sshCopy = () => translateCopy(adminLanguage(), { zh: sshZh, en: sshEn })
const messageOf = (error: unknown): string => error instanceof Error ? error.message : sshCopy()('operationFailed')
const HASH_PATTERN = /^[0-9a-f]{64}$/u

interface TargetDraft {
  name: string
  host: string
  node: string
  helper: string
  helperHash: string
  workspace: string
  bootstrapPath: string
  bootstrapHash: string
  passwordRef: string
  requestTimeoutMs: string
  maxFrameBytes: string
  maxPending: string
  leaseMs: string
}

const EMPTY_DRAFT: TargetDraft = {
  name: '', host: '', node: '', helper: '', helperHash: '', workspace: '',
  bootstrapPath: '', bootstrapHash: '', passwordRef: '', requestTimeoutMs: '', maxFrameBytes: '', maxPending: '', leaseMs: '',
}

function draftOf(target: AdminSshTarget): TargetDraft {
  return {
    name: target.name, host: target.host, node: target.node, helper: target.helper,
    helperHash: target.helperHash, workspace: target.workspace,
    bootstrapPath: target.bootstrapPath ?? '', bootstrapHash: target.bootstrapHash ?? '',
    passwordRef: target.passwordRef ?? '',
    requestTimeoutMs: target.requestTimeoutMs === null ? '' : String(target.requestTimeoutMs),
    maxFrameBytes: target.maxFrameBytes === null ? '' : String(target.maxFrameBytes),
    maxPending: target.maxPending === null ? '' : String(target.maxPending),
    leaseMs: target.leaseMs === null ? '' : String(target.leaseMs),
  }
}

const text = (value: string) => value.trim() === '' ? null : value.trim()
const limit = (value: string, label: string, max: number, min = 1) => {
  if (value.trim() === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(sshCopy()('errorIntegerRange', { label, min: String(min), max: String(max) }))
  }
  return parsed
}
const boundedText = (value: string, label: string, max: number): string => {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(sshCopy()('errorRequired', { label }))
  if (trimmed.length > max) throw new Error(sshCopy()('errorTooLong', { label, max: String(max) }))
  return trimmed
}
const absolutePath = (value: string, label: string): string => {
  const trimmed = boundedText(value, label, 1024)
  if (!trimmed.startsWith('/')) throw new Error(sshCopy()('errorAbsolutePath', { label }))
  return trimmed
}
const HOST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/u

function fieldsOf(draft: TargetDraft): AdminSshTargetFields {
  const t = sshCopy()
  const bootstrapPath = text(draft.bootstrapPath)
  const bootstrapHash = text(draft.bootstrapHash)
  const passwordRef = text(draft.passwordRef)
  if ((bootstrapPath === null) !== (bootstrapHash === null)) throw new Error(t('errorBootstrapPair'))
  if (bootstrapPath !== null && (!bootstrapPath.startsWith('/') || bootstrapPath.length > 1024)) {
    throw new Error(t('errorBootstrapPath'))
  }
  const host = boundedText(draft.host, t('labelHostAlias'), 256)
  if (!HOST_PATTERN.test(host)) throw new Error(t('errorHostAlias'))
  if (!HASH_PATTERN.test(draft.helperHash.trim())) throw new Error(t('errorHelperHash'))
  if (bootstrapHash !== null && !HASH_PATTERN.test(bootstrapHash)) throw new Error(t('errorBootstrapHash'))
  if (passwordRef !== null && !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(passwordRef)) {
    throw new Error(t('errorPasswordRef'))
  }
  return {
    name: boundedText(draft.name, t('labelName'), 128), host,
    node: absolutePath(draft.node, t('labelNode')),
    helper: absolutePath(draft.helper, t('labelHelper')),
    helperHash: draft.helperHash.trim(), workspace: absolutePath(draft.workspace, t('labelWorkspace')),
    bootstrapPath, bootstrapHash, passwordRef,
    requestTimeoutMs: limit(draft.requestTimeoutMs, t('labelRequestTimeout'), 2_147_483_647),
    maxFrameBytes: limit(draft.maxFrameBytes, t('labelMaxFrame'), 67_108_864),
    maxPending: limit(draft.maxPending, t('labelMaxPending'), 128),
    leaseMs: limit(draft.leaseMs, t('labelLease'), 600_000, 3_000),
  }
}

export function SshPage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: sshZh, en: sshEn }), [])
  const [targets, setTargets] = useState<AdminSshTarget[] | null>(null)
  const [projects, setProjects] = useState<Array<{ id: number; name: string }>>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<{ target: AdminSshTarget | null; draft: TargetDraft } | null>(null)
  const [removing, setRemoving] = useState<AdminSshTarget | null>(null)
  const [sharing, setSharing] = useState<AdminSshTarget | null>(null)
  const [acting, setActing] = useState(false)
  const [reload, setReload] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    let disposed = false
    void Promise.all([listSshTargets(), listProjects()]).then(([ssh, projectRows]) => {
      if (disposed) return
      setTargets(ssh.targets)
      setProjects(projectRows.map(project => ({ id: project.id, name: project.name })))
      setError('')
    }).catch((cause: unknown) => { if (!disposed) setError(messageOf(cause)) })
    return () => { disposed = true; generation.current++ }
  }, [reload])

  const refresh = () => { setReload(value => value + 1) }
  const patchDraft = (patch: Partial<TargetDraft>) => {
    setEditing(current => current === null ? current : { ...current, draft: { ...current.draft, ...patch } })
  }

  async function save(): Promise<void> {
    if (editing === null || acting) return
    const attempt = generation.current
    setActing(true); setError(''); setNotice('')
    try {
      const fields = fieldsOf(editing.draft)
      if (editing.target === null) await createSshTarget(fields)
      else await updateSshTarget(editing.target.publicId, editing.target.revision, fields)
      if (attempt !== generation.current) return
      setNotice(editing.target === null ? t('noticeCreated') : t('noticeUpdated'))
      setEditing(null); refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  async function toggle(target: AdminSshTarget): Promise<void> {
    if (acting) return
    const attempt = generation.current
    setActing(true); setError(''); setNotice('')
    try {
      await mutateSshTarget(target.publicId, target.revision, target.enabled ? 'disable' : 'enable')
      if (attempt !== generation.current) return
      setNotice(target.enabled ? t('noticeDisabled', { name: target.name }) : t('noticeEnabled', { name: target.name }))
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
      await mutateSshTarget(removing.publicId, removing.revision, 'remove')
      if (attempt !== generation.current) return
      setNotice(t('noticeRemoved', { name: removing.name })); setRemoving(null); refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  async function toggleShare(projectId: number, shared: boolean): Promise<void> {
    if (sharing === null || acting) return
    const attempt = generation.current
    setActing(true); setError('')
    try {
      const updated = await shareSshTarget(sharing.publicId, projectId, shared)
      if (attempt !== generation.current) return
      setSharing(updated); refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  return (
    <>
      <PageHeader title="SSH" description={t('pageDescription')} />
      {error === '' ? null : <ErrorBanner message={error} />}
      {notice === '' ? null : <p role="status">{notice}</p>}
      <Section
        flush
        title={t('sectionTargets')}
        actions={<>
          <IconButton label={t('refresh')} icon={RefreshCw} onClick={refresh} />
          <Button icon={Plus} onClick={() => { setEditing({ target: null, draft: EMPTY_DRAFT }) }}>{t('registerTarget')}</Button>
        </>}
      >
        {targets === null ? <LoadingState label={t('loading')} /> : targets.length === 0 ? (
          <EmptyState title={t('emptyTitle')} detail={t('emptyDetail')} />
        ) : (
          <div className="tableWrap" role="region" aria-label={t('tableAria')} tabIndex={0}>
            <table className="dataTable">
              <thead><tr><th>{t('labelName')}</th><th>{t('labelHostAlias')}</th><th>{t('columnWorkspace')}</th><th>{t('columnShared')}</th><th>{t('columnStatus')}</th><th>{t('columnActions')}</th></tr></thead>
              <tbody>
                {targets.map(target => (
                  <tr key={target.publicId}>
                    <td>{target.name}</td>
                    <td><code>{target.host}</code></td>
                    <td><code>{target.workspace}</code></td>
                    <td>{target.sharedProjects.length === 0 ? '—' : target.sharedProjects.map(id => projects.find(project => project.id === id)?.name ?? `#${String(id)}`).join(t('projectSeparator'))}</td>
                    <td><StatusBadge tone={target.enabled ? 'success' : 'neutral'}>{target.enabled ? t('statusEnabled') : t('statusDisabled')}</StatusBadge></td>
                    <td>
                      <IconButton label={t('edit')} icon={Pencil} onClick={() => { setEditing({ target, draft: draftOf(target) }) }} />
                      <IconButton label={t('shareAction')} icon={Share2} onClick={() => { setSharing(target) }} />
                      <Button variant="ghost" onClick={() => void toggle(target)} disabled={acting}>{target.enabled ? t('disable') : t('enable')}</Button>
                      <IconButton label={t('delete')} icon={Trash2} onClick={() => { setRemoving(target) }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <SshPermissions />
      <Dialog
        open={editing !== null}
        title={editing === null || editing.target === null ? t('titleRegister') : t('titleEdit', { name: editing.target.name })}
        description={t('editDescription')}
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
            <Field label={t('labelName')} hint={t('hintName')}><input className="input" value={editing.draft.name} onChange={event => { patchDraft({ name: event.target.value }) }} /></Field>
            <Field label={t('labelHostAlias')} hint={t('hintHostAlias')}><input className="input" value={editing.draft.host} onChange={event => { patchDraft({ host: event.target.value }) }} /></Field>
            <Field label={t('labelPasswordRef')} hint={t('hintPasswordRef')}><input className="input" autoComplete="off" value={editing.draft.passwordRef} onChange={event => { patchDraft({ passwordRef: event.target.value }) }} /></Field>
            <Field label={t('labelNode')} hint={t('hintAbsolutePath')}><input className="input" value={editing.draft.node} onChange={event => { patchDraft({ node: event.target.value }) }} /></Field>
            <Field label={t('labelHelper')} hint={t('hintHelper')}><input className="input" value={editing.draft.helper} onChange={event => { patchDraft({ helper: event.target.value }) }} /></Field>
            <Field label={t('labelHelperHash')} hint={t('hintHelperHash')}><input className="input" value={editing.draft.helperHash} onChange={event => { patchDraft({ helperHash: event.target.value }) }} /></Field>
            <Field label={t('labelWorkspace')} hint={t('hintAbsolutePath')}><input className="input" value={editing.draft.workspace} onChange={event => { patchDraft({ workspace: event.target.value }) }} /></Field>
            <Field label={t('labelBootstrapPath')} hint={t('hintBootstrapPath')}><input className="input" value={editing.draft.bootstrapPath} onChange={event => { patchDraft({ bootstrapPath: event.target.value }) }} /></Field>
            <Field label={t('labelBootstrapHash')} hint={t('hintBootstrapHash')}><input className="input" value={editing.draft.bootstrapHash} onChange={event => { patchDraft({ bootstrapHash: event.target.value }) }} /></Field>
            <Field label={t('labelRequestTimeoutMs')}><input className="input" inputMode="numeric" value={editing.draft.requestTimeoutMs} onChange={event => { patchDraft({ requestTimeoutMs: event.target.value }) }} /></Field>
            <Field label={t('labelMaxFrameBytes')}><input className="input" inputMode="numeric" value={editing.draft.maxFrameBytes} onChange={event => { patchDraft({ maxFrameBytes: event.target.value }) }} /></Field>
            <Field label={t('labelMaxPending')}><input className="input" inputMode="numeric" value={editing.draft.maxPending} onChange={event => { patchDraft({ maxPending: event.target.value }) }} /></Field>
            <Field label={t('labelLeaseMs')}><input className="input" inputMode="numeric" value={editing.draft.leaseMs} onChange={event => { patchDraft({ leaseMs: event.target.value }) }} /></Field>
          </div>
        )}
      </Dialog>
      <Dialog
        open={sharing !== null}
        title={sharing === null ? '' : t('titleShare', { name: sharing.name })}
        description={t('shareDescription')}
        onClose={() => { if (!acting) setSharing(null) }}
      >
        {sharing === null ? null : projects.length === 0 ? <EmptyState title={t('shareEmpty')} /> : (
          projects.map(project => (
            <Switch
              key={project.id}
              label={project.name}
              checked={sharing.sharedProjects.includes(project.id)}
              disabled={acting}
              onChange={(checked) => { void toggleShare(project.id, checked) }}
            />
          ))
        )}
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        title={removing === null ? '' : t('titleRemove', { name: removing.name })}
        description={t('removeDescription')}
        confirmLabel={t('delete')}
        pending={acting}
        onConfirm={() => void remove()}
        onClose={() => { if (!acting) setRemoving(null) }}
      />
    </>
  )
}
