/** Terminal qualification and metadata-only process supervision on the current node. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { TerminalPermissions } from '../components/TerminalPermissions.tsx'
import { Button, ConfirmDialog, ErrorBanner, Field, LoadingState, PageHeader, Section, StatusBadge } from '../components/ui.tsx'
import { closeTerminal, listTerminals, listUsers, listProjects, type AdminTerminal, type AdminTerminalInventory } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as terminalsZh, en as terminalsEn } from './terminals.copy.ts'

type Target = { kind: 'user' | 'project'; id: number; label: string }
const keyOf = (target: Target) => `${target.kind}:${String(target.id)}`
const terminalsCopy = () => translateCopy(adminLanguage(), { zh: terminalsZh, en: terminalsEn })
const messageOf = (error: unknown) => error instanceof Error ? error.message : terminalsCopy()('readFailed')

export function TerminalsPage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: terminalsZh, en: terminalsEn }), [])
  const labels: Record<AdminTerminal['state'], string> = {
    starting: t('stateStarting'), running: t('stateRunning'), exited: t('stateExited'),
    failed: t('stateFailed'), stopping: t('stateStopping'),
  }
  const [targets, setTargets] = useState<Target[]>([])
  const [selected, setSelected] = useState('')
  const [inventory, setInventory] = useState<AdminTerminalInventory | null>(null)
  const [confirm, setConfirm] = useState<AdminTerminal | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState(false)
  const [reload, setReload] = useState(0)
  const [ownerReload, setOwnerReload] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    let disposed = false
    void Promise.all([listUsers(), listProjects()]).then(([users, projects]) => {
      if (disposed) return
      setTargets([...users.map(user => ({ kind: 'user' as const, id: user.id, label: t('targetUser', { name: user.displayName, username: user.username }) })),
        ...projects.map(project => ({ kind: 'project' as const, id: project.id, label: t('targetProject', { name: project.name }) }))])
      setError('')
    }).catch((error: unknown) => { if (!disposed) setError(messageOf(error)) })
    return () => { disposed = true; generation.current++ }
  }, [ownerReload, t])

  useEffect(() => {
    const target = targets.find(item => keyOf(item) === selected)
    if (target === undefined) return
    const attempt = ++generation.current, controller = new AbortController()
    setLoading(true)
    void listTerminals(target.kind, target.id, controller.signal).then(value => {
      if (attempt !== generation.current) return
      if (value.target.kind !== target.kind || value.target.id !== target.id) throw new Error(t('targetMismatch'))
      setInventory(value); setError('')
    }).catch(error => { if (attempt === generation.current) { setInventory(null); setError(messageOf(error)) } })
      .finally(() => { if (attempt === generation.current) setLoading(false) })
    return () => { generation.current++; controller.abort() }
  }, [targets, selected, reload, t])

  async function close(): Promise<void> {
    if (confirm === null || inventory === null || acting || loading || `${inventory.target.kind}:${String(inventory.target.id)}` !== selected) return
    const attempt = generation.current
    setActing(true); setError(''); setNotice('')
    try {
      await closeTerminal(inventory, confirm)
      if (attempt !== generation.current) return
      setNotice(t('noticeClosed')); setConfirm(null); setInventory(null); setReload(value => value + 1)
    } catch (error) {
      if (attempt === generation.current) { setConfirm(null); setError(t('closeUnconfirmed', { message: messageOf(error) })) }
    } finally { if (attempt === generation.current) setActing(false) }
  }

  return <div className="page">
    <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
    <TerminalPermissions />
    <Section title={t('sectionProcesses')}>
      <div className="sectionBody">
      <ErrorBanner message={error} />
      <div className="formGrid">
      <Field label={t('scopeLabel')}><select className="select" aria-label={t('scopeAria')} value={selected} disabled={acting} onChange={event => {
        generation.current++; setSelected(event.target.value); setInventory(null); setConfirm(null); setLoading(false); setError(''); setNotice('')
      }}>
        <option value="">{t('scopePlaceholder')}</option>
        {targets.map(target => <option key={keyOf(target)} value={keyOf(target)}>{target.label}</option>)}
      </select></Field>
      <div className="formActions">
      {targets.length === 0 ? <Button onClick={() => setOwnerReload(value => value + 1)}>{t('scopeReload')}</Button> : null}
      {selected === '' ? null : <Button disabled={acting || loading} onClick={() => { setInventory(null); setConfirm(null); setNotice(''); setReload(value => value + 1) }}>{t('refreshInventory')}</Button>}
      </div>
      </div>
      {loading ? <LoadingState label={t('loadingInventory')} /> : null}
      {inventory === null ? null : <>
        <p className="muted">{t('nodeLine', { node: inventory.nodeId })} · {inventory.generation === null ? t('instanceStopped') : t('instanceGeneration', { generation: String(inventory.generation) })}</p>
        {inventory.terminals.length === 0 ? <p>{t('empty')}</p> : <div className="tableWrap"><table className="dataTable" aria-label={t('tableAria')}>
          <thead><tr><th>{t('columnTerminal')}</th><th>{t('columnSession')}</th><th>{t('columnCreator')}</th><th>{t('columnStatus')}</th><th>{t('columnActions')}</th></tr></thead>
          <tbody>{inventory.terminals.map(entry => <tr key={`${entry.ownerId}:${entry.id}`}>
            <td className="terminalIdentity">{entry.id}</td><td className="terminalIdentity">{entry.sessionId}</td><td>{entry.creatorUserId === undefined ? t('localOperator') : t('creatorUser', { id: String(entry.creatorUserId) })}</td><td><StatusBadge tone={entry.state === 'running' ? 'success' : entry.state === 'failed' ? 'danger' : 'neutral'}>{labels[entry.state]}</StatusBadge></td>
            <td><Button variant="danger" disabled={acting || loading} onClick={() => setConfirm(entry)}>{entry.state === 'stopping' ? t('retryCleanup') : t('closeTerminal')}</Button></td>
          </tr>)}</tbody>
        </table></div>}
      </>}
      {notice === '' ? null : <p role="status">{notice}</p>}
      </div>
    </Section>
    <ConfirmDialog open={confirm !== null} title={t('closeTerminal')} description={t('closeDescription', { id: confirm?.id ?? '' })}
      confirmLabel={t('confirmClose')} pending={acting} onConfirm={() => void close()} onClose={() => { if (!acting) setConfirm(null) }} />
  </div>
}
