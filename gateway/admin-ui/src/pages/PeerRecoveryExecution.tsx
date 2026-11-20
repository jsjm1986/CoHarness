/** Administrator review of new conversations and individually eligible recovery integrations. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ErrorBanner, Field, StatusBadge } from '../components/ui.tsx'
import { usePendingEdits } from '../pending-edits.tsx'
import type { CopyTranslate } from '../language.ts'
import type { PeerBackupCopyKey } from './peer-backup.copy.ts'

/** Translate execution review failures and node inspection reasons without exposing configuration content.
 * @param code - exact response error or inspection reason.
 * @param t - active Admin dictionary translator.
 * @returns localized guidance for a recognized execution outcome.
 */
export function recoveryExecutionMessage(code: string, t: CopyTranslate<PeerBackupCopyKey>): string | undefined {
  const keys: Record<string, PeerBackupCopyKey> = {
    'peer-backup/personal-recovery-installation-pending': 'personalRecoveryInstallationPending',
    'peer-backup/personal-session-platform-unsupported': 'personalSessionPlatformUnsupported',
    'peer-backup/personal-legacy-database-checkpoint-required': 'personalLegacyCheckpointRequired',
    'peer-backup/personal-session-evidence-incomplete': 'personalSessionEvidenceIncomplete',
    'peer-backup/personal-workspace-evidence-incomplete': 'personalWorkspaceEvidenceIncomplete',
    'peer-backup/invalid-plugin-inventory': 'personalEvidenceIncomplete',
    'peer-backup/personal-target-volume-mismatch': 'personalTargetVolumeMismatch',
    'peer-backup/point-mismatch': 'recoveryPointInvalid',
    'peer-backup/corrupt-point': 'recoveryPointInvalid',
    'peer-backup/invalid-export': 'recoveryPointInvalid',
    'peer-backup/invalid-target-files': 'personalTargetChanged',
    'peer-backup/replacement-must-be-empty': 'recoveryTargetMustBeEmpty',
    'peer-backup/personal-domain-unavailable': 'personalDomainUnavailable',
    'peer-backup/personal-owner-unavailable': 'personalOwnerUnavailable',
    'peer-backup/personal-quota-exceeded': 'personalQuotaExceeded',
    'peer-backup/personal-target-busy': 'personalTargetBusy',
    'peer-backup/personal-complete-point-required': 'personalCompletePointRequired',
    'peer-backup/personal-document-point-conflict': 'personalDocumentPointConflict',
    'peer-backup/personal-target-changed': 'personalTargetChanged',
    'peer-backup/personal-target-documents-exist': 'personalTargetDocumentsExist',
    'peer-backup/personal-recovery-unavailable': 'personalRecoveryUnavailable',
    'peer-backup/personal-complete-checkpoint-required': 'personalCompleteCheckpointRequired',
    'peer-backup/primary-required': 'primaryRequired',
    'peer-backup/recovery-operation-active': 'recoveryOperationActive',
    'peer-backup/execution-review-changed': 'takeoverChanged',
    'peer-backup/execution-runtime-busy': 'executionRuntimeBusy',
    'peer-backup/execution-not-published': 'executionNotPublished',
    'peer-backup/execution-target-not-local': 'executionTargetNotLocal',
    'peer-backup/project-owner-unavailable': 'checkOwnerAccess',
    'peer-backup/execution-profile-changed': 'executionProfileChanged',
    'peer-backup/execution-policy-migration-required': 'executionPolicyMigrationRequired',
    'peer-backup/execution-review-required': 'executionReviewRequired',
    'peer-backup/execution-policy-missing': 'executionPolicyMissing',
    'peer-backup/execution-item-unsupported': 'executionItemUnsupported',
    'peer-backup/execution-preparation-failed': 'executionPreparationFailed',
    'peer-backup/execution-protocol-upgrade-required': 'executionProtocolUpgradeRequired',
    'peer-backup/execution-not-provisioned': 'reviewTheBackupConfigurationOnThisComputer',
    'recovery-startup-proof-required': 'executionProofRequired',
    'recovery-dynamic-composition-unsupported': 'executionDynamicUnsupported',
    'include-unverifiable': 'executionIncludeUnverifiable',
    'dynamic-composition-unverifiable': 'executionDynamicUnsupported',
    'expression-unverifiable': 'executionExpressionUnverifiable',
    'hook-source-unavailable': 'executionHookSourceUnavailable',
    'artifact-unavailable': 'executionArtifactUnavailable',
    'custom-plugin-review-required': 'executionCustomReviewRequired',
    'execution-review-required': 'executionCapabilityReviewRequired',
    'Recovery has no approved Session persistence provider': 'executionPersistenceMissing',
  }
  const key = keys[code]
  if (key) return t(key)
  const missing = 'Required recovery plugin is unavailable: '
  if (code.startsWith(missing)) return t('executionRequiredPluginMissing', { name: code.slice(missing.length) })
  return undefined
}

