import { useEffect, useMemo, useRef, useState, type DragEvent, type FC, type FormEvent } from 'react'
import {
  Button,
  IconBrowseOutline16,
  IconChevronRightOutline14,
  IconDownloadOutline16,
  IconEditOutline16,
  IconFolderClose16,
  IconFolderOpenOutline16,
  IconInspectOutline12,
  IconPaperclipOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createUserDocClient, readDocumentsScope, UserDocServiceUnavailableError,
  type DocumentsWorkspaceScope, type UserDocDirectoryIdType, type UserDocDirectoryRef,
  type UserDocLimits, type UserDocRef,
} from './documents-client.ts'
import { DocumentPreview } from './DocumentPreview.tsx'
import { formatBytes, getDateGroup } from './format.ts'
import {
  PAGE_SIZE,
  clampPage,
  filterDocuments,
  groupDocumentsByDate,
  pageCount,
  pageSelectionState,
  pageSlice,
  pruneSelection,
  sortDocuments,
  type DocumentSort,
  type DocumentSortDir,
  type DocumentSortKey,
  type DocumentTypeFilter,
} from './listing.ts'
import type { DocumentsKey } from './locales.ts'
import css from './DocumentsModal.module.css'

export interface DocumentsModalProps {
  open: boolean
  onClose: () => void
  t: (key: DocumentsKey, params?: Record<string, string>) => string
  /** Attach a durable document to the current conversation; returns false when unavailable. */
  onAttachDocument?: ((document: UserDocRef) => boolean) | undefined
}

interface UploadProgress {
  current: number
  total: number
  percent: number
}

type FolderEditor =
  | { mode: 'create'; parentDirectoryId: UserDocDirectoryIdType }
  | { mode: 'rename'; directory: UserDocDirectoryRef }

interface Breadcrumb {
  directoryId: UserDocDirectoryIdType
  name: string
}

const MAX_PREVIEW_TEXT_BYTES = 256 * 1024
const ROOT_DIRECTORY_ID = '' as UserDocDirectoryIdType

const DEFAULT_SORT: DocumentSort = { key: 'date', dir: 'desc' }

const SORT_OPTIONS: readonly { value: string; key: DocumentSortKey; dir: DocumentSortDir; label: DocumentsKey }[] = [
  { value: 'date:desc', key: 'date', dir: 'desc', label: 'modal.sort.dateDesc' },
  { value: 'date:asc', key: 'date', dir: 'asc', label: 'modal.sort.dateAsc' },
  { value: 'name:asc', key: 'name', dir: 'asc', label: 'modal.sort.nameAsc' },
  { value: 'name:desc', key: 'name', dir: 'desc', label: 'modal.sort.nameDesc' },
  { value: 'size:desc', key: 'size', dir: 'desc', label: 'modal.sort.sizeDesc' },
  { value: 'size:asc', key: 'size', dir: 'asc', label: 'modal.sort.sizeAsc' },
]

const TYPE_OPTIONS: readonly { value: DocumentTypeFilter; label: DocumentsKey }[] = [
  { value: 'all', label: 'modal.type.all' },
  { value: 'image', label: 'modal.type.image' },
  { value: 'pdf', label: 'modal.type.pdf' },
  { value: 'text', label: 'modal.type.text' },
  { value: 'other', label: 'modal.type.other' },
]

function fileListOf(list: FileList | readonly File[]): File[] {
  return Array.from(list)
}

function parseSort(value: string): DocumentSort {
  const option = SORT_OPTIONS.find(entry => entry.value === value)
  /* v8 ignore next -- the sort <select> only emits SORT_OPTIONS values */
  return option === undefined ? DEFAULT_SORT : { key: option.key, dir: option.dir }
}

function breadcrumbs(directoryId: UserDocDirectoryIdType, rootName: string): Breadcrumb[] {
  const result: Breadcrumb[] = [{ directoryId: ROOT_DIRECTORY_ID, name: rootName }]
  const path: string[] = []
  for (const segment of String(directoryId).split('/').filter(Boolean)) {
    path.push(segment)
    result.push({ directoryId: path.join('/') as UserDocDirectoryIdType, name: segment })
  }
  return result
}

