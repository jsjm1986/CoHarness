/** Terminal qualification and metadata-only process supervision on the current node. */
import { useEffect, useRef, useState } from 'react'
import { TerminalPermissions } from '../components/TerminalPermissions.tsx'
import { Button, ConfirmDialog, ErrorBanner, Field, LoadingState, PageHeader, Section, StatusBadge } from '../components/ui.tsx'
import { closeTerminal, listTerminals, listUsers, listProjects, type AdminTerminal, type AdminTerminalInventory } from '../api.ts'

const labels: Record<AdminTerminal['state'], string> = { starting: '正在启动', running: '运行中', exited: '已退出', failed: '失败', stopping: '正在清理' }
type Target = { kind: 'user' | 'project'; id: number; label: string }
const keyOf = (target: Target) => `${target.kind}:${String(target.id)}`
const messageOf = (error: unknown) => error instanceof Error ? error.message : '无法读取终端'

export function TerminalsPage() {
  const [targets, setTargets] = useState<Target[]>([])
  const [selected, setSelected] = useState('')
  const [inventory, setInventory] = useState<AdminTerminalInventory | null>(null)
  const [confirm, setConfirm] = useState<AdminTerminal | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState(false)
  const [reload, setReload] = useState(0)
  const [ownerReload, setOwnerReload] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    let disposed = false
    void Promise.all([listUsers(), listProjects()]).then(([users, projects]) => {
      if (disposed) return
      setTargets([...users.map(user => ({ kind: 'user' as const, id: user.id, label: `用户 · ${user.displayName} (@${user.username})` })),
        ...projects.map(project => ({ kind: 'project' as const, id: project.id, label: `项目 · ${project.name}` }))])
      setError('')
    }).catch((error: unknown) => { if (!disposed) setError(messageOf(error)) })
    return () => { disposed = true; generation.current++ }
  }, [ownerReload])

  useEffect(() => {
    const target = targets.find(item => keyOf(item) === selected)
    if (target === undefined) return
    const attempt = ++generation.current, controller = new AbortController()
    setLoading(true)
    void listTerminals(target.kind, target.id, controller.signal).then(value => {
      if (attempt !== generation.current) return
      if (value.target.kind !== target.kind || value.target.id !== target.id) throw new Error('终端清单与选中范围不一致，请重新读取')
      setInventory(value); setError('')
    }).catch(error => { if (attempt === generation.current) { setInventory(null); setError(messageOf(error)) } })
      .finally(() => { if (attempt === generation.current) setLoading(false) })
    return () => { generation.current++; controller.abort() }
  }, [targets, selected, reload])

  async function close(): Promise<void> {
    if (confirm === null || inventory === null || acting || loading || `${inventory.target.kind}:${String(inventory.target.id)}` !== selected) return
    const attempt = generation.current
    setActing(true); setError(''); setNotice('')
    try {
      await closeTerminal(inventory, confirm)
      if (attempt !== generation.current) return
      setNotice('进程已完成清理。'); setConfirm(null); setInventory(null); setReload(value => value + 1)
    } catch (error) {
      if (attempt === generation.current) { setConfirm(null); setError(`${messageOf(error)}。尚未确认清理完成，请重新读取后重试。`) }
    } finally { if (attempt === generation.current) setActing(false) }
  }

  return <div className="page">
    <PageHeader title="终端" description="管理准入资格，查看当前节点上的终端并明确关闭。管理员不能读取或输入他人的终端。" />
    <TerminalPermissions />
    <Section title="终端进程">
      <div className="sectionBody">
      <ErrorBanner message={error} />
      <div className="formGrid">
      <Field label="运行范围"><select className="select" aria-label="终端运行范围" value={selected} disabled={acting} onChange={event => {
        generation.current++; setSelected(event.target.value); setInventory(null); setConfirm(null); setLoading(false); setError(''); setNotice('')
      }}>
        <option value="">请选择用户或项目</option>
        {targets.map(target => <option key={keyOf(target)} value={keyOf(target)}>{target.label}</option>)}
      </select></Field>
      <div className="formActions">
      {targets.length === 0 ? <Button onClick={() => setOwnerReload(value => value + 1)}>重新加载运行范围</Button> : null}
      {selected === '' ? null : <Button disabled={acting || loading} onClick={() => { setInventory(null); setConfirm(null); setNotice(''); setReload(value => value + 1) }}>刷新终端清单</Button>}
      </div>
      </div>
      {loading ? <LoadingState label="正在读取终端清单" /> : null}
      {inventory === null ? null : <>
        <p className="muted">节点 {inventory.nodeId} · {inventory.generation === null ? '实例未运行；读取清单不会启动实例。' : `实例代次 ${String(inventory.generation)}`}</p>
        {inventory.terminals.length === 0 ? <p>没有保留的终端。</p> : <div className="tableWrap"><table className="dataTable" aria-label="终端进程">
          <thead><tr><th>终端</th><th>会话</th><th>创建者</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>{inventory.terminals.map(entry => <tr key={`${entry.ownerId}:${entry.id}`}>
            <td className="terminalIdentity">{entry.id}</td><td className="terminalIdentity">{entry.sessionId}</td><td>{entry.creatorUserId === undefined ? '本机操作者' : `用户 #${String(entry.creatorUserId)}`}</td><td><StatusBadge tone={entry.state === 'running' ? 'success' : entry.state === 'failed' ? 'danger' : 'neutral'}>{labels[entry.state]}</StatusBadge></td>
            <td><Button variant="danger" disabled={acting || loading} onClick={() => setConfirm(entry)}>{entry.state === 'stopping' ? '重试清理' : '关闭终端'}</Button></td>
          </tr>)}</tbody>
        </table></div>}
      </>}
      {notice === '' ? null : <p role="status">{notice}</p>}
      </div>
    </Section>
    <ConfirmDialog open={confirm !== null} title="关闭终端" description={`将终止终端 ${confirm?.id ?? ''} 及其所属进程；运行中的命令会中断。隐藏标签不会执行此操作。`}
      confirmLabel="确认关闭" pending={acting} onConfirm={() => void close()} onClose={() => { if (!acting) setConfirm(null) }} />
  </div>
}
