/** Bounded node directory and explicit, one-time enrollment operations. */
import { usePendingEdits } from '../pending-edits.tsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Plus, RefreshCw } from 'lucide-react'
import type { NodeEnrollmentId } from '../../../src/node-access.ts'
import { randomUUID } from '../../../../packages/util/crypto/src/index.ts'
import {
  AdminRequestError, issueNodeEnrollment, listNodeAccess, reissueNodeEnrollment, revokeNodeAccess, detachNodeAccess, listDeploymentCandidates,
  type NodeAccessEntry, type NodeAccessPage, type NodeEnrollment,
} from '../api.ts'
import { adminLanguage, translateCopy, type CopyTranslate } from '../language.ts'
import { Button, Dialog, EmptyState, ErrorBanner, Field, IconButton, LoadingState, Section, StatusBadge } from '../components/ui.tsx'
import { zh, en, type NodeAccessCopyKey } from './node-access.copy.ts'

type Action = { kind: 'create' } | { kind: 'reissue' | 'revoke' | 'detach'; node: NodeAccessEntry }
type Ticket = { name: string; receipt: NodeEnrollment }
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u
const STATUS: Record<NodeAccessEntry['status'], 'neutral' | 'success' | 'warning' | 'danger'> = {
  detached: 'neutral', pending: 'warning', connected: 'success', disconnected: 'neutral', revoked: 'danger',
}

function mutationMessage(error: unknown, t: CopyTranslate<NodeAccessCopyKey>): { message: string; uncertain: boolean } {
  if (!(error instanceof AdminRequestError)) return { message: t('uncertain'), uncertain: true }
  const key: Partial<Record<string, NodeAccessCopyKey>> = {
    'node-access/computer-busy': 'computerBusy',
    'node-service/busy': 'computerBusy',
    'node-access/name-conflict': 'nameConflict', 'node-access/revision-conflict': 'revisionConflict',
    'node-access/enrollment-already-issued': 'issuedBefore', 'maintenance': 'maintenance', 'stale-epoch': 'maintenance',
    'node-access/mode-disabled': 'modeDisabled', 'node-access/not-found': 'notFound',
    'node-access/detached': 'nodeDetached',
  }
  if (error.status === 401 || error.status === 403) return { message: t('denied'), uncertain: false }
  const known = Object.hasOwn(key, error.code) ? key[error.code] : undefined
  if (known !== undefined) return { message: t(known), uncertain: error.code === 'node-access/enrollment-already-issued' }
  return error.status >= 500 ? { message: t('uncertain'), uncertain: true } : { message: t('refused'), uncertain: false }
}

