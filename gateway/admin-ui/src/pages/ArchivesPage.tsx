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
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  applyArchiveAction,
  exportArchive,
  getArchive,
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
  const [emptySelected, setEmptySelected] = useState<Set<string>>(new Set())
  const [emptyLoading, setEmptyLoading] = useState(false)
  const [emptyError, setEmptyError] = useState('')

  const fetchRows = useCallback(async (filter: Draft, nextOffset: number, showLoading = true) => {
    const userId = filter.userId === '' ? undefined : Number(filter.userId)
    const projectId = filter.projectId === '' ? undefined : Number(filter.projectId)
    if ((userId !== undefined && (!Number.isSafeInteger(userId) || userId <= 0))
      || (projectId !== undefined && (!Number.isSafeInteger(projectId) || projectId <= 0))) {
      setError('用户 ID 和项目 ID 必须是正整数')
      return
    }
    if (showLoading) setLoading(true)
    try {
      setRows(await listArchives({
        state: filter.state,
        query: filter.query,
        userId,
        projectId,
        limit: PAGE_SIZE,
        offset: nextOffset,
      }))
      setOffset(nextOffset)
      setSelected(new Set())
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchRows(EMPTY_DRAFT, 0) }, [fetchRows])

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
    setDetailLoading(true)
    setActionError('')
    try {
      setDetail(await getArchive(row.rootSessionId))
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setDetailLoading(false)
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
      else if (detail !== null) setDetail(null)
      await fetchRows(active, offset, false)
    } catch (cause) {
      setActionError(messageFrom(cause))
    } finally {
      setPendingAction(null)
    }
  }

  const allSelected = rows.length > 0 && rows.every(row => selected.has(row.rootSessionId))
  const hasFilters = Object.entries(active).some(([key, value]) => key !== 'state' ? value !== '' : value !== 'archived')
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const selectedRows = useMemo(() => rows.filter(row => selected.has(row.rootSessionId)), [rows, selected])

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
      <Section title="空白会话维护" meta="仅管理员可见">
        <div className="archiveBulkBar">
          <span>先扫描一小时无可见内容的会话，再将选中项移入可恢复回收站。</span>
          <div className="pageActionGroup">
            <Button icon={SearchCheck} onClick={() => { void scanEmptyDrafts() }} loading={emptyLoading}>扫描</Button>
            <Button icon={Trash2} variant="danger" disabled={emptySelected.size === 0 || emptyLoading} onClick={() => { void moveEmptyDraftsToTrash() }}>清理选中空草稿</Button>
          </div>
        </div>
        <ErrorBanner message={emptyError} />
        {emptyCandidates.length === 0 ? <p className="mutedText">尚未发现待维护的空白会话。</p> : (
          <div className="mobileList">{emptyCandidates.map(candidate => (
            <label className="mobileItem" key={candidate.rootSessionId}>
              <span className="checkLabel"><input type="checkbox" checked={emptySelected.has(candidate.rootSessionId)} onChange={event => setEmptySelected(nextSelection(emptySelected, candidate.rootSessionId, event.target.checked))} /><strong>{candidate.rootSessionId}</strong></span>
              <span className="mutedText">{candidate.creator?.displayName ?? '未知用户'} · {candidate.eventCount} 条事件 · {formatTime(candidate.updatedAt)}</span>
            </label>
          ))}</div>
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
            <div className="archiveBulkBar">
              <label className="checkLabel"><input type="checkbox" checked={allSelected} onChange={event => setSelected(event.target.checked ? new Set(rows.map(row => row.rootSessionId)) : new Set())} /><span>全选本页</span></label>
              <span>{selectedRows.length > 0 ? `已选择 ${selectedRows.length} 条` : '选择记录后可批量操作'}</span>
            </div>
            <div className="tableWrap desktopOnly">
              <table className="dataTable archiveTable">
                <thead><tr><th aria-label="选择" /><th>对话</th><th>归属</th><th>归档时间</th><th>状态</th><th>消息</th><th aria-label="查看" /></tr></thead>
                <tbody>{rows.map(row => <ArchiveTableRow key={row.rootSessionId} row={row} checked={selected.has(row.rootSessionId)} onCheck={checked => setSelected(nextSelection(selected, row.rootSessionId, checked))} onOpen={() => void openDetail(row)} />)}</tbody>
              </table>
            </div>
            <div className="mobileList">{rows.map(row => <ArchiveMobileRow key={row.rootSessionId} row={row} checked={selected.has(row.rootSessionId)} onCheck={checked => setSelected(nextSelection(selected, row.rootSessionId, checked))} onOpen={() => void openDetail(row)} />)}</div>
          </>
        )}
        {loading || (rows.length === 0 && offset === 0) ? null : <div className="pagination"><span>第 {page} 页</span><IconButton label="上一页" icon={ChevronLeft} variant="secondary" disabled={offset === 0} onClick={() => void fetchRows(active, Math.max(0, offset - PAGE_SIZE))} /><IconButton label="下一页" icon={ChevronRight} variant="secondary" disabled={rows.length < PAGE_SIZE} onClick={() => void fetchRows(active, offset + PAGE_SIZE)} /></div>}
      </Section>
      <Dialog open={detail !== null || detailLoading} title={detail?.record.title ?? '归档对话'} description={detail === null ? '正在加载对话内容' : `${detail.record.rootSessionId} · ${detail.record.project?.name ?? '个人会话'}`} onClose={() => { if (!detailLoading) setDetail(null) }} wide footer={detail === null ? undefined : <div className="dialogActionRow"><a className="button button-secondary" href={exportArchive(detail.record.rootSessionId)}>导出</a><Button icon={Undo2} onClick={() => setConfirmAction('restore')} loading={pendingAction === 'restore'}>恢复</Button><Button icon={Trash2} variant="danger" onClick={() => setConfirmAction('trash')} loading={pendingAction === 'trash'}>移入回收站</Button><Button variant="danger" onClick={() => setConfirmAction('purge')} loading={pendingAction === 'purge'}>永久清理</Button></div>}>
        {detailLoading ? <LoadingState label="正在读取对话" /> : detail === null ? null : <ArchiveDetail detail={detail} error={actionError} />}
      </Dialog>
      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'purge' ? '永久清理归档对话？' : confirmAction === 'trash' ? '移入回收站？' : '恢复归档对话？'}
        description={confirmAction === 'purge' ? '该操作会清理整棵对话树和已关联的内容，不能恢复。' : confirmAction === 'trash' ? '对话会进入回收站，并在部署配置的保留窗口内可恢复。' : '对话会恢复到原来的 Workspace 位置。'}
        confirmLabel={confirmAction === 'purge' ? '永久清理' : confirmAction === 'trash' ? '移入回收站' : '恢复'}
        pending={pendingAction !== null}
        onClose={() => { if (pendingAction === null) setConfirmAction(null) }}
        onConfirm={() => { if (confirmAction !== null) { const action = confirmAction; setConfirmAction(null); void runAction(action) } }}
      />
    </div>
  )
}