/**
 * Workspace document manager dialog: folder navigation and management plus
 * document search, sort, paging, upload, preview, move, download, and delete.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - Escape, mask click, or the header close control.
 * @param props.t - localized documents dictionary.
 * @param props.onAttachDocument - optional callback for adding an existing document to the composer.
 * @returns the manager dialog plus nested delete-confirm and preview dialogs.
 */
export const DocumentsModal: FC<DocumentsModalProps> = ({ open, onClose, t, onAttachDocument }) => {
  const [documents, setDocuments] = useState<UserDocRef[]>([])
  const [directories, setDirectories] = useState<UserDocDirectoryRef[]>([])
  const [currentDirectoryId, setCurrentDirectoryId] = useState<UserDocDirectoryIdType>(ROOT_DIRECTORY_ID)
  const [limits, setLimits] = useState<UserDocLimits | null>(null)
  const [scope, setScope] = useState<DocumentsWorkspaceScope>({ kind: 'personal' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modalError, setModalError] = useState('')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<DocumentTypeFilter>('all')
  const [sortValue, setSortValue] = useState('date:desc')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [deleteTargets, setDeleteTargets] = useState<UserDocRef[] | null>(null)
  const [folderEditor, setFolderEditor] = useState<FolderEditor | null>(null)
  const [folderName, setFolderName] = useState('')
  const [deleteDirectory, setDeleteDirectory] = useState<UserDocDirectoryRef | null>(null)
  const [moveTargets, setMoveTargets] = useState<UserDocRef[] | null>(null)
  const [moveDirectories, setMoveDirectories] = useState<UserDocDirectoryRef[]>([])
  const [moveDirectoryId, setMoveDirectoryId] = useState<UserDocDirectoryIdType>(ROOT_DIRECTORY_ID)
  const [moveLoading, setMoveLoading] = useState(false)
  const [previewDoc, setPreviewDoc] = useState<UserDocRef | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const headerCheckRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const loadGeneration = useRef(0)
  const userDocs = useRef(createUserDocClient())

  const load = async (directoryId: UserDocDirectoryIdType = currentDirectoryId, signal?: AbortSignal) => {
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    setLoading(true)
    setError('')
    try {
      const [response, nextScope] = await Promise.all([
        userDocs.current.browse(directoryId, signal),
        readDocumentsScope(signal),
      ])
      if (signal?.aborted || generation !== loadGeneration.current) return
      setDocuments([...response.documents])
      setDirectories([...response.directories])
      setCurrentDirectoryId(response.directoryId)
      setLimits(response.limits)
      setScope(nextScope)
    } catch (cause) {
      if (signal?.aborted || generation !== loadGeneration.current) return
      if (cause instanceof UserDocServiceUnavailableError) {
        setError(t('error.unavailable'))
      } else {
        setError(cause instanceof Error ? cause.message : /* v8 ignore next -- Error is always an Error in tests */ String(cause))
      }
    } finally {
      if (!signal?.aborted && generation === loadGeneration.current) setLoading(false)
    }
  }

  useEffect(() => {
    /* v8 ignore next -- modal is always open in tests */
    if (!open) return
    const controller = new AbortController()
    void load(ROOT_DIRECTORY_ID, controller.signal)
    return () => { controller.abort() }
  }, [open])

  useEffect(() => {
    setPage(1)
  }, [query, typeFilter, sortValue, currentDirectoryId])

  const sort = parseSort(sortValue)
  const filtered = useMemo(
    () => sortDocuments(filterDocuments(documents, query, typeFilter), parseSort(sortValue)),
    [documents, query, typeFilter, sortValue],
  )
  const filteredDirectories = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return directories.filter(directory => needle === '' || directory.name.toLowerCase().includes(needle))
  }, [directories, query])

  useEffect(() => {
    const visibleIds = filtered.map(doc => doc.docId)
    setSelected((prev) => {
      const next = pruneSelection(prev, visibleIds)
      if (next.size === prev.size) return prev
      return next
    })
  }, [filtered])

  const pages = pageCount(filtered.length)
  const currentPage = clampPage(page, filtered.length)
  const pageDocs = pageSlice(filtered, currentPage)
  const pageIds = pageDocs.map(doc => doc.docId)
  const headerState = pageSelectionState(pageIds, selected)
  const groups = sort.key === 'date' ? groupDocumentsByDate(pageDocs) : null

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage)
  }, [page, currentPage])

  useEffect(() => {
    const node = headerCheckRef.current
    if (node !== null) node.indeterminate = headerState === 'some'
  }, [headerState])

  const uploadFiles = async (list: FileList | readonly File[]) => {
    const files = fileListOf(list)
    if (files.length === 0) return
    setUploading(true)
    setError('')
    setProgress({ current: 0, total: files.length, percent: 0 })
    try {
      for (const [index, file] of files.entries()) {
        await userDocs.current.upload(file, currentDirectoryId, undefined, (loaded: number, total: number) => {
          setProgress({
            current: index + 1,
            total: files.length,
            percent: total === 0 ? 0 : Math.round((loaded / total) * 100),
          })
        })
      }
      /* v8 ignore next -- the hidden input stays mounted for the modal lifetime */
      if (fileInputRef.current) fileInputRef.current.value = ''
      void load(currentDirectoryId)
    } catch {
      setError(t('modal.upload.error'))
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  const handleDelete = async () => {
    /* v8 ignore next -- only called when deleteTargets is set */
    if (deleteTargets === null || deleteTargets.length === 0) return
    const targets = deleteTargets
    setUploading(true)
    setError('')
    setModalError('')
    setProgress({ current: 0, total: targets.length, percent: 0 })
    try {
      for (const [index, doc] of targets.entries()) {
        await userDocs.current.remove(doc.docId)
        setSelected((prev) => {
          const next = new Set(prev)
          next.delete(doc.docId)
          return next
        })
        setProgress({
          current: index + 1,
          total: targets.length,
          percent: Math.round(((index + 1) / targets.length) * 100),
        })
      }
      setDeleteTargets(null)
      setSelected(new Set())
      void load(currentDirectoryId)
    } catch {
      await load(currentDirectoryId)
      setModalError(t('delete.error'))
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  const navigate = (directoryId: UserDocDirectoryIdType) => {
    setSelected(new Set())
    setQuery('')
    setPage(1)
    void load(directoryId)
  }

  const openCreateDirectory = () => {
    setModalError('')
    setFolderName('')
    setFolderEditor({ mode: 'create', parentDirectoryId: currentDirectoryId })
  }

  const openRenameDirectory = (directory: UserDocDirectoryRef) => {
    setModalError('')
    setFolderName(directory.name)
    setFolderEditor({ mode: 'rename', directory })
  }

  const handleFolderSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (folderEditor === null || folderName.trim() === '') return
    setUploading(true)
    setModalError('')
    try {
      if (folderEditor.mode === 'create') {
        await userDocs.current.createDirectory(folderEditor.parentDirectoryId, folderName.trim())
      } else {
        await userDocs.current.renameDirectory(folderEditor.directory.directoryId, folderName.trim())
      }
      setFolderEditor(null)
      await load(currentDirectoryId)
    } catch {
      setModalError(t(folderEditor.mode === 'create' ? 'folder.create.error' : 'folder.rename.error'))
    } finally {
      setUploading(false)
    }
  }

  const handleDeleteDirectory = async () => {
    if (deleteDirectory === null) return
    setUploading(true)
    setModalError('')
    try {
      await userDocs.current.removeDirectory(deleteDirectory.directoryId)
      setDeleteDirectory(null)
      await load(currentDirectoryId)
    } catch {
      setModalError(t('folder.delete.error'))
    } finally {
      setUploading(false)
    }
  }

  const openMove = async (targets: UserDocRef[]) => {
    if (targets.length === 0) return
    setMoveTargets(targets)
    setMoveDirectories([])
    setMoveDirectoryId(ROOT_DIRECTORY_ID)
    setMoveLoading(true)
    setError('')
    setModalError('')
    try {
      const response = await userDocs.current.listDirectories()
      const available = [...response.directories]
      setMoveDirectories(available)
      if (currentDirectoryId === ROOT_DIRECTORY_ID) {
        setMoveDirectoryId(available[0]?.directoryId ?? ROOT_DIRECTORY_ID)
      }
    } catch {
      setMoveTargets(null)
      setError(t('move.destinations.error'))
    } finally {
      setMoveLoading(false)
    }
  }

  const attachDocument = (doc: UserDocRef) => {
    setError('')
    try {
      if (onAttachDocument?.(doc) === true) {
        onClose()
        return
      }
    } catch (_attachError) {
      // Session teardown can race the click; keep the manager open and show the same actionable failure.
    }
    setError(t('action.attach.error'))
  }

  const handleMove = async () => {
    if (moveTargets === null || moveTargets.length === 0 || moveDirectoryId === currentDirectoryId) return
    const targets = moveTargets
    setUploading(true)
    setModalError('')
    setProgress({ current: 0, total: targets.length, percent: 0 })
    try {
      for (const [index, doc] of targets.entries()) {
        await userDocs.current.move(doc.docId, moveDirectoryId)
        setSelected((prev) => {
          const next = new Set(prev)
          next.delete(doc.docId)
          return next
        })
        const remaining = targets.slice(index + 1)
        setMoveTargets(remaining.length === 0 ? null : remaining)
        setProgress({
          current: index + 1,
          total: targets.length,
          percent: Math.round(((index + 1) / targets.length) * 100),
        })
      }
      setMoveTargets(null)
      setSelected(new Set())
      await load(currentDirectoryId)
    } catch {
      await load(currentDirectoryId)
      setModalError(t('move.error'))
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  const toggleId = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (headerState === 'all') {
        for (const id of pageIds) next.delete(id)
      } else {
        for (const id of pageIds) next.add(id)
      }
      return next
    })
  }

  const limitsText = limits === null
    ? ''
    : limits.maxFileBytes === null
      ? t('modal.limits.unlimited', { count: String(limits.maxFilesPerMessage) })
      : t('modal.limits', { size: formatBytes(limits.maxFileBytes), count: String(limits.maxFilesPerMessage) })

  const closeDelete = () => {
    setDeleteTargets(null)
    setModalError('')
  }

  const title = scope.kind === 'project'
    ? t('modal.title.project', { name: scope.projectName })
    : t('modal.title')
  const directoryTrail = breadcrumbs(currentDirectoryId, t('breadcrumb.root'))

  const projectExtra = scope.kind === 'project' ? t('delete.confirm.project.extra') : ''
  const visibility = scope.kind === 'project'
    ? t('modal.visibility.project')
    : t('modal.visibility.personal')

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

  const uploadLabel = progress !== null && uploading
    ? t('modal.upload.progressCount', {
      current: String(progress.current),
      total: String(progress.total),
      percent: String(progress.percent),
    })
    : t('modal.upload')

  const confirmMessage = deleteTargets !== null && deleteTargets.length > 1
    ? t('delete.confirm.message.many', { count: String(deleteTargets.length), projectExtra })
    : t('delete.confirm.message', { projectExtra })

  const showPager = filtered.length > PAGE_SIZE
  const busy = uploading
  const hasEntries = directories.length > 0 || documents.length > 0
  const hasVisibleEntries = filteredDirectories.length > 0 || filtered.length > 0
  const moveOptions = [
    { directoryId: ROOT_DIRECTORY_ID, name: t('breadcrumb.root') },
    ...moveDirectories.map(directory => ({
      directoryId: directory.directoryId,
      name: String(directory.directoryId),
    })),
  ].filter(directory => directory.directoryId !== currentDirectoryId)

  const renderDirectory = (directory: UserDocDirectoryRef) => (
    <div key={directory.directoryId} className={`${css.row} ${css.folderRow}`} role="listitem">
      <span className={css.folderAlign} aria-hidden="true" />
      <button
        type="button"
        className={css.folderOpen}
        aria-label={t('folder.openNamed', { name: directory.name })}
        onClick={() => { navigate(directory.directoryId) }}
      >
        <span className={css.fileIcon} aria-hidden="true"><IconFolderClose16 size={16} /></span>
        <span className={css.name} title={directory.name}>{directory.name}</span>
      </button>
      <span className={css.actions}>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t('folder.renameNamed', { name: directory.name })}
          title={t('folder.rename')}
          onClick={() => { openRenameDirectory(directory) }}
        >
          <span className={css.actionIcon} aria-hidden="true"><IconEditOutline16 size={16} /></span>
          <span className={css.actionLabel}>{t('folder.rename')}</span>
        </Button>
        <Button
          className={css.delete}
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t('folder.deleteNamed', { name: directory.name })}
          title={t('folder.delete')}
          onClick={() => { setDeleteDirectory(directory) }}
        >
          <span className={css.actionIcon} aria-hidden="true"><IconTrashOutline16 size={16} /></span>
          <span className={css.actionLabel}>{t('folder.delete')}</span>
        </Button>
      </span>
    </div>
  )

  const renderRow = (doc: UserDocRef) => (
    <div key={doc.docId} className={css.row} role="listitem">
      <label className={css.check}>
        <input
          type="checkbox"
          checked={selected.has(doc.docId)}
          aria-label={doc.name}
          onChange={() => { toggleId(doc.docId) }}
        />
      </label>
      <span className={css.fileIcon} aria-hidden="true">
        <IconBrowseOutline16 size={16} />
      </span>
      <div className={css.meta}>
        <span className={css.name} title={doc.name}>{doc.name}</span>
        <span className={css.size}>
          {sort.key === 'date'
            ? formatBytes(doc.bytes)
            : `${formatBytes(doc.bytes)} · ${getDateGroup(doc.modifiedAt)}`}
        </span>
      </div>
      <span className={css.actions}>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t('action.attachNamed', { name: doc.name })}
          title={t('action.attach')}
          disabled={busy}
          onClick={() => { attachDocument(doc) }}
        >
          <span className={css.actionIcon} aria-hidden="true">
            <IconPaperclipOutline16 size={16} />
          </span>
          <span className={css.actionLabel}>{t('action.attach')}</span>
        </Button>
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
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t('action.moveNamed', { name: doc.name })}
          title={t('action.move')}
          onClick={() => { void openMove([doc]) }}
        >
          <span className={css.actionIcon} aria-hidden="true">
            <IconFolderOpenOutline16 size={16} />
          </span>
          <span className={css.actionLabel}>{t('action.move')}</span>
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
          onClick={() => { setDeleteTargets([doc]) }}
        >
          <span className={css.actionIcon} aria-hidden="true">
            <IconTrashOutline16 size={16} />
          </span>
          <span className={css.actionLabel}>{t('action.delete')}</span>
        </Button>
      </span>
    </div>
  )

  const pager = showPager
    ? (
      <div className={css.pager}>
        <Button
          type="button"
          variant="outline"
          disabled={currentPage <= 1 || busy}
          onClick={() => { setPage(currentPage - 1) }}
        >
          {t('pager.prev')}
        </Button>
        <span>{t('pager.status', { page: String(currentPage), pages: String(pages) })}</span>
        <Button
          type="button"
          variant="outline"
          disabled={currentPage >= pages || busy}
          onClick={() => { setPage(currentPage + 1) }}
        >
          {t('pager.next')}
        </Button>
      </div>
    )
    : undefined

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={title}
        closeLabel={t('modal.close')}
        {...(limitsText === '' ? {} : { description: limitsText })}
        className={css.dialog as string}
        contentClassName={css.shell as string}
        {...(pager === undefined ? {} : { footer: pager })}
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

          <nav className={css.breadcrumbs} aria-label={t('breadcrumb.label')}>
            {directoryTrail.map((crumb, index) => (
              <span key={crumb.directoryId || 'root'} className={css.crumbSeat}>
                {index > 0 && <IconChevronRightOutline14 size={12} className={css.crumbChevron} />}
                <button
                  type="button"
                  className={css.crumb}
                  aria-current={index === directoryTrail.length - 1 ? 'page' : undefined}
                  disabled={loading || index === directoryTrail.length - 1}
                  onClick={() => { navigate(crumb.directoryId) }}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>

          <div className={css.toolbar}>
            <Input
              className={css.search as string}
              icon={<IconSearchOutline16 size={16} />}
              placeholder={t('modal.search')}
              value={query}
              onChange={(event) => { setQuery(event.target.value) }}
            />
            <select
              className={css.select}
              aria-label={t('modal.type')}
              value={typeFilter}
              onChange={(event) => { setTypeFilter(event.currentTarget.value as DocumentTypeFilter) }}
            >
              {TYPE_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{t(option.label)}</option>
              ))}
            </select>
            <select
              className={css.select}
              aria-label={t('modal.sort')}
              value={sortValue}
              onChange={(event) => { setSortValue(event.currentTarget.value) }}
            >
              {SORT_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{t(option.label)}</option>
              ))}
            </select>
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
              className={css.newFolder}
              type="button"
              variant="outline"
              disabled={busy}
              icon={<IconFolderClose16 size={16} />}
              onClick={openCreateDirectory}
            >
              {t('folder.create')}
            </Button>
            <Button
              className={css.upload}
              type="button"
              variant="primary"
              disabled={busy}
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
              disabled={busy}
              icon={<IconRefreshOutline16 size={16} />}
              onClick={() => { void load(currentDirectoryId) }}
            />
          </div>

          <div className={css.caption}>
            <span>{visibility}</span>
            {!loading && <span>{t('modal.count', { count: String(filtered.length) })}</span>}
          </div>

          {selected.size > 0 && (
            <div className={css.selectionBar}>
              <span>{t('selection.selected', { count: String(selected.size) })}</span>
              <Button
                type="button"
                variant="ghost"
                onClick={() => { setSelected(new Set()) }}
              >
                {t('selection.clear')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => { void openMove(documents.filter(doc => selected.has(doc.docId))) }}
              >
                {t('selection.move')}
              </Button>
              <Button
                className={css.delete}
                type="button"
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setDeleteTargets(documents.filter(doc => selected.has(doc.docId)))
                }}
              >
                {t('selection.delete')}
              </Button>
            </div>
          )}

          {progress !== null && (
            <div className={css.progress} aria-hidden="true">
              <span style={{ width: `${String(progress.percent)}%` }} />
            </div>
          )}

          {loading ? (
            <p className={css.status}>{t('modal.loading')}</p>
          ) : !hasEntries ? (
            <p className={css.empty}>{t('modal.empty')}</p>
          ) : !hasVisibleEntries ? (
            <p className={css.empty}>{t('modal.noResults')}</p>
          ) : (
            <div className={css.list} role="list" aria-label={t('modal.title')}>
              {pageDocs.length > 0 && (
                <div className={css.listHeader}>
                  <label className={css.check}>
                    <input
                      ref={headerCheckRef}
                      type="checkbox"
                      checked={headerState === 'all'}
                      aria-label={t('selection.selectPage')}
                      onChange={togglePage}
                    />
                  </label>
                </div>
              )}
              {currentPage === 1 && filteredDirectories.map(renderDirectory)}
              {groups === null
                ? pageDocs.map(renderRow)
                : groups.map(group => (
                  <div
                    key={group.date}
                    className={css.group}
                    role="group"
                    aria-label={`${t('listing.date')} ${group.date}`}
                  >
                    <div className={css.groupDate}>{group.date}</div>
                    {group.documents.map(renderRow)}
                  </div>
                ))}
            </div>
          )}
          <div className={css.drop} aria-hidden="true">{t('modal.drop')}</div>
        </div>
      </Modal>

      {deleteTargets !== null && deleteTargets.length > 0 && (
        <Modal
          open
          onClose={closeDelete}
          title={t('delete.confirm.title')}
          closeLabel={t('modal.close')}
          className={css.confirmDialog as string}
          footer={(
            <>
              <Button type="button" variant="outline" onClick={closeDelete}>
                {t('modal.cancel')}
              </Button>
              <Button type="button" variant="primary" disabled={busy} onClick={() => { void handleDelete() }}>
                {t('delete.confirm.button')}
              </Button>
            </>
          )}
        >
          {modalError !== '' && <div className={css.error} role="alert">{modalError}</div>}
          <p className={css.confirm}>{confirmMessage}</p>
        </Modal>
      )}

      {folderEditor !== null && (
        <Modal
          open
          onClose={() => {
            if (!busy) {
              setFolderEditor(null)
              setModalError('')
            }
          }}
          title={t(folderEditor.mode === 'create' ? 'folder.create.title' : 'folder.rename.title')}
          closeLabel={t('modal.close')}
          className={css.confirmDialog as string}
        >
          <form className={css.form} onSubmit={(event) => { void handleFolderSubmit(event) }}>
            {modalError !== '' && <div className={css.error} role="alert">{modalError}</div>}
            <label className={css.formLabel} htmlFor="documents-folder-name">{t('folder.name')}</label>
            <Input
              id="documents-folder-name"
              value={folderName}
              onChange={(event) => { setFolderName(event.target.value) }}
              autoFocus
              maxLength={255}
              required
            />
            <div className={css.formActions}>
              <Button type="button" variant="outline" disabled={busy} onClick={() => {
                setFolderEditor(null)
                setModalError('')
              }}>
                {t('modal.cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={busy || folderName.trim() === ''}>
                {t(folderEditor.mode === 'create' ? 'folder.create.confirm' : 'folder.rename.confirm')}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {deleteDirectory !== null && (
        <Modal
          open
          onClose={() => {
            if (!busy) {
              setDeleteDirectory(null)
              setModalError('')
            }
          }}
          title={t('folder.delete.title')}
          closeLabel={t('modal.close')}
          className={css.confirmDialog as string}
          footer={(
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => {
                setDeleteDirectory(null)
                setModalError('')
              }}>
                {t('modal.cancel')}
              </Button>
              <Button type="button" variant="primary" disabled={busy} onClick={() => { void handleDeleteDirectory() }}>
                {t('folder.delete.confirm')}
              </Button>
            </>
          )}
        >
          {modalError !== '' && <div className={css.error} role="alert">{modalError}</div>}
          <p className={css.confirm}>{t('folder.delete.message', { name: deleteDirectory.name })}</p>
        </Modal>
      )}

      {moveTargets !== null && moveTargets.length > 0 && (
        <Modal
          open
          onClose={() => {
            if (!busy) {
              setMoveTargets(null)
              setModalError('')
            }
          }}
          title={t('move.title')}
          closeLabel={t('modal.close')}
          className={css.confirmDialog as string}
          footer={(
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => {
                setMoveTargets(null)
                setModalError('')
              }}>
                {t('modal.cancel')}
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={busy || moveLoading || moveOptions.length === 0 || moveDirectoryId === currentDirectoryId}
                onClick={() => { void handleMove() }}
              >
                {t('move.confirm')}
              </Button>
            </>
          )}
        >
          <div className={css.form}>
            {modalError !== '' && <div className={css.error} role="alert">{modalError}</div>}
            <p className={css.confirm}>{t('move.message', { count: String(moveTargets.length) })}</p>
            {moveLoading ? (
              <p className={css.status}>{t('move.loading')}</p>
            ) : moveOptions.length === 0 ? (
              <p className={css.status}>{t('move.noDestinations')}</p>
            ) : (
              <>
                <label className={css.formLabel} htmlFor="documents-move-destination">{t('move.destination')}</label>
                <select
                  id="documents-move-destination"
                  className={`${css.select} ${css.moveSelect}`}
                  value={moveDirectoryId}
                  onChange={(event) => { setMoveDirectoryId(event.currentTarget.value as UserDocDirectoryIdType) }}
                >
                  {moveOptions.map(option => (
                    <option key={option.directoryId || 'root'} value={option.directoryId}>{option.name}</option>
                  ))}
                </select>
              </>
            )}
          </div>
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
