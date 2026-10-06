import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Eye,
  Filter,
  SearchCheck,
  RotateCcw,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  applyArchiveAction,
  exportArchive,
  getArchive,
  getArchiveStatus,
  listArchives,
  previewEmptyDrafts,
  trashEmptyDrafts,
  type EmptyDraftCandidate,
  type ConversationArchiveDetail,
  type ConversationArchiveRow,
  type ConversationArchiveState,
} from '../api.ts'
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
} from '../components/ui.tsx'
import { ArchiveConversation } from '../components/ArchiveConversation.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as archivesZh, en as archivesEn } from './archives.copy.ts'

const PAGE_SIZE = 50

type Draft = { state: ConversationArchiveState | 'all'; query: string; userId: string; projectId: string }
const EMPTY_DRAFT: Draft = { state: 'archived', query: '', userId: '', projectId: '' }

export function ArchivesPage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  const [rows, setRows] = useState<ConversationArchiveRow[]>([])
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [active, setActive] = useState<Draft>(EMPTY_DRAFT)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<ConversationArchiveDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState<'restore' | 'trash' | 'purge' | null>(null)
  const [confirmAction, setConfirmAction] = useState<'restore' | 'trash' | 'purge' | null>(null)
  const [actionError, setActionError] = useState('')
  const [emptyCandidates, setEmptyCandidates] = useState<EmptyDraftCandidate[]>([])
  const [emptyScanned, setEmptyScanned] = useState(false)
  const [emptySelected, setEmptySelected] = useState<Set<string>>(new Set())
  const [emptyCutoff, setEmptyCutoff] = useState<number | null>(null)
  const [emptyConfirm, setEmptyConfirm] = useState<{ ids: readonly string[]; cutoff: number | null } | null>(null)
  const [emptyResult, setEmptyResult] = useState('')
  const [emptyLoading, setEmptyLoading] = useState(false)
  const [emptyError, setEmptyError] = useState('')
  const rowsGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const viewKey = useRef(JSON.stringify([EMPTY_DRAFT, 0]))
  useEffect(() => () => { rowsGeneration.current++; detailGeneration.current++ }, [])

  const fetchRows = useCallback(async (filter: Draft, nextOffset: number, showLoading = true) => {
    const userId = filter.userId === '' ? undefined : Number(filter.userId)
    const projectId = filter.projectId === '' ? undefined : Number(filter.projectId)
    if ((userId !== undefined && (!Number.isSafeInteger(userId) || userId <= 0))
      || (projectId !== undefined && (!Number.isSafeInteger(projectId) || projectId <= 0))) {
      setError(t('invalidIdFilter'))
      return
    }
    const key = JSON.stringify([filter, nextOffset])
    if (showLoading) viewKey.current = key
    else if (viewKey.current !== key) return
    const generation = ++rowsGeneration.current
    if (showLoading) setLoading(true)
    try {
      const current = await listArchives({
        state: filter.state,
        query: filter.query,
        userId,
        projectId,
        limit: PAGE_SIZE,
        offset: nextOffset,
      })
      if (generation !== rowsGeneration.current || viewKey.current !== key) return
      setRows(current)
      setOffset(nextOffset)
      if (showLoading) setSelected(new Set())
      else setSelected(previous => new Set([...previous].filter(id => current.some(row => row.rootSessionId === id))))
      setError('')
    } catch (cause) {
      if (generation === rowsGeneration.current) setError(messageFrom(cause))
    } finally {
      if (showLoading && generation === rowsGeneration.current) setLoading(false)
    }
  }, [t])

  useEffect(() => { void fetchRows(EMPTY_DRAFT, 0) }, [fetchRows])

  useEffect(() => {
    const pending = rows.filter(row => row.syncState === 'pending' && row.rootSessionId !== detail?.record.rootSessionId)
    if (pending.length === 0) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const generation = rowsGeneration.current
    const poll = async () => {
      try {
        const statuses = await Promise.all(pending.map(row => getArchiveStatus(row.rootSessionId)))
        if (cancelled || generation !== rowsGeneration.current) return
        if (statuses.some(row => active.state !== 'all' && row.state !== active.state)) {
          await fetchRows(active, offset, false)
        } else {
          const byId = new Map(statuses.map(row => [row.rootSessionId, row]))
          setRows(current => current.map(row => byId.get(row.rootSessionId) ?? row))
        }
      } catch (cause) {
        if (!cancelled && generation === rowsGeneration.current) setError(messageFrom(cause))
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 5000)
    }
    timer = setTimeout(() => void poll(), 5000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [active, detail?.record.rootSessionId, fetchRows, offset, rows])

  useEffect(() => {
    if (detail?.record.syncState !== 'pending') return
    const id = detail.record.rootSessionId
    const generation = detailGeneration.current
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const record = await getArchiveStatus(id)
        if (cancelled || generation !== detailGeneration.current) return
        setDetail(current => current?.record.rootSessionId !== id ? current : {
          ...current, record, ...record.state === 'purged' ? { descendants: [], events: [], hasMore: false } : {},
        })
        if (record.syncState !== 'pending') { void fetchRows(active, offset, false); return }
      } catch (cause) {
        if (!cancelled && generation === detailGeneration.current) setActionError(messageFrom(cause))
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000)
    }
    timer = setTimeout(() => void poll(), 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [active, detail?.record.rootSessionId, detail?.record.syncState, fetchRows, offset])

  function onFilter(event: FormEvent) {
    event.preventDefault()
    setActive(draft)
    void fetchRows(draft, 0)
  }

  async function scanEmptyDrafts() {
    setEmptyLoading(true)
    setEmptyError('')
    try {
      const result = await previewEmptyDrafts({ limit: 200 })
      setEmptyCandidates(result.candidates)
      setEmptyCutoff(result.cutoff)
      setEmptyScanned(true)
      setEmptySelected(new Set())
      setEmptyResult('')
    } catch (cause) {
      setEmptyError(messageFrom(cause))
    } finally {
      setEmptyLoading(false)
    }
  }

  function requestEmptyTrash() {
    if (emptySelected.size === 0) return
    setEmptyConfirm({ ids: [...emptySelected], cutoff: emptyCutoff })
  }

  async function confirmEmptyTrash() {
    const intent = emptyConfirm
    if (intent === null || intent.ids.length === 0) return
    setEmptyLoading(true)
    setEmptyError('')
    try {
      const result = await trashEmptyDrafts([...intent.ids], intent.cutoff ?? undefined)
      const skipped = Math.max(0, intent.ids.length - result.trashed.length)
      setEmptyConfirm(null)
      await scanEmptyDrafts()
      setEmptyResult(t('emptyTrashResult', { count: String(result.trashed.length), skipped: String(skipped) }))
    } catch (cause) {
      setEmptyError(messageFrom(cause))
    } finally {
      setEmptyLoading(false)
    }
  }

  function resetFilters() {
    setDraft(EMPTY_DRAFT)
    setActive(EMPTY_DRAFT)
    void fetchRows(EMPTY_DRAFT, 0)
  }

  async function openDetail(row: ConversationArchiveRow) {
    const generation = ++detailGeneration.current
    setDetailLoading(true)
    setActionError('')
    try {
      const current = await getArchive(row.rootSessionId)
      if (generation === detailGeneration.current) setDetail(current)
    } catch (cause) {
      if (generation === detailGeneration.current) setError(messageFrom(cause))
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false)
    }
  }

  async function runAction(action: 'restore' | 'trash' | 'purge') {
    const ids = detail === null ? [...selected] : [detail.record.rootSessionId]
    if (ids.length === 0) return
    setPendingAction(action)
    setActionError('')
    try {
      const result = await applyArchiveAction(action, ids)
      const failed = result.results.filter(item => !item.ok)
      if (failed.length > 0) setActionError(t('actionPartialFailure', { count: String(failed.length), details: failed.map(item => item.error ?? item.rootSessionId).join(t('detailSeparator')) }))
      else if (detail !== null) {
        const generation = detailGeneration.current
        const record = await getArchiveStatus(detail.record.rootSessionId)
        if (generation === detailGeneration.current) setDetail(current => current?.record.rootSessionId !== record.rootSessionId ? current : {
          ...current, record, ...record.state === 'purged' ? { descendants: [], events: [], hasMore: false } : {},
        })
      }
      await fetchRows(active, offset, false)
    } catch (cause) {
      setActionError(messageFrom(cause))
    } finally {
      setPendingAction(null)
    }
  }

  const hasFilters = Object.entries(active).some(([key, value]) => key !== 'state' ? value !== '' : value !== 'archived')
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const selectedRows = useMemo(() => rows.filter(row => selected.has(row.rootSessionId)), [rows, selected])
  const allSelected = rows.length > 0 && selectedRows.length === rows.length
  const indeterminate = selectedRows.length > 0 && !allSelected
  const selectAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectAllRef.current !== null) selectAllRef.current.indeterminate = indeterminate
  }, [indeterminate])
  const toggleAll = (checked: boolean): void => {
    setSelected(checked ? new Set(rows.map(row => row.rootSessionId)) : new Set())
  }

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        meta={loading ? undefined : t('recordCount', { count: String(rows.length) })}
        actions={selectedRows.length === 0 ? undefined : (
          <div className="pageActionGroup">
            <Button icon={Undo2} onClick={() => setConfirmAction('restore')}>{t('restoreSelected')}</Button>
            <Button icon={Trash2} variant="danger" onClick={() => setConfirmAction('trash')}>{t('moveToTrash')}</Button>
            <Button variant="danger" onClick={() => setConfirmAction('purge')}>{t('purgeSelected')}</Button>
          </div>
        )}
      />
      <ErrorBanner message={error} />
      <Section title={t('emptySectionTitle')} meta={emptyScanned ? t('emptyMetaScanned') : t('emptyMetaAdminOnly')}>
        <div className="archiveBulkBar">
          <span>{t('emptyHint')}</span>
          <div className="pageActionGroup">
            <Button icon={SearchCheck} onClick={() => { void scanEmptyDrafts() }} loading={emptyLoading}>{t('scan')}</Button>
            {emptySelected.size > 0 ? <Button icon={Trash2} variant="danger" disabled={emptyLoading} onClick={requestEmptyTrash}>{t('trashSelectedEmpty')}</Button> : null}
          </div>
        </div>
        <ErrorBanner message={emptyError} />
        {emptyResult === '' ? null : <p className="emptyTrashResult">{emptyResult}</p>}
        {emptyCandidates.length === 0 ? <div className="emptyDraftState">
          <span className="emptyDraftStateIcon" aria-hidden="true"><Archive /></span>
          <strong>{emptyScanned ? t('emptyScannedTitle') : t('emptyNotScannedTitle')}</strong>
          <p>{emptyScanned ? t('emptyScannedDetail') : t('emptyNotScannedDetail')}</p>
        </div> : (
          <>
            <div className="tableWrap desktopOnly emptyDraftTableWrap">
              <table className="dataTable emptyDraftTable" aria-label={t('emptyTableAria')}>
                <thead><tr><th aria-label={t('colSelect')} /><th>{t('colSession')}</th><th>{t('colOwner')}</th><th>{t('creatorLabel')}</th><th>{t('colUpdatedAt')}</th><th>{t('colEvents')}</th></tr></thead>
                <tbody>{emptyCandidates.map(candidate => (
                  <tr key={candidate.rootSessionId}>
                    <td><input type="checkbox" aria-label={t('selectItem', { name: candidate.rootSessionId })} checked={emptySelected.has(candidate.rootSessionId)} onChange={event => setEmptySelected(nextSelection(emptySelected, candidate.rootSessionId, event.target.checked))} /></td>
                    <td><span className="codeText">{candidate.rootSessionId}</span></td>
                    <td><span className="archiveOwner"><strong>{candidate.project?.name ?? t('personalConversation')}</strong><small>{candidate.runtime.kind === 'project' ? t('projectRuntime', { id: String(candidate.runtime.id) }) : t('personalRuntime', { id: String(candidate.runtime.id) })}</small></span></td>
                    <td>{candidate.creator?.displayName ?? t('unknownUser')}</td>
                    <td><time dateTime={new Date(candidate.updatedAt).toISOString()}>{formatTime(candidate.updatedAt)}</time></td>
                    <td>{candidate.eventCount}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="mobileList emptyDraftMobileList">{emptyCandidates.map(candidate => (
              <label className="mobileItem" key={candidate.rootSessionId}>
                <span className="mobileItemHeader"><span className="checkLabel"><input type="checkbox" aria-label={t('selectItem', { name: candidate.rootSessionId })} checked={emptySelected.has(candidate.rootSessionId)} onChange={event => setEmptySelected(nextSelection(emptySelected, candidate.rootSessionId, event.target.checked))} /><strong className="codeText">{candidate.rootSessionId}</strong></span><strong>{candidate.project?.name ?? t('personalConversation')}</strong></span>
                <span className="mobileItemBody"><span className="muted">{candidate.creator?.displayName ?? t('unknownUser')} · {candidate.runtime.kind === 'project' ? t('projectRuntime', { id: String(candidate.runtime.id) }) : t('personalRuntime', { id: String(candidate.runtime.id) })}</span><span className="muted">{t('eventCount', { count: String(candidate.eventCount) })} · {formatTime(candidate.updatedAt)}</span></span>
              </label>
            ))}</div>
          </>
        )}
      </Section>
      <Section title={t('filterTitle')}>
        <form className="filterPanel" onSubmit={onFilter}>
          <div className="filterGrid">
            <Field label={t('stateLabel')}>
              <select className="input" value={draft.state} onChange={event => setDraft({ ...draft, state: event.target.value as Draft['state'] })}>
                <option value="archived">{t('stateArchived')}</option>
                <option value="trash">{t('stateTrash')}</option>
                <option value="purged">{t('statePurged')}</option>
                <option value="all">{t('stateAll')}</option>
              </select>
            </Field>
            <Field label={t('filterKeyword')}>
              <input className="input" value={draft.query} onChange={event => setDraft({ ...draft, query: event.target.value })} placeholder={t('filterKeywordPlaceholder')} />
            </Field>
            <Field label={t('filterUserId')}>
              <input className="input" value={draft.userId} onChange={event => setDraft({ ...draft, userId: event.target.value })} placeholder={t('filterUserIdAll')} inputMode="numeric" />
            </Field>
            <Field label={t('filterProjectId')}>
              <input className="input" value={draft.projectId} onChange={event => setDraft({ ...draft, projectId: event.target.value })} placeholder={t('filterProjectIdAll')} inputMode="numeric" />
            </Field>
          </div>
          <div className="filterActions">
            <Button type="button" icon={RotateCcw} onClick={resetFilters} disabled={!hasFilters && draft.query === '' && draft.userId === '' && draft.projectId === ''}>{t('filterReset')}</Button>
            <Button type="submit" variant="primary" icon={Filter}>{t('filterApply')}</Button>
          </div>
        </form>
      </Section>
      <Section className="responsiveSection" title={t('recordsTitle')} meta={loading ? undefined : t('pageIndicator', { page: String(page) })}>
        {loading ? <LoadingState label={t('loadingRecords')} /> : rows.length === 0 ? (
          <EmptyState icon={Archive} title={t('emptyTitle')} detail={hasFilters ? t('emptyDetailFiltered') : t('emptyDetailNone')} />
        ) : (
          <>
            <div className="archiveBulkBar archiveSelectionSummary">
              <span>{selectedRows.length > 0 ? t('selectedCount', { count: String(selectedRows.length) }) : t('selectHint')}</span>
            </div>
            <div className="tableWrap desktopOnly">
              <table className="dataTable archiveTable">
                <thead><tr><th aria-label={t('colSelect')}><label className="checkLabel archiveSelectAll"><input ref={selectAllRef} type="checkbox" checked={allSelected} aria-checked={indeterminate ? 'mixed' : allSelected} onChange={event => toggleAll(event.target.checked)} /><span>{t('selectAllPage')}</span></label></th><th>{t('colConversation')}</th><th>{t('colOwner')}</th><th>{t('colArchivedAt')}</th><th>{t('stateLabel')}</th><th>{t('colMessages')}</th><th aria-label={t('colView')} /></tr></thead>
                <tbody>{rows.map(row => <ArchiveTableRow key={row.rootSessionId} row={row} checked={selected.has(row.rootSessionId)} onCheck={checked => setSelected(nextSelection(selected, row.rootSessionId, checked))} onOpen={() => void openDetail(row)} />)}</tbody>
              </table>
            </div>
            <div className="mobileList">{rows.map(row => <ArchiveMobileRow key={row.rootSessionId} row={row} checked={selected.has(row.rootSessionId)} onCheck={checked => setSelected(nextSelection(selected, row.rootSessionId, checked))} onOpen={() => void openDetail(row)} />)}</div>
          </>
        )}
        {loading || (rows.length === 0 && offset === 0) ? null : <div className="pagination"><span>{t('pageIndicator', { page: String(page) })}</span><IconButton label={t('prevPage')} icon={ChevronLeft} variant="secondary" disabled={offset === 0} onClick={() => void fetchRows(active, Math.max(0, offset - PAGE_SIZE))} /><IconButton label={t('nextPage')} icon={ChevronRight} variant="secondary" disabled={rows.length < PAGE_SIZE} onClick={() => void fetchRows(active, offset + PAGE_SIZE)} /></div>}
      </Section>
      <Dialog open={detail !== null || detailLoading} title={detail?.record.title ?? t('dialogTitleFallback')} description={detail === null ? t('dialogLoading') : `${detail.record.workspace?.title ?? t('ungrouped')} · ${detail.record.project?.name ?? t('personalConversation')}`} onClose={() => { if (!detailLoading) { detailGeneration.current++; setDetail(null) } }} wide footer={detail === null ? undefined : <div className="dialogActionRow">{detail.record.state === 'purged' ? <Button variant="secondary" disabled>{t('exportAction')}</Button> : <a className="button button-secondary" href={exportArchive(detail.record.rootSessionId)}>{t('exportAction')}</a>}<Button icon={Undo2} onClick={() => setConfirmAction('restore')} loading={pendingAction === 'restore'} disabled={detail.record.syncState === 'pending' || detail.record.state === 'purged'}>{t('restore')}</Button><Button icon={Trash2} variant="danger" onClick={() => setConfirmAction('trash')} loading={pendingAction === 'trash'} disabled={detail.record.syncState === 'pending' || detail.record.state === 'purged'}>{t('moveToTrash')}</Button><Button variant="danger" onClick={() => setConfirmAction('purge')} loading={pendingAction === 'purge'} disabled={detail.record.syncState === 'pending' || (detail.record.state === 'purged' && detail.record.syncState === 'synced')}>{t('purge')}</Button></div>}>
        {detailLoading ? <LoadingState label={t('loadingConversation')} /> : detail === null ? null : <ArchiveDetail detail={detail} error={actionError} />}
      </Dialog>
      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'purge' ? t('confirmPurgeTitle') : confirmAction === 'trash' ? t('confirmTrashTitle') : t('confirmRestoreTitle')}
        description={confirmAction === 'purge' ? t('confirmPurgeDescription') : confirmAction === 'trash' ? t('confirmTrashDescription') : t('confirmRestoreDescription')}
        confirmLabel={confirmAction === 'purge' ? t('purge') : confirmAction === 'trash' ? t('moveToTrash') : t('restore')}
        pending={pendingAction !== null}
        onClose={() => { if (pendingAction === null) setConfirmAction(null) }}
        onConfirm={() => { if (confirmAction !== null) { const action = confirmAction; setConfirmAction(null); void runAction(action) } }}
      />
      <ConfirmDialog
        open={emptyConfirm !== null}
        title={t('emptyConfirmTitle')}
        description={t('emptyConfirmBody', { count: String(emptyConfirm?.ids.length ?? 0) })}
        confirmLabel={t('trashSelectedEmpty')}
        pending={emptyLoading}
        onClose={() => { if (!emptyLoading) setEmptyConfirm(null) }}
        onConfirm={() => { void confirmEmptyTrash() }}
      />
    </div>
  )
}

