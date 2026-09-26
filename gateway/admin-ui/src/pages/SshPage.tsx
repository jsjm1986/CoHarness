/** Registered SSH targets, project sharing, and account qualification. */
import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, RefreshCw, Share2, Trash2 } from 'lucide-react'
import {
  createSshTarget, listProjects, listSshTargets, mutateSshTarget, shareSshTarget, updateSshTarget,
  type AdminSshTarget, type AdminSshTargetFields,
} from '../api.ts'
import {
  Button, ConfirmDialog, Dialog, EmptyState, ErrorBanner, Field, IconButton, LoadingState,
  PageHeader, Section, StatusBadge, Switch,
} from '../components/ui.tsx'
import { SshPermissions } from '../components/SshPermissions.tsx'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : '无法完成 SSH 操作'
const HASH_PATTERN = /^[0-9a-f]{64}$/u

interface TargetDraft {
  name: string
  host: string
  node: string
  helper: string
  helperHash: string
  workspace: string
  bootstrapPath: string
  bootstrapHash: string
  requestTimeoutMs: string
  maxFrameBytes: string
  maxPending: string
  leaseMs: string
}

const EMPTY_DRAFT: TargetDraft = {
  name: '', host: '', node: '', helper: '', helperHash: '', workspace: '',
  bootstrapPath: '', bootstrapHash: '', requestTimeoutMs: '', maxFrameBytes: '', maxPending: '', leaseMs: '',
}

function draftOf(target: AdminSshTarget): TargetDraft {
  return {
    name: target.name, host: target.host, node: target.node, helper: target.helper,
    helperHash: target.helperHash, workspace: target.workspace,
    bootstrapPath: target.bootstrapPath ?? '', bootstrapHash: target.bootstrapHash ?? '',
    requestTimeoutMs: target.requestTimeoutMs === null ? '' : String(target.requestTimeoutMs),
    maxFrameBytes: target.maxFrameBytes === null ? '' : String(target.maxFrameBytes),
    maxPending: target.maxPending === null ? '' : String(target.maxPending),
    leaseMs: target.leaseMs === null ? '' : String(target.leaseMs),
  }
}

