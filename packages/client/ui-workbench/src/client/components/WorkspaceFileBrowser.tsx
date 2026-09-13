/** Session-scoped Workspace directory browser used by the Workbench. */
import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceFileEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceResourceOpenRequest, WorkspaceResourceTarget } from '@deepseek-ai/dsh-client-runtime/client'
import { workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import css from './Workbench.module.css'

/** List one direct directory level through its owning runtime. */
export type ListWorkspaceDirectory = (
  path: string, signal: AbortSignal,
) => Promise<{ entries: readonly WorkspaceFileEntry[]; truncated: boolean }>
/** Open a file resource using the identity of the active Workbench pane. */
export type OpenWorkspaceResource = (request: WorkspaceResourceOpenRequest) => void

/** Browse direct children without treating the directory as a User Document.
 * @param props - Session identity, target runtime, bounded list reader, opener, close action, and labels.
 * @returns a modal directory browser.
 */
export function WorkspaceFileBrowser({
  sessionId, runtimeTarget, list, open, close, labels,
}: {
  sessionId: import('@deepseek-ai/dsh-client-connection/client').SessionId
  runtimeTarget: WorkspaceResourceTarget
  list: ListWorkspaceDirectory
  open: OpenWorkspaceResource
  close: () => void
  labels: {
    close: string
    title: string
    root: string
    up: string
    loading: string
    empty: string
    directory: string
    truncated: string
    error: string
    reload?: string
  }
}) {
  const [path, setPath] = useState('.')
  const [entries, setEntries] = useState<readonly WorkspaceFileEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  const ownerKey = runtimeTarget.kind === 'project' ? `project:${String(runtimeTarget.projectId)}` : 'base'
  useEffect(() => {
    const controller = new AbortController()
    setPending(true)
    setError(undefined)
    setEntries([])
    setTruncated(false)
    void list(path, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setEntries(value.entries)
      setTruncated(value.truncated)
    }, (cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : labels.error)
    }).finally(() => { if (!controller.signal.aborted) setPending(false) })
    return () => { controller.abort() }
  }, [labels.error, list, path, reload, sessionId, ownerKey])
  const parent = path === '.' ? undefined : path.includes('/')
    ? path.slice(0, path.lastIndexOf('/')) : '.'
  const visibleEntries = [...entries].sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  const breadcrumbs = path === '.' ? [] : path.split('/').map((segment, index, all) => ({
    label: segment,
    path: all.slice(0, index + 1).join('/'),
  }))
  const show = (entry: WorkspaceFileEntry): void => {
    const request: WorkspaceResourceOpenRequest = {
      runtimeTarget,
      sessionId,
      path: entry.path,
      address: workspaceResourceAddress(sessionId, entry.path),
    }
    if (entry.type === 'directory') setPath(entry.path)
    else open(request)
  }
  /* v8 ignore next -- CSS modules always provide this generated class in a built client. */
  const browserClass = css.fileBrowser ?? ''
  return (
    <Modal open title={labels.title} closeLabel={labels.close} onClose={close}
      className={browserClass}
      footer={labels.reload === undefined ? undefined : <Button size="sm" disabled={pending} onClick={() => { setReload(value => value + 1) }}>{labels.reload}</Button>}>
      <nav className={css.fileBrowserPath} aria-label={path}>
        <button type="button" onClick={() => { setPath('.') }} aria-current={path === '.' ? 'page' : undefined}>{labels.root}</button>
        {breadcrumbs.map(crumb => <span key={crumb.path}> / <button type="button" onClick={() => { setPath(crumb.path) }} aria-current={crumb.path === path ? 'page' : undefined}>{crumb.label}</button></span>)}
      </nav>
      {parent !== undefined && <Button size="sm" onClick={() => { setPath(parent) }}>{labels.up}</Button>}
      {pending && <p role="status">{labels.loading}</p>}
      {error !== undefined && <p role="alert">{error}</p>}
      {!pending && error === undefined && entries.length === 0 && <p>{labels.empty}</p>}
      <div role="tree" className={css.fileBrowserList}>
        {visibleEntries.map(entry => (
          <button key={entry.path} type="button" role="treeitem" className={css.fileBrowserEntry}
            onClick={() => { show(entry) }} aria-label={`${entry.type === 'directory' ? labels.directory : ''}${entry.name}`}>
            <span aria-hidden="true">{entry.type === 'directory' ? '▸' : '·'}</span><span>{entry.name}</span>
            {entry.type === 'file' && entry.bytes !== undefined && <small>{entry.bytes.toLocaleString()} B</small>}
          </button>
        ))}
      </div>
      {truncated && <p role="status">{labels.truncated}</p>}
    </Modal>
  )
}
