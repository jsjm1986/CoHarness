import { ArrowLeft, Check, ChevronRight, Folder, HardDrive, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  listProjectDirectories,
  type ProjectDirectoryListing,
} from '../api.ts'
import { Button, EmptyState, ErrorBanner, LoadingState, Switch } from './ui.tsx'

export function ProjectDirectoryBrowser({
  selectedPath,
  onSelect,
}: {
  selectedPath?: string
  onSelect: (path: string) => void
}) {
  const [listing, setListing] = useState<ProjectDirectoryListing>()
  const [requestedPath, setRequestedPath] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const requestSerial = useRef(0)

  const load = useCallback(async (path?: string) => {
    const serial = ++requestSerial.current
    setRequestedPath(path)
    setLoading(true)
    setError('')
    try {
      const next = await listProjectDirectories(path)
      if (serial !== requestSerial.current) return
      setListing(next)
    } catch (cause) {
      if (serial !== requestSerial.current) return
      setError(directoryMessageFrom(cause))
    } finally {
      if (serial === requestSerial.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => { requestSerial.current += 1 }
  }, [load])

  const hiddenCount = listing?.entries.filter(entry => entry.hidden).length ?? 0
  const entries = useMemo(
    () => listing?.entries.filter(entry => showHidden || !entry.hidden) ?? [],
    [listing, showHidden],
  )
  const currentSelected = listing?.path !== undefined
    && listing.path !== null
    && listing.path === selectedPath

  return (
    <div className="directoryBrowser">
      <div className="directoryBrowserHeader">
        <div className="directoryBrowserIdentity">
          <span className="directoryBrowserIcon"><HardDrive aria-hidden="true" /></span>
          <span>
            <strong>Gateway 主机</strong>
            <small>{listing?.scope === 'configured-roots' ? '已配置目录' : '本机文件系统'}</small>
          </span>
        </div>
        {listing?.path === undefined || listing.path === null ? null : (
          <span className="directoryCurrentPath" title={listing.path}>{listing.path}</span>
        )}
      </div>

      {listing === undefined ? null : (
        <nav className="directoryBreadcrumbs" aria-label="目录路径">
          {listing.crumbs.map((crumb, index) => (
            <span className="directoryCrumb" key={`${crumb.path ?? 'roots'}-${index}`}>
              {index === 0 ? null : <ChevronRight aria-hidden="true" />}
              <button
                type="button"
                aria-current={index === listing.crumbs.length - 1 ? 'location' : undefined}
                disabled={loading || index === listing.crumbs.length - 1}
                onClick={() => { void load(crumb.path ?? undefined) }}
                title={crumb.path ?? crumb.name}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
      )}

      <div className="directoryBrowserBody">
        {loading ? <LoadingState label="正在读取目录" /> : error !== '' ? (
          <div className="directoryBrowserError">
            <ErrorBanner message={error} />
            <div className="directoryBrowserErrorActions">
              {listing === undefined ? null : (
                <Button
                  type="button"
                  icon={ArrowLeft}
                  onClick={() => { void load(listing.path ?? undefined) }}
                >
                  返回当前目录
                </Button>
              )}
              <Button type="button" icon={RefreshCw} onClick={() => { void load(requestedPath) }}>重试</Button>
            </div>
          </div>
        ) : entries.length === 0 ? (
          <EmptyState icon={Folder} title="没有可浏览的子目录" />
        ) : (
          <div className="directoryEntries" role="list" aria-label="子目录">
            {entries.map(entry => (
              <div role="listitem" key={`${entry.name}-${entry.path}`}>
                <button
                  type="button"
                  className="directoryEntry"
                  onClick={() => { void load(entry.path) }}
                  disabled={loading}
                  aria-label={`打开目录 ${entry.name}`}
                >
                  <Folder aria-hidden="true" />
                  <span>
                    <strong>{entry.name}</strong>
                    {listing?.path === null ? <small>{entry.path}</small> : null}
                  </span>
                  <ChevronRight aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="directoryBrowserFooter">
        <div className="directoryBrowserOptions">
          {hiddenCount === 0 ? null : (
            <Switch label={`显示隐藏目录 (${hiddenCount})`} checked={showHidden} onChange={setShowHidden} />
          )}
          {listing?.truncated === true ? <span>仅显示前 1000 个目录</span> : null}
        </div>
        <Button
          type="button"
          variant={currentSelected ? 'primary' : 'secondary'}
          icon={Check}
          disabled={loading || listing?.path === null || listing?.path === undefined || listing.selectable === false}
          onClick={() => { if (listing?.path !== null && listing?.path !== undefined) onSelect(listing.path) }}
        >
          {currentSelected ? '已选择当前目录' : '使用当前目录'}
        </Button>
      </div>
    </div>
  )
}

function directoryMessageFrom(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message === 'project-directory-path-not-absolute') return '目录路径必须是 Gateway 主机上的绝对路径。'
  if (message === 'project-directory-path-not-found') return '目录不存在或已经被移动。'
  if (message === 'project-directory-path-not-directory') return '所选路径不是目录。'
  if (message === 'project-directory-path-inaccessible') return 'Gateway 无权读取该目录。'
  if (message === 'project-directory-path-outside-root') return '该目录不在服务器配置的项目根目录内。'
  if (message === 'project-directory-path-reserved') return '该目录由 Gateway 管理，不能用于项目。'
  return message
}
