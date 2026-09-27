/** Deployment control: maintenance windows, node convergence, backups, restore requests, and the operation ledger. */
import { useCallback, useEffect, useState } from 'react'
import { DatabaseBackup, HardDriveDownload, RefreshCw, ShieldCheck, Wrench } from 'lucide-react'
import {
  createBackup, getDeployment, listBackups, requestDeploymentRestore, setDeploymentNodeStatus,
  setMaintenance, verifyBackup,
  type DeploymentBackup, type DeploymentNode, type DeploymentState,
} from '../api.ts'
import {
  Button, ConfirmDialog, EmptyState, ErrorBanner, Field, IconButton, LoadingState,
  PageHeader, Section, StatusBadge,
} from '../components/ui.tsx'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : '无法完成部署操作'

const MODE_LABEL: Record<DeploymentState['mode'], { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  serving: { label: '服务中', tone: 'success' },
  maintenance: { label: '维护窗口', tone: 'warning' },
  restoring: { label: '恢复中', tone: 'danger' },
}

const NODE_STATUS_LABEL: Record<DeploymentNode['status'], { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  active: { label: '在线', tone: 'success' },
  draining: { label: '排空中', tone: 'warning' },
  offline: { label: '离线', tone: 'neutral' },
}

const BACKUP_STATUS_LABEL: Record<DeploymentBackup['status'], { label: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }> = {
  recording: { label: '记录中', tone: 'info' },
  verified: { label: '已验证', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  restored: { label: '已用于恢复', tone: 'warning' },
}

function heartbeatText(node: DeploymentNode): string {
  if (node.lastHeartbeatAt === null) return '从未心跳'
  if (node.heartbeatAgeMs === null) return node.lastHeartbeatAt
  if (node.heartbeatAgeMs < 60_000) return `${String(Math.round(node.heartbeatAgeMs / 1000))} 秒前`
  return `${String(Math.round(node.heartbeatAgeMs / 60_000))} 分钟前`
}

export function DeploymentPage() {
  const [state, setState] = useState<DeploymentState | null>(null)
  const [backups, setBackups] = useState<DeploymentBackup[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reason, setReason] = useState('')
  const [acting, setActing] = useState(false)
  const [restoring, setRestoring] = useState<DeploymentBackup | null>(null)
  const [exiting, setExiting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [next, list] = await Promise.all([getDeployment(), listBackups()])
      setState(next)
      setBackups(list.backups)
      setError('')
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 10_000)
    return () => { clearInterval(timer) }
  }, [refresh])

  const run = async (work: () => Promise<unknown>, ok: string) => {
    setActing(true)
    setError('')
    setNotice('')
    try {
      await work()
      setNotice(ok)
      await refresh()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setActing(false)
    }
  }

  const mode = state === null ? null : MODE_LABEL[state.mode]

  return (
    <div>
      <PageHeader
        title="部署与迁移"
        description="维护窗口协调全部写者收敛后再执行迁移或恢复；恢复完成会推进写纪元，使恢复前启动的进程自动停止写入。"
        actions={<IconButton label="刷新" icon={RefreshCw} onClick={() => void refresh()} />}
      />
      <ErrorBanner message={error} />
      {notice === '' ? null : <p role="status">{notice}</p>}

      <Section title="集群状态" meta={state === null ? undefined : `写纪元 ${state.writeEpoch}`}>
        {state === null || mode === null ? <LoadingState label="正在加载集群状态" /> : (
          <div className="deploymentStatus">
            <div className="statusRow">
              <StatusBadge tone={mode.tone}>{mode.label}</StatusBadge>
              <StatusBadge tone={state.writersQuiesced ? 'success' : 'warning'}>
                {state.writersQuiesced ? '写者已收敛' : '写者未收敛'}
              </StatusBadge>
              <span className="sectionMeta">维护纪元 {state.maintenanceEpoch}</span>
            </div>
            {state.reason === null ? null : <p>维护事由：{state.reason}</p>}
            {state.mode === 'serving' ? (
              <div className="formGrid">
                <Field label="维护事由" hint="记录到控制行与操作台账；进入维护后变更请求返回 503。">
                  <input className="input" value={reason} onChange={event => { setReason(event.target.value) }} placeholder="例如：应用 v40→v41 迁移" />
                </Field>
                <div>
                  <Button variant="primary" icon={Wrench} disabled={acting}
                    onClick={() => void run(() => setMaintenance('enter', reason.trim() === '' ? undefined : reason.trim()), '已进入维护窗口')}>
                    进入维护窗口
                  </Button>
                </div>
              </div>
            ) : (
              <div className="statusRow">
                {state.mode === 'maintenance' ? (
                  <Button variant="primary" disabled={acting} onClick={() => { setExiting(true) }}>退出维护窗口</Button>
                ) : (
                  <p>恢复进行中：写者保持拒绝，等待独立应用器完成。</p>
                )}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="计算节点" meta="写者收敛要求每个活跃节点心跳新鲜、已确认维护纪元且在途写者归零">
        {state === null ? null : state.nodes.length === 0 ? <EmptyState title="没有登记节点" /> : (
          <table className="dataTable">
            <thead><tr><th>名称</th><th>状态</th><th>心跳</th><th>已确认纪元</th><th>在途写者</th><th>收敛</th><th>操作</th></tr></thead>
            <tbody>
              {state.nodes.map(node => (
                <tr key={node.nodeId}>
                  <td><code>{node.name}</code></td>
                  <td><StatusBadge tone={NODE_STATUS_LABEL[node.status].tone}>{NODE_STATUS_LABEL[node.status].label}</StatusBadge></td>
                  <td>{heartbeatText(node)}</td>
                  <td>{node.maintenanceAppliedEpoch}</td>
                  <td>{node.inflightWrites < 0 ? '未上报' : node.inflightWrites}</td>
                  <td>{node.quiesced ? '是' : '否'}</td>
                  <td>
                    {node.status === 'active' ? (
                      <Button variant="ghost" disabled={acting}
                        onClick={() => void run(() => setDeploymentNodeStatus(node.nodeId, 'draining'), `节点 ${node.name} 已排空`)}>排空</Button>
                    ) : null}
                    {node.status === 'draining' ? (
                      <Button variant="ghost" disabled={acting}
                        onClick={() => void run(() => setDeploymentNodeStatus(node.nodeId, 'active'), `节点 ${node.name} 已恢复`)}>恢复在线</Button>
                    ) : null}
                    {node.status !== 'offline' ? (
                      <Button variant="ghost" disabled={acting}
                        onClick={() => void run(() => setDeploymentNodeStatus(node.nodeId, 'offline'), `节点 ${node.name} 已标记离线`)}>标记离线</Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="数据库迁移" meta="由独立应用器 pg:deploy apply 在维护窗口内执行">
        {state === null ? null : state.migrations === null ? <EmptyState title="迁移目录不可用" /> : (
          <div>
            <p>当前版本 {state.migrations.current}，已应用 {state.migrations.applied.length} 个迁移。</p>
            {state.migrations.drifted.length === 0 ? null : (
              <ErrorBanner message={`已应用迁移与打包文件不一致：${state.migrations.drifted.join('、')}。先核对发布内容再继续。`} />
            )}
            {state.migrations.pending.length === 0 ? <p>没有待应用的迁移。</p> : (
              <p>待应用：{state.migrations.pending.map(migration => migration.name).join('、')}</p>
            )}
          </div>
        )}
      </Section>

      <Section
        title="备份"
        meta="数据库转储与受管文件快照"
        actions={<Button icon={DatabaseBackup} disabled={acting}
          onClick={() => void run(async () => { await createBackup() }, '备份已完成并通过校验')}>立即备份</Button>}
      >
        {backups === null ? <LoadingState label="正在加载备份" /> : backups.length === 0 ? (
          <EmptyState title="尚无备份" detail="备份记录登记每次转储的迁移版本、写纪元与受管文件清单，供恢复时核对。" />
        ) : (
          <table className="dataTable">
            <thead><tr><th>路径</th><th>迁移版本</th><th>写纪元</th><th>大小</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody>
              {backups.map(backup => (
                <tr key={backup.id}>
                  <td><code>{backup.path}</code></td>
                  <td>{backup.migrationVersion}</td>
                  <td>{backup.writeEpoch}</td>
                  <td>{backup.sizeBytes === null ? '—' : `${String(Math.round(backup.sizeBytes / 1024))} KiB`}</td>
                  <td><StatusBadge tone={BACKUP_STATUS_LABEL[backup.status].tone}>{BACKUP_STATUS_LABEL[backup.status].label}</StatusBadge></td>
                  <td>{backup.createdAt}</td>
                  <td>
                    <IconButton label="校验" icon={ShieldCheck} disabled={acting}
                      onClick={() => void run(() => verifyBackup(backup.id), '校验完成')} />
                    {backup.status === 'verified' || backup.status === 'restored' ? (
                      <Button variant="ghost" icon={HardDriveDownload} disabled={acting || state?.mode === 'restoring'}
                        onClick={() => { setRestoring(backup) }}>请求恢复</Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="操作台账" meta="最近的部署操作">
        {state === null ? null : state.operations.length === 0 ? <EmptyState title="尚无部署操作" /> : (
          <table className="dataTable">
            <thead><tr><th>类型</th><th>状态</th><th>节点</th><th>创建时间</th><th>完成时间</th><th>错误</th></tr></thead>
            <tbody>
              {state.operations.map(operation => (
                <tr key={operation.id}>
                  <td><code>{operation.kind}</code></td>
                  <td><code>{operation.status}</code></td>
                  <td>{operation.nodeName ?? '—'}</td>
                  <td>{operation.createdAt}</td>
                  <td>{operation.finishedAt ?? '—'}</td>
                  <td>{operation.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <ConfirmDialog
        open={restoring !== null}
        title="请求恢复备份"
        description="登记一条待执行的恢复请求；独立应用器在维护窗口内认领执行：pg:deploy restore。恢复完成后写纪元推进，恢复前启动的进程必须重启。"
        confirmLabel="登记恢复请求"
        pending={acting}
        onClose={() => { setRestoring(null) }}
        onConfirm={() => {
          const backup = restoring
          setRestoring(null)
          if (backup === null) return
          void run(() => requestDeploymentRestore(backup.id), '恢复请求已登记；请进入维护窗口并运行 pg:deploy restore')
        }}
      />
      <ConfirmDialog
        open={exiting}
        title="退出维护窗口"
        description="退出后变更请求恢复受理。确认迁移或恢复已验证完成。"
        confirmLabel="退出维护"
        pending={acting}
        onClose={() => { setExiting(false) }}
        onConfirm={() => {
          setExiting(false)
          void run(() => setMaintenance('exit'), '已退出维护窗口')
        }}
      />
    </div>
  )
}
