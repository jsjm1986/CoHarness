/** Account qualification and the independent project grant share optimistic revision checks. */
import { useEffect, useRef, useState } from 'react'
import { listProjects, listUsers, type AdminResourcePolicy } from '../api.ts'
import { Button, ErrorBanner, Field, LoadingState, Section, Switch } from './ui.tsx'

type Owner = Pick<AdminResourcePolicy, 'kind' | 'id'> & { label: string }
const keyOf = (owner: Owner): string => `${owner.kind}:${String(owner.id)}`
const messageOf = (error: unknown): string => error instanceof Error ? error.message : '无法更新授权'

/** Shared optimistic editor; each resource owns its decisions and explanation. */
export function ResourcePermissions({ name, description, saved, read, write }: {
  name: string
  description: string
  saved: string
  read: (kind: AdminResourcePolicy['kind'], id: number, signal?: AbortSignal) => Promise<AdminResourcePolicy>
  write: (policy: AdminResourcePolicy) => Promise<AdminResourcePolicy>
}) {
  const [owners, setOwners] = useState<Owner[]>([])
  const [selected, setSelected] = useState('')
  const [policy, setPolicy] = useState<AdminResourcePolicy | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [loadingOwners, setLoadingOwners] = useState(true)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const [reload, setReload] = useState(0)
  const [ownerReload, setOwnerReload] = useState(0)

  useEffect(() => {
    let disposed = false
    setLoadingOwners(true)
    void Promise.all([listUsers(), listProjects()]).then(([users, projects]) => {
      if (disposed) return
      setError('')
      setOwners([
        ...users.map(user => ({ kind: 'user' as const, id: user.id, label: `用户 · ${user.displayName} (@${user.username})` })),
        ...projects.map(project => ({ kind: 'project' as const, id: project.id, label: `项目 · ${project.name}` })),
      ])
    }).catch((cause: unknown) => { if (!disposed) setError(messageOf(cause)) })
      .finally(() => { if (!disposed) setLoadingOwners(false) })
    return () => { disposed = true; generation.current++ }
  }, [ownerReload])

  useEffect(() => {
    const owner = owners.find(item => keyOf(item) === selected)
    if (owner === undefined) return
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
  }, [owners, selected, reload, read])

  async function save(): Promise<void> {
    if (policy === null || `${policy.kind}:${String(policy.id)}` !== selected || saving || loading) return
    const attempt = generation.current
    setSaving(true); setError(''); setNotice('')
    try {
      const result = await write({ ...policy, enabled })
      if (attempt !== generation.current) return
      setPolicy(result); setEnabled(result.enabled)
      setNotice(result.enabled ? saved : '准入资格已撤销，已通知运行中的会话重新核验。')
    } catch (cause) {
      if (attempt === generation.current) { setPolicy(null); setError(`${messageOf(cause)}。请重新读取当前授权。`) }
    } finally { if (attempt === generation.current) setSaving(false) }
  }

  return <Section title={`${name}准入资格`}>
    <div className="sectionBody">
    <p className="muted">{description}</p>
    <ErrorBanner message={error} />
    {loadingOwners ? <LoadingState label="正在加载授权对象" /> : <Field label="授权对象">
      <select className="select" aria-label={`${name}授权对象`} value={selected} disabled={saving} onChange={(event) => {
        generation.current++; setPolicy(null); setLoading(false); setNotice(''); setError(''); setSelected(event.target.value)
      }}>
        <option value="">请选择用户或项目</option>
        {owners.map(owner => <option key={keyOf(owner)} value={keyOf(owner)}>{owner.label}</option>)}
      </select>
    </Field>}
    {!loadingOwners && owners.length === 0 ? <Button type="button" variant="secondary" onClick={() => setOwnerReload(value => value + 1)}>重新加载授权对象</Button> : null}
    <div className="formSectionSpacing">
    {loading ? <LoadingState label={`正在读取${name}授权`} /> : policy === null ? null : <div>
      <Switch checked={enabled} disabled={saving} onChange={setEnabled}
        label={policy.kind === 'user' ? `授予此用户${name}资格` : `允许此项目使用${name}`} />
      <p className="muted">{policy.revision === '0' ? '来源：默认拒绝' : `来源：管理员设置 · 版本 ${policy.revision}`}；保存后按当前权限核验，不改变模型权限模式。</p>
      <Button type="button" disabled={saving || enabled === policy.enabled} onClick={() => void save()}>{saving ? '正在保存' : `保存${name}授权`}</Button>
    </div>}
    {selected === '' ? null : <Button type="button" variant="secondary" disabled={saving || loading} onClick={() => {
      setPolicy(null); setNotice(''); setReload(value => value + 1)
    }}>重新读取授权</Button>}
    {notice === '' ? null : <p role="status">{notice}</p>}
    </div>
    </div>
  </Section>
}
