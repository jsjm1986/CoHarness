import { Archive, FileText, Filter, History, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  deleteAdminDocument,
  applyAdminDocumentAction,
  getAdminDocument,
  listAdminDocuments,
  listAdminDocumentsPage,
  listDocumentMetrics,
  getProject,
  listProjects,
  listUsers,
  transferAdminDocumentOwnership,
  AdminRequestError,
  type AdminDocument,
  type AdminDocumentDetail,
  type AdminDocumentMetrics,
  type AdminUser,
  type Project,
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
import { Metric } from '../components/usage.tsx'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh as documentsZh, en as documentsEn, type DocumentsCopyKey } from './documents.copy.ts'

const documentsCopy = () => translateCopy(adminLanguage(), { zh: documentsZh, en: documentsEn })

type Draft = { query: string; scope: '' | 'personal' | 'project'; projectId: string; ownerUserId: string; state: 'active' | 'trash' | 'purged' | 'deleted' | 'all' }
const EMPTY: Draft = { query: '', scope: '', projectId: '', ownerUserId: '', state: 'active' }
const PAGE_SIZE = 50

/** Independent organization-wide document catalog dashboard for administrators. */
export function DocumentsPage() {
  const [metrics, setMetrics] = useState<AdminDocumentMetrics | null>(null)
  const [rows, setRows] = useState<AdminDocument[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [active, setActive] = useState<Draft>(EMPTY)
  const [page, setPage] = useState(0)
  const [pageCursors, setPageCursors] = useState<string[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<AdminDocumentDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [batchPurgeOpen, setBatchPurgeOpen] = useState(false)
  const [ownerId, setOwnerId] = useState('')
  const [memberIds, setMemberIds] = useState<Set<number> | null>(null)
  const [ownerSaving, setOwnerSaving] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchAction, setBatchAction] = useState(false)
  const reloadGeneration = useRef(0)
  const t = useMemo(() => documentsCopy(), [])

  const reload = useCallback(async (filter: Draft, showLoading = true, pageOffset = 0, cursor?: string) => {
    const generation = reloadGeneration.current + 1
    reloadGeneration.current = generation
    if (showLoading) setLoading(true)
    try {
      const requestFilter = {
        ...(filter.scope === '' ? {} : { scope: filter.scope }),
        ...(filter.projectId === '' ? {} : { projectId: Number(filter.projectId) }),
        ...(filter.ownerUserId === '' ? {} : { ownerUserId: Number(filter.ownerUserId) }),
        ...(filter.state === 'all' ? {} : { state: filter.state }),
        ...(filter.query === '' ? {} : { query: filter.query }), limit: PAGE_SIZE,
      } as const
      let nextRows: AdminDocument[]
      let receivedCursor: string | undefined
      try {
        const pageResult = await listAdminDocumentsPage({ ...requestFilter, ...(cursor === undefined ? {} : { cursor }) })
        nextRows = pageResult.documents
        receivedCursor = pageResult.nextCursor
      } catch (cause) {
        // A stale cursor answers 400; retry that one case from the page offset.
        if (cursor === undefined || !(cause instanceof AdminRequestError) || cause.status !== 400) throw cause
        nextRows = await listAdminDocuments({ ...requestFilter, offset: pageOffset * PAGE_SIZE })
        receivedCursor = nextRows.length === PAGE_SIZE ? `offset:${String((pageOffset + 1) * PAGE_SIZE)}` : undefined
      }
      const nextMetrics = await listDocumentMetrics()
      if (generation !== reloadGeneration.current) return
      setRows(nextRows)
      setSelectedIds(new Set())
      setMetrics(nextMetrics)
      setNextCursor(receivedCursor)
      setPageCursors(previous => {
        const next = [...previous]
        if (receivedCursor === undefined) next.length = Math.min(next.length, pageOffset + 1)
        else next[pageOffset + 1] = receivedCursor
        return next
      })
      setError('')
    } catch (cause) {
      if (generation === reloadGeneration.current) setError(messageFrom(cause))
    } finally {
      if (showLoading && generation === reloadGeneration.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.all([listUsers(), listProjects()]).then(([nextUsers, nextProjects]) => {
      setUsers(nextUsers)
      setProjects(nextProjects)
    }).catch(cause => setError(messageFrom(cause)))
  }, [])
  useEffect(() => { void reload(EMPTY) }, [reload])

  function apply(event: FormEvent) {
    event.preventDefault()
    setActive(draft)
    setPage(0)
    setPageCursors([])
    void reload(draft, true, 0)
  }

  function reset() {
    setDraft(EMPTY)
    setActive(EMPTY)
    setPage(0)
    setPageCursors([])
    void reload(EMPTY, true, 0)
  }

  async function openDetail(row: AdminDocument) {
    setDetailLoading(true)
    setMemberIds(null)
    try {
      const next = await getAdminDocument(row.catalogId)
      setDetail(next)
      setOwnerId(next.document.owner === null ? '' : String(next.document.owner.id))
      if (next.document.scope.kind === 'project' && next.document.scope.id !== undefined) {
        const project = await getProject(next.document.scope.id)
        setMemberIds(new Set(project.members.map(member => member.userId)))
      }
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setDetailLoading(false)
    }
  }

  async function remove() {
    if (detail === null) return
    setDeleteLoading(true)
    try {
      await deleteAdminDocument(detail.document.catalogId)
      setDeleteOpen(false)
      setDetail(null)
      await reload(active, false, page, pageCursors[page])
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setDeleteLoading(false)
    }
  }

  async function changeState(action: 'trash' | 'restore' | 'purge') {
    if (detail === null) return
    setDeleteLoading(true)
    try {
      const result = await applyAdminDocumentAction(action, [detail.document.catalogId])
      const item = result.results[0]
      if (item !== undefined && !item.ok) throw new Error(item.error ?? t('errorStateChange'))
      if (action === 'purge') setDetail(null)
      else setDetail(await getAdminDocument(detail.document.catalogId))
      await reload(active, false, page, pageCursors[page])
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setDeleteLoading(false)
    }
  }

  function requestPurge(): void {
    if (detail !== null && detail.document.state === 'trash' && !deleteLoading) setPurgeOpen(true)
  }

  async function confirmPurge(): Promise<void> {
    setPurgeOpen(false)
    await changeState('purge')
  }

  async function changeSelectedState(action: 'trash' | 'restore' | 'purge') {
    if (selectedIds.size === 0) return
    setBatchAction(true)
    try {
      const result = await applyAdminDocumentAction(action, [...selectedIds])
      const failed = result.results.filter(item => !item.ok)
      if (failed.length > 0) throw new Error(t('errorBatchFailed', { count: String(failed.length) }))
      setSelectedIds(new Set())
      await reload(active, false, page, pageCursors[page])
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setBatchAction(false)
    }
  }

  function requestBatchPurge(): void {
    if (selectedIds.size > 0 && !batchAction) setBatchPurgeOpen(true)
  }

  async function confirmBatchPurge(): Promise<void> {
    setBatchPurgeOpen(false)
    await changeSelectedState('purge')
  }

  async function transferOwner(event: FormEvent) {
    event.preventDefault()
    if (detail === null || detail.document.scope.kind !== 'project' || detail.document.state !== 'active' || ownerId === '') return
    setOwnerSaving(true)
    try {
      await transferAdminDocumentOwnership(detail.document.catalogId, Number(ownerId))
      setDetail(await getAdminDocument(detail.document.catalogId))
      await reload(active, false, page, pageCursors[page])
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setOwnerSaving(false)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={<Button icon={RefreshCw} onClick={() => void reload(active, true, page, pageCursors[page])}>{t('refresh')}</Button>}
      />
      <ErrorBanner message={error} />
      <div className="metricGrid" aria-label={t('metricsAria')}>
        <Metric label={t('metricActive')} value={metrics?.active.toLocaleString() ?? '—'} />
        <Metric label={t('stateTrash')} value={(metrics?.trash ?? metrics?.deleted ?? 0).toLocaleString()} tone={(metrics?.trash ?? 0) > 0 ? 'warning' : undefined} />
        <Metric label={t('scopePersonal')} value={metrics?.personal.toLocaleString() ?? '—'} />
        <Metric label={t('scopeProject')} value={metrics?.project.toLocaleString() ?? '—'} />
        <Metric label={t('metricFailures24h')} value={metrics?.failures24h.toLocaleString() ?? '—'} tone={metrics !== null && metrics.failures24h > 0 ? 'warning' : undefined} />
      </div>
      <Section flush title={t('filterSection')}>
        <form className="filterPanel" onSubmit={apply}>
          <div className="filterGrid">
            <Field label={t('labelQuery')}><div className="inputWithIcon"><Search aria-hidden="true" /><input className="input" value={draft.query} onChange={event => setDraft({ ...draft, query: event.target.value })} placeholder={t('queryPlaceholder')} /></div></Field>
            <Field label={t('labelScope')}><select className="select" value={draft.scope} onChange={event => setDraft({ ...draft, scope: event.target.value as Draft['scope'] })}><option value="">{t('scopeAll')}</option><option value="personal">{t('scopePersonal')}</option><option value="project">{t('scopeProject')}</option></select></Field>
            <Field label={t('labelProject')}><select className="select" value={draft.projectId} onChange={event => setDraft({ ...draft, projectId: event.target.value })}><option value="">{t('projectAll')}</option>{projects.map(project => <option key={project.id} value={project.id}>{t('entryWithId', { name: project.name, id: String(project.id) })}</option>)}</select></Field>
            <Field label={t('labelOwner')}><select className="select" value={draft.ownerUserId} onChange={event => setDraft({ ...draft, ownerUserId: event.target.value })}><option value="">{t('ownerAll')}</option>{users.map(user => <option key={user.id} value={user.id}>{t('entryWithId', { name: user.displayName, id: String(user.id) })}</option>)}</select></Field>
          <Field label={t('labelState')}><select className="select" value={draft.state} onChange={event => setDraft({ ...draft, state: event.target.value as Draft['state'] })}><option value="active">{t('stateActive')}</option><option value="trash">{t('stateTrash')}</option><option value="purged">{t('statePurged')}</option><option value="all">{t('stateAll')}</option></select></Field>
          </div>
          <div className="filterActions"><Button type="button" onClick={reset}>{t('reset')}</Button><Button type="submit" variant="primary" icon={Filter}>{t('applyFilters')}</Button></div>
        </form>
      </Section>
      <Section flush className="responsiveSection" title={t('catalogSection')} meta={loading ? undefined : t('recordCount', { count: String(rows.length) })}>
        {selectedIds.size > 0 && <div className="sectionBody filterActions" role="toolbar" aria-label={t('batchAria')}><span className="muted">{t('selectedCount', { count: String(selectedIds.size) })}</span><Button type="button" variant="danger" loading={batchAction} onClick={() => void changeSelectedState('trash')}>{t('trash')}</Button><Button type="button" loading={batchAction} onClick={() => void changeSelectedState('restore')}>{t('restore')}</Button><Button type="button" variant="danger" loading={batchAction} onClick={requestBatchPurge}>{t('purge')}</Button><Button type="button" disabled={batchAction} onClick={() => setSelectedIds(new Set())}>{t('clearSelection')}</Button></div>}
        {loading ? <LoadingState label={t('loadingCatalog')} /> : rows.length === 0 ? <EmptyState icon={Archive} title={t('emptyTitle')} detail={t('emptyDetail')} /> : <>
          <div className="tableWrap desktopOnly"><table className="dataTable documentsTable"><thead><tr><th><span className="visuallyHidden">{t('columnSelect')}</span></th><th>{t('columnDocument')}</th><th>{t('labelScope')}</th><th>{t('labelOwner')}</th><th>{t('labelSize')}</th><th>{t('labelState')}</th><th>{t('labelSource')}</th><th>{t('columnUpdated')}</th><th /></tr></thead><tbody>{rows.map(row => <DocumentTableRow key={row.catalogId} row={row} selected={selectedIds.has(row.catalogId)} onSelect={() => setSelectedIds(previous => { const next = new Set(previous); if (next.has(row.catalogId)) next.delete(row.catalogId); else next.add(row.catalogId); return next })} onOpen={() => void openDetail(row)} />)}</tbody></table></div>
          <div className="mobileList">{rows.map(row => <article className="mobileItem" key={row.catalogId} onClick={() => void openDetail(row)}><div className="mobileItemHeader"><input type="checkbox" aria-label={t('selectRow', { name: row.name })} checked={selectedIds.has(row.catalogId)} onChange={event => { event.stopPropagation(); setSelectedIds(previous => { const next = new Set(previous); if (next.has(row.catalogId)) next.delete(row.catalogId); else next.add(row.catalogId); return next }) }} onClick={event => event.stopPropagation()} /><strong>{row.name}</strong><StatusBadge tone={row.scope.kind === 'project' ? 'info' : 'neutral'}>{row.scope.label}</StatusBadge></div><div className="mobileItemBody"><span className="muted">{row.owner?.displayName ?? t('unassigned')} · {formatBytes(row.bytes)}</span><span className="codeText">{row.catalogId}</span></div></article>)}</div>
        </>}
        {!loading && (nextCursor !== undefined || page > 0) && (
          <div className="sectionBody filterActions" aria-label={t('paginationAria')}>
            <Button type="button" disabled={page === 0} onClick={() => { const next = page - 1; setPage(next); void reload(active, true, next, pageCursors[next]) }}>{t('prevPage')}</Button>
            <span className="muted">{t('pageIndicator', { page: String(page + 1) })}</span>
            <Button type="button" disabled={nextCursor === undefined} onClick={() => { const next = page + 1; setPage(next); void reload(active, true, next, nextCursor) }}>{t('nextPage')}</Button>
          </div>
        )}
      </Section>

      <Dialog open={detail !== null || detailLoading} title={detail?.document.name ?? t('detailTitleFallback')} description={t('detailDescription')} wide onClose={() => { if (!deleteLoading && !ownerSaving) setDetail(null) }} footer={detail === null ? undefined : <><>{detail.document.state === 'active' && <Button type="button" onClick={() => setDeleteOpen(true)} variant="danger" icon={Trash2} disabled={deleteLoading}>{t('trash')}</Button>}{detail.document.state === 'trash' && <><Button type="button" onClick={() => void changeState('restore')} variant="secondary" disabled={deleteLoading}>{t('restore')}</Button><Button type="button" onClick={requestPurge} variant="danger" disabled={deleteLoading}>{t('purge')}</Button></>}{detail.document.state === 'purged' && <StatusBadge tone="danger">{t('statePurged')}</StatusBadge>}</><Button type="button" onClick={() => setDetail(null)}>{t('close')}</Button></>}>
        {detailLoading || detail === null ? <LoadingState label={t('loadingDetail')} /> : <div className="documentDetail"><dl className="definitionGrid"><Definition label={t('labelCatalogId')}><span className="codeText">{detail.document.catalogId}</span></Definition><Definition label={t('labelScope')}>{detail.document.scope.label}</Definition><Definition label={t('labelFileId')}><span className="codeText">{detail.document.docId}</span></Definition><Definition label={t('labelSize')}>{formatBytes(detail.document.bytes)}</Definition><Definition label={t('labelState')}>{documentStateLabel(detail.document.state)}</Definition><Definition label={t('labelSource')}>{documentOwnerSourceLabel(detail.document)}</Definition><Definition label={t('labelLineageRoot')}>{detail.document.lineageRootId === null ? t('lineageCurrent') : <span className="codeText">{detail.document.lineageRootId}</span>}</Definition>{detail.document.purgeAfter !== undefined && detail.document.purgeAfter !== null && <Definition label={t('labelAutoPurge')}>{formatTime(detail.document.purgeAfter)}</Definition>}</dl>{detail.document.scope.kind === 'project' && detail.document.state === 'active' ? (<form className="ownershipForm" onSubmit={event => void transferOwner(event)}><Field label={t('labelOwner')}><select className="select" value={ownerId} onChange={event => setOwnerId(event.target.value)} disabled={ownerSaving || memberIds === null}>{(memberIds === null ? [] : users.filter(user => memberIds.has(user.id))).map(user => <option key={user.id} value={user.id}>{t('entryWithId', { name: user.displayName, id: String(user.id) })}</option>)}</select></Field><Button type="submit" variant="secondary" icon={ShieldCheck} loading={ownerSaving}>{t('transferOwnership')}</Button></form>) : <p className="muted">{t('ownerLine', { name: detail.document.owner?.displayName ?? t('unassigned') })}{detail.document.scope.kind === 'personal' ? t('personalOwnerHint') : ''}</p>}<div className="detailDivider" /><h3><History aria-hidden="true" />{t('historyHeading')}</h3>{detail.history.length === 0 ? <p className="muted">{t('historyEmpty')}</p> : <ol className="historyList">{detail.history.map(item => <li key={item.id}><span><strong>{item.eventKind}</strong><small>{item.actor?.displayName ?? t('systemActor')} · {formatTime(item.createdAt)}</small></span><span className="codeText">{item.operationId ?? '—'}</span></li>)}</ol>}<h3><FileText aria-hidden="true" />{t('copiesHeading')}</h3>{detail.copies.length === 0 ? <p className="muted">{t('copiesEmpty')}</p> : <ul className="historyList">{detail.copies.map((item, index) => <li key={`${item.operationId}-${String(index)}`}><span><strong>{item.status}</strong><small>{item.source.name} → {item.targetDocId ?? t('notGenerated')} · {formatTime(item.createdAt)}</small></span><span className="codeText">{item.operationId}</span></li>)}</ul>}</div>}
      </Dialog>
      <Dialog open={deleteOpen} title={t('trashTitle')} description={t('trashDescription')} danger onClose={() => { if (!deleteLoading) setDeleteOpen(false) }} footer={<><Button type="button" onClick={() => setDeleteOpen(false)} disabled={deleteLoading}>{t('cancel')}</Button><Button type="button" variant="danger" loading={deleteLoading} onClick={() => void remove()}>{t('trash')}</Button></>} />
      <ConfirmDialog
        open={purgeOpen}
        title={t('purgeTitle')}
        description={t('purgeDescription')}
        confirmLabel={t('purge')}
        pending={deleteLoading}
        onClose={() => { if (!deleteLoading) setPurgeOpen(false) }}
        onConfirm={() => { void confirmPurge() }}
      />
      <ConfirmDialog
        open={batchPurgeOpen}
        title={t('batchPurgeTitle')}
        description={t('batchPurgeDescription', { count: String(selectedIds.size) })}
        confirmLabel={t('purge')}
        pending={batchAction}
        onClose={() => { if (!batchAction) setBatchPurgeOpen(false) }}
        onConfirm={() => { void confirmBatchPurge() }}
      />
    </div>
  )
}

function DocumentTableRow({ row, selected, onSelect, onOpen }: { row: AdminDocument; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  const t = useMemo(() => documentsCopy(), [])
  return <tr><td><input type="checkbox" aria-label={t('selectRow', { name: row.name })} checked={selected} onChange={onSelect} /></td><td><button className="tableLink" type="button" onClick={onOpen}><span className="documentIdentity"><FileText aria-hidden="true" /><strong>{row.name}</strong><small>{row.docId}</small></span></button></td><td><StatusBadge tone={row.scope.kind === 'project' ? 'info' : 'neutral'}>{row.scope.label}</StatusBadge></td><td>{row.owner?.displayName ?? <span className="muted">{t('unassigned')}</span>}</td><td>{formatBytes(row.bytes)}</td><td><StatusBadge tone={row.state === 'active' ? 'success' : row.state === 'trash' || row.state === 'deleted' ? 'warning' : 'danger'}>{documentStateLabel(row.state)}</StatusBadge></td><td>{documentOwnerSourceLabel(row)}</td><td>{formatTime(row.modifiedAt)}</td><td><IconButton label={t('viewDetails')} icon={ShieldCheck} variant="secondary" onClick={onOpen} /></td></tr>
}

const DOCUMENT_OWNER_SOURCE_LABEL_KEYS: Record<AdminDocument['ownerSource'], DocumentsCopyKey> = {
  upload: 'sourceUpload',
  transfer: 'sourceTransfer',
  legacy: 'sourceLegacy',
  admin: 'sourceAdmin',
}

function documentOwnerSourceLabel(document: AdminDocument): string {
  return documentsCopy()(document.legacy ? 'sourceLegacy' : DOCUMENT_OWNER_SOURCE_LABEL_KEYS[document.ownerSource])
}

function documentStateLabel(state: AdminDocument['state']): string {
  const t = documentsCopy()
  if (state === 'active') return t('stateActive')
  if (state === 'trash' || state === 'deleted') return t('stateTrash')
  return t('statePurged')
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) { return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div> }
function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB` }
function formatTime(timestamp: number): string { return new Intl.DateTimeFormat(documentsCopy()('dateLocale'), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp) }
function messageFrom(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
