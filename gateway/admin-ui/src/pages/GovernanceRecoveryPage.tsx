/** Restricted governance recovery, independent of ordinary Admin bootstrap and computer selection. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GovernanceRebuildStatus, GovernanceRuntimeReview } from '../../../src/governance-rebuild-review.ts'
import { Button, ErrorBanner, Field, PageHeader, Section, StatusBadge } from '../components/ui.tsx'
import { adminLanguage, translateCopy, type CopyTranslate } from '../language.ts'
import { usePendingEdits, useProtectedNavigation } from '../pending-edits.tsx'
import { GovernanceRecoveryRequestError, requestGovernanceRecovery } from '../governance-recovery-request.ts'
import { PeerRecoveryExecution, recoveryExecutionMessage } from './PeerRecoveryExecution.tsx'
import { en as executionEn, zh as executionZh } from './peer-backup.copy.ts'
import { en, zh, type GovernanceRecoveryCopyKey } from './governance-recovery.copy.ts'

type Translate = CopyTranslate<GovernanceRecoveryCopyKey>
type PageKind = keyof GovernanceRebuildStatus['continuation']
type Draft = { operationId: string; revision: string; subjectId: string; name: string; kind: 'account' | 'node' | 'release';
  decision: 'restore' | 'keep-disabled'; password: string; acknowledged: boolean; domains: string[] }
const domains: Record<string, GovernanceRecoveryCopyKey> = {
  'credentials:browser-and-runtime-sessions': 'domainCredentials', 'credentials:node-admission-and-enrollment': 'domainNodes',
  'configuration:organization-model-connections': 'domainModels', 'configuration:plugin-desired-state': 'domainPlugins',
  'configuration:ssh-and-webhook': 'domainExternal', 'configuration:node-local-paths': 'domainPaths', 'configuration:public-access': 'domainPublic',
  'execution:pending-work-and-device-leases': 'domainTasks', 'data:node-business-domains': 'domainData', 'audit:content-bearing-detail': 'domainAudit',
  'authorization:computer-project-model-and-plugin-grants': 'domainGrants', 'authorization:organization-roles': 'domainRoles',
}
function errorMessage(code: string, t: Translate): string {
  if (code === 'forbidden' || code === '403' || code === 'governance-recovery-bootstrap-required') return t('forbidden')
  if (code.endsWith('review-changed')) return t('changed')
  if (code.endsWith('source-quarantined')) return t('sourceQuarantined')
  if (/name-keys-required|keyring-proof-required/u.test(code)) return t('nameKeys')
  if (code.endsWith('account-not-eligible')) return t('accountIneligible')
  if (/local-target-required|local-entry-required|replacement-entry-required/u.test(code)) return t('localOnly')
  if (/local-runtime-not-stopped|execution-runtime-busy/u.test(code)) return t('busyRuntime')
  if (/local-generation-(changed|ahead)/u.test(code)) return t('generation')
  if (code.endsWith('local-environment-review-required')) return t('environment')
  if (code.endsWith('local-manual-inspection-required')) return t('manualRetry')
  if (code.endsWith('local-account-home-conflict')) return t('accountHomeConflict')
  if (/local-(data|path|directory|session|binding|volume|project|runtime-identity)/u.test(code)) return t('missingData')
  return t('failed') + ' (' + code + ')'
}
function mergeRows<T>(prior: T[], incoming: T[], identity: (row: T) => string): T[] {
  const rows = new Map(prior.map(row => [identity(row), row]))
  for (const row of incoming) rows.set(identity(row), row)
  return [...rows.values()]
}

/** Render only recovery APIs; drafts and review selection belong to this browser document.
 * @returns the restricted review workflow and, after release, an explicit link to ordinary Admin.
 */
