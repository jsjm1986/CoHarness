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

const PAGE_SIZE = 50

type Draft = { state: ConversationArchiveState | 'all'; query: string; userId: string; projectId: string }
const EMPTY_DRAFT: Draft = { state: 'archived', query: '', userId: '', projectId: '' }

export function ArchivesPage() {
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
      setError('用户 ID 和项目 ID 必须是正整数')
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
  }, [])

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
      setEmptyScanned(true)
      setEmptySelected(new Set())
    } catch (cause) {
      setEmptyError(messageFrom(cause))
    } finally {
      setEmptyLoading(false)
    }
  }

  async function moveEmptyDraftsToTrash() {
    if (emptySelected.size === 0) return
    setEmptyLoading(true)
    setEmptyError('')
    try {
      await trashEmptyDrafts([...emptySelected])
      await scanEmptyDrafts()
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
      if (failed.length > 0) setActionError(`有 ${failed.length} 条记录未完成：${failed.map(item => item.error ?? item.rootSessionId).join('；')}`)
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
        title="归档对话"
        description="统一查看和管理组织内已归档的个人与项目对话。"
        meta={loading ? undefined : `${rows.length} 条记录`}
        actions={selectedRows.length === 0 ? undefined : (
          <div className="pageActionGroup">
            <Button icon={Undo2} onClick={() => setConfirmAction('restore')}>恢复所选</Button>
            <Button icon={Trash2} variant="danger" onClick={() => setConfirmAction('trash')}>移入回收站</Button>
            <Button variant="danger" onClick={() => setConfirmAction('purge')}>永久清理所选</Button>
          </div>
        )}
      />
      <ErrorBanner message={error} />
      <Section title="空白会话维护" meta={emptyScanned ? '扫描完成' : '仅管理员可见'}>
        <div className="archiveBulkBar">
          <span>先扫描一小时无可见内容的会话，再将选中项移入可恢复回收站。</span>
          <div className="pageActionGroup">
            <Button icon={SearchCheck} onClick={() => { void scanEmptyDrafts() }} loading={emptyLoading}>扫描</Button>
            {emptySelected.size > 0 ? <Button icon={Trash2} variant="danger" disabled={emptyLoading} onClick={() => { void moveEmptyDraftsToTrash() }}>清理选中空草稿</Button> : null}
          </div>
        </div>
        <ErrorBanner message={emptyError} />
        {emptyCandidates.length === 0 ? <div className="emptyDraftState">
          <span className="emptyDraftStateIcon" aria-hidden="true"><Archive /></span>
          <strong>{emptyScanned ? '当前没有符合条件的空白会话' : '还没有扫描结果'}</strong>
          <p>{emptyScanned ? '扫描完成，未发现超过一小时且没有可见内容的会话。' : '点击“扫描”查找超过一小时且没有可见内容的会话。'}</p>
        </div> : (
          <>
            <div className="tableWrap desktopOnly emptyDraftTableWrap">
              <table className="dataTable emptyDraftTable" aria-label="空白会话维护列表">
                <thead><tr><th aria-label="选择" /><th>会话</th><th>归属</th><th>创建者</th><th>更新时间</th><th>事件</th></tr></thead>
                <tbody>{emptyCandidates.map(candidate => (
                  <tr key={candidate.rootSessionId}>
                    <td><input type="checkbox" aria-label={`选择 ${candidate.rootSessionId}`} checked={emptySelected.has(candidate.rootSessionId)} onChange={event => setEmptySelected(nextSelection(emptySelected, candidate.rootSessionId, event.target.checked))} /></td>
                    <td><span className="codeText">{candidate.rootSessionId}</span></td>
                    <td><span className="archiveOwner"><strong>{candidate.project?.name ?? '个人会话'}</strong><small>{candidate.runtime.kind === 'project' ? `项目 #${candidate.runtime.id}` : `个人运行时 #${candidate.runtime.id}`}</small></span></td>
                    <td>{candidate.creator?.displayName ?? '未知用户'}</td>
                    <td><time dateTime={new Date(candidate.updatedAt).toISOString()}>{formatTime(candidate.updatedAt)}</time></td>
                    <td>{candidate.eventCount}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="mobileList emptyDraftMobileList">{emptyCandidates.map(candidate => (
              <label className="mobileItem" key={candidate.rootSessionId}>
                <span className="mobileItemHeader"><span className="checkLabel"><input type="checkbox" aria-label={`选择 ${candidate.rootSessionId}`} checked={emptySelected.has(candidate.rootSessionId)} onChange={event => setEmptySelected(nextSelection(emptySelected, candidate.rootSessionId, event.target.checked))} /><strong className="codeText">{candidate.rootSessionId}</strong></span><strong>{candidate.project?.name ?? '个人会话'}</strong></span>
                <span className="mobileItemBody"><span className="muted">{candidate.creator?.displayName ?? '未知用户'} · {candidate.runtime.kind === 'project' ? `项目 #${candidate.runtime.id}` : `个人运行时 #${candidate.runtime.id}`}</span><span className="muted">{candidate.eventCount} 条事件 · {formatTime(candidate.updatedAt)}</span></span>
              </label>
            ))}</div>
          </>
        )}
      </Section>
      <Section title="筛选条件">
        <form className="filterPanel" onSubmit={onFilter}>
          <div className="filterGrid">
            <Field label="状态">
              <select className="input" value={draft.state} onChange={event => setDraft({ ...draft, state: event.target.value as Draft['state'] })}>
                <option value="archived">已归档</option>
                <option value="trash">回收站</option>
                <option value="purged">已清理</option>
                <option value="all">全部</option>
              </select>
            </Field>
            <Field label="关键词">
              <input className="input" value={draft.query} onChange={event => setDraft({ ...draft, query: event.target.value })} placeholder="标题、正文或 Session ID" />
            </Field>
            <Field label="用户 ID">
              <input className="input" value={draft.userId} onChange={event => setDraft({ ...draft, userId: event.target.value })} placeholder="全部用户" inputMode="numeric" />
            </Field>
            <Field label="项目 ID">
              <input className="input" value={draft.projectId} onChange={event => setDraft({ ...draft, projectId: event.target.value })} placeholder="全部项目" inputMode="numeric" />
            </Field>
          </div>
          <div className="filterActions">
            <Button type="button" icon={RotateCcw} onClick={resetFilters} disabled={!hasFilters && draft.query === '' && draft.userId === '' && draft.projectId === ''}>重置</Button>
            <Button type="submit" variant="primary" icon={Filter}>应用筛选</Button>
          </div>
        </form>
      </Section>
      <Section className="responsiveSection" title="归档记录" meta={loading ? undefined : `第 ${page} 页`}>
        {loading ? <LoadingState label="正在加载归档记录" /> : rows.length === 0 ? (
          <EmptyState icon={Archive} title="没有匹配的归档对话" detail={hasFilters ? '调整筛选条件后重试。' : '当前还没有归档对话。'} />
        ) : (
          <>
            <div className="archiveBulkBar archiveSelectionSummary">
              <span>{selectedRows.length > 0 ? `已选择 ${selectedRows.length} 条` : '选择记录后可批量操作'}</span>
            </div>
            <div className="tableWrap desktopOnly">
              <table className="dataTable archiveTable">
                <thead><tr><th aria-label="选择"><label className="checkLabel archiveSelectAll"><input ref={selectAllRef} type="checkbox" checked={allSelected} aria-checked={indeterminate ? 'mixed' : allSelected} onChange={event => toggleAll(event.target.checked)} /><span>全选本页</span></label></th><th>对话</th><th>归属</th><th>归档时间</th><th>状态</th><th>消息</th><th aria-label="查看" /></tr></thead>
                <tbody>{rows.map(row => <ArchiveTableRow key={row.rootSessionId} row={row} checked={selected.has(row.rootSessionId)} onCheck={checked => setSelected(nextSelection(selected, row.rootSessionId, checked))} onOpen={() => void openDetail(row)} />)}</tbody>
              </table>
            </div>
            <div className="mobileList">{rows.map(row => <ArchiveMobileRow key={row.rootSessionId} row={row} checked={selected.has(row.rootSessionId)} onCheck={checked => setSelected(nextSelection(selected, row.rootSessionId, checked))} onOpen={() => void openDetail(row)} />)}</div>
          </>
        )}
        {loading || (rows.length === 0 && offset === 0) ? null : <div className="pagination"><span>第 {page} 页</span><IconButton label="上一页" icon={ChevronLeft} variant="secondary" disabled={offset === 0} onClick={() => void fetchRows(active, Math.max(0, offset - PAGE_SIZE))} /><IconButton label="下一页" icon={ChevronRight} variant="secondary" disabled={rows.length < PAGE_SIZE} onClick={() => void fetchRows(active, offset + PAGE_SIZE)} /></div>}
      </Section>
      <Dialog open={detail !== null || detailLoading} title={detail?.record.title ?? '归档对话'} description={detail === null ? '正在加载对话内容' : `${detail.record.workspace?.title ?? '未分组'} · ${detail.record.project?.name ?? '个人会话'}`} onClose={() => { if (!detailLoading) { detailGeneration.current++; setDetail(null) } }} wide footer={detail === null ? undefined : <div className="dialogActionRow">{detail.record.state === 'purged' ? <Button variant="secondary" disabled>导出</Button> : <a className="button button-secondary" href={exportArchive(detail.record.rootSessionId)}>导出</a>}<Button icon={Undo2} onClick={() => setConfirmAction('restore')} loading={pendingAction === 'restore'} disabled={detail.record.syncState === 'pending' || detail.record.state === 'purged'}>恢复</Button><Button icon={Trash2} variant="danger" onClick={() => setConfirmAction('trash')} loading={pendingAction === 'trash'} disabled={detail.record.syncState === 'pending' || detail.record.state === 'purged'}>移入回收站</Button><Button variant="danger" onClick={() => setConfirmAction('purge')} loading={pendingAction === 'purge'} disabled={detail.record.syncState === 'pending' || (detail.record.state === 'purged' && detail.record.syncState === 'synced')}>永久清理</Button></div>}>
        {detailLoading ? <LoadingState label="正在读取对话" /> : detail === null ? null : <ArchiveDetail detail={detail} error={actionError} />}
      </Dialog>
      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'purge' ? '永久清理归档对话？' : confirmAction === 'trash' ? '移入回收站？' : '恢复归档对话？'}
        description={confirmAction === 'purge' ? '请求将在实例确认资源释放后清理整棵对话树及关联内容，不能恢复。仍有运行、子任务、终端或待处理输入时会拒绝，请先停止。' : confirmAction === 'trash' ? '对话会进入回收站，并在部署配置的保留窗口内可恢复。' : '对话会恢复到原来的 Workspace 位置。'}
        confirmLabel={confirmAction === 'purge' ? '永久清理' : confirmAction === 'trash' ? '移入回收站' : '恢复'}
        pending={pendingAction !== null}
        onClose={() => { if (pendingAction === null) setConfirmAction(null) }}
        onConfirm={() => { if (confirmAction !== null) { const action = confirmAction; setConfirmAction(null); void runAction(action) } }}
      />
    </div>
  )
}

function ArchiveTableRow({ row, checked, onCheck, onOpen }: { row: ConversationArchiveRow; checked: boolean; onCheck: (checked: boolean) => void; onOpen: () => void }) {
  return <tr><td><input type="checkbox" aria-label={`选择 ${row.title}`} checked={checked} onChange={event => onCheck(event.target.checked)} /></td><td><button type="button" className="tableLink" onClick={onOpen}><strong>{row.title}</strong>{row.contentPreview === undefined || row.contentPreview === null ? <small className="archivePreview archivePreviewEmpty">暂无正文摘要</small> : <small className="archivePreview" title={row.contentPreview}>{row.contentPreview}</small>}<span className="codeText archiveSessionId">{row.rootSessionId}</span></button></td><td><span className="archiveOwner">{row.creator?.displayName ?? '未知用户'}<small>{row.project?.name ?? '个人会话'}</small></span></td><td><time dateTime={new Date(row.archivedAt).toISOString()}>{formatTime(row.archivedAt)}</time></td><td><ArchiveStateBadge state={row.state} /><ArchiveSyncState row={row} /></td><td>{row.messageCount}</td><td className="alignRight"><IconButton label={`查看 ${row.title}`} icon={Eye} onClick={onOpen} /></td></tr>
}

function ArchiveMobileRow({ row, checked, onCheck, onOpen }: { row: ConversationArchiveRow; checked: boolean; onCheck: (checked: boolean) => void; onOpen: () => void }) {
  return <article className="mobileItem archiveMobileItem"><div className="mobileItemHeader"><label className="checkLabel"><input type="checkbox" aria-label={`选择 ${row.title}`} checked={checked} onChange={event => onCheck(event.target.checked)} /><span className="archiveIdentity"><strong>{row.title}</strong><small className="archivePreview">{row.contentPreview ?? '暂无正文摘要'}</small><small className="codeText archiveSessionId">{row.rootSessionId}</small></span></label><div><ArchiveStateBadge state={row.state} /><ArchiveSyncState row={row} /></div></div><button type="button" className="archiveMobileOpen" onClick={onOpen}><span>{row.creator?.displayName ?? '未知用户'} · {row.project?.name ?? '个人会话'}</span><span>{formatTime(row.archivedAt)} · {row.messageCount} 条消息</span></button></article>
}

function ArchiveSyncState({ row }: { row: ConversationArchiveRow }) {
  if (row.syncState === 'synced') return null
  const label = row.syncState === 'pending' ? '等待实例确认' : row.syncState === 'conflict' ? '操作未完成' : '实例暂不可用'
  return <small className="archiveSyncState" title={row.lastSyncError}>{label}</small>
}

function ArchiveDetail({ detail, error }: { detail: ConversationArchiveDetail; error: string }) {
  const syncLabels: Record<ConversationArchiveDetail['record']['syncState'], string> = {
    pending: '等待实例确认',
    synced: '已同步',
    conflict: '操作未完成',
    unavailable: '运行时暂不可用',
  }
  return <div className="archiveDetail"><ErrorBanner message={error || detail.record.lastSyncError || ''} /><dl className="definitionGrid"><div className="definitionRow"><dt>创建者</dt><dd>{detail.record.creator?.displayName ?? '未知用户'}</dd></div><div className="definitionRow"><dt>Workspace</dt><dd>{detail.record.workspace?.title ?? '未分组'}</dd></div><div className="definitionRow"><dt>项目</dt><dd>{detail.record.project?.name ?? '个人会话'}</dd></div><div className="definitionRow"><dt>归档时间</dt><dd><time dateTime={new Date(detail.record.archivedAt).toISOString()}>{formatTime(detail.record.archivedAt)}</time></dd></div><div className="definitionRow"><dt>记录状态</dt><dd><ArchiveStateBadge state={detail.record.state} /></dd></div><div className="definitionRow"><dt>同步状态</dt><dd>{syncLabels[detail.record.syncState]}</dd></div></dl><ArchiveConversationOrRemoval detail={detail} /></div>
}

function ArchiveConversationOrRemoval({ detail }: { detail: ConversationArchiveDetail }) {
  return detail.record.state === 'purged' && detail.record.syncState === 'synced'
    ? <EmptyState icon={Archive} title="对话已永久清理" detail="正文和历史 Review 已清理，不能恢复。" />
    : <ArchiveConversation detail={detail} />
}

function ArchiveStateBadge({ state }: { state: ConversationArchiveState }) {
  const labels: Record<ConversationArchiveState, string> = { archived: '已归档', trash: '回收站', purged: '已清理' }
  const tones: Record<ConversationArchiveState, 'info' | 'warning' | 'danger'> = { archived: 'info', trash: 'warning', purged: 'danger' }
  return <StatusBadge tone={tones[state]}>{labels[state]}</StatusBadge>
}

function nextSelection(current: Set<string>, id: string, checked: boolean): Set<string> {
  const next = new Set(current)
  if (checked) next.add(id); else next.delete(id)
  return next
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
}

function messageFrom(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
