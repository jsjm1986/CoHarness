/** Organization-owned computer grants remain manageable while a computer is disconnected. */
import { useDeploymentContext } from '../deployment-context.tsx'
import { usePendingEdits } from '../pending-edits.tsx'
import { useEffect, useMemo, useState } from 'react'
import { listUserComputerPermissions, saveUserComputerPermission, type AdminComputerPermission } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { ComputerBadge } from '../model-settings-primitives.ts'
import { zh, en } from '../runtime.copy.ts'
import { Button, EmptyState, ErrorBanner, LoadingState, Section, StatusBadge, Switch } from './ui.tsx'

/** @param props - account whose computer access is being managed. @returns revision-checked grants over a bounded directory. */
export function UserComputerPermissions({ userId }: { userId: number }) {
  const deployment = useDeploymentContext().value
  const showComputer = deployment?.mode === 'multi'
  const localNode = deployment?.scope === 'local' ? deployment.entry.nodeId : undefined
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [page, setPage] = useState<Awaited<ReturnType<typeof listUserComputerPermissions>>>()
  const [cursor, setCursor] = useState<string>()
  const [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const items = page?.items.filter(computer => localNode === undefined || computer.nodeId === localNode) ?? []
  useEffect(() => { setCursor(undefined) }, [localNode])
  usePendingEdits(busy)
  useEffect(() => {
    const controller = new AbortController(); setLoading(true)
    void listUserComputerPermissions(userId, cursor, controller.signal).then(value => {
      if (!controller.signal.aborted) { setPage(value); setError(''); setNeedsRefresh(false) }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) { setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t(showComputer ? 'permissionReadFailed' : 'localReadFailed')); setNeedsRefresh(true) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [userId, cursor, refresh, showComputer, t, localNode])
  async function save(computer: AdminComputerPermission, enabled: boolean): Promise<void> {
    if (busy || loading || needsRefresh || localNode !== undefined && computer.nodeId !== localNode) return
    setBusy(true); setError('')
    try { await saveUserComputerPermission(userId, computer, enabled); setRefresh(value => value + 1) }
    catch (cause) { setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t(showComputer ? 'permissionSaveUnconfirmed' : 'localSaveUnconfirmed')); setNeedsRefresh(true) }
    finally { setBusy(false) }
  }
  return <Section title={t(showComputer ? 'computers' : 'localPermissions')}>
    <p className="muted">{t(showComputer ? 'permissionHint' : 'localPermissionHint')}</p><ErrorBanner message={error} />
    {loading && page === undefined ? <LoadingState label={t(showComputer ? 'loadingComputers' : 'localLoading')} /> : null}
    {!loading && page !== undefined && items.length === 0 ? <EmptyState title={t(showComputer ? 'noComputers' : 'localEmpty')} {...showComputer ? { detail: t('noComputersDetail') } : {}} /> : null}
    <div className="computerPermissions" aria-busy={loading || busy}>{items.map(computer => <div className="qualificationHead" key={computer.nodeId}>
      {showComputer && <ComputerBadge name={computer.name} label={t('computer')} details={[{ label: t('computer'), value: computer.nodeId }]} />}
      <StatusBadge>{computer.enabled ? t('grant') : t('revoke')}</StatusBadge>
      <Switch label={t('grant')} ariaLabel={showComputer ? `${computer.name} · ${t('grant')}` : t('grant')} checked={computer.enabled} disabled={busy || loading || needsRefresh}
        onChange={enabled => { void save(computer, enabled) }} />
    </div>)}</div>
    <div className="formActions"><Button disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>{t(showComputer ? 'refreshComputers' : 'localRefresh')}</Button>
      {showComputer && page?.nextCursor ? <Button disabled={busy || loading} onClick={() => setCursor(page.nextCursor!)}>{t('moreComputers')}</Button> : null}
      {cursor === undefined ? null : <Button disabled={busy || loading} onClick={() => setCursor(undefined)}>{t('first')}</Button>}</div>
  </Section>
}
