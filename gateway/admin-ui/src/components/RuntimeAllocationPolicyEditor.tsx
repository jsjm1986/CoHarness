/** Revision-checked Runtime allocation limits for the organization or one account. */
import { useDeploymentContext } from '../deployment-context.tsx'
import { usePendingEdits } from '../pending-edits.tsx'
import { useEffect, useId, useMemo, useState } from 'react'
import { getRuntimeAllocationPolicy, saveRuntimeAllocationPolicy, type RuntimeAllocationPolicy } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from '../runtime.copy.ts'
import { Button, ErrorBanner, Field, LoadingState } from './ui.tsx'

/** @param props - optional account override; omission edits the organization's defaults. @returns existing form primitives with optimistic conflict handling. */
export function RuntimeAllocationPolicyEditor({ userId }: { userId?: number }) {
  const showComputer = useDeploymentContext().value?.mode === 'multi'
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [policy, setPolicy] = useState<RuntimeAllocationPolicy>()
  const [total, setTotal] = useState(''), [perNode, setPerNode] = useState('')
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<'save' | 'inherit'>()
  const busy = pending !== undefined
  const [error, setError] = useState('')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [notice, setNotice] = useState('')
  const validationId = useId()
  useEffect(() => {
    const controller = new AbortController(); setLoading(true)
    void getRuntimeAllocationPolicy(userId, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setPolicy(value); setTotal(String(value.maxTotal)); setPerNode(String(value.maxPerNode)); setError(''); setNeedsRefresh(false)
    }).catch((cause: unknown) => { if (!controller.signal.aborted) { setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t('limitsReadFailed')); setNeedsRefresh(true) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [userId, refresh, t])
  const limits = { maxTotal: Number(total), maxPerNode: Number(perNode) }
  const valid = Number.isSafeInteger(limits.maxTotal) && Number.isSafeInteger(limits.maxPerNode) && limits.maxTotal > 0 && limits.maxPerNode > 0 && limits.maxPerNode <= limits.maxTotal
  async function save(inherit: boolean): Promise<void> {
    if (policy === undefined || busy || loading || needsRefresh || !inherit && !valid) return
    setPending(inherit ? 'inherit' : 'save'); setError(''); setNotice('')
    try { await saveRuntimeAllocationPolicy(userId, policy.revision, inherit ? null : limits); setNeedsRefresh(true); setRefresh(value => value + 1); setNotice(t('limitsSaved')) }
    catch (cause) { setNeedsRefresh(true); setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t('saveUnconfirmed')) }
    finally { setPending(undefined) }
  }
  usePendingEdits(policy !== undefined && (total !== String(policy.maxTotal) || perNode !== String(policy.maxPerNode)) || busy)
  const disabled = busy || loading || needsRefresh
  return <div className="runtimePolicy" aria-busy={busy || loading}><ErrorBanner message={error} />
    {loading && policy === undefined ? <LoadingState label={t('loadingLimits')} /> : null}
    {policy === undefined ? null : <div className="formGrid">
      <Field label={t('total')}><input className="input" type="number" min="1" step="1" value={total} disabled={disabled} aria-invalid={!valid} aria-describedby={validationId} onChange={event => { setTotal(event.currentTarget.value); setNotice('') }} /></Field>
      <Field label={t(showComputer ? 'perNode' : 'localPerNode')}><input className="input" type="number" min="1" step="1" value={perNode} disabled={disabled} aria-invalid={!valid} aria-describedby={validationId} onChange={event => { setPerNode(event.currentTarget.value); setNotice('') }} /></Field>
    </div>}
    <p className="fieldHint" id={validationId} role="status">{!valid && policy !== undefined ? t(showComputer ? 'invalid' : 'localInvalid') : notice || '\u00a0'}</p>
    <div className="formActions runtimePolicyActions">
      {policy === undefined ? null : <><span className="muted">{t(userId === undefined ? 'organizationDefaults' : policy.source === 'organization' ? 'inherited' : 'override')}</span>
        <Button variant="primary" loading={pending === 'save'} disabled={disabled || !valid} onClick={() => { void save(false) }}>{t('save')}</Button>
        {userId === undefined ? null : <Button loading={pending === 'inherit'} disabled={disabled || policy.source === 'organization'} onClick={() => { void save(true) }}>{t('restore')}</Button>}</>}
      <Button loading={loading} disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t('refreshLimits')}</Button>
    </div>
  </div>
}
