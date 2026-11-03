/** Account qualification and the independent project grant share optimistic revision checks. */
import { usePendingEdits, useProtectedNavigation } from '../pending-edits.tsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { listProjects, listUsers, type AdminResourcePolicy } from '../api.ts'
import { Button, ErrorBanner, Field, LoadingState, Section, Switch } from './ui.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './resource-permissions.copy.ts'

type Owner = Pick<AdminResourcePolicy, 'kind' | 'id'> & { label: string }
const keyOf = (owner: Owner): string => `${owner.kind}:${String(owner.id)}`
const messageOf = (error: unknown): string => error instanceof Error ? error.message : translateCopy(adminLanguage(), { zh, en })('updateFailed')

/** Project metadata owned by the current page, with its loading and retry lifecycle. */
export interface ResourcePermissionProjects {
  readonly items: ReadonlyArray<{ id: number; name: string }>
  readonly loading: boolean
  readonly error: string
  /** Read another snapshot through the same page owner. */
  readonly reload: () => void
}

/** Shared optimistic editor; each resource owns its decisions and explanation. */
export function ResourcePermissions({ name, description, saved, read, write, kinds = ['user', 'project'], owner, projects }: {
  name: string
  description: string
  saved: string
  read: (kind: AdminResourcePolicy['kind'], id: number, signal?: AbortSignal) => Promise<AdminResourcePolicy>
  write: (policy: AdminResourcePolicy) => Promise<AdminResourcePolicy>
  /** Subject kinds offered by the picker; user-scoped grants live on the user detail page. */
  kinds?: ReadonlyArray<AdminResourcePolicy['kind']>
  /** Fixed subject on a detail page; the picker is skipped. */
  owner?: Pick<AdminResourcePolicy, 'kind' | 'id'>
  /** Shared page metadata; omission retains an independent project-list read. */
  projects?: ResourcePermissionProjects
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [owners, setOwners] = useState<Owner[]>([])
  const [selected, setSelected] = useState('')
  const [policy, setPolicy] = useState<AdminResourcePolicy | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [loadingOwners, setLoadingOwners] = useState(true)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const navigation = useProtectedNavigation()
  const [notice, setNotice] = useState('')
  usePendingEdits(saving || policy !== null && enabled !== policy.enabled)
  const generation = useRef(0)
  const [reload, setReload] = useState(0)
  const [ownerReload, setOwnerReload] = useState(0)

  const allowUser = kinds.includes('user')
  const allowProject = kinds.includes('project')
  const fixedKind = owner?.kind
  const fixedId = owner?.id
  const projectItems = fixedKind === undefined ? projects?.items : undefined
  const sharedProjects = projectItems !== undefined
  const ownersLoading = loadingOwners || (sharedProjects && projects?.loading === true)
  const ownersError = sharedProjects ? projects?.error ?? '' : ''
  const availableOwners = useMemo(() => projectItems === undefined ? owners : [
    ...allowUser ? owners.filter(owner => owner.kind === 'user') : [],
    ...allowProject ? projectItems.map(project => ({ kind: 'project' as const, id: project.id, label: t('ownerProject', { name: project.name }) })) : [],
  ], [projectItems, owners, allowUser, allowProject, t])

  useEffect(() => {
    let disposed = false
    if (fixedKind !== undefined && fixedId !== undefined) {
      setOwners([{ kind: fixedKind, id: fixedId, label: '' }])
      setSelected(`${fixedKind}:${String(fixedId)}`)
      setLoadingOwners(false)
      return
    }
    if (sharedProjects && !allowUser) {
      setLoadingOwners(false)
      return
    }
    setLoadingOwners(true)
    void Promise.all([
      allowUser ? listUsers() : Promise.resolve([]),
      allowProject && !sharedProjects ? listProjects() : Promise.resolve([]),
    ]).then(([users, projects]) => {
      if (disposed) return
      setError('')
      setOwners([
        ...users.map(user => ({ kind: 'user' as const, id: user.id, label: t('ownerUser', { name: user.displayName, username: user.username }) })),
        ...projects.map(project => ({ kind: 'project' as const, id: project.id, label: t('ownerProject', { name: project.name }) })),
      ])
    }).catch((cause: unknown) => { if (!disposed) setError(messageOf(cause)) })
      .finally(() => { if (!disposed) setLoadingOwners(false) })
    return () => { disposed = true; generation.current++ }
  }, [ownerReload, allowUser, allowProject, t, fixedKind, fixedId, sharedProjects])

  useEffect(() => {
    const owner = availableOwners.find(item => keyOf(item) === selected)
    setSaving(false)
    if (owner === undefined || ownersLoading || ownersError !== '') {
      setPolicy(null); setLoading(false)
      if (owner === undefined && !ownersLoading && ownersError === '') setSelected('')
      return
    }
    const attempt = ++generation.current
    const controller = new AbortController()
    setLoading(true)
    void read(owner.kind, owner.id, controller.signal).then((value) => {
      if (attempt !== generation.current) return
      setPolicy(value); setEnabled(value.enabled); setError('')
    }).catch((cause: unknown) => {
      if (attempt === generation.current) { setPolicy(null); setError(messageOf(cause)) }
    }).finally(() => { if (attempt === generation.current) setLoading(false) })
    return () => { generation.current++; controller.abort() }
  }, [availableOwners, selected, reload, read, ownersLoading, ownersError])

  async function save(): Promise<void> {
    if (policy === null || `${policy.kind}:${String(policy.id)}` !== selected || saving || loading || ownersLoading || ownersError !== '') return
    const attempt = generation.current
    setSaving(true); setError(''); setNotice('')
    try {
      const result = await write({ ...policy, enabled })
      if (attempt !== generation.current) return
      setPolicy(result); setEnabled(result.enabled)
      setNotice(result.enabled ? saved : t('noticeRevoked'))
    } catch (cause) {
      if (attempt === generation.current) { setPolicy(null); setError(t('errorReread', { error: messageOf(cause) })) }
    } finally { if (attempt === generation.current) setSaving(false) }
  }

  return <Section title={allowUser ? t('titleUser', { name }) : t('titleProject', { name })}>
    <p className="muted">{description}</p>
    {allowUser ? null : <p className="muted">{t('projectOnlyHint', { name })}</p>}
    <ErrorBanner message={ownersError || error} />
    {owner !== undefined ? null : ownersLoading ? <LoadingState label={t('loadingOwners')} /> : <Field label={t('ownerField')}>
      <select className="select" aria-label={t('ownerAria', { name })} value={selected} disabled={saving} onChange={(event) => {
        if (!navigation.canReplace()) return
        generation.current++; setPolicy(null); setLoading(false); setNotice(''); setError(''); setSelected(event.target.value)
      }}>
        <option value="">{allowUser ? t('ownerPlaceholderUser') : t('ownerPlaceholderProject')}</option>
        {availableOwners.map(owner => <option key={keyOf(owner)} value={keyOf(owner)}>{owner.label}</option>)}
      </select>
    </Field>}
    {!ownersLoading && (availableOwners.length === 0 || ownersError !== '') ? <Button type="button" variant="secondary" onClick={() => {
      if (sharedProjects) projects?.reload()
      else setOwnerReload(value => value + 1)
    }}>{t('ownersReload')}</Button> : null}
    <div className="formSectionSpacing">
    {loading ? <LoadingState label={t('loadingPolicy', { name })} /> : policy === null ? null : <div>
      <Switch checked={enabled} disabled={saving} onChange={setEnabled}
        label={policy.kind === 'user' ? t('grantUserLabel', { name }) : t('grantProjectLabel', { name })} />
      <p className="muted">{policy.revision === '0' ? t('sourceDefault') : t('sourceAdmin', { revision: policy.revision })}</p>
      <Button type="button" disabled={saving || enabled === policy.enabled} onClick={() => void save()}>{saving ? t('saving') : t('saveLabel', { name })}</Button>
    </div>}
    {selected === '' ? null : <Button type="button" variant="secondary" disabled={saving || loading} onClick={() => {
      setPolicy(null); setNotice(''); setReload(value => value + 1)
    }}>{t('reread')}</Button>}
    {notice === '' ? null : <p role="status">{notice}</p>}
    </div>
  </Section>
}
