/** Organization-scoped online protection choices. Credentials never enter the form or browser storage. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeploymentNode } from '../api.ts'
import { adminLanguage, translateCopy, type CopyTranslate } from '../language.ts'
import { zh as copyZh, en as copyEn, type PeerBackupCopyKey } from './peer-backup.copy.ts'
import { randomUUID } from '../../../../packages/util/crypto/src/index.ts'
import { usePendingEdits, useProtectedNavigation } from '../pending-edits.tsx'
import { PeerRecoveryExecution, RecoveryEnvironmentNotice, recoveryExecutionMessage } from './PeerRecoveryExecution.tsx'
import { requestPeerBackup as api } from './peer-backup-request.ts'
import { Button, ConfirmDialog, ErrorBanner, Field, Section, StatusBadge } from '../components/ui.tsx'

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
  freshness?: 'current' | 'overdue' | 'unprotected'
  captureStoppedAt?: string | null
  retirementPointId?: string | null
  retirementPending?: boolean
  retirementNeedsReview?: boolean
  retiredAt?: string | null
  retirementCandidate?: { pointId: string; policyId: string; targetNodeId: string; protectedThrough: string } | null
  receiverCapacity?: {
    used: number; remaining: number; receiverUsed: number; receiverLimit: number; remainingObjects: number; measuredAt: string
    reason: 'policy-quota' | 'receiver-capacity' | 'disk-reserve' | 'object-limit'
  } | null
  receiverCapacityStale?: boolean
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
const err = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
const date = (value: string | null, zh: boolean): string =>
  value ? new Date(value).toLocaleString(zh ? 'zh-CN' : 'en-US') : '—'
const storage = (bytes: number, zh: boolean): string => {
  const mib = bytes >= 1048576
  return new Intl.NumberFormat(zh ? 'zh-CN' : 'en-US', { maximumFractionDigits: 1 }).format(bytes / (mib ? 1048576 : 1024))
    + (mib ? ' MiB' : ' KiB')
}
const capacityLimit: Record<NonNullable<Policy['receiverCapacity']>['reason'], PeerBackupCopyKey> = {
  'policy-quota': 'receiverLimitPolicy', 'receiver-capacity': 'receiverLimitShared',
  'disk-reserve': 'receiverLimitDisk', 'object-limit': 'receiverLimitObjects',
}

const scopeKindLabel: Record<Kind, PeerBackupCopyKey> = {
  project: 'projectSpace', personal: 'personalRuntime', governance: 'governanceDatabase',
}

/** Render within the existing primary deployment page after its entry scope is known. */
export function PeerBackupSection({ nodes }: { nodes: readonly DeploymentNode[] }) {
  const navigation = useProtectedNavigation()
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
  const [rotation, setRotation] = useState<{ original: Policy; successorId: string } | null>(null)
  const [retirement, setRetirement] = useState<{ row: Policy; candidate: NonNullable<Policy['retirementCandidate']> } | null>(null)
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
  usePendingEdits(editing || busy || retirement !== null)
  const name = (id: string): string => nodes.find((n) => n.nodeId === id)?.name ?? id
  const message = useCallback((value: string): string => {
    const execution = recoveryExecutionMessage(value, t)
    if (execution !== undefined) return execution
    const labels: Record<string, string> = {
      'peer-backup/recovery-access-required': t('recoveryReadRequired'),
      'peer-backup/recovery-access-changed': t('recoveryReadChanged'),
      'peer-backup/recovery-protocol-upgrade-required': t('recoveryProtocolUpgradeRequired'),
      'peer-backup/recovery-worker-unavailable': t('recoveryWorkerUnavailable'),
      'peer-backup/recovery-reader-owner-unavailable': t('checkOwnerAccess'),
      'peer-backup/recovery-point-denied': t('recoveryReadChanged'),
      'peer-backup/coverage-incomplete': t('thisPointHasUncoveredData'),
      'peer-backup/isolated-recovery-only': t('isolatedRecoveryOnly'),
      'peer-backup/independent-drill-required': t('rehearseOnDifferentComputer'),
      'peer-backup/verified-writer-fence-required': t('verifyWriterFenced'),
      'peer-backup/provisioning-required': t('provisionPolicyRoute'),
      'peer-backup/revision-conflict': t('refreshAndReviewTheUpdatedPolicy'),
      'peer-backup/recovery-in-progress': t('recoveryInProgress'),
      'peer-backup/repository-sealed': t('repositorySealed'),
      'peer-backup/rotation-requires-new-policy': t('repositoryRotationChanged'),
      'peer-backup/rotation-policy-changed': t('repositoryRotationChanged'),
      'peer-backup/repository-retirement-approved': t('repositoryRetirementStarted'),
      'peer-backup/repository-in-use': t('repositoryInUse'),
      'peer-backup/retirement-review-changed': t('refreshAndReviewTheUpdatedPolicy'),
      'peer-backup/retirement-verified-point-required': t('repositoryNeedsProof'),
      'peer-backup/invalid-configuration': t('reviewTheBackupConfigurationOnThisComputer'),
      'peer-backup/source-capacity': t('sourceCapacityExhausted'),
      'peer-backup/source-capacity-unavailable': t('sourceCapacityUnavailable'),
      'peer-backup/personal-directory-unpublished': t('personalDirectoryUnpublished'),
      'peer-backup/unavailable': t('theBackupServiceIsTemporarilyUnavailable'),
      'peer-backup/invalid-request': t('theRequestWasRejectedReviewTheFormValues'),
      'peer-backup/current-revision-drill-required': t('rehearseOriginalPoint'),
      'peer-backup/recovery-approval-changed': t('takeoverChanged'),
      'peer-backup/project-owner-unavailable': t('checkOwnerAccess'),
      'peer-backup/recovery-cleanup-pending': t('waitForCandidateCleanup'),
      'peer-backup/isolation-primary-forbidden': t('cannotIsolatePrimary'),
      'node-access/quarantined': t('computerQuarantined'),
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
        setSelected(old=>{const fresh=result.policies.find(row=>row.policyId===old?.policyId);return fresh??old})
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
  }, [selected?.policyId])
  useEffect(() => {
    if (!editing || !source || original || reprotecting || rotation) return
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
  }, [source, kind, editing, original, reprotecting, rotation])
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
    setRotation(null)
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
  function rotate(row: Policy) {
    edit(row)
    setOriginal(null)
    setAppend('')
    setRecover('')
    setRotation({ original: row, successorId: randomUUID() })
  }
  function protectReplacement(row: Policy, nodeId: string) {
    if (!navigation.canReplace()) return
    edit(null)
    setReprotecting(true)
    setSource(nodeId)
    setKind(row.scopeKind)
    setScope(row.scopeId)
    setChoices([{ id: row.scopeId, publicId: row.scopeId }])
  }
  const coverage = {
    current: t('completeCoverage'),
    partial: t('partial'),
    overdue: t('completeCoverage'),
    unprotected: t('noRecoveryPoint'),
  }
  return (
    <Section
      className="peerBackupSection"
      title={t('encryptedPeerBackups')}
      actions={
        <>
          <Button disabled={loading || busy} onClick={() => void refresh()}>
            {t('refresh')}
          </Button>{' '}
          <Button disabled={busy || editing || nodes.length < 2} onClick={() => { if (navigation.canReplace()) edit(null) }}>
            {t('addPolicy')}
          </Button>
        </>
      }
    >
      {!retirement && <ErrorBanner message={error} />}
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
            <StatusBadge tone={row.retiredAt || !row.enabled || row.captureStoppedAt ? 'neutral'
              : row.coverage === 'partial' || row.freshness === 'overdue' || row.coverage === 'overdue' ? 'warning'
                : row.coverage === 'current' ? 'success' : 'neutral'}>
              {row.retiredAt ? t('repositoryRetired') : row.retirementNeedsReview ? t('repositoryRetirementReviewRequired')
                : row.retirementPending ? t('repositoryRetirementStarted')
                  : row.captureStoppedAt && row.enabled ? t('repositorySealed') : row.enabled ? coverage[row.coverage] : t('paused')}
            </StatusBadge>
          </div>
          <p>
            {t('scope')} {t(scopeKindLabel[row.scopeKind])} · {row.scopeId} ·{' '}
            {row.tier === 'important' ? t('fifteenMin') : t('oneHour')}
          </p>
          <p>
            {t(row.retirementPointId ? 'formerPointProtectedThrough' : 'protectedThrough')} {date(row.protectedThrough, zh)} · {t('covered')}{' '}
            {row.coveredCount ?? '—'} · {t('gaps')} {row.gapCount ?? '—'}
          </p>
          {!row.retiredAt && row.freshness && row.freshness !== 'unprotected' && (
            <p>{t(row.freshness === 'overdue' ? 'backupFreshnessOverdue' : 'backupFreshnessCurrent')}</p>
          )}
          {row.scopeKind === 'personal' && <details>
            <summary>{t('personalProtectionCoverage')}</summary>
            <p>{t('personalProtectionExplanation')}</p>
          </details>}
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
          {row.receiverCapacity ? (
            <div className="muted">
              <p>{t('receiverUsage', {
                used: storage(row.receiverCapacity.used, zh), available: storage(row.receiverCapacity.remaining, zh),
                limit: t(capacityLimit[row.receiverCapacity.reason]),
              })}</p>
              <p>{t('receiverUsageShared', {
                used: storage(row.receiverCapacity.receiverUsed, zh), limit: storage(row.receiverCapacity.receiverLimit, zh),
                objects: String(row.receiverCapacity.remainingObjects),
              })}</p>
              <p>{t(row.receiverCapacityStale ? 'receiverCapacityStale' : 'receiverCapacityMeasured', {
                time: date(row.receiverCapacity.measuredAt, zh),
              })}</p>
            </div>
          ) : row.repositoryBytes != null && row.availableBytes != null && row.receiverCapacity === undefined ? (
            <p className="muted">
              {t('lastMeasuredStorage')} {Math.ceil(row.repositoryBytes / 1048576)} MiB ·{' '}
              {t('available')} {Math.floor(row.availableBytes / 1048576)} MiB
            </p>
          ) : !row.retiredAt && <p className="muted">{t('receiverCapacityUnavailable')}</p>}
          {!row.retiredAt && !row.retirementCandidate && (row.retirementNeedsReview || (!row.retirementPending && row.captureStoppedAt)) && (
            <p className="fieldHint">{t('repositoryNeedsProof')}</p>
          )}
          <details>
            <summary>{t('deploymentIdentity')}</summary>
            <code>{row.policyId}</code>
          </details>
          {row.errorCode && <p role="status">{message(row.errorCode)}</p>}
          <div className="formActions">
            <Button
              disabled={busy || !row.enabled || !!row.captureStoppedAt}
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
              disabled={busy || !!row.retirementPointId}
              onClick={() => {
                if (!navigation.canReplace()) return
                setEditing(false)
                setSelected(row)
                setReplacement(row.targetNodeId)
              }}
            >
              {t('recoveryPointsAndDrills')}
            </Button>
            <Button disabled={busy || !!row.retirementPointId} onClick={() => { if (navigation.canReplace()) edit(row) }}>
              {t('editPolicy')}
            </Button>
            {row.enabled && !row.captureStoppedAt && row.freshness !== undefined && (
              <Button disabled={busy} onClick={() => { if (navigation.canReplace()) rotate(row) }}>
                {t('rotateRepository')}
              </Button>
            )}
            {row.retirementCandidate && (
              <Button disabled={busy} onClick={() => {
                if (navigation.canReplace()) {
                  setError('')
                  setRetirement({ row, candidate: row.retirementCandidate! })
                }
              }}>{t('reviewRepositoryRetirement')}</Button>
            )}
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
                id: rotation?.successorId ?? original?.policyId ?? randomUUID(),
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
                ...(rotation ? { replacementOf: { policyId: rotation.original.policyId, revision: rotation.original.revision } } : {}),
              })
              setEditing(false)
              setNotice(t(rotation ? 'repositoryRotated' : 'backupPolicySaved'))
              await refresh()
            })
          }}
        >
          {reprotecting && <p role="status">{t(kind === 'personal' ? 'protectTransferredPersonal' : 'protectTransferredProject')}</p>}
          {rotation && <p>{t('repositoryRotationProvisioning', { id: rotation.successorId })}</p>}
          <Field label={t('sourceComputer')}>
            <select
              className="input"
              required
              disabled={!!original || reprotecting || !!rotation || busy}
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
              disabled={!!original || reprotecting || !!rotation || busy}
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
              disabled={!!original || reprotecting || !!rotation || busy}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              {original || rotation ? (
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
          {moreChoices && !original && !reprotecting && !rotation && (
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
              readOnly={!!original?.captureStoppedAt}
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
            <input type="checkbox" checked={enabled} disabled={!!rotation} onChange={(e) => setEnabled(e.target.checked)} />
            {t('enablePolicy')}
          </label>
          <div className="formActions">
            <Button type="submit" variant="primary" disabled={busy || !scope || !target || append === recover}>
              {t(rotation ? 'rotateRepository' : 'savePolicy')}
            </Button>
            <Button type="button" disabled={busy} onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
      {retirement && (
        <ConfirmDialog open title={t('reviewRepositoryRetirement')}
          description={t('confirmRepositoryRetirement', {
            old: name(retirement.row.targetNodeId), oldPolicy: retirement.row.policyId,
            target: name(retirement.candidate.targetNodeId), point: retirement.candidate.pointId,
            when: date(retirement.candidate.protectedThrough, zh),
          })}
          confirmLabel={t('retireRepository')} pending={busy} error={error}
          onClose={() => { if (!busy) { setRetirement(null); setError('') } }}
          onConfirm={() => void run(async () => {
            await api('/' + retirement.row.policyId + '/retire', 'POST', {
              confirm: retirement.row.policyId, revision: retirement.row.revision, pointId: retirement.candidate.pointId,
            })
            setRetirement(null)
            setSelected(null)
            setNotice(t('repositoryRetirementStarted'))
            await refresh()
          })}
        />
      )}
      {selected && (
        <div className="detailBlock">
          <Field label={t('recoveryPoint')}>
            <select className="input" value={point} onChange={(e) => { if (navigation.canReplace()) setPoint(e.target.value) }}>
              {points.map((p) => (
                <option key={p.id} value={p.id}>
                  {date(p.protectedThrough, zh)} · {t('gaps')} {p.gapCount}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('independentRehearsalComputer')}>
            <select className="input" value={replacement} onChange={(e) => {if(navigation.canReplace()){setReplacement(e.target.value);setNotice('')}}}>
              {replacement&&!nodes.some(node=>node.nodeId===replacement)&&<option value={replacement}>{replacement}</option>}
              {nodes
                .filter((n) => n.nodeId !== selected.sourceNodeId)
                .map((n) => (
                  <option key={n.nodeId} value={n.nodeId} disabled={n.status!=='active'}>
                    {n.name}
                  </option>
                ))}
            </select>
          </Field>
          <p>{t('backupComputer')} · {name(selected.targetNodeId)}</p>
          {selected.scopeKind!=='governance'&&replacement&&replacement!==selected.targetNodeId&&point&&<PeerRecoveryReadAccess
            key={selected.policyId+'/'+point+'/'+replacement} policy={selected} pointId={point} nodeId={replacement} t={t} message={message}/>}
          {localWorker?.recovery && selected.scopeKind !== 'governance' && point && (
            <PeerRecoveryActions
              key={selected.policyId + '/' + point}
              policy={selected}
              point={points.find((row) => row.id === point)!}
              replacement={replacement}
              nodeName={name(replacement)}
              name={name}
              sourceName={name(selected.sourceNodeId)}
              t={t}
              message={message}
              onReprotect={(nodeId) => protectReplacement(selected,nodeId)}
            />
          )}
          <div className="formActions">
            <Button
              disabled={busy || !point || !replacement || !nodes.some(node=>node.nodeId===replacement&&node.status==='active')}
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
              disabled={busy || !point || !replacement || !nodes.some(node=>node.nodeId===replacement&&node.status==='active')}
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
            <Button disabled={busy} onClick={() => { if (navigation.canReplace()) setSelected(null) }}>
              {t('close')}
            </Button>
          </div>
        </div>
      )}
    </Section>
  )
}

function PeerRecoveryReadAccess({policy,pointId,nodeId,t,message}:{policy:Policy;pointId:string;nodeId:string;
  t:CopyTranslate<PeerBackupCopyKey>;message:(code:string)=>string}) {
  const [reviewRevision,setReviewRevision]=useState(policy.revision)
  const requestId=useRef(randomUUID())
  const [fingerprint,setFingerprint]=useState(''),[expires,setExpires]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [state,setState]=useState<{maxLifetimeMs:number|null;items:{id:string;pointId:string;recoveryNodeId:string;policyRevision:number;expiresAt:string;revokedAt:string|null}[]}>()
  const alive=useRef(false)
  const refresh=useCallback(async(signal?:AbortSignal)=>{
    const value=await api<NonNullable<typeof state>>('/'+policy.policyId+'/recovery-access','GET',undefined,signal)
    if(alive.current&&!signal?.aborted)setState(value)
  },[policy.policyId])
  useEffect(()=>{alive.current=true;const ctl=new AbortController();void refresh(ctl.signal).catch(cause=>{if(!ctl.signal.aborted)setError(err(cause))})
    return()=>{alive.current=false;ctl.abort()}},[refresh])
  usePendingEdits(busy||!!fingerprint||!!expires)
  async function mutate(action:()=>Promise<unknown>,clearSubmittedDraft=false){
    if(busy)return
    setBusy(true);setError('')
    try{await action();if(alive.current){if(clearSubmittedDraft){setFingerprint('');setExpires('');requestId.current=randomUUID()}await refresh()}}
    catch(cause){if(alive.current)setError(err(cause))}finally{if(alive.current)setBusy(false)}
  }
  const approvals=state?.items.filter(row=>row.pointId===pointId&&row.recoveryNodeId===nodeId&&!row.revokedAt)??[]
  return <details className="detailBlock">
    <summary>{t('replacementReadAccess')}</summary>
    <p>{t('replacementReadScope')}</p>
    {reviewRevision!==policy.revision&&<div role="status"><p>{t('refreshAndReviewTheUpdatedPolicy')}</p>
      <Button disabled={busy} onClick={()=>{setReviewRevision(policy.revision);requestId.current=randomUUID()}}>{t('reviewReadPolicyRevision')}</Button></div>}
    {error&&<ErrorBanner message={message(error)}/>}
    {approvals.map(row=><div key={row.id}><p>{t('readApprovalExpiry',{time:date(row.expiresAt,adminLanguage()==='zh')})}</p>
      <Button disabled={busy} onClick={()=>void mutate(()=>api('/'+policy.policyId+'/recovery-access/'+row.id+'/revoke','POST',{confirm:row.id}))}>{t('revokeReadApproval')}</Button></div>)}
    <form aria-label={t('replacementReadAccess')} onSubmit={event=>{event.preventDefault();void mutate(()=>api('/'+policy.policyId+'/recovery-access','POST',{
      id:requestId.current,expectedRevision:reviewRevision,pointId,recoveryNodeId:nodeId,fingerprint,expiresAt:new Date(expires).toISOString(),
    }),true)}}>
      <Field label={t('replacementReadFingerprint')} hint={t('replacementReadProvisioning')}>
        <input className="input" name="fingerprint" required pattern="[a-f0-9]{64}" autoComplete="off" autoCapitalize="none" spellCheck={false}
          value={fingerprint} disabled={busy} onChange={event=>{setFingerprint(event.target.value);requestId.current=randomUUID()}}/>
      </Field>
      <Field label={t('readApprovalExpires')} hint={state?.maxLifetimeMs?t('readApprovalMax',{minutes:String(state.maxLifetimeMs/60000)}):undefined}>
        <input className="input" name="expires" type="datetime-local" required value={expires} disabled={busy} onChange={event=>{setExpires(event.target.value);requestId.current=randomUUID()}}/>
      </Field>
      <Button type="submit" disabled={busy||!state?.maxLifetimeMs}>{t('approveReplacementRead')}</Button>
    </form>
  </details>
}

interface RecoveryAttempt {
  repositoryNodeId?: string
  targetNodeId?: string
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
  recoveryMode?: 'planned' | 'disaster'
  sourceNodeId?: string
  sourceGeneration?: string
  sourceEpoch?: string
  schedulesSuspended?: boolean
  executionReviewRequired?: boolean
  executionPolicyTransferRequired?: boolean
  suspendedEnvironmentKeys?: string[]
  executionBlockers?: string[]
  isolation?: { method: 'power-off' | 'network-isolation'; evidenceReference: string; confirmedAt: string; confirmedBy: string } | null
}
interface RecoveryOptions {
  targets: { nodeId: string; volumeId: string }[]
  attempts: RecoveryAttempt[]
}

function PeerRecoveryActions({
  policy,
  point,
  nodeName,
  sourceName,
  replacement,
  name,
  t,
  message,
  onReprotect,
}: {
  policy: Policy
  point: Point
  nodeName: string
  sourceName: string
  replacement: string
  name: (nodeId:string)=>string
  t: CopyTranslate<PeerBackupCopyKey>
  message: (code: string) => string
  onReprotect: (nodeId:string) => void
}) {
  const personal = policy.scopeKind === 'personal'
  const recoveryBase = personal ? '/personal-recoveries' : '/recoveries'
  const [options, setOptions] = useState<RecoveryOptions>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState(''),
    [volume, setVolume] = useState(''),
    [recoveryMode, setRecoveryMode] = useState<'planned' | 'disaster'>(personal ? 'disaster' : 'planned'),
    [isolationDraft, setIsolationDraft] = useState<RecoveryAttempt>(),
    [isolationMethod, setIsolationMethod] = useState<'power-off' | 'network-isolation'>('power-off'),
    [evidenceReference, setEvidenceReference] = useState(''),
    [isolated, setIsolated] = useState(false),
    [acceptLoss, setAcceptLoss] = useState(false)
  const alive = useRef(false),
    generation = useRef(0)
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const request = ++generation.current
      const data = await api<RecoveryOptions>(
        recoveryBase + '?policyId=' + encodeURIComponent(policy.policyId),
        'GET',
        undefined,
        signal,
      )
      if (alive.current && !signal?.aborted && request === generation.current) {
        setOptions(data)
        const eligible=data.targets.filter(row=>row.nodeId===replacement)
        setVolume(previous=>previous||(eligible.length===1?eligible[0]!.volumeId:''))
      }
    },
    [policy.policyId, policy.revision, recoveryBase, replacement],
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
  usePendingEdits(busy || !!confirm || !!isolationDraft || (!personal && !current && recoveryMode === 'disaster'))
  const paired = options?.targets.filter((target) => target.nodeId === replacement) ?? []
  useEffect(()=>{setVolume('');setConfirm('');setIsolationDraft(undefined);setIsolated(false);setAcceptLoss(false)},[replacement,policy.revision])
  const selectedVolume = paired.some((target) => target.volumeId === volume)
    ? volume : ''
  const cleanupPending = options?.attempts.some((attempt) => attempt.cleanupPending)
  const labels: Record<string, string> = {
    preparing: t(personal?'personalPointVerification':'projectPointVerification'),
    activating: t('switchingOwnership'),
    prepared: current?.recoveryMode === 'disaster' ? t('waitingForIsolation') : t('preparingReplacement'),
    'externally-fenced': t(personal ? 'isolatedReplacementVerified' : 'preparingIsolatedReplacement'),
    'disaster-ready': t('isolatedReplacementVerified'),
    'target-ready': t('replacementVerified'),
    'retire-approved': t('waitingForSourceToConfirmItHasStopped'),
    retiring: t('fencingSourceWriter'),
    retreat: t('resolvingSourceFence'),
    'old-fenced': t('sourceWriterFenced'),
    switching: t('switchingOwnership'),
    published: current?.targetActivatedAt
      ? current.executionReviewRequired ? t('replacementDataRestored') : t('replacementIsServing')
      : t('waitingForFinalVerification'),
  }
  const problem = message
  const run = async (action: () => Promise<unknown>, closeConfirmation = true) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
      if (alive.current) {
        if (closeConfirmation) {
          setConfirm('')
          setIsolationDraft(undefined)
          setIsolated(false)
          setAcceptLoss(false)
        }
        await refresh()
      }
    } catch (cause) {
      if (alive.current) setError(err(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const operate = (action: string) =>
    current && api(recoveryBase + '/' + current.id + '/' + action, 'POST', { confirm: current.id })
  const step = current?.reapprovalRequired ? undefined :
    personal ? current?.phase === 'externally-fenced' ? 'activate' : undefined :
    current?.phase === 'target-ready' ? 'approve-retirement' :
      current?.phase === 'old-fenced' || current?.phase === 'disaster-ready' ? 'activate' : undefined
  const canConfirmIsolation = current?.recoveryMode === 'disaster' && current.phase === 'prepared' &&
    !current.reapprovalRequired && current.policyEnabled && current.pointId === point.id &&
    current.sourceNodeId === policy.sourceNodeId && !!current.sourceGeneration && !!current.sourceEpoch
  const unchangedIsolation = isolationDraft && current && isolationDraft.id === current.id &&
    isolationDraft.currentPolicyRevision === current.currentPolicyRevision &&
    isolationDraft.sourceGeneration === current.sourceGeneration && isolationDraft.sourceEpoch === current.sourceEpoch &&
    isolationDraft.sourceNodeId === current.sourceNodeId && isolationDraft.pointId === current.pointId &&
    isolationDraft.targetNodeId===current.targetNodeId && isolationDraft.repositoryNodeId===current.repositoryNodeId
  const help =
    step === 'approve-retirement'
      ? t('confirmFenceNotice')
      : t(personal ? 'personalConfirmSwitch' : 'confirmSwitch', { name: current?.targetNodeId?name(current.targetNodeId):nodeName })
  return (
    <div className="detailBlock">
      <strong>{t(personal ? 'personalTakeover' : 'projectTakeover')}</strong>
      {personal && !current && <p>{t('personalTakeoverPreparation')}</p>}
      <p>{current ? labels[current.phase] : t('replacementComputer') + ' · ' + nodeName}</p>
      {current?.targetNodeId&&<p>{t('replacementComputer')} · {name(current.targetNodeId)}</p>}
      {current && current.pointId !== point.id && <p role="status">{t('takeoverConflict')}</p>}
      {!!current?.affectedMemberCount && <p role="status">{t(
        'memberAccessNotice', { count: String(current.affectedMemberCount) })}</p>}
      {cleanupPending && <p role="status">{t('candidateCleanupPending')}</p>}
      {current?.reapprovalRequired && !['switching', 'published'].includes(current.phase) && <div role="status">
        <p>{current.policyEnabled ? t('policyRevisionChanged', {
          from: String(current.policyRevision), to: String(current.currentPolicyRevision),
        }) : t('policyPausedRehearse')}</p>
        {current.policyEnabled && confirm !== current.id + '/reapprove' && <Button disabled={busy}
          onClick={() => setConfirm(current.id + '/reapprove')}>{t('reviewTakeoverContinuation')}</Button>}
        {current.policyEnabled && confirm === current.id + '/reapprove' && <div>
          <p>{t('continuationConditions')}</p>
          <Button disabled={busy} onClick={() => void run(() => api(recoveryBase + '/' + current.id + '/reapprove', 'POST', {
            confirm: current.id, policyRevision: current.currentPolicyRevision, phase: current.phase,
          }))}>{t('confirmContinuation')}</Button>{' '}
          <Button disabled={busy} onClick={() => setConfirm('')}>{t('back')}</Button>
        </div>}
      </div>}
      {current?.lastError && <p role="status">{t('lastCheck') + ' · ' + problem(current.lastError)}</p>}
      {error && <ErrorBanner message={problem(error)} />}
      {!personal && !current && <Field label={t('recoveryMethod')}>
        <select className="input" value={recoveryMode} disabled={busy || cleanupPending}
          onChange={(event) => setRecoveryMode(event.target.value as 'planned' | 'disaster')}>
          <option value="planned">{t('plannedReplacement')}</option>
          <option value="disaster">{t('disasterReplacement')}</option>
        </select>
      </Field>}
      {!personal && !current && recoveryMode === 'disaster' && <p role="status">{t('disasterPreparationNotice')}</p>}
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
              api(recoveryBase, 'POST', {
                requestId: randomUUID(),
                policyId: policy.policyId,
                pointId: point.id,
                targetNode: replacement,
                targetVolume: selectedVolume,
                ...(personal ? {} : { recoveryMode }),
              }),
            )
          }
        >
          {t('prepareReplacement')}
        </Button>
      )}
      {!current && options && !paired.length && <p role="status">{t('noVerifiedVolume')}</p>}
      {current?.targetActivatedAt && <div>
        <p>{current.executionReviewRequired ? t(personal ? 'personalProtectRestoredData' : 'protectRestoredData') : t('runningOnReplacement')}</p>
        <Button disabled={busy} onClick={()=>onReprotect(current.targetNodeId??policy.targetNodeId)}>{t('protectTheReplacement')}</Button>
      </div>}
      {current?.executionPolicyTransferRequired && <p role="status">{t('executionPolicyTransferRequired')}</p>}
      {current?.schedulesSuspended && <p role="status">{t('restoredSchedulesSuspended')}</p>}
      {!current?.targetActivatedAt && <RecoveryEnvironmentNotice keys={current?.suspendedEnvironmentKeys} t={t} />}
      {current?.executionReviewRequired && !current.targetActivatedAt && <p role="status">{t('restoredExecutionRequiresReview')}</p>}
      {current?.targetActivatedAt && current.executionReviewRequired && <PeerRecoveryExecution key={current.id}
        operationId={current.id} scopeKind={personal ? 'personal' : 'project'} request={api} t={t} message={message} />}
      {current?.isolation && <p>{t('recordedIsolation', { reference: current.isolation.evidenceReference })}</p>}
      {canConfirmIsolation && !isolationDraft && <Button disabled={busy} onClick={() => {
        setIsolationDraft(current)
        setIsolated(false)
        setAcceptLoss(false)
      }}>{t('recordSourceIsolation')}</Button>}
      {isolationDraft && <div>
        <p>{t('isolateWholeComputer', { name: sourceName })}</p>
        <p>{t('recoveryPointLoss', { time: date(point.protectedThrough, adminLanguage() === 'zh') })}</p>
        <Field label={t('isolationMethod')}>
          <select className="input" value={isolationMethod} disabled={busy}
            onChange={(event) => setIsolationMethod(event.target.value as 'power-off' | 'network-isolation')}>
            <option value="power-off">{t('poweredOff')}</option>
            <option value="network-isolation">{t('networkIsolated')}</option>
          </select>
        </Field>
        <Field label={t('isolationEvidence')} hint={t('isolationEvidenceHint')}>
          <input className="input" value={evidenceReference} maxLength={512} disabled={busy}
            onChange={(event) => setEvidenceReference(event.target.value)} />
        </Field>
        <label className="checkLabel"><input type="checkbox" checked={isolated} disabled={busy}
          onChange={(event) => setIsolated(event.target.checked)} />{t('confirmPhysicalIsolation')}</label>
        <label className="checkLabel"><input type="checkbox" checked={acceptLoss} disabled={busy}
          onChange={(event) => setAcceptLoss(event.target.checked)} />{t('acknowledgeRecoveryLoss')}</label>
        {(!canConfirmIsolation || !unchangedIsolation) && <p role="status">{t('takeoverChanged')}</p>}
        <div className="formActions">
          <Button variant="danger" disabled={busy || !canConfirmIsolation || !unchangedIsolation ||
            !isolated || !acceptLoss || !evidenceReference.trim()} onClick={() => void run(() =>
            api(recoveryBase + '/' + isolationDraft.id + '/confirm-isolation', 'POST', {
              confirm: isolationDraft.id,
              policyRevision: isolationDraft.currentPolicyRevision,
              sourceNodeId: isolationDraft.sourceNodeId,
              sourceGeneration: isolationDraft.sourceGeneration,
              sourceEpoch: isolationDraft.sourceEpoch,
              pointId: isolationDraft.pointId,
              isolationMethod,
              evidenceReference: evidenceReference.trim(),
              acknowledgeDataLoss: true,
            }))}>{t('confirmIsolationAndPrepare')}</Button>
          <Button disabled={busy} onClick={() => setIsolationDraft(undefined)}>{t('back')}</Button>
        </div>
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
      {current && (personal ? ['preparing', 'prepared'] : ['prepared', 'target-ready', 'retire-approved', 'retiring']).includes(current.phase) && (
        <Button disabled={busy} onClick={() => void run(() => Promise.resolve(operate('cancel')))}>
          {t('cancelTakeover')}
        </Button>
      )}
      <Button disabled={busy} onClick={() => void run(() => Promise.resolve(), false)}>
        {t('refreshTakeoverStatus')}
      </Button>
    </div>
  )
}
