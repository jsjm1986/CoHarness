/** Reviewed organization mode and the existing computer-local connection setup. @module */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDeploymentContext } from '../deployment-context.tsx'
import { usePendingEdits } from '../pending-edits.tsx'
import { adminComputerTarget } from '../computer-target.ts'
import { AdminRequestError, getDeploymentTopology, getNodeConnection, preflightDeploymentTopology, saveDeploymentTopology, saveNodeConnection, startNodeConnection } from '../api.ts'
import type { DeploymentContext, DeploymentPreflight } from '../../../src/deployment-protocol.ts'
import type { NodeConnectionView } from '../../../src/deployment-protocol.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { Button, Dialog, ErrorBanner, Field, LoadingState, Section } from '../components/ui.tsx'
import { zh, en } from './topology.copy.ts'

export function DeploymentTopologySection() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const shared = useDeploymentContext()
  const [baseline, setBaseline] = useState<DeploymentContext | null>(null)
  const [enabled, setEnabled] = useState(false), [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [preflight, setPreflight] = useState<DeploymentPreflight | null>(null)
  const [confirm, setConfirm] = useState(false)
  const dirty = baseline !== null && (enabled !== (baseline.mode === 'multi') || enabled && address !== (baseline.primary?.origin ?? window.location.origin))
  usePendingEdits(dirty || busy)
  useEffect(() => {
    if (shared.value === null || dirty || busy) return
    setBaseline(shared.value); setEnabled(shared.value.mode === 'multi'); setAddress(shared.value.primary?.origin ?? window.location.origin)
  }, [shared.value, dirty, busy])

  const failed = (cause: unknown): void => {
    const code = cause instanceof AdminRequestError ? cause.code : ''
    setError(t(code === 'deployment/revision-conflict' ? 'conflict'
      : code === 'deployment/computers-still-attached' ? 'attached' : code === 'deployment/origin-not-configured' ? 'originUnconfigured'
        : code === 'deployment/legacy-primary-required' ? 'legacyPrimary' : 'failed'))
  }
  const save = async (): Promise<void> => {
    if (baseline === null || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const next = await saveDeploymentTopology({ revision: baseline.revision, enabled, ...(enabled ? { primaryOrigin: address } : {}) })
      setBaseline(next); setEnabled(next.mode === 'multi'); setAddress(next.primary?.origin ?? window.location.origin)
      setConfirm(false); setPreflight(null); setNotice(t('saved')); await shared.refresh()
    } catch (cause) { failed(cause) } finally { setBusy(false) }
  }
  const submit = async (): Promise<void> => {
    if (enabled) { await save(); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const next = await preflightDeploymentTopology(); setPreflight(next)
      if (next.canDisable) setConfirm(true); else setError(t('attached'))
    } catch (cause) { failed(cause) } finally { setBusy(false) }
  }
  const view = shared.value
  const remote = view?.mode === 'multi' && view.scope !== 'organization'
  return <Section title={t('title')}>
    {view === null || baseline === null ? <>
      <ErrorBanner message={shared.error ? t('readFailed') : ''} />
      {shared.error ? <Button onClick={() => void shared.refresh()}>{t('refresh')}</Button> : <LoadingState label={t('loading')} />}
    </> : <>
      <ErrorBanner message={shared.error ? t('readFailed') : ''} /><p className="fieldHint">{t('hint')}</p>
      {view.legacyMigrationRequired && <p role="status">{t('legacy')}</p>}
      <p className="fieldHint">{t(view.scope === 'organization' ? 'rolePrimary' : 'local')}</p>
      {remote ? <p><span>{t('primary', { name: view.primary?.name ?? '' })}</span>{' '}
        <a href={`${view.primary!.origin}/admin/deployment`} target="_blank" rel="noopener noreferrer">{t('openPrimary')}</a></p>
        : <form onSubmit={event => { event.preventDefault(); void submit() }}>
          <label className="checkLabel"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => { setEnabled(event.target.checked) }} /> {t('enabled')}</label>
          {enabled && <Field label={t('origin')} hint={t('originHint')}><input className="input" type="url" aria-label={t('origin')} value={address} disabled={busy} required onChange={event => { setAddress(event.target.value) }} /></Field>}
          <ErrorBanner message={error} />
          {notice && <p role="status">{notice}</p>}
          {preflight !== null && !preflight.canDisable && <p role="status">{t('blockers', { count: String(preflight.blockingCount) })}: {preflight.computers.map(item => `${item.name} (${item.activeRuntimes})`).join('、')}</p>}
          <div className="formActions"><Button type="submit" variant="primary" disabled={busy || !dirty && !view.legacyMigrationRequired}>{t('save')}</Button>
            <Button type="button" disabled={busy} onClick={() => { void getDeploymentTopology().then(next => { setBaseline(next); if (!dirty) { setEnabled(next.mode === 'multi'); setAddress(next.primary?.origin ?? window.location.origin) } return shared.refresh() }).catch(failed) }}>{t('refresh')}</Button></div>
        </form>}
      <Dialog open={confirm} onClose={() => { if (!busy) setConfirm(false) }} title={t('disableTitle')}
        footer={<><Button disabled={busy} onClick={() => { setConfirm(false) }}>{t('cancel')}</Button><Button disabled={busy} variant="primary" onClick={() => void save()}>{t('confirmDisable')}</Button></>}>
        <p>{t('disableBody')}</p><ErrorBanner message={error} />
      </Dialog>
    </>}
  </Section>
}

