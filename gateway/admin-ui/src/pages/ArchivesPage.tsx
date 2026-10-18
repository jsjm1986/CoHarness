import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Eye,
  Eraser,
  Filter,
  OctagonX,
  RotateCcw,
  SearchCheck,
  StopCircle,
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
import { zh as archivesZh, en as archivesEn, type ArchivesCopyKey } from './archives.copy.ts'

const PAGE_SIZE = 50
const STALE_PENDING_MS = 24 * 60 * 60 * 1_000

type ArchiveAction = 'restore' | 'trash' | 'purge' | 'settle'
type ArchiveTab = 'archived' | 'trash' | 'purged'

type Active = { tab: ArchiveTab; query: string; userId: string; projectId: string }
type FilterDraft = Omit<Active, 'tab'>
const EMPTY_DRAFT: FilterDraft = { query: '', userId: '', projectId: '' }
const EMPTY_ACTIVE: Active = { tab: 'archived', ...EMPTY_DRAFT }

type RecordAction = Exclude<ArchiveAction, 'settle'>
const TABS: ArchiveTab[] = ['archived', 'trash', 'purged']
const TAB_ACTIONS: Record<ArchiveTab, readonly RecordAction[]> = {
  archived: ['restore', 'trash'],
  trash: ['restore', 'purge'],
  purged: [],
}

