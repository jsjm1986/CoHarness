import { ChevronLeft, ChevronRight, Filter, RotateCcw, ScrollText } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { listAudit, type AuditEntry, type AuditFilter } from '../api.ts'
import {
  Button,
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

type FilterDraft = {
  userId: string
  actionPrefix: string
  from: string
  to: string
}

const EMPTY_FILTER: FilterDraft = { userId: '', actionPrefix: '', from: '', to: '' }

function msFromDatetimeLocal(value: string): number | undefined {
  if (value === '') return undefined
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

export function AuditPage() {
  const [rows, setRows] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_FILTER)
  const [activeFilter, setActiveFilter] = useState<FilterDraft>(EMPTY_FILTER)
  const [offset, setOffset] = useState(0)

  const fetchPage = useCallback(async (filter: FilterDraft, nextOffset: number, showLoading = true) => {
    const parsedUserId = filter.userId === '' ? undefined : Number(filter.userId)
    if (parsedUserId !== undefined && (!Number.isInteger(parsedUserId) || parsedUserId <= 0)) {
      setError('用户 ID 必须是正整数')
      return
    }
    const apiFilter: AuditFilter = {
      userId: parsedUserId,
      actionPrefix: filter.actionPrefix === '' ? undefined : filter.actionPrefix,
      from: msFromDatetimeLocal(filter.from),
      to: msFromDatetimeLocal(filter.to),
      limit: PAGE_SIZE,
      offset: nextOffset,
    }
    if (showLoading) setLoading(true)
    try {
      setRows(await listAudit(apiFilter))
      setOffset(nextOffset)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchPage(EMPTY_FILTER, 0) }, [fetchPage])

  function onFilter(event: FormEvent) {
    event.preventDefault()
    setActiveFilter(draft)
    void fetchPage(draft, 0)
  }

  function resetFilters() {
    setDraft(EMPTY_FILTER)
    setActiveFilter(EMPTY_FILTER)
    void fetchPage(EMPTY_FILTER, 0)
  }

  const hasFilters = Object.values(activeFilter).some(value => value !== '')
  const page = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <div className="page">
      <PageHeader
        title="审计日志"
        description="检索管理操作、认证事件、模型拒绝和网关请求结果。"
        meta={hasFilters ? '已筛选' : undefined}
      />
      <ErrorBanner message={error} />
      <Section title="筛选条件">
        <form className="filterPanel" onSubmit={onFilter}>
          <div className="filterGrid">
            <Field label="用户 ID">
              <input className="input" value={draft.userId} onChange={event => setDraft({ ...draft, userId: event.target.value })} placeholder="全部用户" inputMode="numeric" />
            </Field>
            <Field label="操作前缀">
              <input className="input codeText" value={draft.actionPrefix} onChange={event => setDraft({ ...draft, actionPrefix: event.target.value })} placeholder="例如 admin." />
            </Field>
            <Field label="开始时间">
              <input className="input" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} type="datetime-local" />
            </Field>
            <Field label="结束时间">
              <input className="input" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} type="datetime-local" />
            </Field>
          </div>
          <div className="filterActions">
            <Button type="button" icon={RotateCcw} onClick={resetFilters} disabled={!Object.values(draft).some(value => value !== '') && !hasFilters}>重置</Button>
            <Button type="submit" variant="primary" icon={Filter}>应用筛选</Button>
          </div>
        </form>
      </Section>
      <Section className="responsiveSection" title="事件记录" meta={loading ? undefined : `第 ${page} 页`}>
        {loading ? <LoadingState label="正在加载审计日志" /> : rows.length === 0 ? (
          <EmptyState icon={ScrollText} title="没有匹配的记录" detail={hasFilters ? '调整筛选条件后重试。' : '网关尚未写入审计事件。'} />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable auditTable">
                <thead><tr><th>时间</th><th>用户</th><th>操作</th><th>请求</th><th>请求结果</th><th>对象与执行信息</th><th>来源 IP</th></tr></thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.id}>
                      <td><time className="auditTime" dateTime={new Date(row.ts).toISOString()}>{formatTime(row.ts)}</time></td>
                      <td>{row.userId === null ? <span className="muted">系统</span> : <span className="codeText">#{row.userId}</span>}</td>
                      <td><span className="auditAction"><strong>{row.action}</strong><span>ID {row.id}</span></span></td>
                      <td><span className="pathText">{row.methodPath}</span></td>
                      <td><RequestResult row={row} /></td>
                      <td><AuditMetadata metadata={row.metadata} /></td>
                      <td><span className="codeText">{row.ip}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobileList">
              {rows.map(row => (
                <article className="mobileItem" key={row.id}>
                  <div className="mobileItemHeader">
                    <span className="auditAction"><strong>{row.action}</strong><span>{formatTime(row.ts)}</span></span>
                    <RequestResult row={row} />
                  </div>
                  <div className="mobileItemBody">
                    <span className="pathText">{row.methodPath}</span>
                    <dl className="definitionGrid">
                      <Definition label="用户">{row.userId === null ? '系统' : `#${row.userId}`}</Definition>
                      <Definition label="来源 IP"><span className="codeText">{row.ip}</span></Definition>
                    </dl>
                    <AuditMetadata metadata={row.metadata} />
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
        {loading || (rows.length === 0 && offset === 0) ? null : (
          <div className="pagination">
            <span>第 {page} 页</span>
            <IconButton label="上一页" icon={ChevronLeft} variant="secondary" disabled={offset === 0} onClick={() => void fetchPage(activeFilter, Math.max(0, offset - PAGE_SIZE))} />
            <IconButton label="下一页" icon={ChevronRight} variant="secondary" disabled={rows.length < PAGE_SIZE} onClick={() => void fetchPage(activeFilter, offset + PAGE_SIZE)} />
          </div>
        )}
      </Section>
    </div>
  )
}

const RESULT_LABELS = { success: '请求成功', failure: '请求失败', recorded: '已记录', unknown: '结果未知' } as const

function RequestResult({ row }: { row: AuditEntry }) {
  const tone = row.outcome === 'failure' ? 'danger' : row.outcome === 'success' ? 'success' : 'neutral'
  return <StatusBadge tone={tone}>{RESULT_LABELS[row.outcome]}{row.status === null ? '' : ` · HTTP ${row.status}`}</StatusBadge>
}

const METADATA_LABELS: Record<string, string> = {
  id: '对象 ID', targetId: '目标 ID', targetKind: '目标类型', userId: '用户 ID', ownerUserId: '所有者 ID',
  projectId: '项目 ID', nodeId: '节点 ID', catalogId: '文档 ID', rootSessionId: '根会话', sessionId: '会话',
  grantId: '授权 ID', backupId: '备份 ID', operationId: '操作 ID', receiptId: '原回执', redispatchId: '重派回执',
  subjectId: '配额对象 ID', subjectType: '配额对象类型', revision: '配置代次', generation: '实例代次',
  count: '数量', requested: '请求数量', succeeded: '成功数量', trashed: '回收数量', opCount: '配置操作数',
  allowed: '允许', shared: '共享', enabled: '启用', autoReviewEligible: 'Auto 资格', terminalEnabled: '终端资格',
  sshEligible: 'SSH 资格', desktopEligible: '桌面资格', status: '对象状态', state: '执行状态', mode: '访问模式', role: '角色', action: '动作',
}

function AuditMetadata({ metadata }: Pick<AuditEntry, 'metadata'>) {
  const entries = Object.entries(metadata)
  if (entries.length === 0) return <span className="muted">无附加信息</span>
  return <dl className="definitionGrid">{entries.map(([key, value]) => (
    <Definition key={key} label={METADATA_LABELS[key] ?? key}>{typeof value === 'boolean' ? value ? '是' : '否' : String(value)}</Definition>
  ))}</dl>
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="definitionRow"><dt>{label}</dt><dd>{children}</dd></div>
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp)
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
