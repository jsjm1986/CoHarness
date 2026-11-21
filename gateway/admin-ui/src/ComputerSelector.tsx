/** Document-scoped computer choice over the existing Admin pages and APIs. */
import { Check, ChevronDown, Monitor, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AdminComputerContext, NodeAccessEntry, NodeAccessPage } from '../../src/node-access.ts'
import type { RuntimeNodeId } from '../../src/runtime-catalog.ts'
import { AdminRequestError, getAdminComputerContext, listNodeAccess } from './api.ts'
import { Button, Dialog, IconButton, PageHeaderComputerContext } from './components/ui.tsx'
import { adminLanguage, translateCopy } from './language.ts'
import { zh, en } from './computer.copy.ts'

/**
 * Keep the selected computer and directory reads alive across Admin page titles.
 * @param props - Organization availability, the document target, and the protected navigation callback.
 * @returns The route content with a computer control when organization scope is active.
 */
export function ComputerSelectorProvider({ enabled, nodeId, onSelect, children }: {
  enabled: boolean
  nodeId?: RuntimeNodeId
  onSelect(nodeId?: RuntimeNodeId): void
  children: ReactNode
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [context, setContext] = useState<AdminComputerContext | null>(null)
  const [page, setPage] = useState<NodeAccessPage | null>(null)
  const [selected, setSelected] = useState<NodeAccessEntry | null>(null)
  const [cursor, setCursor] = useState<RuntimeNodeId>()
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [contextLoading, setContextLoading] = useState(true)
  const [error, setError] = useState('')
  const [contextError, setContextError] = useState('')

  useEffect(() => {
    if (!enabled) return
    const reread = () => setRefresh(value => value + 1)
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('hgw-deployment-policy')
    channel?.addEventListener('message', reread)
    window.addEventListener('hgw-deployment-policy-changed', reread)
    return () => { window.removeEventListener('hgw-deployment-policy-changed', reread); channel?.close() }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setContext(null)
      setContextError('')
      setContextLoading(true)
      return
    }
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
  }, [enabled, refresh, t])

  useEffect(() => {
    if (!enabled) {
      setPage(null)
      setSelected(null)
      setCursor(undefined)
      setError('')
      setLoading(true)
      return
    }
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
  }, [enabled, cursor, refresh, nodeId, t])

  const items = page?.items ?? []
  const selection = nodeId === context?.nodeId ? undefined : nodeId
  const active = items.find(item => item.nodeId === selection)
  const current = active ?? selected
  const centerName = context?.name ?? t('center')
  const currentName = selection === undefined ? centerName : current?.name ?? t('selected', { id: selection.slice(0, 8) })
  const notice = error || contextError || (context !== null && !context.forwardingEnabled ? t('disabled') : '')
  const choices: ComputerChoice[] = [{ name: centerName, detail: context === null ? undefined : t('center') }]
  if (selection !== undefined && active === undefined) choices.push({ id: selection, name: currentName, status: current?.status })
  for (const item of items) choices.push({ id: item.nodeId, name: item.name, status: item.status })
  const next = page?.nextCursor ?? undefined
  const control = enabled ? <ComputerSelector
    choices={choices} selection={selection} currentName={currentName} notice={notice}
    loading={loading} refreshing={loading || contextLoading} onSelect={onSelect}
    onRefresh={() => setRefresh(value => value + 1)}
    onNext={next === undefined ? undefined : () => setCursor(next)}
    onFirst={cursor === undefined ? undefined : () => setCursor(undefined)}
  /> : null
  return <PageHeaderComputerContext.Provider value={control}>{children}</PageHeaderComputerContext.Provider>
}

interface ComputerChoice {
  id?: RuntimeNodeId
  name: string
  detail?: string
  status?: NodeAccessEntry['status']
}