/** Computer access stays independently usable while other deployment sections are loading. */
export function NodeAccessSection() {
  const language = useMemo(() => adminLanguage(), [])
  const t = useMemo(() => translateCopy(language, { zh, en }), [language])
  const [page, setPage] = useState<NodeAccessPage | null>(null)
  const [cursor, setCursor] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [action, setAction] = useState<Action | null>(null)
  const [name, setName] = useState('')
  const [existing, setExisting] = useState('')
  const [candidates, setCandidates] = useState<Awaited<ReturnType<typeof listDeploymentCandidates>>>()
  const [candidateCursor, setCandidateCursor] = useState<string>()
  const [candidateError, setCandidateError] = useState('')
  useEffect(() => {
    if (action?.kind !== 'create') return
    const controller = new AbortController()
    void listDeploymentCandidates(candidateCursor, controller.signal).then(value => { if (!controller.signal.aborted) { setCandidates(value); setCandidateError('') } })
      .catch(() => { if (!controller.signal.aborted) { setCandidates(undefined); setCandidateError(t('candidateFailed')) } })
    return () => { controller.abort() }
  }, [action?.kind, candidateCursor, t])
  const [actionError, setActionError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [acting, setActing] = useState(false)
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [revealed, setRevealed] = useState(false)
  usePendingEdits(acting || ticket !== null || action?.kind === 'create' && (name !== '' || existing !== ''))
  const [copyStatus, setCopyStatus] = useState('')
  const [copyError, setCopyError] = useState('')
  const mounted = useRef(false)
  const busy = useRef(false)
  const ticketRevision = useRef(0)
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (action?.kind === 'create') nameInput.current?.focus() }, [action])

  useEffect(() => {
    let disposed = false, pending = false
    let controller: AbortController | undefined
    const load = async () => {
      if (pending || disposed) return
      pending = true
      controller = new AbortController()
      setLoading(true)
      try {
        const next = await listNodeAccess(cursor, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
        if (!disposed) { setPage(next); setError('') }
      } catch (cause) {
        if (disposed || controller.signal.aborted) return
        if (cause instanceof AdminRequestError && (cause.status === 401 || cause.status === 403)) {
          ticketRevision.current += 1
          setPage(null); setTicket(null); setAction(null); setError(t('denied'))
        } else setError(t('readFailed'))
      } finally {
        pending = false
        if (!disposed) setLoading(false)
      }
    }
    void load()
    const whenVisible = () => { if (document.visibilityState === 'visible') void load() }
    const timer = setInterval(whenVisible, 10_000)
    document.addEventListener('visibilitychange', whenVisible)
    return () => { disposed = true; clearInterval(timer); controller?.abort(); document.removeEventListener('visibilitychange', whenVisible) }
  }, [cursor, refresh, t])

  const reread = () => { setRefresh(value => value + 1) }
  const open = (next: Action) => {
    setAction(next); setName(''); setExisting(''); setCandidateCursor(undefined); setCandidates(undefined); setCandidateError(''); setActionError(''); setUncertain(false); setNotice('')
  }
  const close = () => { if (!busy.current) { setAction(null); setActionError(''); setUncertain(false) } }
  const time = (value: string) => new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')

  const submit = async () => {
    if (action === null || busy.current || uncertain) return
    const computerName = action.kind === 'create' ? name.trim() : action.node.name
    if (action.kind === 'create' && existing === '' && (!NAME.test(computerName) || computerName.length > 64)) { setActionError(t('nameInvalid')); return }
    busy.current = true; setActing(true); setActionError('')
    try {
      if (action.kind === 'detach') {
        await detachNodeAccess(action.node)
        if (mounted.current) { setNotice(t('detachedNotice', { name: computerName })); setAction(null) }
      } else if (action.kind === 'revoke') {
        await revokeNodeAccess(action.node)
        if (mounted.current) { setNotice(t('revokedNotice', { name: computerName })); setAction(null) }
      } else {
        const requestId = randomUUID() as NodeEnrollmentId
        const receipt = action.kind === 'create' ? existing === '' ? await issueNodeEnrollment(computerName, requestId)
          : await issueNodeEnrollment(computerName, requestId, existing as import('../api.ts').RuntimeNodeId)
          : await reissueNodeEnrollment(action.node, requestId)
        if (mounted.current) {
          ticketRevision.current += 1
          setTicket({ name: computerName, receipt }); setRevealed(false); setCopyStatus(''); setCopyError(''); setAction(null)
          setCursor(undefined)
        }
      }
      if (mounted.current) reread()
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof AdminRequestError && (cause.status === 401 || cause.status === 403)) {
        ticketRevision.current += 1
        setPage(null); setTicket(null); setAction(null); setError(t('denied'))
        return
      }
      const failure = mutationMessage(cause, t)
      setActionError(failure.message); setUncertain(failure.uncertain)
      if (failure.uncertain) { setCursor(undefined); reread() }
    } finally { busy.current = false; if (mounted.current) setActing(false) }
  }

  const copy = async () => {
    if (ticket === null) return
    const current = ticket
    const revision = ticketRevision.current
    setCopyStatus(''); setCopyError('')
    try {
      await navigator.clipboard.writeText(current.receipt.token)
      if (mounted.current && revision === ticketRevision.current) setCopyStatus(t('copied'))
    } catch { if (mounted.current && revision === ticketRevision.current) setCopyError(t('copyFailed')) }
  }

  const closeTicket = () => { ticketRevision.current += 1; setTicket(null); setCopyStatus(''); setCopyError(''); setRevealed(false) }

  const title = action === null ? '' : action.kind === 'create' ? t('createTitle')
    : t(action.kind === 'reissue' ? 'reissueTitle' : action.kind === 'detach' ? 'detachTitle' : 'revokeTitle', { name: action.node.name })
  return (
    <>
      <Section title={t('title')} meta={t('meta')} actions={(
        <div className="rowActions">
          <IconButton label={t('refresh')} icon={RefreshCw} onClick={reread} disabled={loading} />
          <Button icon={Plus} onClick={() => open({ kind: 'create' })}>{t('add')}</Button>
        </div>
      )}>
        <p className="nodeAccessScope">{t('scope')}</p>
        <ErrorBanner message={error} />
        {notice === '' ? null : <p role="status">{notice}</p>}
        {page === null ? loading ? <LoadingState label={t('loading')} /> : null : page.items.length === 0 ? (
          <EmptyState title={t('empty')} detail={t('emptyDetail')} />
        ) : (
          <div className="tableWrap" role="region" aria-label={t('table')} tabIndex={0} aria-busy={loading}>
            <table className="dataTable">
              <thead><tr><th>{t('name')}</th><th>{t('connection')}</th><th>{t('system')}</th><th>{t('seen')}</th><th>{t('actions')}</th></tr></thead>
              <tbody>{page.items.map(node => (
                <tr key={node.nodeId}>
                  <td className="nodeAccessName">{node.name}</td>
                  <td><StatusBadge tone={STATUS[node.status]}>{t(node.status)}</StatusBadge></td>
                  <td>{node.platform === null ? t('unknownSystem')
                    : `${node.platform === 'darwin' ? 'macOS' : node.platform === 'linux' ? 'Linux' : 'Windows'}${node.architecture ? ` · ${node.architecture}` : ''}`}</td>
                  <td>{node.lastSeenAt === null ? t('never') : <time dateTime={node.lastSeenAt}>{time(node.lastSeenAt)}</time>}</td>
                  <td><div className="rowActions">
                    <Button variant="ghost" onClick={() => open({ kind: 'reissue', node })}>{t('reissue')}</Button>
                    {node.status !== 'detached' && <Button variant="ghost" onClick={() => open({ kind: 'detach', node })}>{t('detach')}</Button>}
                    {node.status === 'revoked' || node.status === 'detached' ? null : <Button variant="ghost" onClick={() => open({ kind: 'revoke', node })}>{t('revoke')}</Button>}
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {cursor === undefined && page?.nextCursor == null ? null : (
          <div className="formActions">
            <Button disabled={loading || cursor === undefined} onClick={() => setCursor(undefined)}>{t('previous')}</Button>
            <Button disabled={loading || page?.nextCursor == null} onClick={() => { if (page?.nextCursor != null) setCursor(page.nextCursor) }}>{t('more')}</Button>
          </div>
        )}
      </Section>

      <Dialog open={action !== null} title={title}
        description={action === null ? undefined : action.kind === 'create' ? t('createDetail') : t(action.kind === 'reissue' ? 'reissueDetail' : action.kind === 'detach' ? 'detachDetail' : 'revokeDetail')}
        danger={action?.kind === 'revoke'} onClose={close}
        footer={(
          <>
            <Button disabled={acting} onClick={close}>{t('cancel')}</Button>
            {uncertain ? <Button onClick={reread}>{t('refresh')}</Button> : (
              <Button variant={action?.kind === 'revoke' ? 'danger' : 'primary'} loading={acting} onClick={() => void submit()}>
                {action?.kind === 'revoke' ? t('revoke') : action?.kind === 'detach' ? t('detach') : t('issue')}
              </Button>
            )}
          </>
        )}>
        {action?.kind === 'create' && <><ErrorBanner message={candidateError} /><Field label={t('existing')}><select className="select" value={existing} disabled={acting || uncertain} onChange={event => {
          const id = event.target.value; setExisting(id); setName(candidates?.items.find(item => item.nodeId === id)?.name ?? '')
        }}><option value="">{t('registerNew')}</option>
          {existing !== '' && !candidates?.items.some(item => item.nodeId === existing) && <option value={existing}>{name}</option>}
          {candidates?.items.map(item => <option key={item.nodeId} value={item.nodeId}>{item.name}</option>)}
        </select></Field>
        {candidates?.nextCursor && <Button disabled={acting || uncertain} onClick={() => setCandidateCursor(candidates.nextCursor!)}>{t('candidatesMore')}</Button>}</>}
        {action?.kind === 'create' && existing === '' ? (
          <Field label={t('name')} hint={t('nameHint')}>
            <input ref={nameInput} aria-label={t('name')} aria-description={t('nameHint')} value={name} maxLength={64} placeholder={t('namePlaceholder')} disabled={acting || uncertain}
              onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} />
          </Field>
        ) : null}
        <ErrorBanner message={actionError} />
      </Dialog>

      <Dialog open={ticket !== null} title={ticket === null ? '' : t('ticketTitle', { name: ticket.name })} description={t('ticketDetail')}
        onClose={closeTicket}
        footer={<Button onClick={closeTicket}>{t('done')}</Button>}>
        {ticket === null ? null : (
          <div className="nodeAccessTicket">
            <Field label={t('token')}>
              <input readOnly type={revealed ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={ticket.receipt.token} />
            </Field>
            <div className="rowActions">
              <Button icon={Copy} onClick={() => void copy()}>{t('copy')}</Button>
              <Button variant="ghost" onClick={() => setRevealed(value => !value)}>{t(revealed ? 'hide' : 'show')}</Button>
            </div>
            {copyStatus === '' ? null : <p role="status">{copyStatus}</p>}
            <ErrorBanner message={copyError} />
            <p>{t('expiry', { time: time(ticket.receipt.expiresAt) })}</p>
            <details className="nodeAccessSetup">
              <summary>{t('setup')}</summary>
              <p>{t('codeUsage')}</p>
              <p>{t('startCommand')}<br /><code>node lib/node-agent-main.js</code></p>
              <p>{t('node')}<br /><code>{ticket.receipt.nodeId}</code></p>
            </details>
          </div>
        )}
      </Dialog>
    </>
  )
}