const text = (value: string) => value.trim() === '' ? null : value.trim()
const limit = (value: string) => {
  if (value.trim() === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('数值字段必须是正整数')
  return parsed
}

function fieldsOf(draft: TargetDraft): AdminSshTargetFields {
  const bootstrapPath = text(draft.bootstrapPath)
  const bootstrapHash = text(draft.bootstrapHash)
  if ((bootstrapPath === null) !== (bootstrapHash === null)) throw new Error('PTC 引导路径与摘要必须同时填写')
  if (!HASH_PATTERN.test(draft.helperHash.trim())) throw new Error('助手摘要必须是 64 位小写十六进制')
  if (bootstrapHash !== null && !HASH_PATTERN.test(bootstrapHash)) throw new Error('引导摘要必须是 64 位小写十六进制')
  return {
    name: draft.name.trim(), host: draft.host.trim(), node: draft.node.trim(), helper: draft.helper.trim(),
    helperHash: draft.helperHash.trim(), workspace: draft.workspace.trim(),
    bootstrapPath, bootstrapHash,
    requestTimeoutMs: limit(draft.requestTimeoutMs), maxFrameBytes: limit(draft.maxFrameBytes),
    maxPending: limit(draft.maxPending), leaseMs: limit(draft.leaseMs),
  }
}

export function SshPage() {
  const [targets, setTargets] = useState<AdminSshTarget[] | null>(null)
  const [projects, setProjects] = useState<Array<{ id: number; name: string }>>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<{ target: AdminSshTarget | null; draft: TargetDraft } | null>(null)
  const [removing, setRemoving] = useState<AdminSshTarget | null>(null)
  const [sharing, setSharing] = useState<AdminSshTarget | null>(null)
  const [acting, setActing] = useState(false)
  const [reload, setReload] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    let disposed = false
    void Promise.all([listSshTargets(), listProjects()]).then(([ssh, projectRows]) => {
      if (disposed) return
      setTargets(ssh.targets)
      setProjects(projectRows.map(project => ({ id: project.id, name: project.name })))
      setError('')
    }).catch((cause: unknown) => { if (!disposed) setError(messageOf(cause)) })
    return () => { disposed = true; generation.current++ }
  }, [reload])

  const refresh = () => { setReload(value => value + 1) }
  const patchDraft = (patch: Partial<TargetDraft>) => {
    setEditing(current => current === null ? current : { ...current, draft: { ...current.draft, ...patch } })
  }

  async function save(): Promise<void> {
    if (editing === null || acting) return
    const attempt = generation.current
    setActing(true); setError(''); setNotice('')
    try {
      const fields = fieldsOf(editing.draft)
      if (editing.target === null) await createSshTarget(fields)
      else await updateSshTarget(editing.target.publicId, editing.target.revision, fields)
      if (attempt !== generation.current) return
      setNotice(editing.target === null ? 'SSH 目标已注册。' : 'SSH 目标已更新。')
      setEditing(null); refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  async function toggle(target: AdminSshTarget): Promise<void> {
    if (acting) return
    const attempt = generation.current
    setActing(true); setError(''); setNotice('')
    try {
      await mutateSshTarget(target.publicId, target.revision, target.enabled ? 'disable' : 'enable')
      if (attempt !== generation.current) return
      setNotice(target.enabled ? `已停用 ${target.name}。` : `已启用 ${target.name}。`)
      refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  async function remove(): Promise<void> {
    if (removing === null || acting) return
    const attempt = generation.current
    setActing(true); setError(''); setNotice('')
    try {
      await mutateSshTarget(removing.publicId, removing.revision, 'remove')
      if (attempt !== generation.current) return
      setNotice(`已删除 ${removing.name} 及其项目共享。`); setRemoving(null); refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  async function toggleShare(projectId: number, shared: boolean): Promise<void> {
    if (sharing === null || acting) return
    const attempt = generation.current
    setActing(true); setError('')
    try {
      const updated = await shareSshTarget(sharing.publicId, projectId, shared)
      if (attempt !== generation.current) return
      setSharing(updated); refresh()
    } catch (cause) {
      if (attempt === generation.current) setError(messageOf(cause))
    } finally { if (attempt === generation.current) setActing(false) }
  }

  return (
    <>
      <PageHeader title="SSH" description="登记的 OpenSSH 目标、项目共享和账号资格。" />
      {error === '' ? null : <ErrorBanner message={error} />}
      {notice === '' ? null : <p role="status">{notice}</p>}
      <Section
        title="连接目标"
        actions={<>
          <IconButton label="刷新" icon={RefreshCw} onClick={refresh} />
          <Button icon={Plus} onClick={() => { setEditing({ target: null, draft: EMPTY_DRAFT }) }}>注册目标</Button>
        </>}
      >
        {targets === null ? <LoadingState label="正在加载 SSH 目标" /> : targets.length === 0 ? (
          <EmptyState title="尚无 SSH 目标" detail="登记部署拥有的 OpenSSH 别名后，具备资格的账号才能在受管运行时挂载远端执行环境。" />
        ) : (
          <table className="dataTable">
            <thead><tr><th>名称</th><th>主机别名</th><th>远端工作区</th><th>共享项目</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {targets.map(target => (
                <tr key={target.publicId}>
                  <td>{target.name}</td>
                  <td><code>{target.host}</code></td>
                  <td><code>{target.workspace}</code></td>
                  <td>{target.sharedProjects.length === 0 ? '—' : target.sharedProjects.map(id => projects.find(project => project.id === id)?.name ?? `#${String(id)}`).join('、')}</td>
                  <td><StatusBadge tone={target.enabled ? 'success' : 'neutral'}>{target.enabled ? '已启用' : '已停用'}</StatusBadge></td>
                  <td>
                    <IconButton label="编辑" icon={Pencil} onClick={() => { setEditing({ target, draft: draftOf(target) }) }} />
                    <IconButton label="项目共享" icon={Share2} onClick={() => { setSharing(target) }} />
                    <Button variant="ghost" onClick={() => void toggle(target)} disabled={acting}>{target.enabled ? '停用' : '启用'}</Button>
                    <IconButton label="删除" icon={Trash2} onClick={() => { setRemoving(target) }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <SshPermissions />
      <Dialog
        open={editing !== null}
        title={editing === null || editing.target === null ? '注册 SSH 目标' : `编辑 ${editing.target.name}`}
        description="全部字段来自部署拥有的 OpenSSH 与已安装助手坐标；连接值只下发给通过资格校验的受管运行时。"
        onClose={() => { if (!acting) setEditing(null) }}
        footer={<>
          <Button type="button" onClick={() => { setEditing(null) }} disabled={acting}>取消</Button>
          <Button type="button" variant="primary" onClick={() => void save()} disabled={acting}>保存</Button>
        </>}
        wide
      >
        {editing === null ? null : (
          <div className="formGrid">
            <Field label="名称" hint="组织内唯一的管理显示名。"><input className="input" value={editing.draft.name} onChange={event => { patchDraft({ name: event.target.value }) }} /></Field>
            <Field label="主机别名" hint="包含既有用户、密钥和 known-hosts 配置的 OpenSSH 别名。"><input className="input" value={editing.draft.host} onChange={event => { patchDraft({ host: event.target.value }) }} /></Field>
            <Field label="远端 Node 可执行文件" hint="绝对路径。"><input className="input" value={editing.draft.node} onChange={event => { patchDraft({ node: event.target.value }) }} /></Field>
            <Field label="助手入口" hint="已安装打包助手的绝对路径。"><input className="input" value={editing.draft.helper} onChange={event => { patchDraft({ helper: event.target.value }) }} /></Field>
            <Field label="助手摘要" hint="助手包的 SHA-256；不匹配拒绝连接。"><input className="input" value={editing.draft.helperHash} onChange={event => { patchDraft({ helperHash: event.target.value }) }} /></Field>
            <Field label="远端默认工作区" hint="绝对路径。"><input className="input" value={editing.draft.workspace} onChange={event => { patchDraft({ workspace: event.target.value }) }} /></Field>
            <Field label="PTC 引导路径" hint="可选；与摘要同时填写。"><input className="input" value={editing.draft.bootstrapPath} onChange={event => { patchDraft({ bootstrapPath: event.target.value }) }} /></Field>
            <Field label="PTC 引导摘要" hint="可选；64 位小写十六进制。"><input className="input" value={editing.draft.bootstrapHash} onChange={event => { patchDraft({ bootstrapHash: event.target.value }) }} /></Field>
            <Field label="请求超时（毫秒）"><input className="input" inputMode="numeric" value={editing.draft.requestTimeoutMs} onChange={event => { patchDraft({ requestTimeoutMs: event.target.value }) }} /></Field>
            <Field label="单帧上限（字节）"><input className="input" inputMode="numeric" value={editing.draft.maxFrameBytes} onChange={event => { patchDraft({ maxFrameBytes: event.target.value }) }} /></Field>
            <Field label="并发请求上限"><input className="input" inputMode="numeric" value={editing.draft.maxPending} onChange={event => { patchDraft({ maxPending: event.target.value }) }} /></Field>
            <Field label="远端租约（毫秒）"><input className="input" inputMode="numeric" value={editing.draft.leaseMs} onChange={event => { patchDraft({ leaseMs: event.target.value }) }} /></Field>
          </div>
        )}
      </Dialog>
      <Dialog
        open={sharing !== null}
        title={sharing === null ? '' : `共享 ${sharing.name}`}
        description="共享使项目运行时能够解析该目标；每位执行用户仍需独立 SSH 资格。"
        onClose={() => { if (!acting) setSharing(null) }}
      >
        {sharing === null ? null : projects.length === 0 ? <EmptyState title="没有可共享的项目" /> : (
          projects.map(project => (
            <Switch
              key={project.id}
              label={project.name}
              checked={sharing.sharedProjects.includes(project.id)}
              disabled={acting}
              onChange={(checked) => { void toggleShare(project.id, checked) }}
            />
          ))
        )}
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        title={removing === null ? '' : `删除 ${removing.name}`}
        description="删除会同时移除全部项目共享；已挂载的连接在访问失效传播后被切断。"
        confirmLabel="删除"
        pending={acting}
        onConfirm={() => void remove()}
        onClose={() => { if (!acting) setRemoving(null) }}
      />
    </>
  )
}
