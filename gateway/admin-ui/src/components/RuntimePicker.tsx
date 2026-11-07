/** Bounded selection of an exact Runtime on the Admin document's computer. */
import { useDeploymentContext } from '../deployment-context.tsx'
import { useProtectedNavigation } from '../pending-edits.tsx'
import { useEffect, useMemo, useState } from 'react'
import { getAdminComputerContext, listRuntimeEnvironments, listUserRuntimes, type RuntimeCatalogEntry, type RuntimeCatalogPage, type RuntimeId } from '../api.ts'
import { adminComputerTarget } from '../computer-target.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { ComputerBadge } from '../model-settings-primitives.ts'
import { zh, en } from '../runtime.copy.ts'
import { Button, ErrorBanner, Field } from './ui.tsx'
import { instanceStateLabel } from './instance-state-label.ts'

/** @param props - existing owner selection and an explicit instance callback. @returns the existing form controls plus the computer identity card. */
export function RuntimePicker({ owner, value, selectedId, onSelect, onAvailabilityChange, disabled = false }: {
  owner: { kind: 'user' | 'project'; id: number }
  value?: RuntimeCatalogEntry
  selectedId?: RuntimeId
  disabled?: boolean
  onSelect(value: RuntimeCatalogEntry | undefined): void
  onAvailabilityChange?(available: boolean): void
}) {
  const navigation = useProtectedNavigation()
  const deployment = useDeploymentContext().value
  const showComputer = deployment?.mode === 'multi'
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const [page, setPage] = useState<RuntimeCatalogPage | null>(null)
  const [node, setNode] = useState<string>()
  const [cursor, setCursor] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); onAvailabilityChange?.(false)
    void Promise.all([getAdminComputerContext(controller.signal), owner.kind === 'user'
      ? listUserRuntimes(owner.id, cursor, controller.signal) : listRuntimeEnvironments(cursor, controller.signal)]).then(([context, result]) => {
      if (controller.signal.aborted) return
      const selectedNode = adminComputerTarget(globalThis.location?.pathname ?? '/admin') ?? context.nodeId
      setNode(selectedNode); setPage(result); setError('')
      const matches = result.items.filter(item => item.node.id === selectedNode && item.owner.id === owner.id && item.owner.kind === (owner.kind === 'user' ? 'personal' : 'project'))
      const current = matches.find(item => item.id === (value?.id ?? selectedId))
      if (current !== undefined) {
        if (value === undefined || value.id !== current.id || value.generation !== current.generation) {
          if (value !== undefined && !navigation.canReplace()) { setError(t('selectionUnavailable')); return }
          onSelect(current)
        }
        onAvailabilityChange?.(true)
      }
      else if (cursor === undefined && result.nextCursor === null && (value !== undefined || selectedId !== undefined)) setError(t('selectionUnavailable'))
      else if (value === undefined && selectedId === undefined && result.nextCursor === null && matches.length === 1) { onSelect(matches[0]); onAvailabilityChange?.(true) }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) { setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : t('readFailed')) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
    // The owner is keyed by the parent; value changes never reload the directory.
  }, [owner.kind, owner.id, cursor, refresh, t, deployment?.revision])
  const items = page?.items.filter(item => item.node.id === node && item.owner.id === owner.id && item.owner.kind === (owner.kind === 'user' ? 'personal' : 'project')) ?? []
  const active = value ?? page?.items.find(item => item.id === selectedId && item.node.id === node)
  const choices = value === undefined || items.some(item => item.id === value.id) ? items : [value, ...items]
  return <div>
    <div className="targetPicker" aria-busy={loading}>
      <Field label={t('choose')}><select className="select" aria-label={t('choose')} value={value?.id ?? selectedId ?? ''} disabled={disabled || loading}
        onChange={event => { if (navigation.canReplace()) { const next = choices.find(item => item.id === event.currentTarget.value); onSelect(next); onAvailabilityChange?.(next !== undefined && items.some(item => item.id === next.id)) } }}>
        <option value="">{t('placeholder')}</option>{selectedId !== undefined && !choices.some(item => item.id === selectedId) ? <option value={selectedId}>{selectedId}</option> : null}{choices.map(item => <option key={item.id} value={item.id}>{showComputer ? `${item.node.name} · ` : ''}{item.id.slice(0, 8)} · {instanceStateLabel(item.observedState)}</option>)}
      </select></Field>
      {!showComputer || active === undefined ? null : <ComputerBadge label={t('computer')} name={active.node.name} details={[
        { label: t('identity'), value: active.id }, { label: t('generation'), value: String(active.generation) },
      ]} />}
      <Button disabled={disabled || loading} onClick={() => setRefresh(current => current + 1)}>{t('refresh')}</Button>
      {page?.nextCursor ? <Button disabled={disabled || loading} onClick={() => setCursor(page.nextCursor!)}>{t('more')}</Button> : null}
      {cursor === undefined ? null : <Button disabled={disabled || loading} onClick={() => setCursor(undefined)}>{t('first')}</Button>}
    </div>
    <ErrorBanner message={error} />{!loading && page !== null && items.length === 0 ? <p className="muted">{t(showComputer ? 'empty' : 'localMatching')}</p> : null}
  </div>
}
