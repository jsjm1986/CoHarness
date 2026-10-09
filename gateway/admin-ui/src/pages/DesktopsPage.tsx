import { DesktopPermissions } from '../components/DesktopPermissions.tsx'
import { Ban, Monitor, RefreshCw, ShieldOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  applyDesktopAction,
  desktopHolderOf,
  getDesktopDetail,
  listDesktops,
  type AdminDesktopDetail,
  type AdminDesktopGrant,
  type AdminDesktopQueueEntry,
  type AdminDesktopResource,
} from '../api.ts'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  IconButton,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
} from '../components/ui.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as desktopsZh, en as desktopsEn } from './desktops.copy.ts'

const desktopsCopy = () => translateCopy(adminLanguage(), { zh: desktopsZh, en: desktopsEn })

type ConfirmState =
  | { kind: 'revoke'; grant: AdminDesktopGrant }
  | { kind: 'clear'; resource: AdminDesktopResource }

/** Interactive-desktop grant and queue supervision for administrators. */
export function DesktopsPage() {
  const [rows, setRows] = useState<AdminDesktopResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<AdminDesktopResource | null>(null)
  const [detail, setDetail] = useState<AdminDesktopDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [acting, setActing] = useState(false)
  const t = useMemo(() => desktopsCopy(), [])

  const reload = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const result = await listDesktops()
      setRows(result.resources)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  const openDetail = useCallback(async (resource: AdminDesktopResource) => {
    setSelected(resource)
    setDetailLoading(true)
    try {
      setDetail(await getDesktopDetail(resource.node, resource.desktop))
      setError('')
    } catch (cause) {
      setDetail(null)
      setError(messageFrom(cause))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  async function runAction(): Promise<void> {
    if (confirm === null) return
    setActing(true)
    try {
      if (confirm.kind === 'revoke') {
        await applyDesktopAction('revoke', { grantId: confirm.grant.grantId })
      } else {
        await applyDesktopAction('clear', { node: confirm.resource.node, desktop: confirm.resource.desktop })
      }
      setConfirm(null)
      await reload(false)
      if (selected !== null) await openDetail(selected)
    } catch (cause) {
      setError(messageFrom(cause))
      setConfirm(null)
    } finally {
      setActing(false)
    }
  }

  const activeGrants = detail?.grants.filter(grant => grant.state !== 'released') ?? []
  const liveQueue = detail?.queue.filter(entry => entry.state === 'queued') ?? []

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        meta={t('resourceCount', { count: String(rows.length) })}
      />
      <DesktopPermissions />
      <ErrorBanner message={error} />
      <Section
        flush
        title={t('sectionResources')}
        meta={<IconButton label={t('refresh')} icon={RefreshCw} variant="secondary" onClick={() => void reload()} />}
      >
        {loading ? <LoadingState label={t('loadingResources')} /> : rows.length === 0 ? (
          <EmptyState icon={Monitor} title={t('emptyTitle')} detail={t('emptyDetail')} />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable">
                <thead><tr><th>{t('columnNode')}</th><th>{t('columnDesktop')}</th><th>{t('labelState')}</th><th>{t('labelFencingSeq')}</th><th>{t('labelUpdated')}</th><th /></tr></thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.resourceKey}>
                      <td><span className="codeText">{row.node}</span></td>
                      <td><span className="codeText">{row.desktop}</span></td>
                      <td><ResourceState state={row.state} note={row.stateNote} /></td>
                      <td><span className="codeText">{row.fencingSeq}</span></td>
                      <td><time dateTime={new Date(row.updatedAt).toISOString()}>{formatTime(row.updatedAt)}</time></td>
                      <td><Button type="button" variant="secondary" onClick={() => void openDetail(row)}>{t('detail')}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobileList">
              {rows.map(row => (
                <article className="mobileItem" key={row.resourceKey}>
                  <div className="mobileItemHeader">
                    <span className="codeText">{row.resourceKey}</span>
                    <ResourceState state={row.state} note={row.stateNote} />
                  </div>
                  <div className="mobileItemBody">
                    <dl className="definitionGrid">
                      <Definition label={t('labelFencingSeq')}><span className="codeText">{row.fencingSeq}</span></Definition>
                      <Definition label={t('labelUpdated')}>{formatTime(row.updatedAt)}</Definition>
                    </dl>
                    <Button type="button" variant="secondary" onClick={() => void openDetail(row)}>{t('detail')}</Button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </Section>
      {selected === null ? null : (
        <Section flush title={t('detailSectionTitle', { key: selected.resourceKey })} meta={detailLoading ? t('loading') : t('grantsQueueMeta', { grants: String(activeGrants.length), queue: String(liveQueue.length) })}>
          {detailLoading ? <LoadingState label={t('loadingDetail')} /> : detail === null ? (
            <EmptyState icon={Monitor} title={t('detailErrorTitle')} detail={t('detailErrorDetail')} />
          ) : (
            <>
              <div className="sectionBody filterActions">
                <Button type="button" variant="danger" icon={ShieldOff} disabled={detail.resource?.state !== 'unavailable'} onClick={() => setConfirm({ kind: 'clear', resource: detail.resource! })}>{t('clearUnavailable')}</Button>
                {detail.resource?.stateNote === null || detail.resource?.stateNote === undefined ? null : <span className="muted">{detail.resource.stateNote}</span>}
              </div>
              <div className="tableWrap">
                <table className="dataTable">
                  <thead><tr><th>{t('columnHolder')}</th><th>{t('columnRuntime')}</th><th>{t('labelState')}</th><th>{t('columnFencing')}</th><th>{t('columnHeartbeat')}</th><th>{t('columnAcquired')}</th><th /></tr></thead>
                  <tbody>
                    {detail.grants.length === 0 ? (
                      <tr><td colSpan={7}><span className="muted">{t('noGrants')}</span></td></tr>
                    ) : detail.grants.map(grant => (
                      <tr key={grant.grantId}>
                        <td><HolderLabel holderJson={grant.holderJson} /></td>
                        <td><RuntimeLabel holderJson={grant.holderJson} /></td>
                        <td><GrantState grant={grant} /></td>
                        <td><span className="codeText">{grant.fencing}</span></td>
                        <td><time dateTime={new Date(grant.heartbeatAt).toISOString()}>{formatTime(grant.heartbeatAt)}</time></td>
                        <td><time dateTime={new Date(grant.acquiredAt).toISOString()}>{formatTime(grant.acquiredAt)}</time></td>
                        <td>{grant.state === 'held' ? (
                          <Button type="button" variant="secondary" icon={Ban} onClick={() => setConfirm({ kind: 'revoke', grant })}>{t('revoke')}</Button>
                        ) : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {detail.queue.length === 0 ? null : (
                <div className="tableWrap">
                  <table className="dataTable">
                    <thead><tr><th>{t('columnPosition')}</th><th>{t('columnHolder')}</th><th>{t('columnRuntime')}</th><th>{t('labelState')}</th><th>{t('columnQueued')}</th></tr></thead>
                    <tbody>
                      {detail.queue.map(entry => (
                        <tr key={entry.queueId}>
                          <td><span className="codeText">{entry.position}</span></td>
                          <td><HolderLabel holderJson={entry.holderJson} /></td>
                          <td><RuntimeLabel holderJson={entry.holderJson} /></td>
                          <td><QueueState entry={entry} /></td>
                          <td><time dateTime={new Date(entry.queuedAt).toISOString()}>{formatTime(entry.queuedAt)}</time></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Section>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'revoke' ? t('revokeTitle') : t('clearTitle')}
        description={confirm?.kind === 'revoke'
          ? t('revokeDescription')
          : t('clearDescription')}
        confirmLabel={confirm?.kind === 'revoke' ? t('revoke') : t('clearAction')}
        pending={acting}
        onConfirm={() => { void runAction() }}
        onClose={() => { if (!acting) setConfirm(null) }}
      />
    </div>
  )
}

function HolderLabel({ holderJson }: { holderJson: string }) {
  const t = useMemo(() => desktopsCopy(), [])
  const holder = desktopHolderOf({ holderJson })
  if (holder === undefined) return <span className="muted">{t('holderUnknown')}</span>
  return <span className="auditAction"><strong>{holder.user.username}</strong><span>#{holder.user.id}</span></span>
}

function RuntimeLabel({ holderJson }: { holderJson: string }) {
  const t = useMemo(() => desktopsCopy(), [])
  const holder = desktopHolderOf({ holderJson })
  if (holder === undefined) return <span className="muted">—</span>
  return <span className="codeText">{t('runtimeLine', { kind: t(holder.runtime.kind === 'user' ? 'runtimeUser' : 'runtimeProject'), id: String(holder.runtime.id), generation: String(holder.runtime.generation) })}</span>
}

function ResourceState({ state, note }: { state: AdminDesktopResource['state']; note: string | null }) {
  const t = useMemo(() => desktopsCopy(), [])
  return state === 'available'
    ? <StatusBadge tone="success">{t('stateAvailable')}</StatusBadge>
    : <StatusBadge tone="danger" >{t('stateUnavailable')}{note === null ? '' : ` · ${note}`}</StatusBadge>
}

function GrantState({ grant }: { grant: AdminDesktopGrant }) {
  const t = useMemo(() => desktopsCopy(), [])
  switch (grant.state) {
    case 'held': return <StatusBadge tone="success">{t('grantHeld')}</StatusBadge>
    case 'stopping': return <StatusBadge tone="warning">{t('grantStopping')}{grant.reason === 'revoked' ? ` · ${t('grantRevoked')}` : ''}</StatusBadge>
    case 'pending-confirm': return <StatusBadge tone="danger">{t('grantPending')}</StatusBadge>
    case 'released': return <StatusBadge>{t('grantReleased')}</StatusBadge>
  }
}

function QueueState({ entry }: { entry: AdminDesktopQueueEntry }) {
  const t = useMemo(() => desktopsCopy(), [])
  switch (entry.state) {
    case 'queued': return <StatusBadge tone="info">{t('queueQueued')}</StatusBadge>
    case 'promoted': return <StatusBadge tone="success">{t('queuePromoted')}</StatusBadge>
    case 'cancelled': return <StatusBadge>{t('queueCancelled')}</StatusBadge>
    case 'expired': return <StatusBadge tone="warning">{t('queueExpired')}</StatusBadge>
  }
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div>
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(desktopsCopy()('dateLocale'), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp)
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