interface ReviewItem {
  id: string
  kind: 'plugin' | 'external-connection'
  name: string
  itemDigest: string
  artifactSha256: string
  configurationSha256: string
  status: 'suspended' | 'eligible' | 'approved'
  reason?: string
}
interface ExecutionReview {
  recoveryMode: 'disaster' | 'planned'
  phase: string
  runtimeId: string
  pointId: string
  targetNodeId: string
  targetEpoch: string
  reviewRevision: string | null
  status: 'unprepared' | 'review-required' | 'new-conversations-enabled'
  preparationStatus: 'idle' | 'queued' | 'ready' | 'failed'
  errorCode: string | null
  oldSessionCount: number | null
  tasksSuspended: true
  sessionsReadOnly: true
  suspendedEnvironmentKeys?: string[]
  items: ReviewItem[]
  blockers: string[]
}
interface ReviewDraft {
  revision: string
  item?: ReviewItem
}
type Request = <T>(suffix: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>

/** Show only names of restored environment settings withheld from Runtime launch.
 * @param props - node-reported key names and the active Admin dictionary.
 * @returns an optional disclosure of settings requiring target-specific configuration.
 */
export function RecoveryEnvironmentNotice({ keys, t }: { keys?: readonly string[]; t: CopyTranslate<PeerBackupCopyKey> }) {
  if (!keys?.length) return null
  return <div className="peerBackupReviewItems"><details>
    <summary>{t('suspendedEnvironmentSettings', { count: String(keys.length) })}</summary>
    <p>{t('suspendedEnvironmentExplanation')}</p>
    <ul>{keys.map(key => <li key={key}><code>{key}</code></li>)}</ul>
  </details></div>
}

/** Render recovery execution review under the exact published replacement operation.
 * @param props - operation identity, authenticated Admin transport and localized feedback.
 * @returns new-conversation admission and per-item review controls; old work remains suspended.
 */
export function PeerRecoveryExecution({ operationId, scopeKind = 'project', request, t, message }: {
  operationId: string
  scopeKind?: 'project' | 'personal'
  request: Request
  t: CopyTranslate<PeerBackupCopyKey>
  message: (code: string) => string
}) {
  const base = (scopeKind === 'personal' ? '/personal-recoveries/' : '/recoveries/') + encodeURIComponent(operationId) + '/execution'
  const [review, setReview] = useState<ExecutionReview>()
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [draft, setDraft] = useState<ReviewDraft>(), [acknowledged, setAcknowledged] = useState(false)
  const [evidence, setEvidence] = useState('')
  const alive = useRef(false), sequence = useRef(0)
  const reading = useRef<AbortController | undefined>(undefined)
  const errorText = (cause: unknown): string => message(cause instanceof Error ? cause.message : String(cause))
  const refresh = useCallback(async (signal?: AbortSignal) => {
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    const active = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
    const token = ++sequence.current
    const next = await request<ExecutionReview>(base, 'GET', undefined, active)
    if (alive.current && !active.aborted && token === sequence.current) setReview(next)
  }, [base, request])
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    setLoading(true)
    void refresh(controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorText(cause))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { alive.current = false; controller.abort(); reading.current?.abort(); sequence.current++ }
  }, [refresh])
  usePendingEdits(busy || draft !== undefined)
  const run = async (action: () => Promise<unknown>, closeDraft = true): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
      if (!alive.current) return
      if (closeDraft) { setDraft(undefined); setAcknowledged(false); setEvidence('') }
      await refresh()
    } catch (cause) { if (alive.current) setError(errorText(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const begin = (item?: ReviewItem): void => {
    if (review?.reviewRevision == null) return
    setError('')
    setDraft({ revision: review.reviewRevision, ...(item ? { item } : {}) })
    setAcknowledged(false)
    setEvidence('')
  }
  const currentItem = draft?.item && review?.items.find(item => item.id === draft.item?.id)
  const currentDraft = draft !== undefined && review?.reviewRevision === draft.revision && review.preparationStatus === 'ready'
    && (draft.item === undefined ? review.status === 'review-required' && review.blockers.length === 0
      : currentItem?.status === 'eligible' && currentItem.itemDigest === draft.item.itemDigest)
  const itemStatus: Record<ReviewItem['status'], PeerBackupCopyKey> = {
    suspended: 'executionItemSuspended', eligible: 'executionItemEligible', approved: 'executionItemApproved',
  }
  const renderItem = (item: ReviewItem) => <div key={item.id} className="detailBlock">
          <div className="statusRow"><strong>{item.name}</strong><StatusBadge tone={item.status === 'approved' ? 'success' : 'neutral'}>
            {t(itemStatus[item.status])}</StatusBadge></div>
          <p>{t(item.kind === 'plugin' ? 'executionPlugin' : 'executionConnection')}</p>
          {item.reason && <p>{message(item.reason)}</p>}
          {item.status === 'suspended' && !item.reason && <p>{t('executionConfiguredInactive')}</p>}
          <details><summary>{t('executionItemVersions')}</summary>
            <p>{t('executionArtifactDigest')} <code>{item.artifactSha256}</code></p>
            <p>{t('executionConfigurationDigest')} <code>{item.configurationSha256}</code></p>
          </details>
          {item.status === 'eligible' && !draft && <Button disabled={busy || review?.preparationStatus !== 'ready'}
            onClick={() => begin(item)}>{t('executionReviewItem', { name: item.name })}</Button>}
        </div>
  return <section className="detailBlock" aria-label={t('executionReview')}>
    <strong>{t('executionReview')}</strong>
    <ErrorBanner message={error} />
    {loading && <p role="status">{t('executionLoading')}</p>}
    {review && <>
      <p role="status">{t(review.status === 'new-conversations-enabled' ? 'executionNewConversationsEnabled' : 'executionNewConversationsPending')}</p>
      <p>{t('executionHistoryReadOnly', { count: review.oldSessionCount === null ? '—' : String(review.oldSessionCount) })}</p>
      <p>{t('executionOldWorkSuspended')}</p>
      <RecoveryEnvironmentNotice keys={review.suspendedEnvironmentKeys} t={t} />
      {review.preparationStatus === 'queued' && <p role="status">{t('executionPreparing')}</p>}
      {review.errorCode && <p role="status">{message(review.errorCode)}</p>}
      {review.blockers.some(code => code !== review.errorCode) && <ul>{review.blockers.filter(code => code !== review.errorCode)
        .map(code => <li key={code}>{message(code)}</li>)}</ul>}
      {review.preparationStatus !== 'queued' && !draft && <Button disabled={busy}
        onClick={() => void run(() => request(base + '/prepare', 'POST', { confirm: operationId }))}>
        {t(review.preparationStatus === 'ready' ? 'executionRecheck' : 'executionPrepare')}</Button>}
      {review.preparationStatus === 'ready' && review.status === 'review-required' && !draft && <Button variant="primary"
        disabled={busy || review.reviewRevision === null || review.blockers.length > 0} onClick={() => begin()}>
        {t('executionReviewEnable')}</Button>}
      {review.items.length > 0 && <div className="peerBackupReviewItems">
        <strong>{t('executionItems')}</strong>
        <p>{t('executionItemsHelp')}</p>
        {review.items.filter(item => item.status === 'eligible').map(renderItem)}
        {review.items.some(item => item.status === 'suspended' && item.reason) && <details>
          <summary>{t('executionSuspendedItems', { count: String(review.items.filter(item => item.status === 'suspended' && item.reason).length) })}</summary>
          {review.items.filter(item => item.status === 'suspended' && item.reason).map(renderItem)}
        </details>}
        {review.items.some(item => item.status === 'approved' || !item.reason && item.status === 'suspended') && <details>
          <summary>{t('executionConfiguredItems', { count: String(review.items.filter(item => item.status === 'approved' || !item.reason && item.status === 'suspended').length) })}</summary>
          {review.items.filter(item => item.status === 'approved' || !item.reason && item.status === 'suspended').map(renderItem)}
        </details>}
      </div>}
      {draft && <div className="detailBlock">
        <strong>{draft.item ? t('executionReviewItem', { name: draft.item.name }) : t('executionReviewEnable')}</strong>
        <p>{t(draft.item ? 'executionItemConfirmation' : 'executionEnableConfirmation')}</p>
        {draft.item && <Field label={t('executionEvidence')} hint={t('isolationEvidenceHint')}>
          <input className="input" value={evidence} maxLength={512} disabled={busy} onChange={event => setEvidence(event.target.value)} />
        </Field>}
        <label className="checkLabel"><input type="checkbox" checked={acknowledged} disabled={busy}
          onChange={event => setAcknowledged(event.target.checked)} />{t(draft.item ? 'executionItemAcknowledgement' : 'executionEnableAcknowledgement')}</label>
        {!currentDraft && <p role="status">{t('takeoverChanged')}</p>}
        <div className="formActions">
          <Button variant="primary" disabled={busy || !currentDraft || !acknowledged || !!draft.item && !evidence.trim()}
            onClick={() => void run(() => draft.item
              ? request(base + '/items/' + encodeURIComponent(draft.item.id) + '/approve', 'POST', {
                confirm: operationId, reviewRevision: draft.revision, itemDigest: draft.item.itemDigest, evidenceReference: evidence.trim(),
              })
              : request(base + '/enable', 'POST', { confirm: operationId, reviewRevision: draft.revision, mode: 'new-conversations-only' }))}>
            {t(draft.item ? 'executionApproveItem' : 'executionEnable')}</Button>
          <Button disabled={busy} onClick={() => setDraft(undefined)}>{t('back')}</Button>
        </div>
      </div>}
    </>}
    <Button disabled={loading || busy} onClick={() => void run(() => Promise.resolve(), false)}>{t('executionRefresh')}</Button>
  </section>
}