export function ArchivesPage() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  const [rows, setRows] = useState<ConversationArchiveRow[]>([])
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT)
  const [active, setActive] = useState<Active>(EMPTY_ACTIVE)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<ConversationArchiveDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState<ArchiveAction | null>(null)
  const [confirmIntent, setConfirmIntent] = useState<{ action: ArchiveAction; ids: string[] } | null>(null)
  const [actionError, setActionError] = useState('')
  const [emptyDialogOpen, setEmptyDialogOpen] = useState(false)
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
  const viewKey = useRef(JSON.stringify([EMPTY_ACTIVE, 0]))
  useEffect(() => () => { rowsGeneration.current++; detailGeneration.current++ }, [])

  const fetchRows = useCallback(async (filter: Active, nextOffset: number, showLoading = true) => {
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
        state: filter.tab,
        recordKind: 'all',
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

  useEffect(() => { void fetchRows(EMPTY_ACTIVE, 0) }, [fetchRows])

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
        if (statuses.some(row => row.state !== active.tab)) {
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
    const next = { ...active, ...draft }
    setActive(next)
    void fetchRows(next, 0)
  }

  function onTab(nextTab: ArchiveTab) {
    if (nextTab === active.tab) return
    const next = { ...active, tab: nextTab }
    setActive(next)
    void fetchRows(next, 0)
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

  function openEmptyDrafts() {
    setEmptyDialogOpen(true)
    if (!emptyScanned) void scanEmptyDrafts()
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
    const next = { ...active, ...EMPTY_DRAFT }
    setActive(next)
    void fetchRows(next, 0)
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

  async function runAction(action: ArchiveAction, ids: string[]) {
    if (ids.length === 0) return
    setPendingAction(action)
    setActionError('')
    try {
      const result = await applyArchiveAction(action, ids)
      const failed = result.results.filter(item => !item.ok)
      if (failed.length > 0) setActionError(t('actionPartialFailure', { count: String(failed.length), details: failed.map(item => item.error ?? item.rootSessionId).join(t('detailSeparator')) }))
      else if (detail !== null && ids.includes(detail.record.rootSessionId)) {
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

  const hasFilters = draft.query !== '' || draft.userId !== '' || draft.projectId !== ''
    || active.query !== '' || active.userId !== '' || active.projectId !== ''
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

  const tabLabels: Record<ArchiveTab, string> = { archived: t('tab_archived'), trash: t('tab_trash'), purged: t('tab_purged') }
  const batchLabels: Record<RecordAction, string> = { restore: t('batch_restore'), trash: t('batch_trash'), purge: t('batch_purge') }
  const emptyDetails: Record<ArchiveTab, string> = { archived: t('emptyDetail_archived'), trash: t('emptyDetail_trash'), purged: t('emptyDetail_purged') }
  const tabActions = TAB_ACTIONS[active.tab]
  const batchSettle = selectedRows.some(row => isStalePending(row))
  const confirmCopy: Record<ArchiveAction, { title: string; description: string; label: string }> = {
    restore: { title: t('confirmRestoreTitle'), description: t('confirmRestoreDescription'), label: t('restore') },
    trash: { title: t('confirmTrashTitle'), description: t('confirmTrashDescription'), label: t('trashAction') },
    purge: { title: t('confirmPurgeTitle'), description: t('confirmPurgeDescription'), label: t('purge') },
    settle: { title: t('confirmSettleTitle'), description: t('confirmSettleDescription'), label: t('settle') },
  }

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        meta={loading ? undefined : t('recordCount', { count: String(rows.length) })}
        actions={<Button icon={Eraser} variant="secondary" onClick={openEmptyDrafts}>{t('emptyToolButton')}</Button>}
      />
      <ErrorBanner message={error} />
      <div className="archiveToolbar">
        <div className="segmented archiveTabs" role="group" aria-label={t('tabsAria')}>
          {TABS.map(tab => <button key={tab} type="button" aria-pressed={active.tab === tab} onClick={() => onTab(tab)}>{tabLabels[tab]}</button>)}
        </div>
      </div>
      <Section flush title={t('filterTitle')}>
        <form className="filterPanel" onSubmit={onFilter}>
          <div className="filterGrid">
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
            <Button type="button" icon={RotateCcw} onClick={resetFilters} disabled={!hasFilters}>{t('filterReset')}</Button>
            <Button type="submit" variant="primary" icon={Filter}>{t('filterApply')}</Button>
          </div>
        </form>
      </Section>
      <Section flush className="responsiveSection" title={t('recordsTitle')} meta={loading ? undefined : t('pageIndicator', { page: String(page) })}>
        {loading ? <LoadingState label={t('loadingRecords')} /> : rows.length === 0 ? (
          <EmptyState icon={Archive} title={t('emptyTitle')} detail={hasFilters ? t('emptyDetailFiltered') : emptyDetails[active.tab]} />
        ) : (
          <>
            <div className="archiveBulkBar archiveSelectionSummary">
              <span>{selectedRows.length > 0 ? t('selectedCount', { count: String(selectedRows.length) }) : t('selectHint')}</span>
              {selectedRows.length === 0 ? null : (
                <div className="pageActionGroup">
                  {tabActions.map(action => <Button key={action} icon={action === 'restore' ? Undo2 : action === 'trash' ? Trash2 : OctagonX} variant={action === 'restore' ? 'secondary' : 'danger'} onClick={() => setConfirmIntent({ action, ids: [...selected] })}>{batchLabels[action]}</Button>)}
                  {batchSettle ? <Button variant="secondary" icon={StopCircle} onClick={() => setConfirmIntent({ action: 'settle', ids: selectedRows.filter(row => isStalePending(row)).map(row => row.rootSessionId) })}>{t('settle')}</Button> : null}
                </div>
              )}
            </div>
            <div className="tableWrap desktopOnly">
              <table className="dataTable archiveTable">
                <thead><tr><th aria-label={t('colSelect')}><label className="checkLabel archiveSelectAll"><input ref={selectAllRef} type="checkbox" checked={allSelected} aria-checked={indeterminate ? 'mixed' : allSelected} onChange={event => toggleAll(event.target.checked)} /><span>{t('selectAllPage')}</span></label></th><th>{t('colConversation')}</th><th>{t('colOwner')}</th><th>{t('colArchivedAt')}</th><th>{t('syncStateLabel')}</th><th>{t('colMessages')}</th><th aria-label={t('colActions')} /></tr></thead>
                <tbody>{rows.map(row => <ArchiveTableRow key={row.rootSessionId} row={row} tab={active.tab} checked={selected.has(row.rootSessionId)} onCheck={checked => setSelected(nextSelection(selected, row.rootSessionId, checked))} onOpen={() => void openDetail(row)} onAction={action => setConfirmIntent({ action, ids: [row.rootSessionId] })} />)}</tbody>
              </table>
            </div>
            <div className="mobileList">{rows.map(row => <ArchiveMobileRow key={row.rootSessionId} row={row} tab={active.tab} checked={selected.has(row.rootSessionId)} onCheck={checked => setSelected(nextSelection(selected, row.rootSessionId, checked))} onOpen={() => void openDetail(row)} onAction={action => setConfirmIntent({ action, ids: [row.rootSessionId] })} />)}</div>
          </>
        )}
        {loading || (rows.length === 0 && offset === 0) ? null : <div className="pagination"><span>{t('pageIndicator', { page: String(page) })}</span><IconButton label={t('prevPage')} icon={ChevronLeft} variant="secondary" disabled={offset === 0} onClick={() => void fetchRows(active, Math.max(0, offset - PAGE_SIZE))} /><IconButton label={t('nextPage')} icon={ChevronRight} variant="secondary" disabled={rows.length < PAGE_SIZE} onClick={() => void fetchRows(active, offset + PAGE_SIZE)} /></div>}
      </Section>
      <Dialog open={detail !== null || detailLoading} title={detail?.record.title ?? t('dialogTitleFallback')} description={detail === null ? t('dialogLoading') : `${detail.record.workspace?.title ?? t('ungrouped')} · ${detail.record.project?.name ?? t('personalConversation')}`} onClose={() => { if (!detailLoading) { detailGeneration.current++; setDetail(null) } }} wide footer={detail === null ? undefined : <DetailFooter detail={detail} pendingAction={pendingAction} onAction={action => setConfirmIntent({ action, ids: [detail.record.rootSessionId] })} />}>
        {detailLoading ? <LoadingState label={t('loadingConversation')} /> : detail === null ? null : <ArchiveDetail detail={detail} error={actionError} />}
      </Dialog>
      <ConfirmDialog
        open={confirmIntent !== null}
        title={confirmIntent === null ? '' : confirmCopy[confirmIntent.action].title}
        description={confirmIntent === null ? '' : confirmCopy[confirmIntent.action].description}
        confirmLabel={confirmIntent === null ? '' : confirmCopy[confirmIntent.action].label}
        pending={pendingAction !== null}
        onClose={() => { if (pendingAction === null) setConfirmIntent(null) }}
        onConfirm={() => { if (confirmIntent !== null) { const intent = confirmIntent; setConfirmIntent(null); void runAction(intent.action, intent.ids) } }}
      />
      <Dialog
        open={emptyDialogOpen}
        title={t('emptyToolTitle')}
        description={t('emptyToolDescription')}
        onClose={() => { if (!emptyLoading) setEmptyDialogOpen(false) }}
        wide
        footer={<div className="dialogActionRow"><Button icon={SearchCheck} onClick={() => { void scanEmptyDrafts() }} loading={emptyLoading}>{t('scan')}</Button>{emptySelected.size > 0 ? <Button icon={Trash2} variant="danger" disabled={emptyLoading} onClick={requestEmptyTrash}>{t('trashSelectedEmpty', { count: String(emptySelected.size) })}</Button> : null}</div>}
      >
        <ErrorBanner message={emptyError} />
        {emptyResult === '' ? null : <p className="emptyTrashResult">{emptyResult}</p>}
        {emptyLoading && !emptyScanned ? <LoadingState label={t('scan')} /> : emptyCandidates.length === 0 ? <div className="emptyDraftState">
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
      </Dialog>
      <ConfirmDialog
        open={emptyConfirm !== null}
        title={t('emptyConfirmTitle')}
        description={t('emptyConfirmBody', { count: String(emptyConfirm?.ids.length ?? 0) })}
        confirmLabel={t('trashAction')}
        pending={emptyLoading}
        onClose={() => { if (!emptyLoading) setEmptyConfirm(null) }}
        onConfirm={() => { void confirmEmptyTrash() }}
      />
    </div>
  )
}

function isStalePending(row: Pick<ConversationArchiveRow, 'syncState' | 'updatedAt'>): boolean {
  return row.syncState === 'pending' && Date.now() - row.updatedAt > STALE_PENDING_MS
}

function archiveActionMeta(action: ArchiveAction): { icon: typeof Undo2; variant: 'secondary' | 'danger' | 'ghost' } {
  return action === 'restore' ? { icon: Undo2, variant: 'ghost' }
    : action === 'trash' ? { icon: Trash2, variant: 'danger' }
    : action === 'purge' ? { icon: OctagonX, variant: 'danger' }
    : { icon: StopCircle, variant: 'ghost' }
}

function archiveActionLabels(t: (key: ArchivesCopyKey, parameters?: Record<string, string>) => string): Record<RecordAction, string> {
  return { restore: t('row_restore'), trash: t('row_trash'), purge: t('row_purge') }
}

function RowActionButtons({ row, tab, onAction }: { row: ConversationArchiveRow; tab: ArchiveTab; onAction: (action: ArchiveAction) => void }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  if (isStalePending(row)) {
    return <div className="rowActions"><IconButton label={t('settle')} icon={StopCircle} variant="danger" onClick={() => onAction('settle')} /></div>
  }
  if (row.syncState !== 'synced') return <div className="rowActions" />
  const labels = archiveActionLabels(t)
  return <div className="rowActions">{TAB_ACTIONS[tab].map(action => { const meta = archiveActionMeta(action); return <IconButton key={action} label={labels[action]} icon={meta.icon} variant={meta.variant === 'ghost' ? 'ghost' : 'danger'} onClick={() => onAction(action)} /> })}</div>
}

function ArchiveTableRow({ row, tab, checked, onCheck, onOpen, onAction }: { row: ConversationArchiveRow; tab: ArchiveTab; checked: boolean; onCheck: (checked: boolean) => void; onOpen: () => void; onAction: (action: ArchiveAction) => void }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  return <tr><td><input type="checkbox" aria-label={t('selectItem', { name: row.title })} checked={checked} onChange={event => onCheck(event.target.checked)} /></td><td><button type="button" className="tableLink" onClick={onOpen}><strong>{row.title}</strong>{row.contentPreview === undefined || row.contentPreview === null ? <small className="archivePreview archivePreviewEmpty">{t('noPreview')}</small> : <small className="archivePreview" title={row.contentPreview}>{row.contentPreview}</small>}<span className="codeText archiveSessionId">{row.rootSessionId}</span></button></td><td><span className="archiveOwner">{row.creator?.displayName ?? t('unknownUser')}<small>{row.project?.name ?? t('personalConversation')}</small></span></td><td><time dateTime={new Date(row.archivedAt).toISOString()}>{formatTime(row.archivedAt)}</time></td><td>{row.recordKind === 'empty-draft' ? <StatusBadge tone="neutral">{t('emptyDraftBadge')}</StatusBadge> : null}<ArchiveSyncState row={row} /></td><td>{row.messageCount}</td><td className="alignRight"><div className="rowActions"><IconButton label={t('viewItem', { name: row.title })} icon={Eye} onClick={onOpen} /><RowActionButtons row={row} tab={tab} onAction={onAction} /></div></td></tr>
}

function ArchiveMobileRow({ row, tab, checked, onCheck, onOpen, onAction }: { row: ConversationArchiveRow; tab: ArchiveTab; checked: boolean; onCheck: (checked: boolean) => void; onOpen: () => void; onAction: (action: ArchiveAction) => void }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  return <article className="mobileItem archiveMobileItem"><div className="mobileItemHeader"><label className="checkLabel"><input type="checkbox" aria-label={t('selectItem', { name: row.title })} checked={checked} onChange={event => onCheck(event.target.checked)} /><span className="archiveIdentity"><strong>{row.title}</strong><small className="archivePreview">{row.contentPreview ?? t('noPreview')}</small><small className="codeText archiveSessionId">{row.rootSessionId}</small></span></label><div>{row.recordKind === 'empty-draft' ? <StatusBadge tone="neutral">{t('emptyDraftBadge')}</StatusBadge> : null}<ArchiveSyncState row={row} /></div></div><div className="archiveMobileFooter"><button type="button" className="archiveMobileOpen" onClick={onOpen}><span>{row.creator?.displayName ?? t('unknownUser')} · {row.project?.name ?? t('personalConversation')}</span><span>{formatTime(row.archivedAt)} · {t('messageCount', { count: String(row.messageCount) })}</span></button><RowActionButtons row={row} tab={tab} onAction={onAction} /></div></article>
}

function ArchiveSyncState({ row }: { row: ConversationArchiveRow }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  if (row.syncState === 'synced') return <span className="archiveSyncOk">{t('syncOk')}</span>
  const stalePending = isStalePending(row)
  const label = row.syncState === 'pending'
    ? (stalePending ? t('syncPendingStale') : t('syncPending'))
    : row.syncState === 'conflict' ? t('syncConflict') : t('syncUnavailable')
  return <small className={`archiveSyncState${stalePending ? ' archiveSyncStale' : ''}`} title={row.lastSyncError}>{label}</small>
}

function DetailFooter({ detail, pendingAction, onAction }: { detail: ConversationArchiveDetail; pendingAction: ArchiveAction | null; onAction: (action: ArchiveAction) => void }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  const record = detail.record
  const pending = record.syncState === 'pending'
  const labels = archiveActionLabels(t)
  return <div className="dialogActionRow">
    {record.state === 'purged' ? <Button variant="secondary" disabled>{t('exportAction')}</Button> : <a className="button button-secondary" href={exportArchive(record.rootSessionId)}>{t('exportAction')}</a>}
    {record.state === 'purged' ? null : TAB_ACTIONS[record.state === 'trash' ? 'trash' : 'archived'].map(action => { const meta = archiveActionMeta(action); return <Button key={action} icon={meta.icon} variant={action === 'restore' ? 'secondary' : 'danger'} onClick={() => onAction(action)} loading={pendingAction === action} disabled={pending}>{labels[action]}</Button> })}
    {pending ? <Button variant="secondary" icon={StopCircle} onClick={() => onAction('settle')} loading={pendingAction === 'settle'}>{t('settle')}</Button> : null}
  </div>
}

function ArchiveDetail({ detail, error }: { detail: ConversationArchiveDetail; error: string }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  const syncLabels: Record<ConversationArchiveDetail['record']['syncState'], string> = {
    pending: t('syncPending'),
    synced: t('syncOk'),
    conflict: t('syncConflict'),
    unavailable: t('syncUnavailable'),
  }
  return <div className="archiveDetail"><ErrorBanner message={error || detail.record.lastSyncError || ''} />{detail.record.syncState === 'pending' ? <p className="archivePendingHint">{t('settlePendingHint')}</p> : null}<dl className="definitionGrid"><div className="definitionRow"><dt>{t('creatorLabel')}</dt><dd>{detail.record.creator?.displayName ?? t('unknownUser')}</dd></div><div className="definitionRow"><dt>{t('detailWorkspace')}</dt><dd>{detail.record.workspace?.title ?? t('ungrouped')}</dd></div><div className="definitionRow"><dt>{t('detailProject')}</dt><dd>{detail.record.project?.name ?? t('personalConversation')}</dd></div><div className="definitionRow"><dt>{t('colArchivedAt')}</dt><dd><time dateTime={new Date(detail.record.archivedAt).toISOString()}>{formatTime(detail.record.archivedAt)}</time></dd></div><div className="definitionRow"><dt>{t('recordStateLabel')}</dt><dd><ArchiveStateBadge state={detail.record.state} /></dd></div><div className="definitionRow"><dt>{t('syncStateLabel')}</dt><dd>{syncLabels[detail.record.syncState]}</dd></div></dl><ArchiveConversationOrRemoval detail={detail} /></div>
}

function ArchiveConversationOrRemoval({ detail }: { detail: ConversationArchiveDetail }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  return detail.record.state === 'purged'
    ? <EmptyState icon={Archive} title={t('purgedTitle')} detail={t('purgedDetail')} />
    : <ArchiveConversation detail={detail} />
}

function ArchiveStateBadge({ state }: { state: ConversationArchiveState }) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: archivesZh, en: archivesEn }), [])
  const labels: Record<ConversationArchiveState, string> = { archived: t('tab_archived'), trash: t('tab_trash'), purged: t('tab_purged') }
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
