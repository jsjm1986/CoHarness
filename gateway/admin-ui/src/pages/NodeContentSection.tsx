/** Administrator-triggered physical content storage verification for a single computer. */
import { useEffect, useRef, useState } from 'react'
import type { NodeContentHealth } from '../../../src/node-content-health.ts'
import { getNodeContentHealth, type DeploymentNode } from '../api.ts'
import { adminComputerTarget } from '../computer-target.ts'
import { Button, ErrorBanner, Field, Section } from '../components/ui.tsx'
import { adminLanguage } from '../language.ts'

/** @param props - current ingress and the computers visible to this administrator. @returns the selected computer's storage check. */
export function NodeContentSection({ entry, nodes }: { entry: { nodeId: string; name: string }; nodes: readonly DeploymentNode[] }) {
  const pinned = adminComputerTarget(window.location.pathname)
  const [choice, setChoice] = useState(entry.nodeId)
  const selected = pinned ?? choice
  const [view, setView] = useState<NodeContentHealth>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef<AbortController>(undefined)
  const zh = adminLanguage() === 'zh'
  useEffect(() => () => pending.current?.abort(), [selected])

  async function check() {
    pending.current?.abort()
    const owner = new AbortController()
    pending.current = owner
    setBusy(true)
    setView(undefined)
    setError('')
    try {
      const health = await getNodeContentHealth(selected, owner.signal)
      if (!owner.signal.aborted) setView(health)
    } catch {
      if (!owner.signal.aborted) setError(zh ? '无法核验这台电脑的内容库。' : 'Could not verify the content database on this computer.')
    } finally { if (!owner.signal.aborted) setBusy(false) }
  }
  return <Section title={zh ? '项目内容库' : 'Project content database'}>
    {!pinned && nodes.length > 1 && <Field label={zh ? '电脑' : 'Computer'}>
      <select value={selected} onChange={event => {
        pending.current?.abort()
        setChoice(event.target.value)
        setBusy(false)
        setView(undefined)
        setError('')
      }}>{nodes.map(node => <option value={node.nodeId} key={node.nodeId}>{node.name}</option>)}</select>
    </Field>}
    <Button disabled={busy} onClick={() => { void check() }}>{busy ? (zh ? '正在核验…' : 'Verifying…') : (zh ? '核验存储位置' : 'Verify storage location')}</Button>
    {error && <ErrorBanner message={error}/>}
    {view && view.nodeId === selected && <p className="fieldHint" role="status">
      {view.status === 'unconfigured' ? (zh ? '此电脑尚未配置本地项目内容库。' : 'This computer has no local project content database configured.')
        : view.status === 'unavailable' ? (zh ? '无法验证内容卷，请检查节点数据库和数据目录。' : 'The content volume could not be verified. Check the database and data directory.')
        : (zh ? '已验证本机 PostgreSQL 数据卷。' : 'Local PostgreSQL data volume verified.')}
      {view.status === 'verified' && <> <code>{view.dataDirectory}</code></>}
    </p>}
  </Section>
}
