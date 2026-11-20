/** Existing local recovery permissions remain manageable after multi-computer aggregation is disabled. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, ErrorBanner, Field, Section } from '../components/ui.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { useProtectedNavigation } from '../pending-edits.tsx'
import { en, zh } from './peer-backup.copy.ts'
import { requestPeerBackup } from './peer-backup-request.ts'
import { PeerRecoveryExecution, recoveryExecutionMessage } from './PeerRecoveryExecution.tsx'

type LocalRecovery = { id: string; runtimeId: string; pointId: string } &
  ({ scopeKind: 'project'; projectId: number } | { scopeKind: 'personal'; userId: number })
interface LocalRecoveries { items: LocalRecovery[]; nextCursor?: string }
const identity = (item: LocalRecovery): string => item.scopeKind + '/' + item.id

/** Show only existing local recovery reviews; an empty list preserves the ordinary single-computer page.
 * @returns local space selection and the shared execution-review form, without new recovery operations.
 */
export function LocalRecoveryExecutionSection() {
  const t = useMemo(() => translateCopy(adminLanguage(), { en, zh }), [])
  const label = (item: LocalRecovery): string => item.scopeKind === 'personal'
    ? t('recoveryPersonalRuntime', { id: String(item.userId), runtime: item.runtimeId.slice(0, 8) })
    : t('recoveryProject', { id: String(item.projectId) })
  const navigation = useProtectedNavigation()
  const [items, setItems] = useState<LocalRecovery[]>([])
  const [selected, setSelected] = useState<LocalRecovery>()
  const [cursor, setCursor] = useState<string>()
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const owner = useRef<AbortController | undefined>(undefined)
  const message = useCallback((code: string) => recoveryExecutionMessage(code, t)
    ?? t(code === 'forbidden' || code === '403' ? 'thisAccountIsNotAllowedToDoThat' : 'theBackupServiceIsTemporarilyUnavailable'), [t])
  const read = useCallback(async (after?: string): Promise<void> => {
    owner.current?.abort()
    const controller = new AbortController()
    owner.current = controller
    setLoading(true)
    setError('')
    try {
      const result = await requestPeerBackup<LocalRecoveries>('/recoveries/local-execution'
        + (after ? '?after=' + encodeURIComponent(after) : ''), 'GET', undefined, controller.signal)
      if (controller.signal.aborted) return
      setItems(previous => after ? [...previous, ...result.items.filter(item => !previous.some(row => identity(row) === identity(item)))] : result.items)
      setCursor(result.nextCursor)
      setSelected(previous => previous ?? result.items[0])
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause instanceof Error ? cause.message : String(cause)))
    } finally { if (!controller.signal.aborted) setLoading(false) }
  }, [message])
  useEffect(() => { void read(); return () => owner.current?.abort() }, [read])
  if (!selected && items.length === 0 && !error) return null
  return <Section className="peerBackupSection" title={t('localRecoveryReviews')}
    actions={<Button disabled={loading} onClick={() => void read()}>{t('refresh')}</Button>}>
    <ErrorBanner message={error} />
    {items.some(item => identity(item) !== (selected && identity(selected))) && <Field label={t('recoveredProject')}><select className="input" value={selected ? identity(selected) : ''}
      onChange={event => { if (navigation.canReplace()) setSelected(items.find(item => identity(item) === event.target.value)) }}>
      {selected && !items.some(item => identity(item) === identity(selected)) && <option value={identity(selected)}>{label(selected)}</option>}
      {items.map(item => <option key={identity(item)} value={identity(item)}>{label(item)}</option>)}
    </select></Field>}
    {cursor && <Button disabled={loading} onClick={() => void read(cursor)}>{t('moreRecoveryProjects')}</Button>}
    {selected && <>
      <p>{label(selected)}</p>
      <PeerRecoveryExecution key={identity(selected)} operationId={selected.id} scopeKind={selected.scopeKind} request={requestPeerBackup} t={t} message={message} />
    </>}
  </Section>
}
