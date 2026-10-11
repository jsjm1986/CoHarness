/** Per-user qualification card: reads and writes one resource policy for a fixed account. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdminResourcePolicy } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { Button, ErrorBanner, StatusBadge, Switch } from './ui.tsx'
import { zh, en } from './user-qualification-card.copy.ts'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : translateCopy(adminLanguage(), { zh, en })('updateFailed')

export function UserQualificationCard({ name, description, userId, read, write, ineligible }: {
  name: string
  description: string
  userId: number
  read: (kind: AdminResourcePolicy['kind'], id: number, signal?: AbortSignal) => Promise<AdminResourcePolicy>
  write: (policy: AdminResourcePolicy) => Promise<AdminResourcePolicy>
  /**
   * Why this account cannot hold the qualification right now. While set the
   * grant switch stays disabled; an already-enabled row still offers a revoke
   * action so a stale grant can be cleared.
   */
  ineligible?: string
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
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

  async function save(nextEnabled = enabled): Promise<void> {
    if (policy === null || saving || loading) return
    const attempt = generation.current
    setSaving(true); setError(''); setNotice('')
    try {
      const result = await write({ ...policy, enabled: nextEnabled })
      if (attempt !== generation.current) return
      setPolicy(result); setEnabled(result.enabled)
      setNotice(result.enabled ? t('noticeGranted') : t('noticeRevoked'))
    } catch (cause) {
      if (attempt === generation.current) { setPolicy(null); setError(t('errorReread', { error: messageOf(cause) })) }
    } finally { if (attempt === generation.current) setSaving(false) }
  }

  return (
    <div className="qualificationCard">
      <div className="qualificationHead">
        <strong>{name}</strong>
        {policy === null ? null : ineligible !== undefined ? (
          <StatusBadge tone={policy.enabled ? 'warning' : 'neutral'}>{policy.enabled ? t('staleGrant') : t('notGrantable')}</StatusBadge>
        ) : <StatusBadge tone={policy.enabled ? 'success' : 'neutral'}>{policy.enabled ? t('granted') : t('notGranted')}</StatusBadge>}
      </div>
      <p className="muted">{description}</p>
      <ErrorBanner message={error} />
      {loading ? <p className="muted">{t('loadingPolicy', { name })}</p> : policy === null ? (
        <Button type="button" variant="secondary" onClick={() => setReload(value => value + 1)}>{t('reread')}</Button>
      ) : (
        <>
          <Switch checked={enabled} disabled={saving || ineligible !== undefined} onChange={setEnabled} label={t('grantLabel', { name })} />
          {ineligible === undefined ? null : <p className="muted">{ineligible}</p>}
          <p className="muted">{policy.revision === '0' ? t('sourceDefault') : t('sourceAdmin', { revision: policy.revision })}</p>
          {ineligible === undefined
            ? <Button type="button" disabled={saving || enabled === policy.enabled} onClick={() => void save()}>{saving ? t('saving') : t('saveLabel', { name })}</Button>
            : policy.enabled
              ? <Button type="button" variant="secondary" disabled={saving} onClick={() => void save(false)}>{saving ? t('saving') : t('revokeStale')}</Button>
              : null}
        </>
      )}
      {notice === '' ? null : <p role="status">{notice}</p>}
    </div>
  )
}
