import { DesktopPermissions } from '../components/DesktopPermissions.tsx'
import { Ban, Monitor, RefreshCw, ShieldOff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  applyDesktopAction,
  desktopHolderOf,
  getDesktopDetail,
  listDesktops,
  type AdminDesktopDetail,
  type AdminDesktopGrant,
  type AdminDesktopQueueEntry,
  type AdminDesktopResource,
} from '../api.ts'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  IconButton,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
} from '../components/ui.tsx'

type ConfirmState =
  | { kind: 'revoke'; grant: AdminDesktopGrant }
  | { kind: 'clear'; resource: AdminDesktopResource }

/** Interactive-desktop grant and queue supervision for administrators. */
export function DesktopsPage() {
  const [rows, setRows] = useState<AdminDesktopResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<AdminDesktopResource | null>(null)
  const [detail, setDetail] = useState<AdminDesktopDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [acting, setActing] = useState(false)

  const reload = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    try {
      const result = await listDesktops()
      setRows(result.resources)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  const openDetail = useCallback(async (resource: AdminDesktopResource) => {
    setSelected(resource)
    setDetailLoading(true)
    try {
      setDetail(await getDesktopDetail(resource.node, resource.desktop))
      setError('')
    } catch (cause) {
      setDetail(null)
      setError(messageFrom(cause))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  async function runAction(): Promise<void> {
    if (confirm === null) return
    setActing(true)
    try {
      if (confirm.kind === 'revoke') {
        await applyDesktopAction('revoke', { grantId: confirm.grant.grantId })
      } else {
        await applyDesktopAction('clear', { node: confirm.resource.node, desktop: confirm.resource.desktop })
      }
      setConfirm(null)
      await reload(false)
      if (selected !== null) await openDetail(selected)
    } catch (cause) {
      setError(messageFrom(cause))
      setConfirm(null)
    } finally {
      setActing(false)
    }
  }

  const activeGrants = detail?.grants.filter(grant => grant.state !== 'released') ?? []
  const liveQueue = detail?.queue.filter(entry => entry.state === 'queued') ?? []

  return (
    <div className="page">
      <PageHeader
        title="桌面协调"
        description="查看交互桌面的独占授权、FIFO 排队与失联恢复状态。"
        meta={`${rows.length} 个资源`}
      />
      <DesktopPermissions />
      <ErrorBanner message={error} />
      <Section
        title="桌面资源"
        meta={<IconButton label="刷新" icon={RefreshCw} variant="secondary" onClick={() => void reload()} />}
      >
        {loading ? <LoadingState label="正在加载桌面资源" /> : rows.length === 0 ? (
          <EmptyState icon={Monitor} title="没有桌面资源" detail="尚无运行时申请交互桌面授权。" />
        ) : (
          <>
            <div className="tableWrap desktopOnly">
              <table className="dataTable">
                <thead><tr><th>节点</th><th>桌面</th><th>状态</th><th>栅栏序号</th><th>更新时间</th><th /></tr></thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.resourceKey}>
                      <td><span className="codeText">{row.node}</span></td>
                      <td><span className="codeText">{row.desktop}</span></td>
                      <td><ResourceState state={row.state} note={row.stateNote} /></td>
                      <td><span className="codeText">{row.fencingSeq}</span></td>
                      <td><time dateTime={new Date(row.updatedAt).toISOString()}>{formatTime(row.updatedAt)}</time></td>
                      <td><Button type="button" variant="secondary" onClick={() => void openDetail(row)}>详情</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobileList">
              {rows.map(row => (
                <article className="mobileItem" key={row.resourceKey}>
                  <div className="mobileItemHeader">
                    <span className="codeText">{row.resourceKey}</span>
                    <ResourceState state={row.state} note={row.stateNote} />
                  </div>
                  <div className="mobileItemBody">
                    <dl className="definitionGrid">
                      <Definition label="栅栏序号"><span className="codeText">{row.fencingSeq}</span></Definition>
                      <Definition label="更新时间">{formatTime(row.updatedAt)}</Definition>
                    </dl>
                    <Button type="button" variant="secondary" onClick={() => void openDetail(row)}>详情</Button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </Section>
      {selected === null ? null : (
        <Section title={`授权与排队 · ${selected.resourceKey}`} meta={detailLoading ? '加载中' : `${activeGrants.length} 项授权 / ${liveQueue.length} 项排队`}>
          {detailLoading ? <LoadingState label="正在加载桌面详情" /> : detail === null ? (
            <EmptyState icon={Monitor} title="无法读取详情" detail="桌面资源可能已被清理。" />
          ) : (
            <>
              {detail.resource?.state === 'unavailable' ? (
                <div className="filterActions">
                  <Button type="button" variant="danger" icon={ShieldOff} onClick={() => setConfirm({ kind: 'clear', resource: detail.resource! })}>清理不可用状态</Button>
                  {detail.resource.stateNote === null ? null : <span className="muted">{detail.resource.stateNote}</span>}
                </div>
              ) : null}
              <div className="tableWrap">
                <table className="dataTable">
                  <thead><tr><th>持有人</th><th>运行时</th><th>状态</th><th>栅栏</th><th>心跳</th><th>获取时间</th><th /></tr></thead>
                  <tbody>
                    {detail.grants.length === 0 ? (
                      <tr><td colSpan={7}><span className="muted">没有授权记录。</span></td></tr>
                    ) : detail.grants.map(grant => (
                      <tr key={grant.grantId}>
                        <td><HolderLabel holderJson={grant.holderJson} /></td>
                        <td><RuntimeLabel holderJson={grant.holderJson} /></td>
                        <td><GrantState grant={grant} /></td>
                        <td><span className="codeText">{grant.fencing}</span></td>
                        <td><time dateTime={new Date(grant.heartbeatAt).toISOString()}>{formatTime(grant.heartbeatAt)}</time></td>
                        <td><time dateTime={new Date(grant.acquiredAt).toISOString()}>{formatTime(grant.acquiredAt)}</time></td>
                        <td>{grant.state === 'held' ? (
                          <Button type="button" variant="secondary" icon={Ban} onClick={() => setConfirm({ kind: 'revoke', grant })}>撤权</Button>
                        ) : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {detail.queue.length === 0 ? null : (
                <div className="tableWrap">
                  <table className="dataTable">
                    <thead><tr><th>位次</th><th>持有人</th><th>运行时</th><th>状态</th><th>入队时间</th></tr></thead>
                    <tbody>
                      {detail.queue.map(entry => (
                        <tr key={entry.queueId}>
                          <td><span className="codeText">{entry.position}</span></td>
                          <td><HolderLabel holderJson={entry.holderJson} /></td>
                          <td><RuntimeLabel holderJson={entry.holderJson} /></td>
                          <td><QueueState entry={entry} /></td>
                          <td><time dateTime={new Date(entry.queuedAt).toISOString()}>{formatTime(entry.queuedAt)}</time></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Section>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'revoke' ? '撤权桌面授权' : '清理不可用桌面'}
        description={confirm?.kind === 'revoke'
          ? '授权进入停止流程，持有人需在时限内确认输入已排空。操作会写入审计日志。'
          : '强制释放无法确认的授权并恢复桌面可用，队首请求会被提升。操作会写入审计日志。'}
        confirmLabel={confirm?.kind === 'revoke' ? '撤权' : '清理'}
        pending={acting}
        onConfirm={() => { void runAction() }}
        onClose={() => { if (!acting) setConfirm(null) }}
      />
    </div>
  )
}

function HolderLabel({ holderJson }: { holderJson: string }) {
  const holder = desktopHolderOf({ holderJson })
  if (holder === undefined) return <span className="muted">未知</span>
  return <span className="auditAction"><strong>{holder.user.username}</strong><span>#{holder.user.id}</span></span>
}

function RuntimeLabel({ holderJson }: { holderJson: string }) {
  const holder = desktopHolderOf({ holderJson })
  if (holder === undefined) return <span className="muted">—</span>
  const kind = holder.runtime.kind === 'user' ? '个人' : '项目'
  return <span className="codeText">{kind} {holder.runtime.id} · 代次 {holder.runtime.generation}</span>
}

function ResourceState({ state, note }: { state: AdminDesktopResource['state']; note: string | null }) {
  return state === 'available'
    ? <StatusBadge tone="success">可用</StatusBadge>
    : <StatusBadge tone="danger" >不可用{note === null ? '' : ` · ${note}`}</StatusBadge>
}

function GrantState({ grant }: { grant: AdminDesktopGrant }) {
  switch (grant.state) {
    case 'held': return <StatusBadge tone="success">持有中</StatusBadge>
    case 'stopping': return <StatusBadge tone="warning">停止中{grant.reason === 'revoked' ? ' · 已撤权' : ''}</StatusBadge>
    case 'pending-confirm': return <StatusBadge tone="danger">待确认</StatusBadge>
    case 'released': return <StatusBadge>已释放</StatusBadge>
  }
}

function QueueState({ entry }: { entry: AdminDesktopQueueEntry }) {
  switch (entry.state) {
    case 'queued': return <StatusBadge tone="info">排队中</StatusBadge>
    case 'promoted': return <StatusBadge tone="success">已提升</StatusBadge>
    case 'cancelled': return <StatusBadge>已取消</StatusBadge>
    case 'expired': return <StatusBadge tone="warning">已过期</StatusBadge>
  }
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