function ArchiveTableRow({ row, checked, onCheck, onOpen }: { row: ConversationArchiveRow; checked: boolean; onCheck: (checked: boolean) => void; onOpen: () => void }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  return <tr><td><input type="checkbox" aria-label={t('selectItem', { name: row.title })} checked={checked} onChange={event => onCheck(event.target.checked)} /></td><td><button type="button" className="tableLink" onClick={onOpen}><strong>{row.title}</strong>{row.contentPreview === undefined || row.contentPreview === null ? <small className="archivePreview archivePreviewEmpty">{t('noPreview')}</small> : <small className="archivePreview" title={row.contentPreview}>{row.contentPreview}</small>}<span className="codeText archiveSessionId">{row.rootSessionId}</span></button></td><td><span className="archiveOwner">{row.creator?.displayName ?? t('unknownUser')}<small>{row.project?.name ?? t('personalConversation')}</small></span></td><td><time dateTime={new Date(row.archivedAt).toISOString()}>{formatTime(row.archivedAt)}</time></td><td><ArchiveStateBadge state={row.state} /><ArchiveSyncState row={row} /></td><td>{row.messageCount}</td><td className="alignRight"><IconButton label={t('viewItem', { name: row.title })} icon={Eye} onClick={onOpen} /></td></tr>
}

