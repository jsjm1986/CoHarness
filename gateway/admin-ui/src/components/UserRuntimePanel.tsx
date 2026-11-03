/** Account-wide Runtime allocations and limits, with computer-specific lifecycle operations. */
import { useDeploymentContext } from '../deployment-context.tsx'
import { usePendingEdits } from '../pending-edits.tsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { allocateUserRuntime, getAdminComputerContext, listUserRuntimes, operateRuntime,
  type RuntimeCatalogEntry, type RuntimeCatalogPage, type RuntimeId, type RuntimeNodeId } from '../api.ts'
import { adminComputerTarget } from '../computer-target.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { ComputerBadge } from '../model-settings-primitives.ts'
import { zh, en } from '../runtime.copy.ts'
import { InstanceState } from './users.tsx'
import { RuntimeAllocationPolicyEditor } from './RuntimeAllocationPolicyEditor.tsx'
import { Button, ConfirmDialog, EmptyState, ErrorBanner, LoadingState, Section } from './ui.tsx'

/** @param props - account whose existing assignments and policy are managed. @returns bounded Runtime controls inside the existing user detail page. */
export function UserRuntimePanel({ userId, onChanged }: { userId: number; onChanged?(): void }) {
  const deployment = useDeploymentContext().value
  const showComputer = deployment?.mode === 'multi'
  const localNode = deployment?.scope === 'local' ? deployment.entry.nodeId : undefined
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [page, setPage] = useState<RuntimeCatalogPage | null>(null)
  const [nodeId, setNodeId] = useState<RuntimeNodeId>()
  const [cursor, setCursor] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  usePendingEdits(busy)
  const [confirm, setConfirm] = useState<{ runtime: RuntimeCatalogEntry; action: 'start' | 'stop' | 'restart' | 'retire' } | null>(null)
  const allocation = useRef<{ nodeId: RuntimeNodeId; requestId: string } | undefined>(undefined)
  const items = page?.items.filter(runtime => localNode === undefined || runtime.node.id === localNode) ?? []
  const allocationUnavailable = localNode !== undefined && (allocation.current?.nodeId ?? nodeId) !== undefined
    && (allocation.current?.nodeId ?? nodeId) !== localNode
  const confirmationUnavailable = confirm !== null && localNode !== undefined && confirm.runtime.node.id !== localNode
  useEffect(() => { setCursor(undefined) }, [localNode])
  const lifetime = useRef<AbortController | null>(null)
  useEffect(() => { const owner = new AbortController(); lifetime.current = owner; return () => { owner.abort(); lifetime.current = null } }, [])
  useEffect(() => {
    const controller = new AbortController(); setLoading(true)
    void Promise.all([listUserRuntimes(userId, cursor, controller.signal), getAdminComputerContext(controller.signal)])
      .then(([runtimes, context]) => {
        if (controller.signal.aborted) return
        setPage(runtimes); setNeedsRefresh(false)
        setNodeId(adminComputerTarget(globalThis.location?.pathname ?? '/admin') ?? context.nodeId); setError('')
      }).catch((cause: unknown) => { if (!controller.signal.aborted) { setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t('readFailed')); setNeedsRefresh(true) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [userId, cursor, revision, t, localNode])
  async function run<T>(operation: () => Promise<T>, completion?: (result: T) => string): Promise<void> {
    if (busy || needsRefresh) return
    const owner = lifetime.current
    setBusy(true); setError(''); setNotice('')
    try { const result = await operation(); if (owner?.signal.aborted) return; setConfirm(null); setRevision(value => value + 1); onChanged?.(); setNotice(completion === undefined ? t('updated') : completion(result)) }
    catch (cause) { if (!owner?.signal.aborted) { setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t(confirm === null ? 'allocationUnconfirmed' : 'operationUnconfirmed')); if (confirm !== null) setNeedsRefresh(true) } }
    finally { if (!owner?.signal.aborted) setBusy(false) }
  }
  async function allocate(): Promise<RuntimeId> {
    if (nodeId === undefined || allocationUnavailable) throw new Error(t('selectionUnavailable'))
    allocation.current ??= { nodeId, requestId: crypto.randomUUID() }
    const receipt = await allocateUserRuntime(userId, allocation.current.nodeId, allocation.current.requestId)
    if (receipt.status === 'preparing') throw new Error(t('allocationPending'))
    allocation.current = undefined
    return receipt.runtimeId
  }
  const controls = (runtime: RuntimeCatalogEntry) => <div className="formActions runtimeActions">{(['start', 'stop', 'restart', 'retire'] as const).map(action => <Button key={action} variant={action === 'retire' ? 'danger' : 'secondary'}
    disabled={busy || loading || needsRefresh || runtime.provisioning === 'preparing' || action === 'start' && ['ready', 'starting', 'stopping'].includes(runtime.observedState)}
    onClick={() => { setError(''); setConfirm({ runtime, action }) }}>{t(action)}</Button>)}</div>
  return <Section title={t(showComputer ? 'title' : 'localTitle')}>
    <p className="muted">{t(showComputer ? 'description' : 'localDescription')}</p><ErrorBanner message={confirm === null ? error : ''} />
    {loading && page === null ? <LoadingState label={t('refresh')} /> : null}
    <div className="formActions">
      <Button variant="primary" loading={busy && confirm === null} disabled={busy || loading || needsRefresh || allocationUnavailable || nodeId === undefined} onClick={() => { void run(allocate, runtime => t('allocated', { runtime })) }}>{t(allocation.current === undefined ? showComputer ? 'allocate' : 'localAllocate' : 'retryAllocation')}</Button>
      <Button loading={loading} disabled={busy} onClick={() => setRevision(value => value + 1)}>{t('refresh')}</Button>
    </div>
    {!loading && page !== null && items.length === 0 ? <EmptyState title={t(cursor === undefined ? 'noAllocations' : 'noPageAllocations')} detail={t(cursor === undefined ? showComputer ? 'noAllocationsDetail' : 'localNoAllocations' : 'noPageAllocationsDetail')} /> : null}
    {page === null || items.length === 0 ? null : <div aria-busy={loading || busy}>
      <div className="tableWrap desktopOnly"><table className="dataTable"><thead><tr>{showComputer && <th>{t('computer')}</th>}<th>{t('identity')}</th><th>{t('state')}</th><th>{t('actions')}</th></tr></thead>
      <tbody>{items.map(runtime => <tr key={runtime.id}>
        {showComputer && <td><ComputerBadge label={t('computer')} name={runtime.node.name} details={[{ label: t('identity'), value: runtime.id }, { label: t('generation'), value: String(runtime.generation) }]} /></td>}
        <td className="terminalIdentity">{runtime.id}</td><td><InstanceState state={runtime.observedState} /></td>
        <td>{controls(runtime)}</td>
      </tr>)}</tbody></table></div>
      <div className="mobileList runtimeMobileList">{items.map(runtime => <article className="mobileItem" key={runtime.id}>
        <div className="mobileItemHeader">{showComputer && <ComputerBadge label={t('computer')} name={runtime.node.name} details={[{ label: t('identity'), value: runtime.id }, { label: t('generation'), value: String(runtime.generation) }]} />}<InstanceState state={runtime.observedState} /></div>
        <div className="mobileItemBody"><span className="fieldLabel">{t('identity')}</span><span className="codeText runtimeAssignmentId">{runtime.id}</span></div>
        {controls(runtime)}
      </article>)}</div>
    </div>}
    <div className="formActions">{page?.nextCursor ? <Button disabled={busy || loading} onClick={() => setCursor(page.nextCursor!)}>{t('more')}</Button> : null}
      {cursor === undefined ? null : <Button disabled={busy || loading} onClick={() => setCursor(undefined)}>{t('first')}</Button>}</div>
    {notice === '' ? null : <p role="status">{notice}</p>}
    <details className="runtimePolicyDetails"><summary>{t('limitsTitle')}</summary><RuntimeAllocationPolicyEditor userId={userId} /></details>
    <ConfirmDialog open={confirm !== null} title={t('confirm', { action: confirm === null ? '' : t(confirm.action) })}
      description={confirm === null ? '' : `${t(showComputer ? 'confirmDetail' : 'localConfirm', { computer: confirm.runtime.node.name, runtime: confirm.runtime.id, generation: String(confirm.runtime.generation) })}${confirm.action === 'retire' ? ` · ${t(showComputer ? 'retiredDetail' : 'localRetired')}` : ''}`}
      pending={busy} error={confirmationUnavailable ? t('selectionUnavailable') : error} confirmDisabled={needsRefresh || confirmationUnavailable} confirmLabel={confirm === null ? '' : t(confirm.action)} onClose={() => { if (!busy) setConfirm(null) }}
      onConfirm={() => { if (confirm !== null && !confirmationUnavailable) { const selected = confirm; void run(() => operateRuntime(selected.runtime, selected.action)) } }} />
  </Section>
}
