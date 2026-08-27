import { Archive, FileText, Filter, History, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  deleteAdminDocument,
  applyAdminDocumentAction,
  getAdminDocument,
  listAdminDocuments,
  listAdminDocumentsPage,
  listDocumentMetrics,
  listProjects,
  listUsers,
  transferAdminDocumentOwnership,
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
  const [ownerSaving, setOwnerSaving] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchAction, setBatchAction] = useState(false)
  const reloadGeneration = useRef(0)

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
      } catch {
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
    try {
      setDetail(await getAdminDocument(row.catalogId))
      setOwnerId(row.owner === null ? '' : String(row.owner.id))
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
      if (item !== undefined && !item.ok) throw new Error(item.error ?? '文档状态变更失败')
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
      if (failed.length > 0) throw new Error(`${failed.length} 条记录处理失败`)
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
    if (detail === null || ownerId === '') return
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
        title="文档"
        description="组织级文档元数据、所有权、复制谱系和操作历史。文件内容只在授权作用域内查看。"
        actions={<Button icon={RefreshCw} onClick={() => void reload(active, true, page, pageCursors[page])}>刷新</Button>}
      />
      <ErrorBanner message={error} />
      <div className="metricGrid" aria-label="文档汇总">
        <Metric label="活跃文档" value={metrics?.active.toLocaleString() ?? '—'} />
        <Metric label="回收站" value={(metrics?.trash ?? metrics?.deleted ?? 0).toLocaleString()} tone={(metrics?.trash ?? 0) > 0 ? 'warning' : undefined} />
        <Metric label="个人文档" value={metrics?.personal.toLocaleString() ?? '—'} />
        <Metric label="项目文档" value={metrics?.project.toLocaleString() ?? '—'} />
        <Metric label="近 24 小时失败" value={metrics?.failures24h.toLocaleString() ?? '—'} tone={metrics !== null && metrics.failures24h > 0 ? 'warning' : undefined} />
      </div>
      <Section title="筛选条件">
        <form className="filterPanel" onSubmit={apply}>
          <div className="filterGrid">
            <Field label="文件名或 ID"><div className="inputWithIcon"><Search aria-hidden="true" /><input className="input" value={draft.query} onChange={event => setDraft({ ...draft, query: event.target.value })} placeholder="搜索元数据" /></div></Field>
            <Field label="作用域"><select className="select" value={draft.scope} onChange={event => setDraft({ ...draft, scope: event.target.value as Draft['scope'] })}><option value="">全部作用域</option><option value="personal">个人文档</option><option value="project">项目文档</option></select></Field>
            <Field label="项目"><select className="select" value={draft.projectId} onChange={event => setDraft({ ...draft, projectId: event.target.value })}><option value="">全部项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}（#{project.id}）</option>)}</select></Field>
            <Field label="所有者"><select className="select" value={draft.ownerUserId} onChange={event => setDraft({ ...draft, ownerUserId: event.target.value })}><option value="">全部用户</option>{users.map(user => <option key={user.id} value={user.id}>{user.displayName}（#{user.id}）</option>)}</select></Field>
          <Field label="状态"><select className="select" value={draft.state} onChange={event => setDraft({ ...draft, state: event.target.value as Draft['state'] })}><option value="active">活跃</option><option value="trash">回收站</option><option value="purged">已永久清理</option><option value="all">全部</option></select></Field>
          </div>
          <div className="filterActions"><Button type="button" onClick={reset}>重置</Button><Button type="submit" variant="primary" icon={Filter}>应用筛选</Button></div>
        </form>
      </Section>
      <Section className="responsiveSection" title="文档目录" meta={loading ? undefined : `${rows.length} 条记录`}>
        {selectedIds.size > 0 && <div className="filterActions" role="toolbar" aria-label="批量文档操作"><span className="muted">已选 {selectedIds.size} 条</span><Button type="button" variant="danger" loading={batchAction} onClick={() => void changeSelectedState('trash')}>移入回收站</Button><Button type="button" loading={batchAction} onClick={() => void changeSelectedState('restore')}>恢复</Button><Button type="button" variant="danger" loading={batchAction} onClick={requestBatchPurge}>永久清理</Button><Button type="button" disabled={batchAction} onClick={() => setSelectedIds(new Set())}>清除选择</Button></div>}
        {loading ? <LoadingState label="正在加载文档目录" /> : rows.length === 0 ? <EmptyState icon={Archive} title="没有匹配的文档" detail="调整筛选条件后重试。" /> : <>
          <div className="tableWrap desktopOnly"><table className="dataTable documentsTable"><thead><tr><th><span className="visuallyHidden">选择</span></th><th>文档</th><th>作用域</th><th>所有者</th><th>大小</th><th>状态</th><th>来源</th><th>更新时间</th><th /></tr></thead><tbody>{rows.map(row => <DocumentTableRow key={row.catalogId} row={row} selected={selectedIds.has(row.catalogId)} onSelect={() => setSelectedIds(previous => { const next = new Set(previous); if (next.has(row.catalogId)) next.delete(row.catalogId); else next.add(row.catalogId); return next })} onOpen={() => void openDetail(row)} />)}</tbody></table></div>
          <div className="mobileList">{rows.map(row => <article className="mobileItem" key={row.catalogId} onClick={() => void openDetail(row)}><div className="mobileItemHeader"><input type="checkbox" aria-label={`选择 ${row.name}`} checked={selectedIds.has(row.catalogId)} onChange={event => { event.stopPropagation(); setSelectedIds(previous => { const next = new Set(previous); if (next.has(row.catalogId)) next.delete(row.catalogId); else next.add(row.catalogId); return next }) }} onClick={event => event.stopPropagation()} /><strong>{row.name}</strong><StatusBadge tone={row.scope.kind === 'project' ? 'info' : 'neutral'}>{row.scope.label}</StatusBadge></div><div className="mobileItemBody"><span className="muted">{row.owner?.displayName ?? '未分配'} · {formatBytes(row.bytes)}</span><span className="codeText">{row.catalogId}</span></div></article>)}</div>
        </>}
        {!loading && (nextCursor !== undefined || page > 0) && (
          <div className="filterActions" aria-label="文档分页">
            <Button type="button" disabled={page === 0} onClick={() => { const next = page - 1; setPage(next); void reload(active, true, next, pageCursors[next]) }}>上一页</Button>
            <span className="muted">第 {page + 1} 页</span>
            <Button type="button" disabled={nextCursor === undefined} onClick={() => { const next = page + 1; setPage(next); void reload(active, true, next, nextCursor) }}>下一页</Button>
          </div>
        )}
      </Section>

      <Dialog open={detail !== null || detailLoading} title={detail?.document.name ?? '文档详情'} description="默认仅显示元数据；回收、恢复、永久清理和所有权变更都会写入审计日志。" wide onClose={() => { if (!deleteLoading && !ownerSaving) setDetail(null) }} footer={detail === null ? undefined : <><>{detail.document.state === 'active' && <Button type="button" onClick={() => setDeleteOpen(true)} variant="danger" icon={Trash2} disabled={deleteLoading}>移入回收站</Button>}{detail.document.state === 'trash' && <><Button type="button" onClick={() => void changeState('restore')} variant="secondary" disabled={deleteLoading}>恢复</Button><Button type="button" onClick={requestPurge} variant="danger" disabled={deleteLoading}>永久清理</Button></>}{detail.document.state === 'purged' && <StatusBadge tone="danger">已永久清理</StatusBadge>}</><Button type="button" onClick={() => setDetail(null)}>关闭</Button></>}>
        {detailLoading || detail === null ? <LoadingState label="正在加载文档详情" /> : <div className="documentDetail"><dl className="definitionGrid"><Definition label="目录 ID"><span className="codeText">{detail.document.catalogId}</span></Definition><Definition label="作用域">{detail.document.scope.label}</Definition><Definition label="文件 ID"><span className="codeText">{detail.document.docId}</span></Definition><Definition label="大小">{formatBytes(detail.document.bytes)}</Definition><Definition label="状态">{documentStateLabel(detail.document.state)}</Definition><Definition label="来源">{documentOwnerSourceLabel(detail.document)}</Definition><Definition label="谱系根">{detail.document.lineageRootId === null ? '当前根文档' : <span className="codeText">{detail.document.lineageRootId}</span>}</Definition>{detail.document.purgeAfter !== undefined && detail.document.purgeAfter !== null && <Definition label="自动清理">{formatTime(detail.document.purgeAfter)}</Definition>}</dl><form className="ownershipForm" onSubmit={event => void transferOwner(event)}><Field label="所有者"><select className="select" value={ownerId} onChange={event => setOwnerId(event.target.value)} disabled={ownerSaving}>{users.map(user => <option key={user.id} value={user.id}>{user.displayName}（#{user.id}）</option>)}</select></Field><Button type="submit" variant="secondary" icon={ShieldCheck} loading={ownerSaving}>转移所有权</Button></form><div className="detailDivider" /><h3><History aria-hidden="true" />操作历史</h3>{detail.history.length === 0 ? <p className="muted">暂无历史记录。</p> : <ol className="historyList">{detail.history.map(item => <li key={item.id}><span><strong>{item.eventKind}</strong><small>{item.actor?.displayName ?? '系统'} · {formatTime(item.createdAt)}</small></span><span className="codeText">{item.operationId ?? '—'}</span></li>)}</ol>}<h3><FileText aria-hidden="true" />复制记录</h3>{detail.copies.length === 0 ? <p className="muted">暂无复制记录。</p> : <ul className="historyList">{detail.copies.map((item, index) => <li key={`${item.operationId}-${String(index)}`}><span><strong>{item.status}</strong><small>{item.source.name} → {item.targetDocId ?? '未生成'} · {formatTime(item.createdAt)}</small></span><span className="codeText">{item.operationId}</span></li>)}</ul>}</div>}
      </Dialog>
      <Dialog open={deleteOpen} title="确认移入回收站" description="文档会从作用域中移入可恢复回收站，并写入审计日志。保留期结束后才会永久清理。" danger onClose={() => { if (!deleteLoading) setDeleteOpen(false) }} footer={<><Button type="button" onClick={() => setDeleteOpen(false)} disabled={deleteLoading}>取消</Button><Button type="button" variant="danger" loading={deleteLoading} onClick={() => void remove()}>移入回收站</Button></>} />
      <ConfirmDialog
        open={purgeOpen}
        title="永久清理文档？"
        description="该操作会永久删除回收站中的文档元数据，不能恢复。确认前请核对文档名称和作用域。"
        confirmLabel="永久清理"
        pending={deleteLoading}
        onClose={() => { if (!deleteLoading) setPurgeOpen(false) }}
        onConfirm={() => { void confirmPurge() }}
      />
      <ConfirmDialog
        open={batchPurgeOpen}
        title="永久清理所选文档？"
        description={`将永久清理 ${String(selectedIds.size)} 条回收站记录，不能恢复。`}
        confirmLabel="永久清理"
        pending={batchAction}
        onClose={() => { if (!batchAction) setBatchPurgeOpen(false) }}
        onConfirm={() => { void confirmBatchPurge() }}
      />
    </div>
  )
}

function DocumentTableRow({ row, selected, onSelect, onOpen }: { row: AdminDocument; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  return <tr><td><input type="checkbox" aria-label={`选择 ${row.name}`} checked={selected} onChange={onSelect} /></td><td><button className="tableLink" type="button" onClick={onOpen}><span className="documentIdentity"><FileText aria-hidden="true" /><strong>{row.name}</strong><small>{row.docId}</small></span></button></td><td><StatusBadge tone={row.scope.kind === 'project' ? 'info' : 'neutral'}>{row.scope.label}</StatusBadge></td><td>{row.owner?.displayName ?? <span className="muted">未分配</span>}</td><td>{formatBytes(row.bytes)}</td><td><StatusBadge tone={row.state === 'active' ? 'success' : row.state === 'trash' || row.state === 'deleted' ? 'warning' : 'danger'}>{documentStateLabel(row.state)}</StatusBadge></td><td>{documentOwnerSourceLabel(row)}</td><td>{formatTime(row.modifiedAt)}</td><td><IconButton label="查看详情" icon={ShieldCheck} variant="secondary" onClick={onOpen} /></td></tr>
}

const DOCUMENT_OWNER_SOURCE_LABELS: Record<AdminDocument['ownerSource'], string> = {
  upload: '上传',
  transfer: '跨作用域复制',
  legacy: '历史导入',
  admin: '管理员登记',
}

function documentOwnerSourceLabel(document: AdminDocument): string {
  return document.legacy ? '历史导入' : DOCUMENT_OWNER_SOURCE_LABELS[document.ownerSource]
}

function documentStateLabel(state: AdminDocument['state']): string {
  if (state === 'active') return '活跃'
  if (state === 'trash' || state === 'deleted') return '回收站'
  return '已永久清理'
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) { return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div> }
function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB` }
function formatTime(timestamp: number): string { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp) }
function messageFrom(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