function ArchiveMobileRow({ row, checked, onCheck, onOpen }: { row: ConversationArchiveRow; checked: boolean; onCheck: (checked: boolean) => void; onOpen: () => void }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  return <article className="mobileItem archiveMobileItem"><div className="mobileItemHeader"><label className="checkLabel"><input type="checkbox" aria-label={t('selectItem', { name: row.title })} checked={checked} onChange={event => onCheck(event.target.checked)} /><span className="archiveIdentity"><strong>{row.title}</strong><small className="archivePreview">{row.contentPreview ?? t('noPreview')}</small><small className="codeText archiveSessionId">{row.rootSessionId}</small></span></label><div><ArchiveStateBadge state={row.state} /><ArchiveSyncState row={row} /></div></div><button type="button" className="archiveMobileOpen" onClick={onOpen}><span>{row.creator?.displayName ?? t('unknownUser')} · {row.project?.name ?? t('personalConversation')}</span><span>{formatTime(row.archivedAt)} · {t('messageCount', { count: String(row.messageCount) })}</span></button></article>
}

function ArchiveSyncState({ row }: { row: ConversationArchiveRow }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  if (row.syncState === 'synced') return null
  const label = row.syncState === 'pending' ? t('syncPending') : row.syncState === 'conflict' ? t('syncConflict') : t('syncUnavailable')
  return <small className="archiveSyncState" title={row.lastSyncError}>{label}</small>
}

