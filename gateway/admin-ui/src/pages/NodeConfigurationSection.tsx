/** Desired and effective deployment settings for the server-confirmed current node. */
import { useEffect, useMemo, useState } from 'react'
import { NODE_CONFIG_FIELDS } from '../../../src/node-config-fields.ts'
import { getNodeConfiguration, mutateNodeConfiguration, type NodeConfigurationView, type NodeSettingValues } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './node-configuration.copy.ts'
import { Button, Dialog, ErrorBanner, Field, LoadingState, Section, StatusBadge } from '../components/ui.tsx'

function configurationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const t = translateCopy(adminLanguage(), { zh, en })
  const descriptions: Record<string, string> = {
    'node-configuration-revision-conflict': t('errRevisionConflict'),
    'node-configuration-identity-mismatch': t('errIdentityMismatch'),
    'node-configuration-apply-in-progress': t('errApplyInProgress'),
    'deployment-data-operation-already-running': t('errOperationRunning'),
    'configuration-requires-quiesced-maintenance': t('errRequiresMaintenance'),
    'node-configuration-request-predates-restored-data': t('errPredatesRestore'),
    'gateway-service-restart-failed': t('errRestartFailed'),
    'gateway-did-not-confirm-configured-revision': t('errRevisionUnconfirmed'),
    'previous-configuration-restored': t('errPreviousRestored'),
  }
  return message.split('; ').map(part => descriptions[part] ?? part).join(' ')
}

