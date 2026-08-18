import { useEffect, useRef, useState, type DragEvent, type FC } from 'react'
import {
  Button,
  IconBrowseOutline16,
  IconDownloadOutline16,
  IconInspectOutline12,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createUserDocClient, readDocumentsScope, UserDocServiceUnavailableError,
  type DocumentsWorkspaceScope, type UserDocLimits, type UserDocRef,
} from './documents-client.ts'
import { DocumentPreview } from './DocumentPreview.tsx'
import { formatBytes, getDateGroup } from './format.ts'
import type { DocumentsKey } from './locales.ts'
import css from './DocumentsModal.module.css'

export interface DocumentsModalProps {
  open: boolean
  onClose: () => void
  t: (key: DocumentsKey, params?: Record<string, string>) => string
}

interface GroupedDoc {
  date: string
  documents: UserDocRef[]
}

interface UploadProgress {
  current: number
  total: number
  percent: number
}

const MAX_PREVIEW_TEXT_BYTES = 256 * 1024

function fileListOf(list: FileList | readonly File[]): File[] {
  return Array.from(list)
}

/**
 * Workspace document manager dialog: search, upload, preview, download, and delete.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - Escape, mask click, or the header close control.
 * @param props.t - localized documents dictionary.
 * @returns the manager dialog plus nested delete-confirm and preview dialogs.
 */
