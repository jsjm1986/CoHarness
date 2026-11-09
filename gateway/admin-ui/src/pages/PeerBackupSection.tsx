/** Organization-scoped online protection choices. Credentials never enter the form or browser storage. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeploymentNode } from '../api.ts'
import { adminLanguage, translateCopy, type CopyTranslate } from '../language.ts'
import { zh as copyZh, en as copyEn, type PeerBackupCopyKey } from './peer-backup.copy.ts'
import { randomUUID } from '../../../../packages/util/crypto/src/index.ts'
import { usePendingEdits } from '../pending-edits.tsx'
import { Button, ErrorBanner, Field, Section, StatusBadge } from '../components/ui.tsx'

interface Policy {
  policyId: string
  scopeId: string
  scopeKind: Kind
  sourceNodeId: string
  targetNodeId: string
  revision: number
  enabled: boolean
  tier: 'important' | 'ordinary'
  quotaBytes: number
  appendFingerprint: string
  recoveryFingerprint: string
  coverage: 'current' | 'partial' | 'overdue' | 'unprotected'
  protectedThrough: string | null
  pendingBytes: number | null
  repositoryBytes?: number | null
  availableBytes?: number | null
  coveredCount: number | null
  gapCount: number | null
  gapTypes?: string[]
  jobStatus: string | null
  errorCode: string | null
  lastDrillAt: string | null
  drillStatus: string | null
  recoveryMs?: number | null
}
type Kind = 'project' | 'personal' | 'governance'
interface Point {
  id: string
  protectedThrough: string
  gapCount: number
  coveredCount: number
}
interface Choice {
  id: string
  publicId: string
}
const base = '/admin/api/peer-backups'
async function api<T>(suffix: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(base + suffix, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
  })
  const result = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(result.error ?? String(response.status))
  return result
}
const err = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
const date = (value: string | null, zh: boolean): string =>
  value ? new Date(value).toLocaleString(zh ? 'zh-CN' : 'en-US') : '—'

const scopeKindLabel: Record<Kind, PeerBackupCopyKey> = {
  project: 'projectSpace', personal: 'personalRuntime', governance: 'governanceDatabase',
}

/** Render within the existing primary deployment page after its entry scope is known. */
export function PeerBackupSection({ nodes }: { nodes: readonly DeploymentNode[] }) {
  const language = adminLanguage()
  const zh = language === 'zh'
  const t = useMemo(() => translateCopy(language, { zh: copyZh, en: copyEn }), [language])
  const [policies, setPolicies] = useState<Policy[]>([]),
    [more, setMore] = useState(false),
    [loading, setLoading] = useState(false)
  const [localWorker, setLocalWorker] = useState<{ configured: boolean; recovery?: boolean; error?: string }>()
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false),
    [original, setOriginal] = useState<Policy | null>(null),
    [reprotecting, setReprotecting] = useState(false)
  const [source, setSource] = useState(''),
    [target, setTarget] = useState(''),
    [kind, setKind] = useState<Kind>('project'),
    [scope, setScope] = useState('')
  const [choices, setChoices] = useState<Choice[]>([]),
    [moreChoices, setMoreChoices] = useState(false)
  const [tier, setTier] = useState<Policy['tier']>('important'),
    [quota, setQuota] = useState('1024'),
    [enabled, setEnabled] = useState(true)
  const [append, setAppend] = useState(''),
    [recover, setRecover] = useState('')
  const [selected, setSelected] = useState<Policy | null>(null),
    [points, setPoints] = useState<Point[]>([]),
    [point, setPoint] = useState(''),
    [replacement, setReplacement] = useState('')
  const alive = useRef(true),
    read = useRef<AbortController | null>(null)
  usePendingEdits(editing || busy)
  const name = (id: string): string => nodes.find((n) => n.nodeId === id)?.name ?? id
  const message = useCallback((value: string): string => {
    const labels: Record<string, string> = {
      'peer-backup/coverage-incomplete': t('thisPointHasUncoveredData'),
      'peer-backup/isolated-recovery-only': t('isolatedRecoveryOnly'),
      'peer-backup/independent-drill-required': t('rehearseOnDifferentComputer'),
      'peer-backup/verified-writer-fence-required': t('verifyWriterFenced'),
      'peer-backup/provisioning-required': t('provisionPolicyRoute'),
      'peer-backup/revision-conflict': t('refreshAndReviewTheUpdatedPolicy'),
      'peer-backup/recovery-in-progress': t('recoveryInProgress'),
      'peer-backup/invalid-configuration': t('reviewTheBackupConfigurationOnThisComputer'),
      'peer-backup/personal-directory-unpublished': t('personalDirectoryUnpublished'),
      'peer-backup/unavailable': t('theBackupServiceIsTemporarilyUnavailable'),
      'peer-backup/invalid-request': t('theRequestWasRejectedReviewTheFormValues'),
      'peer-backup/current-revision-drill-required': t('rehearseOriginalPoint'),
      'peer-backup/recovery-approval-changed': t('takeoverChanged'),
      'peer-backup/project-owner-unavailable': t('checkOwnerAccess'),
      'peer-backup/recovery-cleanup-pending': t('waitForCandidateCleanup'),
      forbidden: t('thisAccountIsNotAllowedToDoThat'),
      unauthorized: t('thisAccountIsNotAllowedToDoThat'),
      'password-change-required': t('passwordChangeRequired'),
      'account-changed': t('accountChanged'),
      maintenance: t('maintenance'),
      'stale-epoch': t('staleEpoch'),
      '401': t('theSessionExpiredSignInAgain'),
      '403': t('thisAccountIsNotAllowedToDoThat'),
      unavailable: t('theServiceIsTemporarilyUnavailable'),
      queued: t('queued'),
      running: t('running'),
      confirmed: t('verified'),
      failed: t('failed'),
    }
    return labels[value] ?? t('unrecognizedOutcome')
  }, [t])
  const refresh = useCallback(async (after = '') => {
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    setLoading(true)
    try {
      const result = await api<{
        policies: Policy[]
        localWorkerConfigured: boolean
        recoveryConfigured?: boolean
        localWorkerError?: string
      }>('?after=' + encodeURIComponent(after), 'GET', undefined, controller.signal)
      if (!controller.signal.aborted) {
        setLocalWorker({
          configured: result.localWorkerConfigured,
          recovery: result.recoveryConfigured,
          error: result.localWorkerError,
        })
        setPolicies((old) => (after ? [...old, ...result.policies] : result.policies))
        setMore(result.policies.length === 50)
        setError('')
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(err(cause)))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [message])
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
      read.current?.abort()
    }
  }, [refresh])
  useEffect(() => {
    if (!selected) {
      setPoints([])
      return
    }
    setPoints([])
    setPoint('')
    const ctl = new AbortController()
    void api<{ points: Point[] }>('/' + selected.policyId + '/points', 'GET', undefined, ctl.signal)
      .then((result) => {
        if (!ctl.signal.aborted) {
          setPoints(result.points)
          setPoint(result.points[0]?.id ?? '')
        }
      })
      .catch((cause) => {
        if (!ctl.signal.aborted) setError(message(err(cause)))
      })
    return () => ctl.abort()
  }, [selected])
  useEffect(() => {
    if (!editing || !source || original || reprotecting) return
    const ctl = new AbortController()
    setChoices([])
    setScope('')
    setMoreChoices(false)
    void api<{ scopes: Choice[] }>('/scopes?source=' + source + '&kind=' + kind, 'GET', undefined, ctl.signal)
      .then((result) => {
        if (!ctl.signal.aborted) {
          setChoices(result.scopes)
          setScope(result.scopes[0]?.id ?? '')
          setMoreChoices(result.scopes.length === 100)
        }
      })
      .catch((cause) => {
        if (!ctl.signal.aborted) setError(message(err(cause)))
      })
    return () => ctl.abort()
  }, [source, kind, editing, original, reprotecting])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (cause) {
      if (alive.current) setError(message(err(cause)))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  function edit(row: Policy | null) {
    setSelected(null)
    setReprotecting(false)
    setOriginal(row)
    setSource(row?.sourceNodeId ?? nodes[0]?.nodeId ?? '')
    setTarget(row?.targetNodeId ?? '')
    setKind(row?.scopeKind ?? 'project')
    setScope(row?.scopeId ?? '')
    setQuota(String((row?.quotaBytes ?? 1024 * 1024 * 1024) / (1024 * 1024)))
    setEnabled(row?.enabled ?? true)
    setTier(row?.tier ?? 'important')
    setAppend(row?.appendFingerprint ?? '')
    setRecover(row?.recoveryFingerprint ?? '')
    setEditing(true)
  }
  function protectReplacement(row: Policy) {
    edit(null)
    setReprotecting(true)
    setSource(row.targetNodeId)
    setKind(row.scopeKind)
    setScope(row.scopeId)
    setChoices([{ id: row.scopeId, publicId: row.scopeId }])
  }
  const coverage = {
    current: t('current'),
    partial: t('partial'),
    overdue: t('overdue'),
    unprotected: t('noRecoveryPoint'),
  }
  return (
    <Section
      title={t('encryptedPeerBackups')}
      actions={
        <>
          <Button disabled={loading || busy} onClick={() => void refresh()}>
            {t('refresh')}
          </Button>{' '}
          <Button disabled={busy || editing || nodes.length < 2} onClick={() => edit(null)}>
            {t('addPolicy')}
          </Button>
        </>
      }
    >
      <ErrorBanner message={error} />
      {notice && <p role="status">{notice}</p>}
      {!policies.length && !editing && (
        <p className="fieldHint">
          {loading
            ? t('loadingBackupPolicies')
            : t('chooseBackupComputer')}
        </p>
      )}
      {policies.map((row) => (
        <div key={row.policyId} className="detailBlock">
          <div className="statusRow">
            <strong>
              {name(row.sourceNodeId)} → {name(row.targetNodeId)}
            </strong>
            <StatusBadge tone={row.coverage === 'current' ? 'success' : row.coverage === 'overdue' ? 'warning' : 'neutral'}>
              {row.enabled ? coverage[row.coverage] : t('paused')}
            </StatusBadge>
          </div>
          <p>
            {t('scope')} {t(scopeKindLabel[row.scopeKind])} · {row.scopeId} ·{' '}
            {row.tier === 'important' ? t('fifteenMin') : t('oneHour')}
          </p>
          <p>
            {t('protectedThrough')} {date(row.protectedThrough, zh)} · {t('covered')}{' '}
            {row.coveredCount ?? '—'} · {t('gaps')} {row.gapCount ?? '—'}
          </p>
          {row.gapTypes?.length ? (
            <p>
              {t('pendingCoverage')} ·{' '}
              {row.gapTypes
                .map(
                  (gap) =>
                    ({
                      files: t('files'),
                      plugins: t('pluginData'),
                      database: t('contentDatabase'),
                      unknown: t('unclassifiedData'),
                    })[gap] ?? gap,
                )
                .join(zh ? '、' : ', ')}
            </p>
          ) : null}
          {row.jobStatus && (
            <p>
              {t('backgroundOperation')} · {message(row.jobStatus)}
            </p>
          )}
          <p>
            {t('pending')} {row.pendingBytes === null ? '—' : Math.ceil(row.pendingBytes / 1024) + ' KiB'} ·{' '}
            {t('latestRehearsal')} {date(row.lastDrillAt, zh)} {row.drillStatus ? message(row.drillStatus) : ''}{' '}
            {row.recoveryMs != null ? (row.recoveryMs / 1000).toFixed(1) + ' s' : ''}
          </p>
          {row.repositoryBytes != null && row.availableBytes != null && (
            <p className="muted">
              {t('lastMeasuredStorage')} {Math.ceil(row.repositoryBytes / 1048576)} MiB ·{' '}
              {t('available')} {Math.floor(row.availableBytes / 1048576)} MiB
            </p>
          )}
          <details>
            <summary>{t('deploymentIdentity')}</summary>
            <code>{row.policyId}</code>
          </details>
          {row.errorCode && <p role="status">{message(row.errorCode)}</p>}
          <div className="formActions">
            <Button
              disabled={busy || !row.enabled}
              onClick={() =>
                void run(async () => {
                  await api('/' + row.policyId + '/capture', 'POST', {})
                  setNotice(t('queuedForBackgroundCapture'))
                  await refresh()
                })
              }
            >
              {t('backUpNow')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setSelected(row)
                setReplacement(row.targetNodeId)
              }}
            >
              {t('recoveryPointsAndDrills')}
            </Button>
            <Button disabled={busy} onClick={() => edit(row)}>
              {t('editPolicy')}
            </Button>
          </div>
        </div>
      ))}
      {localWorker && (!localWorker.configured || localWorker.error) && (
        <p role="status">
          {localWorker.error
            ? message(localWorker.error)
            : t('configureLocalBackup')}
        </p>
      )}
      {more && (
        <Button disabled={loading || busy} onClick={() => void refresh(policies[policies.length - 1]!.policyId)}>
          {t('morePolicies')}
        </Button>
      )}
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              await api('', 'PUT', {
                id: original?.policyId ?? randomUUID(),
                expectedRevision: original?.revision ?? 0,
                scopeKind: kind,
                scopeId: scope,
                sourceNodeId: source,
                targetNodeId: target,
                tier,
                enabled,
                quotaBytes: Number(quota) * 1024 * 1024,
                appendFingerprint: append,
                recoveryFingerprint: recover,
              })
              setEditing(false)
              setNotice(t('backupPolicySaved'))
              await refresh()
            })
          }}
        >
          {reprotecting && <p role="status">{t('protectTransferredProject')}</p>}
          <Field label={t('sourceComputer')}>
            <select
              className="input"
              required
              disabled={!!original || reprotecting || busy}
              value={source}
              onChange={(e) => {
                setSource(e.target.value)
                setTarget('')
              }}
            >
              {nodes.map((n) => (
                <option key={n.nodeId} value={n.nodeId}>
                  {n.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('backupComputer')}>
            <select
              className="input"
              required
              disabled={!!original || busy}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">{t('selectComputer')}</option>
              {nodes
                .filter((n) => n.nodeId !== source)
                .map((n) => (
                  <option key={n.nodeId} value={n.nodeId}>
                    {n.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t('protectedType')}>
            <select
              className="input"
              disabled={!!original || reprotecting || busy}
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              <option value="project">{t('projectSpace')}</option>
              <option value="personal">{t('personalRuntime')}</option>
              <option value="governance">{t('governanceDatabase')}</option>
            </select>
          </Field>
          <Field label={t('protectedScope')}>
            <select
              className="input"
              required
              disabled={!!original || reprotecting || busy}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              {original ? (
                <option value={scope}>{scope}</option>
              ) : (
                choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {kind === 'governance'
                      ? t('governanceDatabase')
                      : '#' + c.publicId + ' · ' + c.id.slice(0, 8)}
                  </option>
                ))
              )}
            </select>
          </Field>
          {moreChoices && !original && !reprotecting && (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api<{ scopes: Choice[] }>(
                    '/scopes?source=' + source + '&kind=' + kind + '&after=' + choices[choices.length - 1]!.id,
                  )
                  setChoices([...choices, ...r.scopes])
                  setMoreChoices(r.scopes.length === 100)
                })
              }
            >
              {t('moreSpaces')}
            </Button>
          )}
          <Field label={t('recoveryPointObjective')}>
            <select className="input" value={tier} onChange={(e) => setTier(e.target.value as Policy['tier'])}>
              <option value="important">{t('important15Min')}</option>
              <option value="ordinary">{t('ordinary1Hour')}</option>
            </select>
          </Field>
          <Field label={t('repositoryQuotaMiB')}>
            <input
              className="input"
              type="number"
              required
              min="1"
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
            />
          </Field>
          <Field label={t('appendCredentialFingerprintSHA256')}>
            <input
              className="input"
              autoComplete="off"
              required
              pattern="[a-f0-9]{64}"
              value={append}
              onChange={(e) => setAppend(e.target.value)}
            />
          </Field>
          <Field label={t('recoveryCredentialFingerprintSHA256')}>
            <input
              className="input"
              autoComplete="off"
              required
              pattern="[a-f0-9]{64}"
              value={recover}
              onChange={(e) => setRecover(e.target.value)}
            />
          </Field>
          <label className="checkLabel">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t('enablePolicy')}
          </label>
          <div className="formActions">
            <Button type="submit" variant="primary" disabled={busy || !scope || !target || append === recover}>
              {t('savePolicy')}
            </Button>
            <Button type="button" disabled={busy} onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {selected && (
        <div className="detailBlock">
          <Field label={t('recoveryPoint')}>
            <select className="input" value={point} onChange={(e) => setPoint(e.target.value)}>
              {points.map((p) => (
                <option key={p.id} value={p.id}>
                  {date(p.protectedThrough, zh)} · {t('gaps')} {p.gapCount}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('independentRehearsalComputer')}>
            <select className="input" value={replacement} onChange={(e) => setReplacement(e.target.value)}>
              {nodes
                .filter((n) => n.nodeId !== selected.sourceNodeId)
                .map((n) => (
                  <option key={n.nodeId} value={n.nodeId}>
                    {n.name}
                  </option>
                ))}
            </select>
          </Field>
          {localWorker?.recovery && selected.scopeKind === 'project' && point && (
            <PeerRecoveryActions
              key={selected.policyId + '/' + point}
              policy={selected}
              point={points.find((row) => row.id === point)!}
              nodeName={nodes.find((node) => node.nodeId === selected.targetNodeId)?.name ?? selected.targetNodeId}
              t={t}
              message={message}
              onReprotect={() => protectReplacement(selected)}
            />
          )}
          <div className="formActions">
            <Button
              disabled={busy || !point || !replacement}
              onClick={() =>
                void run(async () => {
                  await api('/' + selected.policyId + '/drill', 'POST', { pointId: point, recoveryNodeId: replacement })
                  setNotice(t('isolatedRecoveryDrillQueued'))
                  await refresh()
                })
              }
            >
              {t('startIsolatedDrill')}
            </Button>
            <Button
              disabled={busy || !point || !replacement}
              onClick={() =>
                void run(async () => {
                  const check = await api<{ blockers: string[] }>('/' + selected.policyId + '/preflight', 'POST', {
                    pointId: point,
                    recoveryNodeId: replacement,
                  })
                  setNotice(check.blockers.map(message).join(' '))
                })
              }
            >
              {t('recoveryPreflight')}
            </Button>
            <Button disabled={busy} onClick={() => setSelected(null)}>
              {t('close')}
            </Button>
          </div>
        </div>
      )}
    </Section>
  )
}

