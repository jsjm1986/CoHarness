import { ArrowLeft, Check, ChevronRight, Folder, HardDrive, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  listProjectDirectories,
  type ProjectDirectoryListing,
} from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './project-directory-browser.copy.ts'
import { Button, EmptyState, ErrorBanner, LoadingState, Switch } from './ui.tsx'

export function ProjectDirectoryBrowser({
  selectedPath,
  onSelect,
}: {
  selectedPath?: string
  onSelect: (path: string) => void
}) {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
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
            <strong>{t('gatewayHost')}</strong>
            <small>{listing?.scope === 'configured-roots' ? t('scopeConfiguredRoots') : t('scopeFilesystem')}</small>
          </span>
        </div>
        {listing?.path === undefined || listing.path === null ? null : (
          <span className="directoryCurrentPath" title={listing.path}>{listing.path}</span>
        )}
      </div>

      {listing === undefined ? null : (
        <nav className="directoryBreadcrumbs" aria-label={t('breadcrumbsAria')}>
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
        {loading ? <LoadingState label={t('loadingDirectory')} /> : error !== '' ? (
          <div className="directoryBrowserError">
            <ErrorBanner message={error} />
            <div className="directoryBrowserErrorActions">
              {listing === undefined ? null : (
                <Button
                  type="button"
                  icon={ArrowLeft}
                  onClick={() => { void load(listing.path ?? undefined) }}
                >
                  {t('backToCurrent')}
                </Button>
              )}
              <Button type="button" icon={RefreshCw} onClick={() => { void load(requestedPath) }}>{t('retry')}</Button>
            </div>
          </div>
        ) : entries.length === 0 ? (
          <EmptyState icon={Folder} title={t('emptyTitle')} />
        ) : (
          <div className="directoryEntries" role="list" aria-label={t('entriesAria')}>
            {entries.map(entry => (
              <div role="listitem" key={`${entry.name}-${entry.path}`}>
                <button
                  type="button"
                  className="directoryEntry"
                  onClick={() => { void load(entry.path) }}
                  disabled={loading}
                  aria-label={t('openDirectory', { name: entry.name })}
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
            <Switch label={t('showHidden', { count: String(hiddenCount) })} checked={showHidden} onChange={setShowHidden} />
          )}
          {listing?.truncated === true ? <span>{t('truncatedNote')}</span> : null}
        </div>
        <Button
          type="button"
          variant={currentSelected ? 'primary' : 'secondary'}
          icon={Check}
          disabled={loading || listing?.path === null || listing?.path === undefined || listing.selectable === false}
          onClick={() => { if (listing?.path !== null && listing?.path !== undefined) onSelect(listing.path) }}
        >
          {currentSelected ? t('selectedCurrent') : t('useCurrent')}
        </Button>
      </div>
    </div>
  )
}

function directoryMessageFrom(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  const t = translateCopy(adminLanguage(), { zh, en })
  if (message === 'project-directory-path-not-absolute') return t('errorNotAbsolute')
  if (message === 'project-directory-path-not-found') return t('errorNotFound')
  if (message === 'project-directory-path-not-directory') return t('errorNotDirectory')
  if (message === 'project-directory-path-inaccessible') return t('errorInaccessible')
  if (message === 'project-directory-path-outside-root') return t('errorOutsideRoot')
  if (message === 'project-directory-path-reserved') return t('errorReserved')
  return message
}