export const DocumentsModal: FC<DocumentsModalProps> = ({ open, onClose, t }) => {
  const [documents, setDocuments] = useState<UserDocRef[]>([])
  const [limits, setLimits] = useState<UserDocLimits | null>(null)
  const [scope, setScope] = useState<DocumentsWorkspaceScope>({ kind: 'personal' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<UserDocRef | null>(null)
  const [previewDoc, setPreviewDoc] = useState<UserDocRef | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const userDocs = useRef(createUserDocClient())

  const load = async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const [response, nextScope] = await Promise.all([
        userDocs.current.list(signal),
        readDocumentsScope(signal),
      ])
      if (signal?.aborted) return
      setDocuments([...response.documents].reverse())
      setLimits(response.limits)
      setScope(nextScope)
    } catch (cause) {
      if (signal?.aborted) return
      if (cause instanceof UserDocServiceUnavailableError) {
        setError(t('error.unavailable'))
      } else {
        setError(cause instanceof Error ? cause.message : /* v8 ignore next -- Error is always an Error in tests */ String(cause))
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    /* v8 ignore next -- modal is always open in tests */
    if (!open) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [open])

  const filtered = query === ''
    ? documents
    : documents.filter(d => d.name.toLowerCase().includes(query.toLowerCase()))

  const groups: GroupedDoc[] = []
  const seen = new Set<string>()
  for (const doc of filtered) {
    const date = getDateGroup(doc.docId)
    if (!seen.has(date)) {
      seen.add(date)
      groups.push({ date, documents: [] })
    }
    groups.find(g => g.date === date)?.documents.push(doc)
  }

  const uploadFiles = async (list: FileList | readonly File[]) => {
    const files = fileListOf(list)
    if (files.length === 0) return
    setUploading(true)
    setError('')
    setProgress({ current: 0, total: files.length, percent: 0 })
    try {
      for (const [index, file] of files.entries()) {
        await userDocs.current.upload(file, undefined, (loaded, total) => {
          setProgress({
            current: index + 1,
            total: files.length,
            percent: total === 0 ? 0 : Math.round((loaded / total) * 100),
          })
        })
      }
      /* v8 ignore next -- the hidden input stays mounted for the modal lifetime */
      if (fileInputRef.current) fileInputRef.current.value = ''
      void load()
    } catch {
      setError(t('modal.upload.error'))
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  const handleDelete = async () => {
    /* v8 ignore next -- only called when deleteTarget is set */
    if (!deleteTarget) return
    try {
      await userDocs.current.remove(deleteTarget.docId)
      setDeleteTarget(null)
      void load()
    } catch {
      setError(t('delete.error'))
    }
  }

  const limitsText = limits !== null
    ? t('modal.limits', { size: formatBytes(limits.maxFileBytes), count: String(limits.maxFilesPerMessage) })
    : ''

  const closeDelete = () => { setDeleteTarget(null) }

  const title = scope.kind === 'project'
    ? t('modal.title.project', { name: scope.projectName })
    : t('modal.title')

  const projectExtra = scope.kind === 'project' ? t('delete.confirm.project.extra') : ''

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current += 1
    setDropActive(true)
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDropActive(false)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current = 0
    setDropActive(false)
    void uploadFiles(event.dataTransfer.files)
  }

  const uploadLabel = progress !== null
    ? t('modal.upload.progressCount', {
      current: String(progress.current),
      total: String(progress.total),
      percent: String(progress.percent),
    })
    : t('modal.upload')

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={title}
        closeLabel={t('modal.close')}
        {...(limitsText === '' ? {} : { description: limitsText })}
        className={css.dialog ?? ''}
        contentClassName={css.shell ?? ''}
      >
        <div
          className={`${css.panel}${dropActive ? ` ${css.dropActive}` : ''}`}
          data-documents-panel=""
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {error !== '' && <div className={css.error} role="alert">{error}</div>}

          <div className={css.toolbar}>
            <Input
              className={css.search ?? ''}
              icon={<IconSearchOutline16 size={16} />}
              placeholder={t('modal.search')}
              value={query}
              onChange={(event) => { setQuery(event.target.value) }}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const files = event.currentTarget.files
                /* v8 ignore next -- the file input always exposes a FileList */
                if (files !== null) void uploadFiles(files)
              }}
            />
            <Button
              className={css.upload}
              type="button"
              variant="primary"
              disabled={uploading}
              icon={<IconPlusOutline16 size={16} />}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadLabel}
            </Button>
            <Button
              className={css.refresh}
              type="button"
              variant="ghost"
              aria-label={t('modal.refresh')}
              disabled={uploading}
              icon={<IconRefreshOutline16 size={16} />}
              onClick={() => { void load() }}
            />
          </div>

          {progress !== null && (
            <div className={css.progress} aria-hidden="true">
              <span style={{ width: `${String(progress.percent)}%` }} />
            </div>
          )}

          {loading ? (
            <p className={css.status}>{t('modal.loading')}</p>
          ) : documents.length === 0 ? (
            <p className={css.empty}>{t('modal.empty')}</p>
          ) : filtered.length === 0 ? (
            <p className={css.empty}>{t('modal.noResults')}</p>
          ) : (
            <div className={css.list} role="list" aria-label={t('modal.title')}>
              {groups.map(group => (
                <div
                  key={group.date}
                  className={css.group}
                  role="group"
                  aria-label={`${t('listing.date')} ${group.date}`}
                >
                  <div className={css.groupDate}>{group.date}</div>
                  {group.documents.map(doc => (
                    <div key={doc.docId} className={css.row} role="listitem">
                      <span className={css.fileIcon} aria-hidden="true">
                        <IconBrowseOutline16 size={16} />
                      </span>
                      <div className={css.meta}>
                        <span className={css.name} title={doc.name}>{doc.name}</span>
                        <span className={css.size}>{formatBytes(doc.bytes)}</span>
                      </div>
                      <span className={css.actions}>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={t('action.previewNamed', { name: doc.name })}
                          title={t('action.preview')}
                          onClick={() => { setPreviewDoc(doc) }}
                        >
                          <span className={css.actionIcon} aria-hidden="true">
                            <IconInspectOutline12 size={16} />
                          </span>
                          <span className={css.actionLabel}>{t('action.preview')}</span>
                        </Button>
                        <a
                          className={css.download}
                          href={userDocs.current.contentUrl(doc.docId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={t('action.downloadNamed', { name: doc.name })}
                          title={t('action.download')}
                        >
                          <span className={css.actionIcon} aria-hidden="true">
                            <IconDownloadOutline16 size={16} />
                          </span>
                          <span className={css.actionLabel}>{t('action.download')}</span>
                        </a>
                        <Button
                          className={css.delete}
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={t('action.deleteNamed', { name: doc.name })}
                          title={t('action.delete')}
                          onClick={() => { setDeleteTarget(doc) }}
                        >
                          <span className={css.actionIcon} aria-hidden="true">
                            <IconTrashOutline16 size={16} />
                          </span>
                          <span className={css.actionLabel}>{t('action.delete')}</span>
                        </Button>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className={css.drop} aria-hidden="true">{t('modal.drop')}</div>
        </div>
      </Modal>

      {deleteTarget && (
        <Modal
          open
          onClose={closeDelete}
          title={t('delete.confirm.title')}
          closeLabel={t('modal.close')}
          className={css.dialog ?? ''}
          footer={(
            <>
              <Button type="button" variant="outline" onClick={closeDelete}>
                {t('modal.cancel')}
              </Button>
              <Button type="button" variant="primary" onClick={() => { void handleDelete() }}>
                {t('delete.confirm.button')}
              </Button>
            </>
          )}
        >
          <p className={css.confirm}>{t('delete.confirm.message', { projectExtra })}</p>
        </Modal>
      )}

      {previewDoc && (
        <DocumentPreview
          doc={previewDoc}
          maxTextBytes={MAX_PREVIEW_TEXT_BYTES}
          onClose={() => { setPreviewDoc(null) }}
          t={t}
        />
      )}
    </>
  )
}