export function NodeConnectionSection() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const { value: deployment } = useDeploymentContext()
  const [view, setView] = useState<NodeConnectionView | null>(null)
  const [center, setCenter] = useState(''), [code, setCode] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const owner = useRef<AbortController | undefined>(undefined)
  useEffect(() => { const current = new AbortController(); owner.current = current; return () => { current.abort() } }, [])
  const selected = adminComputerTarget(window.location.pathname) ?? deployment?.entry.nodeId
  const available = deployment?.mode === 'multi' && selected !== deployment.primary?.nodeId
  usePendingEdits(busy || code !== '' || view !== null && center !== (view.centerUrl ?? deployment?.primary?.origin ?? ''))
  useEffect(() => {
    if (!available) return
    const controller = new AbortController()
    void getNodeConnection(controller.signal).then(next => { if (controller.signal.aborted) return; setView(next); setCenter(current => current === '' ? next.centerUrl ?? deployment?.primary?.origin ?? '' : current) })
      .catch(() => { if (!controller.signal.aborted) setError(t('readFailed')) })
    return () => { controller.abort() }
  }, [available, deployment?.primary?.origin, deployment?.revision, t])
  if (!available && view === null) return null
  const run = async (start: boolean): Promise<void> => {
    if (view === null || busy || !available) return
    const lifetime = owner.current
    setBusy(true); setError(''); setNotice('')
    try {
      const next = start ? await startNodeConnection() : await saveNodeConnection({ revision: view.revision, centerUrl: center, enrollmentToken: code })
      if (lifetime?.signal.aborted) return
      setView(next); setCode(''); setNotice(t(start ? 'startRequested' : 'connectionSaved'))
    } catch (cause) {
      if (lifetime?.signal.aborted) return
      const code = cause instanceof AdminRequestError ? cause.code : ''
      setError(t(code === 'node-connection-primary-mismatch' ? 'identityFailed'
        : code === 'node-connection-already-connected' ? 'connected'
          : code === 'node-connection-service-start-failed' ? 'serviceFailed' : code === 'node-connection-new-enrollment-required' ? 'newEnrollment' : 'failed'))
    } finally { if (!lifetime?.signal.aborted) setBusy(false) }
  }
  return <Section title={t('connectionTitle')}>
    <p className="fieldHint">{t('connectionHint')}</p>{!available && <p role="alert">{t('connectionUnavailable')}</p>}<ErrorBanner message={error} />
    {view === null ? <LoadingState label={t('loading')} /> : <>
      <p className="fieldHint">{t(view.configured ? 'configured' : 'unconfigured')} · {t(view.connectionState === 'connected' ? 'connectedState' : view.connectionState)}</p>
      <Field label={t('center')}><input className="input" type="url" aria-label={t('center')} value={center} disabled={busy || !available} onChange={event => { setCenter(event.target.value) }} /></Field>
      <Field label={t('code')}><input className="input" type="password" aria-label={t('code')} autoComplete="off" value={code} disabled={busy || !available} onChange={event => { setCode(event.target.value) }} /></Field>
      <div className="formActions"><Button disabled={busy || !available || code === '' || center === ''} variant="primary" onClick={() => void run(false)}>{t('saveConnection')}</Button>
        <Button disabled={busy || !available || view.connectionState === 'connected' || !view.configured || !view.originReady} onClick={() => void run(true)}>{t('start')}</Button></div>
      {!view.originReady && <><p className="fieldHint">{t('originMissing')}</p><Button disabled={busy || !available} onClick={() => {
        const accepted = !window.dispatchEvent(new CustomEvent('hgw-node-connection-origin', { cancelable: true, detail: { nodeId: selected, origin: view.centerUrl } }))
        setNotice(t(accepted ? 'originAdded' : 'originNotReady'))
      }}>{t('addOrigin')}</Button></>}
      {notice && <p role="status">{notice}</p>}<p className="fieldHint">{t('serviceHint')}</p>
    </>}
  </Section>
}
