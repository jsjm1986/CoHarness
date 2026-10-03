/** Per-user qualification card: reads and writes one resource policy for a fixed account. */
import { useEffect, useRef, useState } from 'react'
import type { AdminResourcePolicy } from '../api.ts'
import { Button, ErrorBanner, StatusBadge, Switch } from './ui.tsx'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : '无法更新授权'

export function UserQualificationCard({ name, description, userId, read, write }: {
  name: string
  description: string
  userId: number
  read: (kind: AdminResourcePolicy['kind'], id: number, signal?: AbortSignal) => Promise<AdminResourcePolicy>
  write: (policy: AdminResourcePolicy) => Promise<AdminResourcePolicy>
}) {
  const [policy, setPolicy] = useState<AdminResourcePolicy | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const attempt = ++generation.current
    const controller = new AbortController()
    setLoading(true)
    void read('user', userId, controller.signal).then((value) => {
      if (attempt !== generation.current) return
      setPolicy(value); setEnabled(value.enabled); setError('')
    }).catch((cause: unknown) => {
      if (attempt === generation.current) { setPolicy(null); setError(messageOf(cause)) }
    }).finally(() => { if (attempt === generation.current) setLoading(false) })
    return () => { generation.current++; controller.abort() }
  }, [userId, reload, read])

  async function save(): Promise<void> {
    if (policy === null || saving || loading) return
    const attempt = generation.current
    setSaving(true); setError(''); setNotice('')
    try {
      const result = await write({ ...policy, enabled })
      if (attempt !== generation.current) return
      setPolicy(result); setEnabled(result.enabled)
      setNotice(result.enabled ? '已授予资格。' : '资格已撤销，已通知运行中的会话重新核验。')
    } catch (cause) {
      if (attempt === generation.current) { setPolicy(null); setError(`${messageOf(cause)}。请重新读取当前授权。`) }
    } finally { if (attempt === generation.current) setSaving(false) }
  }

  return (
    <div className="qualificationCard">
      <div className="qualificationHead">
        <strong>{name}</strong>
        {policy === null ? null : <StatusBadge tone={policy.enabled ? 'success' : 'neutral'}>{policy.enabled ? '已授予' : '未授予'}</StatusBadge>}
      </div>
      <p className="muted">{description}</p>
      <ErrorBanner message={error} />
      {loading ? <p className="muted">正在读取{name}授权…</p> : policy === null ? (
        <Button type="button" variant="secondary" onClick={() => setReload(value => value + 1)}>重新读取授权</Button>
      ) : (
        <>
          <Switch checked={enabled} disabled={saving} onChange={setEnabled} label={`授予此用户${name}资格`} />
          <p className="muted">{policy.revision === '0' ? '来源：默认拒绝' : `来源：管理员设置 · 版本 ${policy.revision}`}</p>
          <Button type="button" disabled={saving || enabled === policy.enabled} onClick={() => void save()}>{saving ? '正在保存' : `保存${name}授权`}</Button>
        </>
      )}
      {notice === '' ? null : <p role="status">{notice}</p>}
    </div>
  )
}