function ArchiveTableRow({ row, checked, onCheck, onOpen }: { row: ConversationArchiveRow; checked: boolean; onCheck: (checked: boolean) => void; onOpen: () => void }) {
  return <tr><td><input type="checkbox" aria-label={`选择 ${row.title}`} checked={checked} onChange={event => onCheck(event.target.checked)} /></td><td><button type="button" className="tableLink" onClick={onOpen}><strong>{row.title}</strong><span className="codeText">{row.rootSessionId}</span></button></td><td><span className="archiveOwner">{row.creator?.displayName ?? '未知用户'}<small>{row.project?.name ?? '个人会话'}</small></span></td><td><time dateTime={new Date(row.archivedAt).toISOString()}>{formatTime(row.archivedAt)}</time></td><td><ArchiveStateBadge state={row.state} /></td><td>{row.messageCount}</td><td className="alignRight"><IconButton label={`查看 ${row.title}`} icon={Eye} onClick={onOpen} /></td></tr>
}

function ArchiveMobileRow({ row, checked, onCheck, onOpen }: { row: ConversationArchiveRow; checked: boolean; onCheck: (checked: boolean) => void; onOpen: () => void }) {
  return <article className="mobileItem archiveMobileItem"><div className="mobileItemHeader"><label className="checkLabel"><input type="checkbox" aria-label={`选择 ${row.title}`} checked={checked} onChange={event => onCheck(event.target.checked)} /><strong>{row.title}</strong></label><ArchiveStateBadge state={row.state} /></div><button type="button" className="archiveMobileOpen" onClick={onOpen}><span className="codeText">{row.rootSessionId}</span><span>{row.creator?.displayName ?? '未知用户'} · {row.project?.name ?? '个人会话'}</span><span>{formatTime(row.archivedAt)} · {row.messageCount} 条消息</span></button></article>
}

function ArchiveDetail({ detail, error }: { detail: ConversationArchiveDetail; error: string }) {
  return <div className="archiveDetail"><ErrorBanner message={error} /><dl className="definitionGrid"><div className="definitionRow"><dt>创建者</dt><dd>{detail.record.creator?.displayName ?? '未知用户'}</dd></div><div className="definitionRow"><dt>Workspace</dt><dd>{detail.record.workspace?.title ?? '未分组'}</dd></div><div className="definitionRow"><dt>子会话</dt><dd>{Math.max(0, detail.descendants.length - 1)}</dd></div><div className="definitionRow"><dt>同步状态</dt><dd>{detail.record.syncState}</dd></div></dl><section className="archiveDescendants" aria-label="子会话与分支"><h3>会话树</h3>{detail.descendants.length === 0 ? <p className="mutedText">没有可用的子会话记录。</p> : <ul>{detail.descendants.map(entry => <li key={entry.sessionId}><span>{entry.sessionId === detail.record.rootSessionId ? '根会话' : '子会话'}</span><strong>{entry.title}</strong><code>{entry.sessionId}</code></li>)}</ul>}</section><div className="archiveTimeline" aria-label="对话时间线">{detail.events.length === 0 ? <EmptyState title="正文暂不可用" detail="该会话可能属于离线个人运行时，稍后重试即可。" /> : detail.events.map(event => <article className="archiveEvent" key={`${event.sessionId}:${event.seq}`}><div className="archiveEventMeta"><span>{event.type}</span><small>{event.sessionId}</small><time>{formatTime(event.time)}</time></div><pre>{formatEvent(event.data)}</pre></article>)}</div></div>
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

function formatEvent(data: unknown): string {
  if (typeof data === 'string') return data
  try { return JSON.stringify(data, null, 2) } catch { return String(data) }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)
}

function messageFrom(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