export function NodeConfigurationSection() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const groups: Record<string, string> = { network: t('groupNetwork'), paths: t('groupPaths'), credentials: t('groupCredentials'), runtime: t('groupRuntime') }
  const status = { pending: t('statusPending'), applying: t('statusApplying'), completed: t('statusCompleted'), failed: t('statusFailed') }
  const [view, setView] = useState<NodeConfigurationView | null>(null)
  const [draft, setDraft] = useState<NodeSettingValues | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [filter, setFilter] = useState('')
  const applying = view?.operation?.status === 'pending' || view?.operation?.status === 'applying'
  const dirty = draft !== null && view !== null && NODE_CONFIG_FIELDS.some(field => draft[field.key] !== view.desired[field.key])
  useEffect(() => {
    const lifetime = new AbortController()
    void getNodeConfiguration(lifetime.signal).then(value => { setView(value); setDraft(value.desired) })
      .catch((cause: unknown) => { if (!lifetime.signal.aborted) setError(configurationMessage(cause)) })
    return () => { lifetime.abort() }
  }, [])
  useEffect(() => {
    if (!applying) return
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try { setView(await getNodeConfiguration(lifetime.signal)); setError('') }
      catch (cause) { if (!lifetime.signal.aborted) setError(configurationMessage(cause)) }
      finally { if (!lifetime.signal.aborted) timer = setTimeout(() => { void read() }, 5000) }
    }
    timer = setTimeout(() => { void read() }, 1000)
    return () => { lifetime.abort(); clearTimeout(timer) }
  }, [applying])

  async function mutate(action: 'save' | 'apply') {
    if (view === null || draft === null) return
    setBusy(true); setError(''); setSaved('')
    try {
      const next = await mutateNodeConfiguration({ action, organizationId: view.organizationId, nodeId: view.nodeId,
        revision: view.revision, ...(action === 'save' ? { values: draft } : {}) })
      setView(next); setDraft(next.desired); setConfirm(false)
      setSaved(action === 'save' ? t('savedSave') : t('savedApply'))
    } catch (cause) { setError(configurationMessage(cause)) }
    finally { setBusy(false) }
  }

  return <Section title={t('sectionTitle')} meta={view === null ? t('metaLoading') : t('metaNode', { node: view.nodeId, revision: String(view.revision), running: String(view.runningRevision) })}>
    {view === null || draft === null ? <><ErrorBanner message={error} />{error === '' ? <LoadingState label={t('loading')} /> : null}</> : <>
      <p>{t('intro')}</p>
      <StatusBadge tone={applying ? 'warning' : view.operation?.status === 'failed' ? 'danger' : 'neutral'}>
        {view.operation === null || view.operation.revision !== view.revision ? (view.revision === view.runningRevision ? t('stateEffective') : t('stateDesired')) : status[view.operation.status]}
      </StatusBadge>
      {view.operation?.error === null || view.operation === null ? null : <ErrorBanner message={t('operationError', { revision: String(view.operation.revision), error: configurationMessage(view.operation.error) })} />}
      {!confirm ? <ErrorBanner message={error} /> : null}
      {saved === '' ? null : <p role="status">{saved}</p>}
      <Field label={t('filterLabel')}><input className="input" value={filter} onChange={event => { setFilter(event.target.value) }} placeholder={t('filterPlaceholder')} /></Field>
      {Object.entries(groups).map(([group, title]) => {
        const fields = NODE_CONFIG_FIELDS.filter(field => field.group === group && `${field.label} ${field.help} ${field.key}`.toLowerCase().includes(filter.toLowerCase()))
        if (fields.length === 0) return null
        return <details key={group} className="nodeConfigurationGroup" open={filter !== '' || group === 'network'}>
          <summary>{title}</summary>
          <fieldset className="nodeConfigurationFields" aria-label={title} disabled={busy || applying}>
          {fields.map(field => <Field key={field.key} label={`${field.label}${field.unit === '' ? '' : `（${field.unit}）`}`}>
            <input className="input" value={draft[field.key]} inputMode={field.kind === 'integer' ? 'numeric' : 'text'}
              aria-label={`${field.label}${field.unit === '' ? '' : `（${field.unit}）`}`} aria-describedby={`node-setting-help-${field.key} node-setting-current-${field.key}`}
              onChange={event => { setDraft(current => current === null ? null : { ...current, [field.key]: event.target.value }); setSaved('') }} />
            <p id={`node-setting-help-${field.key}`}>{field.help}</p>
            <small id={`node-setting-current-${field.key}`}>{t('currentLine', { value: view.effective[field.key] === '' ? t('notSet') : view.effective[field.key], source: view.runningRevision === 0 ? t('sourceBoot') : t('sourceManaged', { revision: String(view.runningRevision) }) })}</small>
          </Field>)}
          </fieldset>
        </details>
      })}
      <div className="formActions">
        <Button variant="primary" disabled={!dirty || applying} loading={busy} onClick={() => { void mutate('save') }}>{t('saveButton')}</Button>
        <Button disabled={busy || dirty || applying || view.revision === view.runningRevision} onClick={() => { setError(''); setConfirm(true) }}>{t('applyButton')}</Button>
        <Button disabled={busy || applying} onClick={() => {
          setBusy(true)
          void getNodeConfiguration().then(next => { setView(next); setDraft(next.desired); setError(''); setSaved('') })
            .catch((cause: unknown) => { setError(configurationMessage(cause)) }).finally(() => { setBusy(false) })
        }}>{t('rereadButton')}</Button>
      </div>
      <p>{t('configFileLead')}<code>{view.configFile}</code>{t('configFileCli')}<code>node gateway/lib/node-config-cli.js status</code>{t('configFileStatus')}<code>recover</code>{t('configFileRecover')}</p>
      <Dialog open={confirm} title={t('applyDialogTitle')} description={t('applyDialogDescription')}
        onClose={() => { if (!busy) setConfirm(false) }} footer={<>
          <Button disabled={busy} onClick={() => { setConfirm(false) }}>{t('cancel')}</Button>
          <Button variant="primary" loading={busy} onClick={() => { void mutate('apply') }}>{t('applyConfirm')}</Button>
        </>}>
          <ErrorBanner message={confirm ? error : ''} />
          <p>{t('applySummary', { revision: String(view.revision), node: view.nodeId })}</p>
          <div className="tableWrap" role="region" aria-label={t('diffAria')} tabIndex={0}>
            <table className="dataTable"><thead><tr><th>{t('colSetting')}</th><th>{t('colCurrent')}</th><th>{t('colDesired')}</th></tr></thead><tbody>
              {NODE_CONFIG_FIELDS.filter(field => view.desired[field.key] !== view.effective[field.key]).map(field => <tr key={field.key}>
                <td>{field.label}</td><td>{view.effective[field.key] || t('notSet')}</td><td>{view.desired[field.key] || t('notSet')}</td>
              </tr>)}
            </tbody></table>
          </div>
        </Dialog>
    </>}
  </Section>
}
