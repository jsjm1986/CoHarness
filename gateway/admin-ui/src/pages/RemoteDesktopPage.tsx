/** Remote-desktop administration: endpoint configuration, user grants, audit. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import {
  createRemoteDesktopGrant, listRemoteDesktopAudit, listRemoteDesktopEndpoints,
  listRemoteDesktopGrants, listUsers, revokeRemoteDesktopGrant,
  saveRemoteDesktopEndpoints, setRemoteDesktopGrantLevel,
  type RemoteDesktopAuditEvent, type RemoteDesktopEndpoint, type RemoteDesktopGrant,
} from '../api.ts'
import {
  Button, ConfirmDialog, Dialog, EmptyState, ErrorBanner, Field, IconButton, LoadingState,
  PageHeader, Section, StatusBadge, Switch,
} from '../components/ui.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './remote-desktop.copy.ts'

const rdCopy = () => translateCopy(adminLanguage(), { zh, en })
const messageOf = (error: unknown): string => error instanceof Error ? error.message : rdCopy()('operationFailed')

interface EndpointDraft { nodeId: string; desktop: string; host: string; port: string }
const EMPTY_ENDPOINT: EndpointDraft = { nodeId: '', desktop: '', host: '', port: '5900' }

interface GrantDraft { principal: string; endpoint: string; level: 'view' | 'control'; recording: boolean }
const EMPTY_GRANT: GrantDraft = { principal: '', endpoint: '', level: 'view', recording: false }

const targetLabel = (target: { nodeId: string; desktop?: string }) =>
  target.desktop === undefined || target.desktop === '' ? target.nodeId : `${target.nodeId} · ${target.desktop}`
const endpointKeyOf = (e: { nodeId: string; desktop?: string }) => `${e.nodeId} ${e.desktop ?? ''}`
const timeLabel = (ms: number) => new Date(ms).toLocaleString()

export function RemoteDesktopPage() {
  const [endpoints, setEndpoints] = useState<RemoteDesktopEndpoint[] | null>(null)
  const [grants, setGrants] = useState<RemoteDesktopGrant[]>([])
  const [events, setEvents] = useState<RemoteDesktopAuditEvent[]>([])
  const [usernames, setUsernames] = useState<string[]>([])
  const [endpointDraft, setEndpointDraft] = useState<EndpointDraft | null>(null)
  const [grantDraft, setGrantDraft] = useState<GrantDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'revoke' | 'endpoint'; id: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const t = rdCopy()

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [e, g, a] = await Promise.all([
        listRemoteDesktopEndpoints(), listRemoteDesktopGrants(), listRemoteDesktopAudit(),
      ])
      setEndpoints(e.endpoints)
      setGrants(g.grants)
      setEvents(a.events)
    } catch (err) {
      setError(messageOf(err))
      setEndpoints([])
    }
  }, [])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    listUsers().then(users => setUsernames(users.map(u => u.username))).catch(() => {})
  }, [])

  const endpointList = useMemo(() => endpoints ?? [], [endpoints])

  const saveEndpoints = async (rows: RemoteDesktopEndpoint[]) => {
    setBusy(true)
    try {
      const result = await saveRemoteDesktopEndpoints(rows)
      setEndpoints(result.endpoints)
      setNotice(t('noticeEndpointsSaved'))
      setEndpointDraft(null)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const issueGrant = async () => {
    if (grantDraft === null) return
    setBusy(true)
    try {
      const sep = grantDraft.endpoint.indexOf(' ')
      const nodeId = sep === -1 ? grantDraft.endpoint : grantDraft.endpoint.slice(0, sep)
      const desktop = sep === -1 ? '' : grantDraft.endpoint.slice(sep + 1)
      await createRemoteDesktopGrant({
        principal: grantDraft.principal.trim(),
        target: { nodeId, ...(desktop === '' ? {} : { desktop }) },
        level: grantDraft.level,
        recording: grantDraft.recording,
      })
      setGrantDraft(null)
      setNotice(t('noticeGranted'))
      await reload()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const changeLevel = async (grant: RemoteDesktopGrant, level: 'view' | 'control') => {
    try {
      await setRemoteDesktopGrantLevel(grant.id, level)
      setNotice(t('noticeLevelChanged'))
      await reload()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const runConfirm = async () => {
    if (confirm === null) return
    setBusy(true)
    try {
      if (confirm.kind === 'revoke') {
        await revokeRemoteDesktopGrant(confirm.id)
        setNotice(t('noticeRevoked'))
        await reload()
      } else {
        await saveEndpoints(endpointList.filter(e => endpointKeyOf(e) !== confirm.id))
      }
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  if (endpoints === null) return error === null ? <LoadingState label={t('loading')} /> : <ErrorBanner message={error} />

  return (
    <div>
      <PageHeader title={t('pageTitle')} description={t('pageDescription')}
        actions={<Button onClick={() => void reload()} icon={RefreshCw}>{t('refresh')}</Button>} />
      {error !== null && <ErrorBanner message={error} />}
      {notice !== null && <p role="status">{notice}</p>}

      <Section title={t('sectionEndpoints')} flush
        actions={<Button variant="secondary" icon={Plus} onClick={() => setEndpointDraft(EMPTY_ENDPOINT)}>{t('addEndpoint')}</Button>}>
        {endpointList.length === 0
          ? <EmptyState title={t('endpointsEmpty')} detail={t('endpointsEmptyDetail')} />
          : (
            <div className="tableWrap" role="region" aria-label={t('tableAriaEndpoints')} tabIndex={0}>
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>{t('labelNodeId')}</th><th>{t('labelDesktop')}</th><th>{t('labelHost')}</th>
                    <th>{t('labelPort')}</th><th>{t('columnActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {endpointList.map(e => (
                    <tr key={endpointKeyOf(e)}>
                      <td>{e.nodeId} {e.host === '127.0.0.1' && <StatusBadge tone="info">{t('localBadge')}</StatusBadge>}</td>
                      <td>{e.desktop ?? '—'}</td><td><code>{e.host}</code></td><td><code>{e.port}</code></td>
                      <td>
                        <div className="compactActions">
                          <IconButton label={t('remove')} icon={Trash2}
                            onClick={() => setConfirm({ kind: 'endpoint', id: endpointKeyOf(e) })} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Section>

      <Section title={t('sectionGrants')} flush
        actions={endpointList.length === 0 ? undefined : (
          <Button variant="secondary" icon={Plus}
            onClick={() => setGrantDraft({ ...EMPTY_GRANT, endpoint: endpointKeyOf(endpointList[0]!) })}>{t('grantAccess')}</Button>
        )}>
        {grants.length === 0
          ? <EmptyState title={t('grantsEmpty')} detail={t('grantsEmptyDetail')} />
          : (
            <div className="tableWrap" role="region" aria-label={t('tableAriaGrants')} tabIndex={0}>
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>{t('labelPrincipal')}</th><th>{t('labelNodeId')}</th><th>{t('labelLevel')}</th>
                    <th>{t('labelScope')}</th><th>{t('labelRecording')}</th><th>{t('labelGrantedBy')}</th>
                    <th>{t('labelCreatedAt')}</th><th>{t('columnActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {grants.map(g => (
                    <tr key={g.id}>
                      <td>{g.principal}</td>
                      <td>{targetLabel(g.target)}</td>
                      <td>
                        {g.revokedAt === undefined
                          ? (
                            <select className="selectCompact" value={g.level}
                              onChange={e => void changeLevel(g, e.target.value as 'view' | 'control')}>
                              <option value="view">{t('levelView')}</option>
                              <option value="control">{t('levelControl')}</option>
                            </select>
                          )
                          : <StatusBadge tone="neutral">{t(g.level === 'control' ? 'levelControl' : 'levelView')}</StatusBadge>}
                      </td>
                      <td>{g.scope.kind === 'machine' ? t('scopeMachine') : t('scopeSession')}</td>
                      <td>{g.recording ? <StatusBadge tone="warning">{t('recordingYes')}</StatusBadge> : '—'}</td>
                      <td>{g.grantedBy}</td>
                      <td>{timeLabel(g.createdAt)}</td>
                      <td>
                        <div className="compactActions">
                          {g.revokedAt === undefined
                            ? <Button variant="ghost" onClick={() => setConfirm({ kind: 'revoke', id: g.id })}>{t('revoke')}</Button>
                            : <StatusBadge tone="danger">{t('revokedBadge')}</StatusBadge>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Section>

      <Section title={t('sectionAudit')} flush>
        {events.length === 0
          ? <EmptyState title={t('auditEmpty')} detail={t('auditEmptyDetail')} />
          : (
            <div className="tableWrap" role="region" aria-label={t('tableAriaAudit')} tabIndex={0}>
              <table className="dataTable">
                <thead><tr><th>{t('eventTime')}</th><th>{t('eventKind')}</th><th>{t('labelPrincipal')}</th><th>{t('labelNodeId')}</th></tr></thead>
                <tbody>
                  {events.map((ev, i) => (
                    <tr key={i}>
                      <td>{timeLabel(ev.at)}</td><td><code>{ev.kind}</code></td>
                      <td>{ev.principal ?? '—'}</td><td>{ev.target === undefined ? '—' : targetLabel(ev.target)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Section>

      <Dialog
        open={endpointDraft !== null}
        title={t('addEndpointTitle')}
        description={t('addEndpointDescription')}
        onClose={() => { if (!busy) setEndpointDraft(null) }}
        footer={<>
          <Button type="button" onClick={() => setEndpointDraft(null)} disabled={busy}>{t('cancel')}</Button>
          <Button type="button" variant="primary" disabled={busy}
            onClick={() => {
              if (endpointDraft === null) return
              void saveEndpoints([...endpointList, {
                nodeId: endpointDraft.nodeId.trim(),
                host: endpointDraft.host.trim(),
                port: Number(endpointDraft.port),
                ...(endpointDraft.desktop.trim() === '' ? {} : { desktop: endpointDraft.desktop.trim() }),
              }])
            }}>{t('save')}</Button>
        </>}
      >
        {endpointDraft === null ? null : (
          <div className="formGrid">
            <Field label={t('labelNodeId')} hint={t('hintNodeId')}>
              <input className="input" value={endpointDraft.nodeId}
                onChange={e => setEndpointDraft({ ...endpointDraft, nodeId: e.target.value })} />
            </Field>
            <Field label={t('labelDesktop')} hint={t('hintDesktop')}>
              <input className="input" value={endpointDraft.desktop}
                onChange={e => setEndpointDraft({ ...endpointDraft, desktop: e.target.value })} />
            </Field>
            <Field label={t('labelHost')} hint={t('hintHost')}>
              <input className="input" value={endpointDraft.host}
                onChange={e => setEndpointDraft({ ...endpointDraft, host: e.target.value })} />
            </Field>
            <Field label={t('labelPort')}>
              <input className="input" inputMode="numeric" value={endpointDraft.port}
                onChange={e => setEndpointDraft({ ...endpointDraft, port: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>

      <Dialog
        open={grantDraft !== null}
        title={t('grantTitle')}
        description={t('grantDescription')}
        onClose={() => { if (!busy) setGrantDraft(null) }}
        footer={<>
          <Button type="button" onClick={() => setGrantDraft(null)} disabled={busy}>{t('cancel')}</Button>
          <Button type="button" variant="primary" onClick={() => void issueGrant()} disabled={busy}>{t('grantAccess')}</Button>
        </>}
      >
        {grantDraft === null ? null : (
          <div className="formGrid">
            <Field label={t('labelPrincipal')} hint={t('hintPrincipal')}>
              <input className="input" list="remote-desktop-principals" value={grantDraft.principal}
                onChange={e => setGrantDraft({ ...grantDraft, principal: e.target.value })} />
              <datalist id="remote-desktop-principals">
                {usernames.map(u => <option key={u} value={u} />)}
              </datalist>
            </Field>
            <Field label={t('labelNodeId')}>
              <select className="input" value={grantDraft.endpoint}
                onChange={e => setGrantDraft({ ...grantDraft, endpoint: e.target.value })}>
                {endpointList.map(e => (
                  <option key={endpointKeyOf(e)} value={endpointKeyOf(e)}>{targetLabel(e)}</option>
                ))}
              </select>
            </Field>
            <Field label={t('labelLevel')} hint={t('hintLevel')}>
              <select className="input" value={grantDraft.level}
                onChange={e => setGrantDraft({ ...grantDraft, level: e.target.value as 'view' | 'control' })}>
                <option value="view">{t('levelView')}</option>
                <option value="control">{t('levelControl')}</option>
              </select>
            </Field>
            <div className="formSpanFull">
              <Switch label={t('labelRecording')} checked={grantDraft.recording}
                onChange={checked => setGrantDraft({ ...grantDraft, recording: checked })} />
            </div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'revoke' ? t('revoke') : t('remove')}
        description={confirm?.kind === 'revoke' ? t('confirmRevoke') : t('confirmRemoveEndpoint')}
        confirmLabel={confirm?.kind === 'revoke' ? t('revoke') : t('remove')}
        pending={busy}
        onConfirm={() => void runConfirm()}
        onClose={() => setConfirm(null)}
      />
    </div>
  )
}