function ComputerSelector({ choices, selection, currentName, notice, loading, refreshing, onSelect, onRefresh, onFirst, onNext }: {
  choices: readonly ComputerChoice[]
  selection?: RuntimeNodeId
  currentName: string
  notice: string
  loading: boolean
  refreshing: boolean
  onSelect(nodeId?: RuntimeNodeId): void
  onRefresh(): void
  onFirst?(): void
  onNext?(): void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const panelId = useId()
  const headingId = useId()
  const noticeId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const nativePopover = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function'

  useLayoutEffect(() => {
    const popup = panel.current
    const button = trigger.current
    if (!open || popup === null || button === null) return
    const viewport = window.visualViewport
    const anchored = CSS.supports('position-area: block-end span-inline-start') && CSS.supports('position-try-fallbacks: flip-block')
    const position = () => {
      const width = viewport?.width ?? document.documentElement.clientWidth
      const height = viewport?.height ?? window.innerHeight
      const measured = !anchored || height < 360 || (viewport?.scale ?? 1) > 1
      popup.toggleAttribute('data-measured', measured)
      if (!measured) return
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8
      const topEdge = (viewport?.offsetTop ?? 0) + 8
      const rightEdge = leftEdge + width - 16
      const bottomEdge = topEdge + height - 16
      const anchor = button.getBoundingClientRect()
      popup.style.setProperty('--computer-panel-available-width', `${Math.max(0, width - 16)}px`)
      const below = Math.max(0, bottomEdge - anchor.bottom - 7)
      const above = Math.max(0, anchor.top - topEdge - 7)
      const side = Math.max(above, below) < popup.scrollHeight && anchor.left - leftEdge - 7 >= popup.offsetWidth
      const flip = below < popup.scrollHeight && above > below
      const available = side ? bottomEdge - topEdge : flip ? above : below
      popup.style.setProperty('--computer-panel-available-height', `${Math.max(0, available)}px`)
      const box = popup.getBoundingClientRect()
      const right = side ? anchor.left - 7 : Math.min(anchor.right, rightEdge)
      const y = side ? Math.min(anchor.top, bottomEdge - box.height) : flip ? anchor.top - 7 - box.height : anchor.bottom + 7
      popup.style.setProperty('--computer-panel-x', `${Math.max(leftEdge, right - box.width)}px`)
      popup.style.setProperty('--computer-panel-y', `${Math.max(topEdge, y)}px`)
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, { passive: true })
    viewport?.addEventListener('resize', position)
    viewport?.addEventListener('scroll', position)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position)
      viewport?.removeEventListener('resize', position)
      viewport?.removeEventListener('scroll', position)
    }
  }, [open, choices, notice])

  const close = () => {
    panel.current?.hidePopover()
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  const refresh = <IconButton label={t('refresh')} icon={RefreshCw} aria-disabled={refreshing || undefined} aria-busy={refreshing || undefined}
    className={refreshing ? 'computerRefreshing' : undefined} onClick={() => { if (!refreshing) onRefresh() }} />
  const directory = <>
    {notice === '' ? null : <div className="computerNotice" id={noticeId} role="status">{notice}</div>}
    <ul className="computerOptions">
      {choices.map(choice => {
        const current = choice.id === selection
        const status = choice.status === undefined || choice.status === 'connected' ? choice.detail : t(choice.status)
        return <li key={choice.id ?? 'center'}>
          <button type="button" className="computerOption" aria-current={current || undefined}
            disabled={choice.status === 'revoked' || choice.status === 'quarantined'}
            onClick={() => { close(); if (!current) onSelect(choice.id) }}>
            <Monitor aria-hidden="true" />
            <span>{choice.name}{status === undefined ? null : <small>{status}</small>}</span>
            {current ? <Check aria-hidden="true" /> : null}
          </button>
        </li>
      })}
    </ul>
    {onFirst === undefined && onNext === undefined ? null : <div className="computerPagination">
      {onFirst === undefined ? null : <Button type="button" variant="ghost" disabled={loading} onClick={onFirst}>{t('first')}</Button>}
      {onNext === undefined ? null : <Button type="button" variant="ghost" disabled={loading} onClick={onNext}>{t('more')}</Button>}
    </div>}
  </>

  return <>
    <button ref={trigger} type="button" className="button button-secondary computerTrigger"
      aria-label={t('choose', { name: currentName })} aria-expanded={open} aria-describedby={notice === '' ? undefined : noticeId}
      aria-controls={nativePopover ? panelId : undefined} aria-haspopup={nativePopover ? undefined : 'dialog'}
      popoverTarget={nativePopover ? panelId : undefined} title={currentName}
      onClick={nativePopover ? undefined : () => setOpen(true)}>
      <Monitor aria-hidden="true" />
      <span className="computerName">{currentName}</span>
      {notice === '' ? null : <TriangleAlert className="computerWarning" aria-hidden="true" />}
      <ChevronDown className="computerChevron" aria-hidden="true" />
    </button>
    {nativePopover ? <div ref={panel} id={panelId} className="computerPanel" popover="auto" role="group" aria-labelledby={headingId}
      onToggle={event => setOpen(event.newState === 'open')}>
      <div className="computerPanelHeader"><h2 id={headingId}>{t('label')}</h2>{refresh}</div>
      {directory}
    </div> : <Dialog open={open} title={t('label')} onClose={close} footer={refresh}>{directory}</Dialog>}
  </>
}