export function GovernanceRecoveryPage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { en, zh }), [])
  const [status, setStatus] = useState<GovernanceRebuildStatus | null>()
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [draft, setDraft] = useState<Draft>(), [conflict, setConflict] = useState(false), [denied, setDenied] = useState(false)
  const draftHeading = useRef<HTMLHeadingElement>(null)
  const [selected, setSelected] = useState<{ operationId: string; runtime: GovernanceRuntimeReview }>()
  const alive = useRef(false), readOwner = useRef<AbortController | undefined>(undefined)
  const navigation = useProtectedNavigation()
  usePendingEdits(busy || draft !== undefined)
  const load = useCallback(async (kind?: PageKind, cursor?: string) => {
    readOwner.current?.abort()
    const controller = new AbortController(); readOwner.current = controller
    setLoading(true)
    try {
      const result = await requestGovernanceRecovery<GovernanceRebuildStatus | null>(kind && cursor ? '?' + kind + '=' + encodeURIComponent(cursor) : '', 'GET', undefined, controller.signal)
      if (controller.signal.aborted || !alive.current) return
      setStatus(previous => {
        if (!kind || !result || !previous || previous.operationId !== result.operationId) return result
        return { ...previous, state: result.state, revision: result.revision, unrestoredDomains: result.unrestoredDomains,
          continuation: { ...previous.continuation, [kind]: result.continuation[kind] },
          ...(kind === 'accounts' ? { accounts: mergeRows(previous.accounts, result.accounts, row => row.userId) } : {}),
          ...(kind === 'nodes' ? { nodes: mergeRows(previous.nodes, result.nodes, row => row.nodeId) } : {}),
          ...(kind === 'runtimes' ? { runtimes: mergeRows(previous.runtimes, result.runtimes, row => row.id) } : {}),
          ...(kind === 'configuration' ? { unreconfiguredItems: mergeRows(previous.unreconfiguredItems, result.unreconfiguredItems, row => row.recordDigest) } : {}) }
      })
      setError(''); setDenied(false)
    } catch (cause) { if (!controller.signal.aborted && alive.current) {
      if (cause instanceof GovernanceRecoveryRequestError && cause.status === 403) setDenied(true)
      setError(errorMessage(cause instanceof Error ? cause.message : String(cause), t))
    } }
    finally { if (!controller.signal.aborted && alive.current) setLoading(false) }
  }, [t])
  useEffect(() => {
    alive.current = true
    const language = document.documentElement.lang; document.documentElement.lang = adminLanguage()
    void load()
    return () => { alive.current = false; readOwner.current?.abort(); document.documentElement.lang = language }
  }, [load])
  useEffect(() => {
    if (draft) { draftHeading.current?.focus({ preventScroll: true }); draftHeading.current?.scrollIntoView({ block: 'nearest' }) }
  }, [draft?.kind, draft?.subjectId])
  const begin = (kind: Draft['kind'], subjectId: string, name: string) => {
    if (!status || draft || busy || !navigation.canReplace()) return
    setConflict(false); setError('')
    setDraft({ operationId: status.operationId, revision: status.revision, kind, subjectId, name,
      decision: 'keep-disabled', password: '', acknowledged: false, domains: [] })
  }
  const current = draft && status && draft.operationId === status.operationId && draft.revision === status.revision && status.state === 'review' && !conflict
  const draftSubjectPresent = status && draft && draft.operationId === status.operationId && (draft.kind === 'release'
    || draft.kind === 'account' && status.accounts.some(row => row.userId === draft.subjectId)
    || draft.kind === 'node' && status.nodes.some(row => row.nodeId === draft.subjectId))
  const submit = async () => {
    if (!draft || !current || busy) return
    setBusy(true); setError('')
    const path = '/' + encodeURIComponent(draft.operationId) + (draft.kind === 'release' ? '/release' : '/' + (draft.kind === 'account' ? 'accounts' : 'nodes') + '/' + encodeURIComponent(draft.subjectId) + '/review')
    const body = { confirm: draft.operationId, revision: draft.revision, ...(draft.kind === 'release'
      ? { acknowledgeUnrestoredDomains: draft.domains }
      : { decision: draft.decision, ...(draft.kind === 'account' && draft.decision === 'restore' ? { newPassword: draft.password } : {}) }) }
    try {
      await requestGovernanceRecovery(path, 'POST', body)
      if (alive.current) { setDraft(undefined); setConflict(false); await load() }
    } catch (cause) {
      if (alive.current) {
        if (cause instanceof GovernanceRecoveryRequestError && cause.status === 403) { readOwner.current?.abort(); setLoading(false); setDenied(true) }
        if (cause instanceof GovernanceRecoveryRequestError && cause.status === 409 && cause.message.endsWith('review-changed')) setConflict(true)
        setError(errorMessage(cause instanceof Error ? cause.message : String(cause), t))
      }
    } finally { if (alive.current) setBusy(false) }
  }
  const more = (kind: PageKind) => status?.continuation[kind] && <Button disabled={loading || busy}
    onClick={() => void load(kind, status.continuation[kind]!)}>{t('more')}</Button>
  const rowState = (decision: 'restore' | 'keep-disabled' | null) => t(decision === 'restore' ? 'approved' : decision === 'keep-disabled' ? 'disabled' : 'pending')
  const selectedRuntime = selected && status?.operationId === selected.operationId
    ? status.runtimes.find(row => row.id === selected.runtime.id) ?? selected.runtime : undefined
  return <main className="governanceRecoveryPage"><div className="page">
    <PageHeader title={t('title')} description={t('subtitle')} actions={<Button disabled={loading || busy} onClick={() => void load()}>{t('refresh')}</Button>} />
    <ErrorBanner message={error} />
    {loading && status === undefined && <p role="status">{t('loading')}</p>}
    {status === null && <p>{t('empty')}</p>}
    {status && <div hidden={denied} inert={denied || undefined}>
      <Section><p role="status">{t(status.state === 'released' ? 'released' : 'restricted')}</p>
        <p>{t('revision', { revision: status.revision })}</p>
        {status.state === 'released' && <a className="button button-primary" href="/admin/">{t('ordinaryAdmin')}</a>}
      </Section>
      {draft && <Section title={t('draft')} className="peerBackupSection">
        <h3 ref={draftHeading} tabIndex={-1}>{draft.name}</h3><p>{t(draft.kind === 'account' ? 'accountHelp' : draft.kind === 'node' ? 'nodeHelp' : 'releaseHelp')}</p>
        {draft.kind !== 'release' && <Field label={draft.kind === 'account' ? t('accounts') : t('nodes')}><select className="input" value={draft.decision} disabled={busy}
          onChange={event => setDraft({ ...draft, decision: event.target.value as Draft['decision'], acknowledged: false })}>
          <option value="keep-disabled">{t('keepDisabled')}</option><option value="restore">{t(draft.kind === 'account' ? 'restoreAccount' : 'restoreNode')}</option>
        </select></Field>}
        {draft.kind === 'account' && draft.decision === 'restore' && <Field label={t('password')} hint={t('passwordHint')}>
          <input className="input" type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={draft.password} disabled={busy}
            onChange={event => setDraft({ ...draft, password: event.target.value })} />
        </Field>}
        {draft.kind === 'release' && <div className="governanceRecoveryDomains">{status.unrestoredDomains.map(domain => <label className="checkLabel" key={domain}>
          <input type="checkbox" checked={draft.domains.includes(domain)} disabled={busy} onChange={event => setDraft({ ...draft,
            domains: event.target.checked ? [...draft.domains, domain] : draft.domains.filter(value => value !== domain) })} />{domains[domain] ? t(domains[domain]) : domain}
        </label>)}</div>}
        <label className="checkLabel"><input type="checkbox" checked={draft.acknowledged} disabled={busy} onChange={event => setDraft({ ...draft, acknowledged: event.target.checked })} />
          {t(draft.kind === 'release' ? 'releaseAck' : 'acknowledge')}</label>
        {!current && <><p role="status">{t('changed')}</p><Button disabled={busy || loading || !draftSubjectPresent || status.state !== 'review' || conflict && status.revision === draft.revision}
          onClick={() => { setConflict(false); setDraft({ ...draft, revision: status.revision, acknowledged: false, domains: [] }) }}>{t('renew')}</Button></>}
        <div className="formActions"><Button variant="primary" disabled={busy || !current || !draft.acknowledged
          || draft.kind === 'account' && draft.decision === 'restore' && draft.password.length < 12
          || draft.kind === 'release' && status.unrestoredDomains.some(domain => !draft.domains.includes(domain))} onClick={() => void submit()}>{t('confirm')}</Button>
          <Button disabled={busy} onClick={() => setDraft(undefined)}>{t('cancel')}</Button></div>
      </Section>}
      <Section title={t('accounts')}><p>{t('accountHelp')}</p>{status.accounts.map(row => <div className="detailBlock" key={row.userId}>
        <div className="statusRow"><strong>{row.username}</strong><StatusBadge>{row.bootstrap ? t('bootstrap') : rowState(row.decision)}</StatusBadge></div>
        {row.role === 'admin' && !row.bootstrap && <p>{t('originalAdmin')}</p>}
        {!row.bootstrap && status.state === 'review' && <Button disabled={!!draft || busy} onClick={() => begin('account', row.userId, row.username)}>{t('reviewAccount', { name: row.username })}</Button>}
      </div>)}{more('accounts')}</Section>
      <Section title={t('nodes')}><p>{t('nodeHelp')}</p>{status.nodes.map(row => <div className="detailBlock" key={row.nodeId}>
        <div className="statusRow"><strong>{row.name}</strong><StatusBadge>{row.quarantined ? t('quarantined') : rowState(row.decision)}</StatusBadge></div>
        {!row.quarantined && status.state === 'review' && <Button disabled={!!draft || busy} onClick={() => begin('node', row.nodeId, row.name)}>{t('reviewNode', { name: row.name })}</Button>}
      </div>)}{more('nodes')}</Section>
      <Section title={t('runtimes')} className="peerBackupSection"><p>{t('runtimeHelp')}</p>{status.runtimes.map(row => <div className="detailBlock" key={row.id}>
        <strong>{t(row.ownerKind === 'user' ? 'runtimeUser' : 'runtimeProject', { id: String(row.ownerPublicId) })}</strong>
        <p><code>{row.runtimeId}</code></p><p>{t('nodeIdentity', { id: status.nodes.find(node => node.nodeId === row.nodeId)?.name ?? row.nodeId })}</p>
        <p>{t(row.dataBinding === 'verified' ? 'verified' : row.dataBinding === 'queued' ? 'queued' : 'unbound')}</p>
        {row.bindingErrorCode && <p role="status">{errorMessage(row.bindingErrorCode, t)}</p>}
        <Button disabled={busy || !!draft} onClick={() => { if (navigation.canReplace()) setSelected({ operationId: status.operationId, runtime: row }) }}>{t('runtimeReview')}</Button>
      </div>)}{more('runtimes')}
      {selected && selectedRuntime && <RuntimeReview key={selected.operationId + selectedRuntime.id} operationId={selected.operationId} runtime={selectedRuntime}
        local={selectedRuntime.nodeId === status.targetNodeId} t={t} refresh={load} />}
      </Section>
      <Section title={t('configuration')}><p>{t('configurationHelp')}</p><ul>{status.unrestoredDomains.map(domain => <li key={domain}>{domains[domain] ? t(domains[domain]) : domain}</li>)}</ul>
        <details><summary>{t('details')}</summary>{status.unreconfiguredItems.map(row => <div className="detailBlock" key={row.recordDigest}>
          <strong>{row.table}</strong><pre>{JSON.stringify(row.identity, null, 2)}</pre>
        </div>)}{more('configuration')}</details>
      </Section>
      {status.state === 'review' && <Section title={t('release')}><p>{t('releaseHelp')}</p><Button variant="primary" disabled={!!draft || busy}
        onClick={() => begin('release', status.operationId, t('release'))}>{t('release')}</Button></Section>}
    </div>}
  </div></main>
}