interface RecoveryAttempt {
  id: string
  phase: string
  pointId: string
  lastError?: string | null
  targetActivatedAt?: string | null
  policyRevision: number
  currentPolicyRevision: number
  policyEnabled: boolean
  reapprovalRequired: boolean
  cleanupPending: boolean
  affectedMemberCount?: number
}
interface RecoveryOptions {
  targets: { nodeId: string; volumeId: string }[]
  attempts: RecoveryAttempt[]
}

function PeerRecoveryActions({
  policy,
  point,
  nodeName,
  t,
  message,
  onReprotect,
}: {
  policy: Policy
  point: Point
  nodeName: string
  t: CopyTranslate<PeerBackupCopyKey>
  message: (code: string) => string
  onReprotect: () => void
}) {
  const [options, setOptions] = useState<RecoveryOptions>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState(''),
    [volume, setVolume] = useState('')
  const alive = useRef(false),
    generation = useRef(0)
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const request = ++generation.current
      const data = await api<RecoveryOptions>(
        '/recoveries?policyId=' + encodeURIComponent(policy.policyId),
        'GET',
        undefined,
        signal,
      )
      if (alive.current && !signal?.aborted && request === generation.current) setOptions(data)
    },
    [policy.policyId],
  )
  useEffect(() => {
    alive.current = true
    const lifetime = new AbortController()
    void refresh(lifetime.signal).catch((cause) => {
      if (!lifetime.signal.aborted) setError(err(cause))
    })
    return () => {
      alive.current = false
      lifetime.abort()
    }
  }, [refresh])
  const current = options?.attempts.find(
    (attempt) => attempt.phase !== 'cancelled' && (!attempt.targetActivatedAt || attempt.pointId === point.id),
  )
  const paired = options?.targets.filter((target) => target.nodeId === policy.targetNodeId) ?? []
  const selectedVolume = paired.some((target) => target.volumeId === volume)
    ? volume : paired.length === 1 ? paired[0]!.volumeId : ''
  const cleanupPending = options?.attempts.some((attempt) => attempt.cleanupPending)
  const labels: Record<string, string> = {
    prepared: t('preparingReplacement'),
    'target-ready': t('replacementVerified'),
    'retire-approved': t('waitingForSourceToConfirmItHasStopped'),
    retiring: t('fencingSourceWriter'),
    retreat: t('resolvingSourceFence'),
    'old-fenced': t('sourceWriterFenced'),
    switching: t('switchingOwnership'),
    published: current?.targetActivatedAt
      ? t('replacementIsServing')
      : t('waitingForFinalVerification'),
  }
  const problem = message
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
      if (alive.current) {
        setConfirm('')
        await refresh()
      }
    } catch (cause) {
      if (alive.current) setError(err(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const operate = (action: string) =>
    current && api('/recoveries/' + current.id + '/' + action, 'POST', { confirm: current.id })
  const step = current?.reapprovalRequired ? undefined :
    current?.phase === 'target-ready' ? 'approve-retirement' : current?.phase === 'old-fenced' ? 'activate' : undefined
  const help =
    step === 'approve-retirement'
      ? t('confirmFenceNotice')
      : t('confirmSwitch', { name: nodeName })
  return (
    <div className="detailBlock">
      <strong>{t('projectTakeover')}</strong>
      <p>{current ? labels[current.phase] : t('replacementComputer') + ' · ' + nodeName}</p>
      {current && current.pointId !== point.id && <p role="status">{t('takeoverConflict')}</p>}
      {!!current?.affectedMemberCount && <p role="status">{t(
        'memberAccessNotice', { count: String(current.affectedMemberCount) })}</p>}
      {cleanupPending && <p role="status">{t('candidateCleanupPending')}</p>}
      {current?.reapprovalRequired && current.phase !== 'switching' && <div role="status">
        <p>{current.policyEnabled ? t('policyRevisionChanged', {
          from: String(current.policyRevision), to: String(current.currentPolicyRevision),
        }) : t('policyPausedRehearse')}</p>
        {current.policyEnabled && confirm !== current.id + '/reapprove' && <Button disabled={busy}
          onClick={() => setConfirm(current.id + '/reapprove')}>{t('reviewTakeoverContinuation')}</Button>}
        {current.policyEnabled && confirm === current.id + '/reapprove' && <div>
          <p>{t('continuationConditions')}</p>
          <Button disabled={busy} onClick={() => void run(() => api('/recoveries/' + current.id + '/reapprove', 'POST', {
            confirm: current.id, policyRevision: current.currentPolicyRevision, phase: current.phase,
          }))}>{t('confirmContinuation')}</Button>{' '}
          <Button disabled={busy} onClick={() => setConfirm('')}>{t('back')}</Button>
        </div>}
      </div>}
      {current?.lastError && <p role="status">{t('lastCheck') + ' · ' + problem(current.lastError)}</p>}
      {error && <ErrorBanner message={problem(error)} />}
      {!current && paired.length > 1 && <Field label={t('targetDataVolume')}>
        <select className="input" value={selectedVolume} disabled={busy || cleanupPending}
          onChange={(event) => setVolume(event.target.value)}>
          <option value="">{t('selectAVerifiedDataVolume')}</option>
          {paired.map((target) => <option key={target.volumeId} value={target.volumeId}>{target.volumeId}</option>)}
        </select>
      </Field>}
      {!current && paired.length > 0 && (
        <Button
          disabled={busy || point.gapCount !== 0 || !selectedVolume || cleanupPending}
          onClick={() =>
            void run(() =>
              api('/recoveries', 'POST', {
                requestId: randomUUID(),
                policyId: policy.policyId,
                pointId: point.id,
                targetNode: policy.targetNodeId,
                targetVolume: selectedVolume,
              }),
            )
          }
        >
          {t('prepareReplacement')}
        </Button>
      )}
      {!current && options && !paired.length && <p role="status">{t('noVerifiedVolume')}</p>}
      {current?.targetActivatedAt && <div>
        <p>{t('runningOnReplacement')}</p>
        <Button disabled={busy} onClick={onReprotect}>{t('protectTheReplacement')}</Button>
      </div>}
      {step && confirm !== current!.id + '/' + step && (
        <Button disabled={busy} onClick={() => setConfirm(current!.id + '/' + step)}>
          {step === 'approve-retirement' ? t('reviewSourceRetirement') : t('reviewSwitch')}
        </Button>
      )}
      {step && confirm === current!.id + '/' + step && (
        <div>
          <p>{help}</p>
          <Button disabled={busy} onClick={() => void run(() => Promise.resolve(operate(step)))}>
            {t('confirm')}
          </Button>{' '}
          <Button disabled={busy} onClick={() => setConfirm('')}>
            {t('back')}
          </Button>
        </div>
      )}
      {current && ['prepared', 'target-ready', 'retire-approved', 'retiring'].includes(current.phase) && (
        <Button disabled={busy} onClick={() => void run(() => Promise.resolve(operate('cancel')))}>
          {t('cancelTakeover')}
        </Button>
      )}
      <Button disabled={busy} onClick={() => void run(() => Promise.resolve())}>
        {t('refreshTakeoverStatus')}
      </Button>
    </div>
  )
}
