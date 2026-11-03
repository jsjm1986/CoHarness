/** Document-scoped computer choice over the existing Admin pages and APIs. */
import { RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AdminComputerContext, NodeAccessEntry, NodeAccessPage } from '../../src/node-access.ts'
import type { RuntimeNodeId } from '../../src/runtime-catalog.ts'
import { AdminRequestError, getAdminComputerContext, listNodeAccess } from './api.ts'
import { Button, Field, IconButton } from './components/ui.tsx'
import { adminLanguage, translateCopy } from './language.ts'
import { zh, en } from './computer.copy.ts'

/** Computer selector; the caller replaces the document to discard old page operations. */
export function ComputerSelector({ nodeId, onSelect }: { nodeId?: RuntimeNodeId; onSelect(nodeId?: RuntimeNodeId): void }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [context, setContext] = useState<AdminComputerContext | null>(null)
  const [page, setPage] = useState<NodeAccessPage | null>(null)
  const [selected, setSelected] = useState<NodeAccessEntry | null>(null)
  const [cursor, setCursor] = useState<string | undefined>()
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [contextLoading, setContextLoading] = useState(true)
  const [error, setError] = useState('')
  const [contextError, setContextError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setContextLoading(true)
    void getAdminComputerContext(controller.signal).then(value => {
      if (!controller.signal.aborted) { setContext(value); setContextError('') }
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      if (cause instanceof AdminRequestError && [401, 403].includes(cause.status)) setContext(null)
      setContextError(t('contextFailed'))
    }).finally(() => { if (!controller.signal.aborted) setContextLoading(false) })
    return () => { controller.abort() }
  }, [refresh, t])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void listNodeAccess(cursor, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setPage(value); setError('')
      const active = value.items.find(item => item.nodeId === nodeId)
      if (active !== undefined) setSelected(active)
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      if (cause instanceof AdminRequestError && [401, 403].includes(cause.status)) {
        setPage(null); setSelected(null); setError(t('denied'))
      } else setError(t('readFailed'))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [cursor, refresh, nodeId, t])

  const items = page?.items ?? []
  const selection = nodeId === context?.nodeId ? '' : nodeId ?? ''
  const missingSelected = nodeId !== undefined && selection !== '' && !items.some(item => item.nodeId === nodeId)
  const current = items.find(item => item.nodeId === nodeId) ?? selected
  const notice = error || contextError || (context !== null && !context.forwardingEnabled ? t('disabled') : '')
  const refreshing = loading || contextLoading
  return <div className="page computerBar">
    <div className="targetPicker" aria-busy={refreshing}>
      <Field label={t('label')}>
        <select className="select" value={selection} onChange={event => {
          const value = event.currentTarget.value
          if (value !== selection) onSelect(value === '' ? undefined : value as RuntimeNodeId)
        }}>
          <option value="">{context === null ? t('center') : `${t('center')} · ${context.name}`}</option>
          {missingSelected ? <option value={nodeId}>{current?.name ?? t('selected', { id: nodeId.slice(0, 8) })}</option> : null}
          {items.map(item => <option key={item.nodeId} value={item.nodeId}
            disabled={item.status === 'revoked'}>
            {item.name}{item.status === 'connected' ? '' : ` · ${t(item.status)}`}
          </option>)}
        </select>
      </Field>
      <IconButton label={t('refresh')} icon={RefreshCw} disabled={refreshing} onClick={() => setRefresh(value => value + 1)} />
      {page?.nextCursor !== null && page?.nextCursor !== undefined
        ? <Button disabled={loading} onClick={() => setCursor(page.nextCursor!)}>{t('more')}</Button> : null}
      {cursor !== undefined ? <Button disabled={loading} onClick={() => setCursor(undefined)}>{t('first')}</Button> : null}
    </div>
    <p className="fieldHint" role="status">{notice || '\u00a0'}</p>
  </div>
}