function RuntimeReview({ operationId, runtime, local, t, refresh }: { operationId: string; runtime: GovernanceRuntimeReview; local: boolean; t: Translate; refresh: () => Promise<void> }) {
  const executionT = useMemo(() => translateCopy(adminLanguage(), { en: executionEn, zh: executionZh }), [])
  const [homePath, setHomePath] = useState(''), [runtimeHome, setRuntimeHome] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [keys, setKeys] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const alive = useRef(false), heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    alive.current = true; heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'nearest' })
    return () => { alive.current = false }
  }, [])
  usePendingEdits(busy || homePath !== '' || runtimeHome !== '')
  const prefix = '/' + encodeURIComponent(operationId) + '/runtimes/' + encodeURIComponent(runtime.id)
  const request = useCallback(<T,>(suffix: string, method?: string, body?: unknown, signal?: AbortSignal) => {
    const source = '/recoveries/' + encodeURIComponent(runtime.id) + '/execution'
    if (!suffix.startsWith(source)) throw new Error('Invalid recovery Runtime target')
    return requestGovernanceRecovery<T>(prefix + '/execution' + suffix.slice(source.length), method, body, signal)
  }, [prefix, runtime.id])
  const bind = async (manual: boolean) => {
    if (busy) return
    setBusy(true); setError(''); setKeys([]); setNotice('')
    try {
      await requestGovernanceRecovery(prefix + '/bind-data', 'POST', { confirm: runtime.id,
        ...(manual ? { selection: { homePath, ...(runtimeHome ? { runtimeHome } : {}) } } : {}) })
      if (alive.current) { setHomePath(''); setRuntimeHome(''); setNotice(t('bindingSubmitted')); await refresh() }
    } catch (cause) { if (alive.current) {
      setError(errorMessage(cause instanceof Error ? cause.message : String(cause), t))
      if (cause instanceof GovernanceRecoveryRequestError) setKeys(cause.keys)
    } } finally { if (alive.current) setBusy(false) }
  }
  return <div className="detailBlock"><h3 ref={heading} tabIndex={-1}>{t(runtime.ownerKind === 'user' ? 'runtimeUser' : 'runtimeProject', { id: String(runtime.ownerPublicId) })}</h3>
    <ErrorBanner message={error} />{keys.length > 0 && <ul>{keys.map(key => <li key={key}><code>{key}</code></li>)}</ul>}
    {notice && runtime.dataBinding !== 'verified' && <p role="status">{notice}</p>}
    {runtime.dataBinding !== 'verified' ? <>
      <Button disabled={busy || runtime.dataBinding === 'queued'} onClick={() => void bind(false)}>{t('bind')}</Button>
      {!local && <p>{t('remoteBindingHelp')}</p>}
      {local && <details><summary>{t('manualBinding')}</summary><p>{t('manualHelp')}</p>
        <Field label={t('homePath')}><input className="input" value={homePath} disabled={busy} onChange={event => setHomePath(event.target.value)} /></Field>
        <Field label={t('runtimeHome')}><input className="input" value={runtimeHome} disabled={busy} onChange={event => setRuntimeHome(event.target.value)} /></Field>
        <Button disabled={busy || !homePath.trim() || runtime.dataBinding === 'queued'} onClick={() => void bind(true)}>{t('submitBinding')}</Button>
      </details>}
    </> : <PeerRecoveryExecution operationId={runtime.id} request={request} t={executionT}
      message={code => recoveryExecutionMessage(code, executionT) ?? errorMessage(code, t)} />}
  </div>
}

