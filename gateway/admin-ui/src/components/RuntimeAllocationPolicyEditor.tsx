/** Revision-checked Runtime allocation limits for the organization or one account. */
import { useDeploymentContext } from '../deployment-context.tsx'
import { usePendingEdits } from '../pending-edits.tsx'
import { useEffect, useId, useMemo, useState } from 'react'
import { getRuntimeAllocationPolicy, saveRuntimeAllocationPolicy, type RuntimeAllocationPolicy } from '../api.ts'
import { unwrapDeploymentOverviewSlice, useDeploymentOverview } from '../deployment-overview.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from '../runtime.copy.ts'
import { Button, ErrorBanner, Field, LoadingState } from './ui.tsx'

type LimitsDraft = { revision: string; total?: string; perNode?: string }

function changedLimit(value: string | undefined, baseline: number): string | undefined {
  return value === undefined || Number(value) === baseline ? undefined : value
}

/** @param props - optional account override; omission edits the organization's defaults. @returns existing form primitives with optimistic conflict handling. */
export function RuntimeAllocationPolicyEditor({ userId }: { userId?: number }) {
  const showComputer = useDeploymentContext().value?.mode === 'multi'
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [policy, setPolicy] = useState<RuntimeAllocationPolicy>()
  const [draft, setDraft] = useState<LimitsDraft>()
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<'save' | 'inherit'>()
  const busy = pending !== undefined
  const [error, setError] = useState('')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [notice, setNotice] = useState('')
  const overview = useDeploymentOverview()
  const includedInOverview = userId === undefined && refresh === 0 && overview?.requested.has('runtimeAllocationPolicy') === true
  const waitingForOverview = includedInOverview && overview?.status === 'loading'
  const overviewPolicy = includedInOverview && overview?.status === 'ready' ? overview.sections?.runtimeAllocationPolicy : undefined
  const validationId = useId()
  useEffect(() => { setDraft(undefined) }, [userId])
  useEffect(() => {
    setLoading(true)
    if (waitingForOverview) return
    const controller = new AbortController()
    const read = overviewPolicy === undefined ? getRuntimeAllocationPolicy(userId, controller.signal)
      : Promise.resolve().then(() => unwrapDeploymentOverviewSlice(overviewPolicy))
    void read.then(value => {
      if (controller.signal.aborted) return
      setPolicy(value); setError(''); setNeedsRefresh(false)
      if (refresh > 0) setDraft(current => {
        if (current === undefined) return undefined
        const next = {
          revision: value.revision,
          total: changedLimit(current.total, value.maxTotal),
          perNode: changedLimit(current.perNode, value.maxPerNode),
        }
        return next.total === undefined && next.perNode === undefined ? undefined : next
      })
    }).catch((cause: unknown) => { if (!controller.signal.aborted) { setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t('limitsReadFailed')); setNeedsRefresh(true) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [userId, refresh, overviewPolicy, waitingForOverview, t])
  const total = draft?.total ?? (policy === undefined ? '' : String(policy.maxTotal))
  const perNode = draft?.perNode ?? (policy === undefined ? '' : String(policy.maxPerNode))
  const staleDraft = draft !== undefined && policy !== undefined && draft.revision !== policy.revision
  const limits = { maxTotal: Number(total), maxPerNode: Number(perNode) }
  const valid = Number.isSafeInteger(limits.maxTotal) && Number.isSafeInteger(limits.maxPerNode) && limits.maxTotal > 0 && limits.maxPerNode > 0 && limits.maxPerNode <= limits.maxTotal
  function edit(field: 'total' | 'perNode', value: string): void {
    if (policy === undefined) return
    const baseline = field === 'total' ? policy.maxTotal : policy.maxPerNode
    setDraft(current => {
      const next = { revision: policy.revision, ...current, [field]: changedLimit(value, baseline) }
      return next.total === undefined && next.perNode === undefined ? undefined : next
    })
    setNotice('')
  }
  async function save(inherit: boolean): Promise<void> {
    if (policy === undefined || busy || loading || needsRefresh || staleDraft || !inherit && !valid) return
    setPending(inherit ? 'inherit' : 'save'); setError(''); setNotice('')
    try {
      const saved = await saveRuntimeAllocationPolicy(userId, draft?.revision ?? policy.revision, inherit ? null : limits)
      setPolicy(saved); setDraft(undefined); setNotice(t('limitsSaved'))
    }
    catch (cause) { setNeedsRefresh(true); setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t('saveUnconfirmed')) }
    finally { setPending(undefined) }
  }
  usePendingEdits(draft !== undefined || busy)
  const disabled = busy || loading || needsRefresh
  return <div className="runtimePolicy" aria-busy={busy || loading}><ErrorBanner message={error} />
    {loading && policy === undefined ? <LoadingState label={t('loadingLimits')} /> : null}
    {policy === undefined ? null : <div className="formGrid">
      <Field label={t('total')}><input className="input" type="number" min="1" step="1" value={total} disabled={disabled} aria-invalid={!valid} aria-describedby={validationId} onChange={event => edit('total', event.currentTarget.value)} /></Field>
      <Field label={t(showComputer ? 'perNode' : 'localPerNode')}><input className="input" type="number" min="1" step="1" value={perNode} disabled={disabled} aria-invalid={!valid} aria-describedby={validationId} onChange={event => edit('perNode', event.currentTarget.value)} /></Field>
    </div>}
    <p className="fieldHint" id={validationId} role="status">{staleDraft ? t('limitsChanged') : !valid && policy !== undefined ? t(showComputer ? 'invalid' : 'localInvalid') : notice || '\u00a0'}</p>
    <div className="formActions runtimePolicyActions">
      {policy === undefined ? null : <><span className="muted">{t(userId === undefined ? 'organizationDefaults' : policy.source === 'organization' ? 'inherited' : 'override')}</span>
        <Button variant="primary" loading={pending === 'save'} disabled={disabled || staleDraft || !valid} onClick={() => { void save(false) }}>{t('save')}</Button>
        {userId === undefined ? null : <Button loading={pending === 'inherit'} disabled={disabled || staleDraft || policy.source === 'organization'} onClick={() => { void save(true) }}>{t('restore')}</Button>}</>}
      <Button loading={loading} disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t('refreshLimits')}</Button>
    </div>
  </div>
}
