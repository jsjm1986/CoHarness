import { Archive, FileText, Filter, History, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  deleteAdminDocument,
  getAdminDocument,
  listAdminDocuments,
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

type Draft = { query: string; scope: '' | 'personal' | 'project'; projectId: string; ownerUserId: string; state: 'active' | 'deleted' | 'all' }
const EMPTY: Draft = { query: '', scope: '', projectId: '', ownerUserId: '', state: 'active' }

/** Independent organization-wide document catalog dashboard for administrators. */
export function DocumentsPage() {
  const [metrics, setMetrics] = useState<AdminDocumentMetrics | null>(null)
  const [rows, setRows] = useState<AdminDocument[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [active, setActive] = useState<Draft>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<AdminDocumentDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [ownerId, setOwnerId] = useState('')
  const [ownerSaving, setOwnerSaving] = useState(false)

  const reload = useCallback(async (filter: Draft, showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const [nextRows, nextMetrics] = await Promise.all([
        listAdminDocuments({
          ...(filter.scope === '' ? {} : { scope: filter.scope }),
          ...(filter.projectId === '' ? {} : { projectId: Number(filter.projectId) }),
          ...(filter.ownerUserId === '' ? {} : { ownerUserId: Number(filter.ownerUserId) }),
          ...(filter.state === 'all' ? {} : { state: filter.state }),
          ...(filter.query === '' ? {} : { query: filter.query }), limit: 500,
        }),
        listDocumentMetrics(),
      ])
      setRows(nextRows)
      setMetrics(nextMetrics)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
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
    void reload(draft)
  }

  function reset() {
    setDraft(EMPTY)
    setActive(EMPTY)
    void reload(EMPTY)
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
      await reload(active, false)
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setDeleteLoading(false)
    }
  }

  async function transferOwner(event: FormEvent) {
    event.preventDefault()
    if (detail === null || ownerId === '') return
    setOwnerSaving(true)
    try {
      await transferAdminDocumentOwnership(detail.document.catalogId, Number(ownerId))
      setDetail(await getAdminDocument(detail.document.catalogId))
      await reload(active, false)
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
        actions={<Button icon={RefreshCw} onClick={() => void reload(active)}>刷新</Button>}
      />
      <ErrorBanner message={error} />
      <div className="metricGrid" aria-label="文档汇总">
        <Metric label="活跃文档" value={metrics?.active.toLocaleString() ?? '—'} />
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
            <Field label="状态"><select className="select" value={draft.state} onChange={event => setDraft({ ...draft, state: event.target.value as Draft['state'] })}><option value="active">活跃</option><option value="deleted">已删除</option><option value="all">全部</option></select></Field>
          </div>
          <div className="filterActions"><Button type="button" onClick={reset}>重置</Button><Button type="submit" variant="primary" icon={Filter}>应用筛选</Button></div>
        </form>
      </Section>
      <Section className="responsiveSection" title="文档目录" meta={loading ? undefined : `${rows.length} 条记录`}>
        {loading ? <LoadingState label="正在加载文档目录" /> : rows.length === 0 ? <EmptyState icon={Archive} title="没有匹配的文档" detail="调整筛选条件后重试。" /> : <>
          <div className="tableWrap desktopOnly"><table className="dataTable documentsTable"><thead><tr><th>文档</th><th>作用域</th><th>所有者</th><th>大小</th><th>状态</th><th>来源</th><th>更新时间</th><th /></tr></thead><tbody>{rows.map(row => <DocumentTableRow key={row.catalogId} row={row} onOpen={() => void openDetail(row)} />)}</tbody></table></div>
          <div className="mobileList">{rows.map(row => <article className="mobileItem" key={row.catalogId} onClick={() => void openDetail(row)}><div className="mobileItemHeader"><strong>{row.name}</strong><StatusBadge tone={row.scope.kind === 'project' ? 'info' : 'neutral'}>{row.scope.label}</StatusBadge></div><div className="mobileItemBody"><span className="muted">{row.owner?.displayName ?? '未分配'} · {formatBytes(row.bytes)}</span><span className="codeText">{row.catalogId}</span></div></article>)}</div>
        </>}
      </Section>

      <Dialog open={detail !== null || detailLoading} title={detail?.document.name ?? '文档详情'} description="默认仅显示元数据；任何删除或所有权变更都会写入审计日志。" wide onClose={() => { if (!deleteLoading && !ownerSaving) setDetail(null) }} footer={detail === null ? undefined : <><Button type="button" onClick={() => setDeleteOpen(true)} variant="danger" icon={Trash2} disabled={deleteLoading}>删除元数据</Button><Button type="button" onClick={() => setDetail(null)}>关闭</Button></>}>
        {detailLoading || detail === null ? <LoadingState label="正在加载文档详情" /> : <div className="documentDetail"><dl className="definitionGrid"><Definition label="目录 ID"><span className="codeText">{detail.document.catalogId}</span></Definition><Definition label="作用域">{detail.document.scope.label}</Definition><Definition label="文件 ID"><span className="codeText">{detail.document.docId}</span></Definition><Definition label="大小">{formatBytes(detail.document.bytes)}</Definition><Definition label="来源">{detail.document.legacy ? '历史导入' : detail.document.ownerSource}</Definition><Definition label="谱系根">{detail.document.lineageRootId === null ? '当前根文档' : <span className="codeText">{detail.document.lineageRootId}</span>}</Definition></dl><form className="ownershipForm" onSubmit={event => void transferOwner(event)}><Field label="所有者"><select className="select" value={ownerId} onChange={event => setOwnerId(event.target.value)} disabled={ownerSaving}>{users.map(user => <option key={user.id} value={user.id}>{user.displayName}（#{user.id}）</option>)}</select></Field><Button type="submit" variant="secondary" icon={ShieldCheck} loading={ownerSaving}>转移所有权</Button></form><div className="detailDivider" /><h3><History aria-hidden="true" />操作历史</h3>{detail.history.length === 0 ? <p className="muted">暂无历史记录。</p> : <ol className="historyList">{detail.history.map(item => <li key={item.id}><span><strong>{item.eventKind}</strong><small>{item.actor?.displayName ?? '系统'} · {formatTime(item.createdAt)}</small></span><span className="codeText">{item.operationId ?? '—'}</span></li>)}</ol>}<h3><FileText aria-hidden="true" />复制记录</h3>{detail.copies.length === 0 ? <p className="muted">暂无复制记录。</p> : <ul className="historyList">{detail.copies.map((item, index) => <li key={`${item.operationId}-${String(index)}`}><span><strong>{item.status}</strong><small>{item.source.name} → {item.targetDocId ?? '未生成'} · {formatTime(item.createdAt)}</small></span><span className="codeText">{item.operationId}</span></li>)}</ul>}</div>}
      </Dialog>
      <Dialog open={deleteOpen} title="确认删除文档元数据" description="该操作会隐藏文档目录记录并写入审计日志，不会尝试读取或复制文件内容。" danger onClose={() => { if (!deleteLoading) setDeleteOpen(false) }} footer={<><Button type="button" onClick={() => setDeleteOpen(false)} disabled={deleteLoading}>取消</Button><Button type="button" variant="danger" loading={deleteLoading} onClick={() => void remove()}>确认删除</Button></>} />
    </div>
  )
}

function DocumentTableRow({ row, onOpen }: { row: AdminDocument; onOpen: () => void }) {
  return <tr><td><button className="tableLink" type="button" onClick={onOpen}><span className="documentIdentity"><FileText aria-hidden="true" /><strong>{row.name}</strong><small>{row.docId}</small></span></button></td><td><StatusBadge tone={row.scope.kind === 'project' ? 'info' : 'neutral'}>{row.scope.label}</StatusBadge></td><td>{row.owner?.displayName ?? <span className="muted">未分配</span>}</td><td>{formatBytes(row.bytes)}</td><td><StatusBadge tone={row.state === 'active' ? 'success' : 'danger'}>{row.state === 'active' ? '活跃' : '已删除'}</StatusBadge></td><td>{row.legacy ? '历史导入' : row.ownerSource}</td><td>{formatTime(row.modifiedAt)}</td><td><IconButton label="查看详情" icon={ShieldCheck} variant="secondary" onClick={onOpen} /></td></tr>
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) { return <div className="metricCard"><span>{label}</span><strong className={tone === undefined ? '' : 'metricWarning'}>{value}</strong></div> }
function Definition({ label, children }: { label: string; children: React.ReactNode }) { return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div> }
function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`; return `${(bytes / 1024 ** 3).toFixed(1)} GB` }
function formatTime(timestamp: number): string { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp) }
function messageFrom(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
