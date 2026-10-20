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
  Button, ConfirmDialog, EmptyState, ErrorBanner, Field, IconButton, LoadingState,
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
  const [draft, setDraft] = useState<EndpointDraft>(EMPTY_ENDPOINT)
  const [grantDraft, setGrantDraft] = useState<GrantDraft>(EMPTY_GRANT)
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
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const addEndpoint = async () => {
    await saveEndpoints([...endpointList, {
      nodeId: draft.nodeId.trim(),
      host: draft.host.trim(),
      port: Number(draft.port),
      ...(draft.desktop.trim() === '' ? {} : { desktop: draft.desktop.trim() }),
    }])
    setDraft(EMPTY_ENDPOINT)
  }

  const issueGrant = async () => {
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
      setGrantDraft(EMPTY_GRANT)
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
      <PageHeader title={t('sectionEndpoints')} description={t('pageDescription')}
        actions={<Button onClick={() => void reload()} icon={RefreshCw}>{t('refresh')}</Button>} />
      {error !== null && <ErrorBanner message={error} />}
      {notice !== null && <p role="status">{notice}</p>}

      <Section title={t('sectionEndpoints')} flush>
        {endpointList.length === 0
          ? <EmptyState title={t('endpointsEmpty')} />
          : (
            <table>
              <thead>
                <tr>
                  <th>{t('labelNodeId')}</th><th>{t('labelDesktop')}</th><th>{t('labelHost')}</th>
                  <th>{t('labelPort')}</th><th />
                </tr>
              </thead>
              <tbody>
                {endpointList.map(e => (
                  <tr key={endpointKeyOf(e)}>
                    <td>{e.nodeId}</td><td>{e.desktop ?? '—'}</td><td>{e.host}</td><td>{e.port}</td>
                    <td>
                      <IconButton label={t('remove')} icon={Trash2}
                        onClick={() => setConfirm({ kind: 'endpoint', id: endpointKeyOf(e) })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        <form onSubmit={ev => { ev.preventDefault(); void addEndpoint() }}>
          <Field label={t('labelNodeId')}>
            <input value={draft.nodeId} onChange={e => setDraft({ ...draft, nodeId: e.target.value })} required />
          </Field>
          <Field label={t('labelDesktop')}>
            <input value={draft.desktop} onChange={e => setDraft({ ...draft, desktop: e.target.value })} />
          </Field>
          <Field label={t('labelHost')}>
            <input value={draft.host} onChange={e => setDraft({ ...draft, host: e.target.value })} required />
          </Field>
          <Field label={t('labelPort')}>
            <input type="number" min={1} max={65535} value={draft.port} onChange={e => setDraft({ ...draft, port: e.target.value })} required />
          </Field>
          <Button type="submit" disabled={busy} icon={Plus}>{t('addEndpoint')}</Button>
        </form>
      </Section>

      <Section title={t('sectionGrants')} flush>
        {grants.length === 0
          ? <EmptyState title={t('grantsEmpty')} />
          : (
            <table>
              <thead>
                <tr>
                  <th>{t('labelPrincipal')}</th><th>{t('labelNodeId')}</th><th>{t('labelLevel')}</th>
                  <th>{t('labelScope')}</th><th>{t('labelRecording')}</th><th>{t('labelGrantedBy')}</th>
                  <th>{t('labelCreatedAt')}</th><th />
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
                          <select value={g.level} onChange={e => void changeLevel(g, e.target.value as 'view' | 'control')}>
                            <option value="view">{t('levelView')}</option>
                            <option value="control">{t('levelControl')}</option>
                          </select>
                        )
                        : t(g.level === 'control' ? 'levelControl' : 'levelView')}
                    </td>
                    <td>{g.scope.kind === 'machine' ? t('scopeMachine') : t('scopeSession')}</td>
                    <td>{g.recording ? t('recordingYes') : '—'}</td>
                    <td>{g.grantedBy}</td>
                    <td>{timeLabel(g.createdAt)}</td>
                    <td>
                      {g.revokedAt === undefined
                        ? <Button variant="secondary" onClick={() => setConfirm({ kind: 'revoke', id: g.id })}>{t('revoke')}</Button>
                        : <StatusBadge>{t('revokedBadge')}</StatusBadge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        {endpointList.length > 0 && (
          <form onSubmit={ev => { ev.preventDefault(); void issueGrant() }}>
            <Field label={t('labelPrincipal')}>
              <input list="remote-desktop-principals" value={grantDraft.principal}
                onChange={e => setGrantDraft({ ...grantDraft, principal: e.target.value })} required />
              <datalist id="remote-desktop-principals">
                {usernames.map(u => <option key={u} value={u} />)}
              </datalist>
            </Field>
            <Field label={t('labelNodeId')}>
              <select value={grantDraft.endpoint} onChange={e => setGrantDraft({ ...grantDraft, endpoint: e.target.value })} required>
                <option value="" disabled>—</option>
                {endpointList.map(e => (
                  <option key={endpointKeyOf(e)} value={endpointKeyOf(e)}>{targetLabel(e)}</option>
                ))}
              </select>
            </Field>
            <Field label={t('labelLevel')}>
              <select value={grantDraft.level} onChange={e => setGrantDraft({ ...grantDraft, level: e.target.value as 'view' | 'control' })}>
                <option value="view">{t('levelView')}</option>
                <option value="control">{t('levelControl')}</option>
              </select>
            </Field>
            <Switch label={t('labelRecording')} checked={grantDraft.recording}
              onChange={checked => setGrantDraft({ ...grantDraft, recording: checked })} />
            <Button type="submit" disabled={busy}>{t('grantAccess')}</Button>
          </form>
        )}
      </Section>

      <Section title={t('sectionAudit')} flush>
        {events.length === 0
          ? <EmptyState title={t('auditEmpty')} />
          : (
            <table>
              <thead><tr><th>{t('eventTime')}</th><th>{t('eventKind')}</th><th>{t('labelPrincipal')}</th><th>{t('labelNodeId')}</th></tr></thead>
              <tbody>
                {events.map((ev, i) => (
                  <tr key={i}>
                    <td>{timeLabel(ev.at)}</td><td>{ev.kind}</td>
                    <td>{ev.principal ?? '—'}</td><td>{ev.target === undefined ? '—' : targetLabel(ev.target)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Section>

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