function ArchiveDetail({ detail, error }: { detail: ConversationArchiveDetail; error: string }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  const syncLabels: Record<ConversationArchiveDetail['record']['syncState'], string> = {
    pending: t('syncPending'),
    synced: t('syncSynced'),
    conflict: t('syncConflict'),
    unavailable: t('syncUnavailableDetail'),
  }
  return <div className="archiveDetail"><ErrorBanner message={error || detail.record.lastSyncError || ''} /><dl className="definitionGrid"><div className="definitionRow"><dt>{t('creatorLabel')}</dt><dd>{detail.record.creator?.displayName ?? t('unknownUser')}</dd></div><div className="definitionRow"><dt>Workspace</dt><dd>{detail.record.workspace?.title ?? t('ungrouped')}</dd></div><div className="definitionRow"><dt>{t('detailProject')}</dt><dd>{detail.record.project?.name ?? t('personalConversation')}</dd></div><div className="definitionRow"><dt>{t('colArchivedAt')}</dt><dd><time dateTime={new Date(detail.record.archivedAt).toISOString()}>{formatTime(detail.record.archivedAt)}</time></dd></div><div className="definitionRow"><dt>{t('recordStateLabel')}</dt><dd><ArchiveStateBadge state={detail.record.state} /></dd></div><div className="definitionRow"><dt>{t('syncStateLabel')}</dt><dd>{syncLabels[detail.record.syncState]}</dd></div></dl><ArchiveConversationOrRemoval detail={detail} /></div>
}

function ArchiveConversationOrRemoval({ detail }: { detail: ConversationArchiveDetail }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  return detail.record.state === 'purged' && detail.record.syncState === 'synced'
    ? <EmptyState icon={Archive} title={t('purgedTitle')} detail={t('purgedDetail')} />
    : <ArchiveConversation detail={detail} />
}

function ArchiveStateBadge({ state }: { state: ConversationArchiveState }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  const labels: Record<ConversationArchiveState, string> = { archived: t('stateArchived'), trash: t('stateTrash'), purged: t('statePurged') }
  const tones: Record<ConversationArchiveState, 'info' | 'warning' | 'danger'> = { archived: 'info', trash: 'warning', purged: 'danger' }
  return <StatusBadge tone={tones[state]}>{labels[state]}</StatusBadge>
}

function nextSelection(current: Set<string>, id: string, checked: boolean): Set<string> {
  const next = new Set(current)
  if (checked) next.add(id); else next.delete(id)
  return next
}

function formatTime(timestamp: number): string {
  const t = translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn })
  return new Intl.DateTimeFormat(t('dateLocale'), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
}

function messageFrom(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