interface LocalReview {
  localOnly: true
  operationId: string
  state: 'released'
  revision: string
  sourceNodeId: string
  targetNodeId: string
  localNodeId: string
  runtimes: GovernanceRuntimeReview[]
  continuation: { runtimes: string | null }
}

/** Review only this direct entry's retained Runtime data after organization recovery is released.
 * @returns local binding and execution controls without organization review, computer selection or release actions.
 */
export function LocalGovernanceRecoveryPage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { en, zh }), [])
  const [status, setStatus] = useState<LocalReview>()
  const [selected, setSelected] = useState<{ operationId: string; runtime: GovernanceRuntimeReview }>()
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [denied, setDenied] = useState(false)
  const owner = useRef<AbortController | undefined>(undefined), alive = useRef(false)
  const navigation = useProtectedNavigation()
  const refresh = useCallback(async (after?: string) => {
    owner.current?.abort()
    const controller = new AbortController(); owner.current = controller; setLoading(true)
    try {
      const result = await requestGovernanceRecovery<LocalReview>('/local' + (after ? '?after=' + encodeURIComponent(after) : ''), 'GET', undefined, controller.signal)
      if (!alive.current || controller.signal.aborted) return
      setStatus(previous => after && previous?.operationId === result.operationId && previous.localNodeId === result.localNodeId
        ? { ...result, runtimes: mergeRows(previous.runtimes, result.runtimes, row => row.id) } : result)
      setDenied(false); setError('')
    } catch (cause) { if (alive.current && !controller.signal.aborted) {
      if (cause instanceof GovernanceRecoveryRequestError && cause.status === 403) setDenied(true)
      setError(errorMessage(cause instanceof Error ? cause.message : String(cause), t))
    } } finally { if (alive.current && !controller.signal.aborted) setLoading(false) }
  }, [t])
  useEffect(() => {
    alive.current = true
    const previous = document.documentElement.lang; document.documentElement.lang = adminLanguage()
    void refresh()
    return () => { alive.current = false; owner.current?.abort(); document.documentElement.lang = previous }
  }, [refresh])
  const runtime = selected && status?.operationId === selected.operationId
    ? status.runtimes.find(row => row.id === selected.runtime.id) ?? selected.runtime : undefined
  return <main className="governanceRecoveryPage"><div className="page">
    <PageHeader title={t('localTitle')} description={t('localHelp')} actions={<Button disabled={loading} onClick={() => void refresh()}>{t('refresh')}</Button>} />
    <ErrorBanner message={error} />
    {loading && !status && <p role="status">{t('loading')}</p>}
    {status && <div hidden={denied} inert={denied || undefined}><Section title={t('runtimes')} className="peerBackupSection">
      <p>{t('localHelp')}</p><p>{t('runtimeHelp')}</p>
      {status.runtimes.length === 0 && <p>{t('noRows')}</p>}
      {status.runtimes.map(row => <div key={row.id} className="detailBlock">
        <strong>{t(row.ownerKind === 'user' ? 'runtimeUser' : 'runtimeProject', { id: String(row.ownerPublicId) })}</strong>
        <p><code>{row.runtimeId}</code></p><p>{t(row.dataBinding === 'verified' ? 'verified' : row.dataBinding === 'queued' ? 'queued' : 'unbound')}</p>
        {row.bindingErrorCode && <p role="status">{errorMessage(row.bindingErrorCode, t)}</p>}
        <Button onClick={() => { if (navigation.canReplace()) setSelected({ operationId: status.operationId, runtime: row }) }}>{t('runtimeReview')}</Button>
      </div>)}
      {status.continuation.runtimes && <Button disabled={loading} onClick={() => void refresh(status.continuation.runtimes!)}>{t('more')}</Button>}
      {runtime && selected && <RuntimeReview key={selected.operationId + runtime.id} operationId={selected.operationId} runtime={runtime}
        local={runtime.nodeId === status.localNodeId} t={t} refresh={refresh} />}
    </Section></div>}
  </div></main>
}
