/** Deployment control: maintenance windows, node convergence, backups, restore requests, and the operation ledger. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { NodeConfigurationSection } from './NodeConfigurationSection.tsx'
import { NODE_CONFIG_FIELDS } from '../../../src/node-config-fields.ts'
import { DatabaseBackup, HardDriveDownload, RefreshCw, ShieldCheck, Wrench } from 'lucide-react'
import {
  createBackup, getDeployment, listBackups, requestDeploymentRestore, setDeploymentNodeStatus,
  setMaintenance, verifyBackup, inspectBackupNodeConfiguration, getNodeConfiguration,
  type BackupNodeConfigurationPreview, type NodeConfigurationView, type DeploymentBackup, type DeploymentNode, type DeploymentState,
} from '../api.ts'
import {
  Button, ConfirmDialog, Dialog, EmptyState, ErrorBanner, Field, IconButton, LoadingState,
  PageHeader, Section, StatusBadge,
} from '../components/ui.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as copyZh, en as copyEn, type DeploymentCopyKey } from './deployment.copy.ts'

const messageOf = (error: unknown): string => error instanceof Error
  ? error.message
  : translateCopy(adminLanguage(), { zh: copyZh, en: copyEn })('operationFailed')

const MODE_LABEL: Record<DeploymentState['mode'], { labelKey: DeploymentCopyKey; tone: 'success' | 'warning' | 'danger' }> = {
  serving: { labelKey: 'modeServing', tone: 'success' },
  maintenance: { labelKey: 'modeMaintenance', tone: 'warning' },
  restoring: { labelKey: 'modeRestoring', tone: 'danger' },
}

const NODE_STATUS_LABEL: Record<DeploymentNode['status'], { labelKey: DeploymentCopyKey; tone: 'success' | 'warning' | 'neutral' }> = {
  active: { labelKey: 'nodeActive', tone: 'success' },
  draining: { labelKey: 'nodeDraining', tone: 'warning' },
  offline: { labelKey: 'nodeOffline', tone: 'neutral' },
}

const BACKUP_STATUS_LABEL: Record<DeploymentBackup['status'], { labelKey: DeploymentCopyKey; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }> = {
  recording: { labelKey: 'backupRecording', tone: 'info' },
  verified: { labelKey: 'backupVerified', tone: 'success' },
  failed: { labelKey: 'backupFailed', tone: 'danger' },
  restored: { labelKey: 'backupRestored', tone: 'warning' },
}

function heartbeatText(node: DeploymentNode): string {
  const t = translateCopy(adminLanguage(), { zh: copyZh, en: copyEn })
  if (node.lastHeartbeatAt === null) return t('heartbeatNever')
  if (node.heartbeatAgeMs === null) return node.lastHeartbeatAt
  if (node.heartbeatAgeMs < 60_000) return t('heartbeatSecondsAgo', { value: String(Math.round(node.heartbeatAgeMs / 1000)) })
  return t('heartbeatMinutesAgo', { value: String(Math.round(node.heartbeatAgeMs / 60_000)) })
}

export function DeploymentPage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: copyZh, en: copyEn }), [])
  const [state, setState] = useState<DeploymentState | null>(null)
  const [backups, setBackups] = useState<DeploymentBackup[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reason, setReason] = useState('')
  const [acting, setActing] = useState(false)
  const [restoring, setRestoring] = useState<DeploymentBackup | null>(null)
  const [exiting, setExiting] = useState(false)
  const [configurationPreview, setConfigurationPreview] = useState<{ backup: BackupNodeConfigurationPreview; current: NodeConfigurationView } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [next, list] = await Promise.all([getDeployment(), listBackups()])
      setState(next)
      setBackups(list.backups)
      setError('')
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 10_000)
    return () => { clearInterval(timer) }
  }, [refresh])

  const run = async (work: () => Promise<unknown>, ok: string) => {
    setActing(true)
    setError('')
    setNotice('')
    try {
      await work()
      setNotice(ok)
      await refresh()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setActing(false)
    }
  }

  const mode = state === null ? null : MODE_LABEL[state.mode]

  return (
    <div>
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={<IconButton label={t('refresh')} icon={RefreshCw} onClick={() => void refresh()} />}
      />
      <ErrorBanner message={error} />
      {notice === '' ? null : <p role="status">{notice}</p>}

      <Section title={t('clusterTitle')} meta={state === null ? undefined : t('writeEpochMeta', { value: state.writeEpoch })}>
        {state === null || mode === null ? <LoadingState label={t('loadingCluster')} /> : (
          <div className="deploymentStatus">
            <div className="statusRow">
              <StatusBadge tone={mode.tone}>{t(mode.labelKey)}</StatusBadge>
              <StatusBadge tone={state.writersQuiesced ? 'success' : 'warning'}>
                {state.writersQuiesced ? t('writersQuiesced') : t('writersNotQuiesced')}
              </StatusBadge>
              <span className="sectionMeta">{t('maintenanceEpochMeta', { value: state.maintenanceEpoch })}</span>
            </div>
            {state.reason === null ? null : <p>{t('maintenanceReasonLine', { reason: state.reason })}</p>}
            {state.mode === 'serving' ? (
              <>
                <Field label={t('fieldReason')} hint={t('hintReason')}>
                  <input className="input" value={reason} onChange={event => { setReason(event.target.value) }} placeholder={t('placeholderReason')} />
                </Field>
                <div className="formActions">
                  <Button variant="primary" icon={Wrench} disabled={acting}
                    onClick={() => void run(() => setMaintenance('enter', reason.trim() === '' ? undefined : reason.trim()), t('noticeEnteredMaintenance'))}>
                    {t('enterMaintenance')}
                  </Button>
                </div>
              </>
            ) : (
              <div className="statusRow">
                {state.mode === 'maintenance' ? (
                  <Button variant="primary" disabled={acting} onClick={() => { setExiting(true) }}>{t('exitMaintenance')}</Button>
                ) : (
                  <p>{t('restoringHint')}</p>
                )}
              </div>
            )}
          </div>
        )}
      </Section>

      <NodeConfigurationSection />

      <Section title={t('nodesTitle')} meta={t('nodesMeta')}>
        {state === null ? null : state.nodes.length === 0 ? <EmptyState title={t('nodesEmpty')} /> : (
          <div className="tableWrap" role="region" aria-label={t('nodesTableAria')} tabIndex={0}>
            <table className="dataTable">
              <thead><tr><th>{t('columnName')}</th><th>{t('columnStatus')}</th><th>{t('columnHeartbeat')}</th><th>{t('columnEpoch')}</th><th>{t('columnInflight')}</th><th>{t('columnRuntimes')}</th><th>{t('columnQuiesced')}</th><th>{t('columnActions')}</th></tr></thead>
              <tbody>
                {state.nodes.map(node => (
                  <tr key={node.nodeId}>
                    <td><code>{node.name}</code></td>
                    <td><StatusBadge tone={NODE_STATUS_LABEL[node.status].tone}>{t(NODE_STATUS_LABEL[node.status].labelKey)}</StatusBadge></td>
                    <td>{heartbeatText(node)}</td>
                    <td>{node.maintenanceAppliedEpoch}</td>
                    <td>{node.inflightWrites < 0 ? t('inflightUnreported') : node.inflightWrites}</td>
                    <td>{node.activeRuntimes}</td>
                    <td>{node.quiesced ? t('yes') : t('no')}</td>
                    <td>
                      {node.status === 'active' ? (
                        <Button variant="ghost" disabled={acting}
                          onClick={() => void run(() => setDeploymentNodeStatus(node.nodeId, 'draining'), t('noticeNodeDrained', { name: node.name }))}>{t('drain')}</Button>
                      ) : null}
                      {node.status === 'draining' ? (
                        <Button variant="ghost" disabled={acting}
                          onClick={() => void run(() => setDeploymentNodeStatus(node.nodeId, 'active'), t('noticeNodeRestored', { name: node.name }))}>{t('restoreOnline')}</Button>
                      ) : null}
                      {node.status !== 'offline' ? (
                        <Button variant="ghost" disabled={acting}
                          onClick={() => void run(() => setDeploymentNodeStatus(node.nodeId, 'offline'), t('noticeNodeOffline', { name: node.name }))}>{t('markOffline')}</Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={t('migrationsTitle')} meta={t('migrationsMeta')}>
        {state === null ? null : state.migrations === null ? <EmptyState title={t('migrationsUnavailable')} /> : (
          <div>
            <p>{t('migrationsSummary', { current: String(state.migrations.current), count: String(state.migrations.applied.length) })}</p>
            {state.migrations.drifted.length === 0 ? null : (
              <ErrorBanner message={t('migrationsDrift', { names: state.migrations.drifted.join(t('listSeparator')) })} />
            )}
            {state.migrations.pending.length === 0 ? <p>{t('migrationsNone')}</p> : (
              <p>{t('migrationsPending', { names: state.migrations.pending.map(migration => migration.name).join(t('listSeparator')) })}</p>
            )}
          </div>
        )}
      </Section>

      <Section
        title={t('backupsTitle')}
        meta={t('backupsMeta')}
        actions={<Button icon={DatabaseBackup} disabled={acting || state?.mode !== 'maintenance' || !state.writersQuiesced}
          onClick={() => void run(async () => { await createBackup() }, t('noticeBackupDone'))}>{t('backupNow')}</Button>}
      >
        {backups === null ? <LoadingState label={t('loadingBackups')} /> : backups.length === 0 ? (
          <EmptyState title={t('backupsEmptyTitle')} detail={t('backupsEmptyDetail')} />
        ) : (
          <div className="tableWrap" role="region" aria-label={t('backupsTableAria')} tabIndex={0}>
            <table className="dataTable">
              <thead><tr><th>{t('columnPath')}</th><th>{t('columnMigration')}</th><th>{t('columnWriteEpoch')}</th><th>{t('columnSize')}</th><th>{t('columnStatus')}</th><th>{t('columnCreatedAt')}</th><th>{t('columnActions')}</th></tr></thead>
              <tbody>
                {backups.map(backup => (
                  <tr key={backup.id}>
                    <td><code>{backup.path}</code></td>
                    <td>{backup.migrationVersion}</td>
                    <td>{backup.writeEpoch}</td>
                    <td>{backup.sizeBytes === null ? '—' : `${String(Math.round(backup.sizeBytes / 1024))} KiB`}</td>
                    <td><StatusBadge tone={BACKUP_STATUS_LABEL[backup.status].tone}>{t(BACKUP_STATUS_LABEL[backup.status].labelKey)}</StatusBadge></td>
                    <td>{backup.createdAt}</td>
                    <td>
                      <Button variant="ghost" disabled={acting} onClick={() => {
                        setActing(true); setError('')
                        void Promise.all([inspectBackupNodeConfiguration(backup.id), getNodeConfiguration()])
                          .then(([saved, current]) => { setConfigurationPreview({ backup: saved, current }) })
                          .catch((cause: unknown) => { setError(messageOf(cause)) }).finally(() => { setActing(false) })
                      }}>{t('viewBackupConfig')}</Button>
                      <IconButton label={t('verify')} icon={ShieldCheck} disabled={acting}
                        onClick={() => void run(() => verifyBackup(backup.id), t('noticeVerified'))} />
                      {(backup.status === 'verified' || backup.status === 'restored') && backup.managedSnapshot !== null ? (
                        <Button variant="ghost" icon={HardDriveDownload} disabled={acting || state?.mode === 'restoring'}
                          onClick={() => { setRestoring(backup) }}>{t('requestRestore')}</Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={t('operationsTitle')} meta={t('operationsMeta')}>
        {state === null ? null : state.operations.length === 0 ? <EmptyState title={t('operationsEmpty')} /> : (
          <div className="tableWrap" role="region" aria-label={t('operationsTableAria')} tabIndex={0}>
            <table className="dataTable">
              <thead><tr><th>{t('columnKind')}</th><th>{t('columnStatus')}</th><th>{t('columnNode')}</th><th>{t('columnCreatedAt')}</th><th>{t('columnFinishedAt')}</th><th>{t('columnError')}</th></tr></thead>
              <tbody>
                {state.operations.map(operation => (
                  <tr key={operation.id}>
                    <td><code>{operation.kind}</code></td>
                    <td><code>{operation.status}</code></td>
                    <td>{operation.nodeName ?? '—'}</td>
                    <td>{operation.createdAt}</td>
                    <td>{operation.finishedAt ?? '—'}</td>
                    <td>{operation.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Dialog open={configurationPreview !== null} title={t('configDialogTitle')} onClose={() => { setConfigurationPreview(null) }}
        description={t('configDialogDescription')}>
        {configurationPreview?.backup.values === null ? <EmptyState title={t('configEmpty')} /> : configurationPreview === null ? null : <>
          <p>{t('configVersions', { backup: configurationPreview.backup.appliedRevision === null ? t('revisionUnknown') : String(configurationPreview.backup.appliedRevision), current: String(configurationPreview.current.runningRevision) })}</p>
          {configurationPreview.backup.incompatibleFields.length === 0 ? null : <ErrorBanner message={t('configIncompatible', { fields: configurationPreview.backup.incompatibleFields.join(t('listSeparator')) })} />}
          <div className="tableWrap" role="region" aria-label={t('configTableAria')} tabIndex={0}>
            <table className="dataTable"><thead><tr><th>{t('columnSetting')}</th><th>{t('columnBackupValue')}</th><th>{t('columnCurrentValue')}</th><th>{t('columnDiff')}</th></tr></thead><tbody>
              {NODE_CONFIG_FIELDS.map(field => <tr key={field.key}>
                <td>{field.label}</td><td>{configurationPreview.backup.values?.[field.key] || t('valueUnset')}</td>
                <td>{configurationPreview.current.effective[field.key] || t('valueUnset')}</td>
                <td>{configurationPreview.backup.values?.[field.key] === configurationPreview.current.effective[field.key] ? t('diffSame') : t('diffDifferent')}</td>
              </tr>)}
            </tbody></table>
          </div>
        </>}
      </Dialog>

      <ConfirmDialog
        open={restoring !== null}
        title={t('restoreTitle')}
        description={t('restoreDescription')}
        confirmLabel={t('restoreConfirm')}
        pending={acting}
        onClose={() => { setRestoring(null) }}
        onConfirm={() => {
          const backup = restoring
          setRestoring(null)
          if (backup === null) return
          void run(() => requestDeploymentRestore(backup.id), t('noticeRestoreRequested'))
        }}
      />
      <ConfirmDialog
        open={exiting}
        title={t('exitMaintenance')}
        description={t('exitDescription')}
        confirmLabel={t('exitConfirm')}
        pending={acting}
        onClose={() => { setExiting(false) }}
        onConfirm={() => {
          setExiting(false)
          void run(() => setMaintenance('exit'), t('noticeExitedMaintenance'))
        }}
      />
    </div>
  )
}
