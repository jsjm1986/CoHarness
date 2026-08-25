import { useEffect, useMemo, useRef, useState, type DragEvent, type FC, type FormEvent } from 'react'
import {
  Button,
  IconBrowseOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCopyOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
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
  useMediaQuery,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createUserDocClient, readDocumentsScope, UserDocHttpError, UserDocServiceUnavailableError,
  type DocumentsWorkspaceScope, type UserDocDirectoryIdType, type UserDocDirectoryRef, type UserDocIdType,
  type UserDocCatalogHistoryItem, type UserDocCatalogRow, type UserDocLimits, type UserDocRef, type UserDocScope,
  type UserDocUploadPhase,
  type UserDocTransferListedDocument, type UserDocTransferResponse,
} from './documents-client.ts'
import { DocumentPreview } from './DocumentPreview.tsx'
import { DocumentsMobileSheet } from './DocumentsMobileSheet.tsx'
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
  /** Attach one existing durable document to the current conversation. */
  onAttachDocument?: (document: UserDocRef) => boolean
}

interface UploadProgress {
  current: number
  total: number
  percent: number
  phase?: UserDocUploadPhase
}

function uploadErrorMessage(error: unknown, t: (key: DocumentsKey) => string): string {
  if (!(error instanceof UserDocHttpError)) return t('modal.upload.error')
  if (error.code === 'DOCUMENT_UPLOAD_STORAGE') return t('modal.upload.error.storage')
  if (error.code === 'DOCUMENT_UPLOAD_EXPIRED') return t('modal.upload.error.expired')
  if (error.code === 'DOCUMENT_UPLOAD_HASH') return t('modal.upload.error.hash')
  if (error.code === 'DOCUMENT_UPLOAD_PROTOCOL') return t('modal.upload.error.protocol')
  if (error.status === 507) return t('modal.upload.error.storage')
  return t('modal.upload.error')
}

type FolderEditor =
  | { mode: 'create'; parentDirectoryId: UserDocDirectoryIdType }
  | { mode: 'rename'; directory: UserDocDirectoryRef }

interface Breadcrumb {
  directoryId: UserDocDirectoryIdType
  name: string
}

interface CopyTargetOption {
  value: string
  label: string
  target: UserDocScope
}

interface SourceOption {
  value: string
  label: string
  scope: UserDocScope
}

/** Metadata-only view selected from the workbench scope rail. */
interface ScopeView {
  value: string
  label: string
  scope: UserDocScope
}

interface OverviewCopyTarget {
  readonly row: UserDocCatalogRow
  readonly source: UserDocScope
}

interface FailedCopyItem {
  readonly docId: UserDocIdType
  readonly name: string
  readonly source: UserDocScope
  readonly target: UserDocScope
}

type MobileSheetState =
  | { kind: 'scope'; mode: 'view' | 'source'; query: string }
  | { kind: 'more' }
  | { kind: 'document'; document: UserDocRef }
  | { kind: 'directory'; directory: UserDocDirectoryRef }
  | { kind: 'overview'; row: UserDocCatalogRow }
  | { kind: 'selection' }

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
  const phone = useMediaQuery('(max-width: 767px)')
  const [documents, setDocuments] = useState<UserDocRef[]>([])
  const [directories, setDirectories] = useState<UserDocDirectoryRef[]>([])
  const [currentDirectoryId, setCurrentDirectoryId] = useState<UserDocDirectoryIdType>(ROOT_DIRECTORY_ID)
  const [limits, setLimits] = useState<UserDocLimits | null>(null)
  const [scope, setScope] = useState<DocumentsWorkspaceScope>({ kind: 'personal' })
  const [scopeView, setScopeView] = useState<ScopeView | null>(null)
  const [alternateSource, setAlternateSource] = useState<SourceOption | null>(null)
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false)
  const [sourcePickerValue, setSourcePickerValue] = useState('')
  const [sourcePickerLoading, setSourcePickerLoading] = useState(false)
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
  const [copyTargets, setCopyTargets] = useState<CopyTargetOption[] | null>(null)
  const [copyTarget, setCopyTarget] = useState<string>('personal')
  const [copyLoading, setCopyLoading] = useState(false)
  const [copyDirectories, setCopyDirectories] = useState<Array<{ directoryId: UserDocDirectoryIdType; name: string }>>([])
  const [copyDirectory, setCopyDirectory] = useState<UserDocDirectoryIdType>(ROOT_DIRECTORY_ID)
  const [copyDirectoryLoading, setCopyDirectoryLoading] = useState(false)
  const [copyFolderName, setCopyFolderName] = useState('')
  const [copyFolderCreating, setCopyFolderCreating] = useState(false)
  const [failedCopyItems, setFailedCopyItems] = useState<FailedCopyItem[]>([])
  const [retryingCopyId, setRetryingCopyId] = useState<string | null>(null)
  const [previewDoc, setPreviewDoc] = useState<UserDocRef | null>(null)
  const [overviewMode, setOverviewMode] = useState(false)
  const [overviewRows, setOverviewRows] = useState<UserDocCatalogRow[]>([])
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [overviewCopyRow, setOverviewCopyRow] = useState<OverviewCopyTarget | null>(null)
  const [overviewError, setOverviewError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyItems, setHistoryItems] = useState<UserDocCatalogHistoryItem[]>([])
  const [mobileSheet, setMobileSheet] = useState<MobileSheetState | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const headerCheckRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const loadGeneration = useRef(0)
  const userDocs = useRef(createUserDocClient())

  const load = async (directoryId: UserDocDirectoryIdType = currentDirectoryId, signal?: AbortSignal) => {
    setMobileSheet(null)
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    setLoading(true)
    setError('')
    setOverviewMode(false)
    setScopeView(null)
    setAlternateSource(null)
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

  const openOverview = async (): Promise<boolean> => {
    setOverviewLoading(true)
    setOverviewError('')
    try {
      const response = await userDocs.current.overview()
      setOverviewRows([...response.documents])
      setOverviewMode(true)
      setScopeView(null)
      setAlternateSource(null)
      setSelected(new Set())
      return true
    } catch (cause) {
      setOverviewError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setOverviewLoading(false)
    }
  }

  const openHistory = async () => {
    setHistoryLoading(true)
    setError('')
    try {
      const response = await userDocs.current.history()
      setHistoryItems([...response.items])
      setHistoryOpen(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setHistoryLoading(false)
    }
  }

  const openScopeView = async (target: UserDocScope, label: string): Promise<boolean> => {
    const current = currentScopeDescriptor()
    if (target.kind === current.kind && (target.kind === 'personal'
      || (current.kind === 'project' && target.projectId === current.projectId))) {
      await load(ROOT_DIRECTORY_ID)
      return true
    }
    setLoading(true)
    setError('')
    try {
      const response = await userDocs.current.listScope(target)
      const nextDocuments: UserDocRef[] = response.documents.map((document: UserDocTransferListedDocument) => ({ ...document, path: '' }))
      setDocuments(nextDocuments)
      setDirectories([])
      setCurrentDirectoryId(ROOT_DIRECTORY_ID)
      setScopeView({ value: target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`, label, scope: target })
      setAlternateSource(null)
      setOverviewMode(false)
      setSelected(new Set())
      setQuery('')
      setPage(1)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setLoading(false)
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
    if (!open || !phone) setMobileSheet(null)
  }, [open, phone])

  useEffect(() => {
    if (copyTargets === null) return
    const option = copyTargets.find(candidate => candidate.value === copyTarget)
    if (option === undefined) return
    const clientRecord = userDocs.current as unknown as Record<string, unknown>
    const listDirectories = typeof clientRecord.listScopeDirectories === 'function'
      ? (target: UserDocScope) => (clientRecord.listScopeDirectories as (scope: UserDocScope) => Promise<{
        readonly directories: readonly { readonly directoryId: string; readonly name: string }[]
      }>)(target)
      : undefined
    if (typeof listDirectories !== 'function') {
      setCopyDirectories([])
      setCopyDirectory(ROOT_DIRECTORY_ID)
      return
    }
    let cancelled = false
    setCopyDirectoryLoading(true)
    void listDirectories(option.target).then((response) => {
      if (cancelled) return
      setCopyDirectories(response.directories.map(directory => ({
        directoryId: directory.directoryId as UserDocDirectoryIdType,
        name: directory.name,
      })))
      setCopyDirectory(ROOT_DIRECTORY_ID)
    }).catch(() => {
      if (!cancelled) setCopyDirectories([])
    }).finally(() => {
      if (!cancelled) setCopyDirectoryLoading(false)
    })
    return () => { cancelled = true }
  }, [copyTarget, copyTargets])

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
    if (writeLocked) return
    const files = fileListOf(list)
    if (files.length === 0) return
    setUploading(true)
    setError('')
    setProgress({ current: 0, total: files.length, percent: 0 })
    try {
      for (const [index, file] of files.entries()) {
        await userDocs.current.upload(file, currentDirectoryId, undefined, (loaded: number, total: number, phase?: UserDocUploadPhase) => {
          setProgress({
            current: index + 1,
            total: files.length,
            percent: total === 0 ? 0 : Math.round((loaded / total) * 100),
            ...(phase === undefined ? {} : { phase }),
          })
        })
      }
      /* v8 ignore next -- the hidden input stays mounted for the modal lifetime */
      if (fileInputRef.current) fileInputRef.current.value = ''
      void load(currentDirectoryId)
    } catch (cause) {
      setError(uploadErrorMessage(cause, t))
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  const handleDelete = async () => {
    if (writeLocked) return
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
    if (writeLocked) return
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
    if (writeLocked) return
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
    if (writeLocked) return
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
    if (writeLocked) return
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

  const openCopy = (targets: UserDocRef[]) => {
    if (targets.length === 0) return
    const source = scopeView?.scope ?? alternateSource?.scope ?? currentScopeDescriptor()
    const options: CopyTargetOption[] = (scope.projects ?? [])
      .filter(project => project.mode === 'rw' && !(source.kind === 'project' && source.projectId === project.projectId))
      .map(project => ({
        value: `project:${String(project.projectId)}`,
        label: project.name,
        target: { kind: 'project', projectId: project.projectId } as const,
      }))
    if (!(source.kind === 'personal')) {
      options.unshift({ value: 'personal', label: t('copy.target.personal'), target: { kind: 'personal' } })
    }
    if (scope.kind === 'personal' && source.kind === 'personal') {
      // Personal-to-personal is not a copy target; keep the target list empty.
      options.splice(0, options.length, ...options.filter(option => option.target.kind === 'project'))
    }
    if (options.length === 0) {
      setError(t('copy.unavailable'))
      return
    }
    setCopyTargets(options)
    setCopyTarget(options[0]?.value ?? '')
    setCopyDirectory(ROOT_DIRECTORY_ID)
    setCopyFolderName('')
    setFailedCopyItems([])
    setMoveTargets(null)
    setModalError('')
  }

  const currentScopeDescriptor = (): UserDocScope => scope.kind === 'project' && scope.projectId !== undefined
    ? { kind: 'project', projectId: scope.projectId }
    : { kind: 'personal' }

  const sourceOptions: SourceOption[] = [
    ...(scope.kind === 'personal' ? [] : [{ value: 'personal', label: t('copy.target.personal'), scope: { kind: 'personal' } as const }]),
    ...(scope.projects ?? [])
      .filter(project => !(scope.kind === 'project' && scope.projectId === project.projectId))
      .map(project => ({ value: `project:${String(project.projectId)}`, label: project.name, scope: { kind: 'project', projectId: project.projectId } as const })),
  ]

  const mobileViewOptions = useMemo(() => [
    {
      value: 'all',
      label: t('scope.all'),
      description: t('scope.all.description'),
      kind: 'all' as const,
    },
    {
      value: 'personal',
      label: t('copy.target.personal'),
      description: t('scope.personal.description'),
      kind: 'personal' as const,
    },
    ...(scope.projects ?? []).map(project => ({
      value: `project:${String(project.projectId)}`,
      label: project.name,
      description: `${project.mode.toUpperCase()} · ${t('scope.project.description')}`,
      kind: 'project' as const,
      projectId: project.projectId,
    })),
  ], [scope.projects, t])

  const mobileScopeValue = overviewMode
    ? 'all'
    : scopeView?.value
      ?? (scope.kind === 'project'
        ? scope.projectId === undefined
          ? mobileViewOptions.find(option => option.kind === 'project' && option.label === scope.projectName)?.value ?? 'personal'
          : `project:${String(scope.projectId)}`
        : 'personal')

  const mobileScopeOptions = mobileSheet?.kind === 'scope' && mobileSheet.mode === 'source'
    ? sourceOptions.map(option => ({
      value: option.value,
      label: option.label,
      description: t('copy.source.viewing', { name: option.label }),
      kind: 'source' as const,
    }))
    : mobileViewOptions

  const mobileScopeQuery = mobileSheet?.kind === 'scope' ? mobileSheet.query.trim().toLowerCase() : ''
  const filteredMobileScopeOptions = mobileScopeOptions.filter(option => (
    mobileScopeQuery === '' || option.label.toLowerCase().includes(mobileScopeQuery)
  ))

  const selectMobileScope = async (value: string) => {
    if (mobileSheet?.kind !== 'scope') return
    const option = mobileScopeOptions.find(candidate => candidate.value === value)
    if (option === undefined) return
    let succeeded = false
    if (mobileSheet.mode === 'source') {
      succeeded = await browseSource(value)
    } else if (option.kind === 'all') {
      succeeded = await openOverview()
    } else if (option.kind === 'personal') {
      succeeded = await openScopeView({ kind: 'personal' }, option.label)
    } else if (option.kind === 'project') {
      succeeded = await openScopeView({ kind: 'project', projectId: option.projectId }, option.label)
    }
    if (succeeded) setMobileSheet(null)
  }

  const browseSource = async (value = sourcePickerValue): Promise<boolean> => {
    const option = sourceOptions.find(candidate => candidate.value === value)
    if (option === undefined) return false
    setSourcePickerLoading(true)
    setError('')
    try {
      const response = await userDocs.current.listScope(option.scope)
      const documents: UserDocRef[] = response.documents.map((document: UserDocTransferListedDocument) => ({
        ...document,
        path: '',
      }))
      setDocuments(documents)
      setDirectories([])
      setCurrentDirectoryId(ROOT_DIRECTORY_ID)
      setScopeView(null)
      setAlternateSource(option)
      setSelected(new Set())
      setQuery('')
      setPage(1)
      setSourcePickerOpen(false)
      return true
    } catch (error) {
      setError(error instanceof Error ? error.message : t('copy.error'))
      return false
    } finally {
      setSourcePickerLoading(false)
    }
  }

  const openSourcePicker = () => {
    if (sourceOptions.length === 0) {
      setError(t('copy.source.unavailable'))
      return
    }
    setSourcePickerValue(sourceOptions[0]?.value ?? '')
    setSourcePickerOpen(true)
    setModalError('')
  }

  const openMobileScopeSheet = (mode: 'view' | 'source') => {
    if (mode === 'source' && sourceOptions.length === 0) {
      setError(t('copy.source.unavailable'))
      return
    }
    setError('')
    setMobileSheet({ kind: 'scope', mode, query: '' })
  }

  const openOverviewCopy = async (row: UserDocCatalogRow) => {
    const source: UserDocScope = row.scope.kind === 'project' && row.scope.id !== undefined
      ? { kind: 'project', projectId: row.scope.id }
      : { kind: 'personal' }
    try {
      const capabilities = await userDocs.current.capabilities()
      const options = capabilities.targets
        .filter(target => target.canWrite && !(target.scope.kind === source.kind
          && (target.scope.kind === 'personal' || target.scope.projectId === (source.kind === 'project' ? source.projectId : -1))))
        .map(target => ({
          value: target.scope.kind === 'personal' ? 'personal' : `project:${String(target.scope.projectId)}`,
          label: target.label,
          target: target.scope,
        }))
      if (options.length === 0) {
        setOverviewError(t('copy.unavailable'))
        return
      }
      setOverviewCopyRow({ row, source })
      setCopyTargets(options)
      setCopyTarget(options[0]?.value ?? '')
      setCopyDirectory(ROOT_DIRECTORY_ID)
      setCopyFolderName('')
      setFailedCopyItems([])
      setModalError('')
    } catch (cause) {
      setOverviewError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleCopy = async () => {
    if (copyTargets === null || (overviewCopyRow === null && selected.size === 0)) return
    const option = copyTargets.find(candidate => candidate.value === copyTarget)
    if (option === undefined) return
    const targets = overviewCopyRow === null
      ? documents.filter(doc => selected.has(doc.docId))
      : [{
        docId: overviewCopyRow.row.docId,
        path: '',
        name: overviewCopyRow.row.name,
        bytes: overviewCopyRow.row.bytes,
        mediaType: overviewCopyRow.row.mediaType,
        modifiedAt: overviewCopyRow.row.modifiedAt,
      } satisfies UserDocRef]
    if (targets.length === 0) return
    setCopyLoading(true)
    setUploading(true)
    setModalError('')
    setProgress({ current: 0, total: targets.length, percent: 0 })
    try {
      const source: UserDocScope = overviewCopyRow?.source ?? scopeView?.scope ?? alternateSource?.scope ?? currentScopeDescriptor()
      const target = alternateSource === null
        ? option.target
        : currentScopeDescriptor()
      const resolvedTarget = overviewCopyRow === null ? target : option.target
      const transferRequest = {
        version: 1,
        source,
        target: resolvedTarget,
        ...(copyDirectory === ROOT_DIRECTORY_ID ? {} : { directory: copyDirectory }),
        documents: targets.map(doc => ({ docId: doc.docId })),
      } as const
      const clientRecord = userDocs.current as unknown as Record<string, unknown>
      const planMethod = clientRecord.plan
      const commitMethod = clientRecord.commit
      let response: UserDocTransferResponse
      if (typeof planMethod === 'function' && typeof commitMethod === 'function') {
        const plan = await (planMethod as (request: typeof transferRequest) => Promise<{ planId: string }>)(transferRequest)
        response = await (commitMethod as (request: typeof transferRequest & { planId: string }) => Promise<UserDocTransferResponse>)({
          ...transferRequest,
          planId: plan.planId,
        })
      } else {
        response = await userDocs.current.transfer(transferRequest)
      }
      const copied = response.items.flatMap(item => item.status === 'copied' ? [item.target] : [])
      const failedItems = response.items.flatMap((item, index) => item.status === 'failed' && targets[index] !== undefined
        ? [{
          docId: targets[index].docId,
          name: targets[index].name,
          source,
          target: resolvedTarget,
        }]
        : [])
      const failed = failedItems.length
      setFailedCopyItems(failedItems)
      if (copied.length > 0 && onAttachDocument !== undefined) {
        let attached = false
        for (const ref of copied) {
          attached = onAttachDocument({ ...ref, path: '' }) || attached
        }
        if (attached) onClose()
      }
      if (failed > 0) setModalError(t('copy.partial', { count: String(failed) }))
      else setCopyTargets(null)
      setSelected(new Set())
      if (overviewCopyRow !== null) {
        setOverviewCopyRow(null)
        await openOverview()
      } else {
        await load(currentDirectoryId)
      }
    } catch (error) {
      setModalError(error instanceof Error ? error.message : t('copy.error'))
    } finally {
      setCopyLoading(false)
      setUploading(false)
      setProgress(null)
      setOverviewCopyRow(null)
    }
  }

  const retryCopy = async (item: FailedCopyItem) => {
    setRetryingCopyId(item.docId)
    try {
      const response = await userDocs.current.retry({
        version: 1,
        source: item.source,
        target: item.target,
        documents: [{ docId: item.docId }],
      })
      if (response.items.some(result => result.status === 'copied')) {
        setFailedCopyItems(prev => prev.filter(candidate => candidate.docId !== item.docId))
        await load(currentDirectoryId)
      } else {
        setModalError(t('copy.retry.failed'))
      }
    } catch (cause) {
      setModalError(cause instanceof Error ? cause.message : t('copy.retry.failed'))
    } finally {
      setRetryingCopyId(null)
    }
  }

  const createCopyFolder = async () => {
    if (copyTargets === null || copyFolderName.trim() === '') return
    const option = copyTargets.find(candidate => candidate.value === copyTarget)
    if (option === undefined || typeof userDocs.current.createScopeDirectory !== 'function') return
    setCopyFolderCreating(true)
    setModalError('')
    try {
      const created = await userDocs.current.createScopeDirectory(option.target, copyDirectory, copyFolderName.trim())
      setCopyDirectories(prev => [...prev, { directoryId: created.directoryId, name: created.name }])
      setCopyDirectory(created.directoryId)
      setCopyFolderName('')
    } catch (cause) {
      setModalError(cause instanceof Error ? cause.message : t('folder.create.error'))
    } finally {
      setCopyFolderCreating(false)
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

  const title = scopeView === null && alternateSource === null && scope.kind === 'project'
    ? t('modal.title.project', { name: scope.projectName })
    : t('modal.title')
  const directoryTrail = breadcrumbs(currentDirectoryId, scopeView?.label ?? alternateSource?.label ?? t('breadcrumb.root'))
  const readOnlyProject = scope.kind === 'project' && scope.mode === 'ro'
  const writeLocked = scopeView !== null || alternateSource !== null || readOnlyProject

  const projectExtra = scope.kind === 'project' ? t('delete.confirm.project.extra') : ''
  const visibility = scope.kind === 'project'
    ? t('modal.visibility.project')
    : t('modal.visibility.personal')
  const visibleScope = scopeView !== null
    ? t('scope.viewing', { name: scopeView.label })
    : alternateSource === null
      ? visibility
      : t('copy.source.viewing', { name: alternateSource.label })
  const mobileScopeLabel = overviewMode
    ? t('scope.all')
    : alternateSource !== null
      ? t('copy.source.viewing', { name: alternateSource.label })
      : scopeView !== null
        ? scopeView.label
        : scope.kind === 'project'
          ? scope.projectName
          : t('copy.target.personal')

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

  const busy = uploading
  const uploadLabel = progress !== null && uploading
    ? t(progress.phase === 'verifying' ? 'modal.upload.verifyingCount' : 'modal.upload.progressCount', {
      current: String(progress.current),
      total: String(progress.total),
      percent: String(progress.percent),
    })
    : t('modal.upload')

  const uploadButton = (
    <Button
      className={css.upload}
      type="button"
      variant="primary"
      disabled={busy || writeLocked}
      icon={<IconPlusOutline16 size={16} />}
      onClick={() => fileInputRef.current?.click()}
    >
      {uploadLabel}
    </Button>
  )

  const selectionLabel = t('selection.selected', { count: String(selected.size) })
  const clearSelectionButton = (
    <Button type="button" variant="ghost" onClick={() => { setSelected(new Set()) }}>
      {t('selection.clear')}
    </Button>
  )

  const confirmMessage = deleteTargets !== null && deleteTargets.length > 1
    ? t('delete.confirm.message.many', { count: String(deleteTargets.length), projectExtra })
    : t('delete.confirm.message', { projectExtra })

  const showPager = filtered.length > PAGE_SIZE
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
      {phone ? (
        <Button
          className={css.rowMore}
          data-documents-row-more="folder"
          type="button"
          variant="ghost"
          aria-label={t('action.moreFolderNamed', { name: directory.name })}
          aria-haspopup="dialog"
          onClick={() => { setMobileSheet({ kind: 'directory', directory }) }}
        >
          <IconEllipsisOutline16 size={20} />
        </Button>
      ) : (
        <span className={css.actions}>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t('folder.renameNamed', { name: directory.name })}
            title={t('folder.rename')}
            disabled={busy || writeLocked}
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
            disabled={busy || writeLocked}
            onClick={() => { setDeleteDirectory(directory) }}
          >
            <span className={css.actionIcon} aria-hidden="true"><IconTrashOutline16 size={16} /></span>
            <span className={css.actionLabel}>{t('folder.delete')}</span>
          </Button>
        </span>
      )}
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
          {phone
            ? `${formatBytes(doc.bytes)} · ${getDateGroup(doc.modifiedAt)}`
            : sort.key === 'date'
              ? formatBytes(doc.bytes)
              : `${formatBytes(doc.bytes)} · ${getDateGroup(doc.modifiedAt)}`}
        </span>
      </div>
      {phone ? (
        scopeView === null && alternateSource === null ? (
          <Button
            className={css.rowMore}
            data-documents-row-more="document"
            type="button"
            variant="ghost"
            aria-label={t('action.moreNamed', { name: doc.name })}
            aria-haspopup="dialog"
            onClick={() => { setMobileSheet({ kind: 'document', document: doc }) }}
          >
            <IconEllipsisOutline16 size={20} />
          </Button>
        ) : (
          <span className={css.readOnlyBadge}>{t('scope.readOnly')}</span>
        )
      ) : (
        <span className={css.actions}>
          {scopeView === null && alternateSource === null && (
            <>
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
                disabled={busy || writeLocked}
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
                disabled={busy || writeLocked}
                onClick={() => { setDeleteTargets([doc]) }}
              >
                <span className={css.actionIcon} aria-hidden="true">
                  <IconTrashOutline16 size={16} />
                </span>
                <span className={css.actionLabel}>{t('action.delete')}</span>
              </Button>
            </>
          )}
        </span>
      )}
    </div>
  )

  const closeMobileSheet = () => { setMobileSheet(null) }

  const performMobileDocumentAction = (action: 'attach' | 'preview' | 'move' | 'download' | 'delete', doc: UserDocRef) => {
    setMobileSheet(null)
    switch (action) {
      case 'attach':
        attachDocument(doc)
        return
      case 'preview':
        setPreviewDoc(doc)
        return
      case 'move':
        void openMove([doc])
        return
      case 'download':
        return
      case 'delete':
        setDeleteTargets([doc])
        return
      default:
        /* v8 ignore next -- action is a closed local union. */
        return
    }
  }

  const performMobileDirectoryAction = (action: 'rename' | 'delete', directory: UserDocDirectoryRef) => {
    setMobileSheet(null)
    if (action === 'rename') openRenameDirectory(directory)
    else setDeleteDirectory(directory)
  }

  const performMobileBatchAction = (action: 'move' | 'copy' | 'delete') => {
    const targets = documents.filter(doc => selected.has(doc.docId))
    setMobileSheet(null)
    if (action === 'move') void openMove(targets)
    else if (action === 'copy') openCopy(targets)
    else setDeleteTargets(targets)
  }

  const mobileSheetContent = mobileSheet?.kind === 'scope' ? (
    <DocumentsMobileSheet
      open
      key={`scope-${mobileSheet.mode}`}
      kind={`scope-${mobileSheet.mode}`}
      title={mobileSheet.mode === 'source' ? t('copy.source.title') : t('scope.switch.title')}
      closeLabel={t('modal.close')}
      onClose={closeMobileSheet}
    >
      <p className={css.sheetDescription}>
        {mobileSheet.mode === 'source' ? t('copy.source.message') : t('scope.switch.message')}
      </p>
      {mobileScopeOptions.length > 1 && (
        <Input
          autoFocus
          className={css.sheetSearch as string}
          icon={<IconSearchOutline16 size={16} />}
          aria-label={t('scope.switch.search')}
          placeholder={t('scope.switch.search')}
          value={mobileSheet.query}
          onChange={(event) => {
            setMobileSheet(previous => previous?.kind === 'scope'
              ? { ...previous, query: event.target.value }
              : previous)
          }}
        />
      )}
      {(loading || overviewLoading || sourcePickerLoading) && (
        <p className={css.sheetStatus} aria-live="polite">{t('modal.loading')}</p>
      )}
      {error !== '' && <div className={css.sheetError} role="alert">{error}</div>}
      {overviewError !== '' && mobileSheet.mode === 'view' && <div className={css.sheetError} role="alert">{overviewError}</div>}
      <div className={css.sheetOptions} role="listbox" aria-label={t('scope.rail.label')}>
        {filteredMobileScopeOptions.length === 0 ? (
          <p className={css.sheetStatus}>{t('modal.noResults')}</p>
        ) : filteredMobileScopeOptions.map((option) => {
          const selectedOption = mobileSheet.mode === 'view' && option.value === mobileScopeValue
          const disabled = loading || overviewLoading || sourcePickerLoading
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selectedOption}
              className={`${css.sheetOption} ${selectedOption ? css.sheetOptionSelected : ''}`}
              disabled={disabled}
              onClick={() => { void selectMobileScope(option.value) }}
            >
              <span className={css.scopeItemIcon} aria-hidden="true">
                {option.kind === 'project' ? <IconFolderClose16 size={18} /> : <IconBrowseOutline16 size={18} />}
              </span>
              <span className={css.sheetOptionCopy}>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {selectedOption && <span className={css.sheetCheck} aria-hidden="true">✓</span>}
            </button>
          )
        })}
      </div>
    </DocumentsMobileSheet>
  ) : mobileSheet?.kind === 'more' ? (
    <DocumentsMobileSheet
      open
      key="toolbar-more"
      kind="toolbar-more"
      title={t('action.more')}
      closeLabel={t('modal.close')}
      onClose={closeMobileSheet}
    >
      <section className={css.sheetSection} aria-label={t('modal.filters')}>
        <h3 className={css.sheetSectionTitle}>{t('modal.filters')}</h3>
        <label className={css.sheetLabel} htmlFor="documents-mobile-type">{t('modal.type')}</label>
        <select
          id="documents-mobile-type"
          className={css.sheetSelect}
          value={typeFilter}
          disabled={busy}
          onChange={(event) => { setTypeFilter(event.currentTarget.value as DocumentTypeFilter) }}
        >
          {TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
        </select>
        <label className={css.sheetLabel} htmlFor="documents-mobile-sort">{t('modal.sort')}</label>
        <select
          id="documents-mobile-sort"
          className={css.sheetSelect}
          value={sortValue}
          disabled={busy}
          onChange={(event) => { setSortValue(event.currentTarget.value) }}
        >
          {SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
        </select>
      </section>
      <div className={css.sheetActions} role="list">
        <Button
          className={css.sheetAction}
          type="button"
          variant="ghost"
          disabled={busy || writeLocked}
          icon={<IconFolderClose16 size={18} />}
          onClick={() => { closeMobileSheet(); openCreateDirectory() }}
        >
          {t('folder.create')}
        </Button>
        <Button
          className={css.sheetAction}
          type="button"
          variant="ghost"
          disabled={busy}
          icon={<IconRefreshOutline16 size={18} />}
          onClick={() => { closeMobileSheet(); void load(currentDirectoryId) }}
        >
          {t('modal.refresh')}
        </Button>
        <Button
          className={css.sheetAction}
          type="button"
          variant="ghost"
          disabled={busy || historyLoading || overviewMode}
          onClick={() => { closeMobileSheet(); void openHistory() }}
        >
          {t('history.button')}
        </Button>
        {scopeView === null && alternateSource === null && sourceOptions.length > 0 && (
          <Button
            className={css.sheetAction}
            type="button"
            variant="ghost"
            disabled={busy}
            icon={<IconBrowseOutline16 size={18} />}
            onClick={() => { openMobileScopeSheet('source') }}
          >
            {t('copy.source')}
          </Button>
        )}
        {(scopeView !== null || alternateSource !== null) && (
          <Button
            className={css.sheetAction}
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => { closeMobileSheet(); void load(ROOT_DIRECTORY_ID) }}
          >
            {t('copy.source.current')}
          </Button>
        )}
      </div>
    </DocumentsMobileSheet>
  ) : mobileSheet?.kind === 'document' ? (
    <DocumentsMobileSheet
      open
      key={`document-${mobileSheet.document.docId}`}
      kind="document-actions"
      title={t('action.moreNamed', { name: mobileSheet.document.name })}
      closeLabel={t('modal.close')}
      onClose={closeMobileSheet}
    >
      <div className={css.sheetEntity}>
        <strong>{mobileSheet.document.name}</strong>
        <small>{formatBytes(mobileSheet.document.bytes)} · {getDateGroup(mobileSheet.document.modifiedAt)}</small>
      </div>
      <div className={css.sheetActions} role="list">
        <Button className={css.sheetAction} type="button" variant="ghost" disabled={busy} icon={<IconPaperclipOutline16 size={18} />} onClick={() => { performMobileDocumentAction('attach', mobileSheet.document) }}>{t('action.attach')}</Button>
        <Button className={css.sheetAction} type="button" variant="ghost" disabled={busy} icon={<IconInspectOutline12 size={18} />} onClick={() => { performMobileDocumentAction('preview', mobileSheet.document) }}>{t('action.preview')}</Button>
        <Button className={css.sheetAction} type="button" variant="ghost" disabled={busy || writeLocked} icon={<IconFolderOpenOutline16 size={18} />} onClick={() => { performMobileDocumentAction('move', mobileSheet.document) }}>{t('action.move')}</Button>
        <a
          className={css.sheetActionLink}
          href={userDocs.current.contentUrl(mobileSheet.document.docId)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('action.downloadNamed', { name: mobileSheet.document.name })}
          onClick={closeMobileSheet}
        >
          <IconDownloadOutline16 size={18} />{t('action.download')}
        </a>
        <Button className={`${css.sheetAction} ${css.sheetDanger}`} type="button" variant="ghost" disabled={busy || writeLocked} icon={<IconTrashOutline16 size={18} />} onClick={() => { performMobileDocumentAction('delete', mobileSheet.document) }}>{t('action.delete')}</Button>
      </div>
    </DocumentsMobileSheet>
  ) : mobileSheet?.kind === 'directory' ? (
    <DocumentsMobileSheet
      open
      key={`directory-${mobileSheet.directory.directoryId}`}
      kind="directory-actions"
      title={t('action.moreFolderNamed', { name: mobileSheet.directory.name })}
      closeLabel={t('modal.close')}
      onClose={closeMobileSheet}
    >
      <div className={css.sheetEntity}><strong>{mobileSheet.directory.name}</strong></div>
      <div className={css.sheetActions} role="list">
        <Button className={css.sheetAction} type="button" variant="ghost" disabled={busy || writeLocked} icon={<IconEditOutline16 size={18} />} onClick={() => { performMobileDirectoryAction('rename', mobileSheet.directory) }}>{t('folder.rename')}</Button>
        <Button className={`${css.sheetAction} ${css.sheetDanger}`} type="button" variant="ghost" disabled={busy || writeLocked} icon={<IconTrashOutline16 size={18} />} onClick={() => { performMobileDirectoryAction('delete', mobileSheet.directory) }}>{t('folder.delete')}</Button>
      </div>
    </DocumentsMobileSheet>
  ) : mobileSheet?.kind === 'overview' ? (
    <DocumentsMobileSheet
      open
      key={`overview-${mobileSheet.row.catalogId}`}
      kind="overview-actions"
      title={t('scope.copyNamed', { name: mobileSheet.row.name })}
      closeLabel={t('modal.close')}
      onClose={closeMobileSheet}
    >
      <div className={css.sheetEntity}>
        <strong>{mobileSheet.row.name}</strong>
        <small>{mobileSheet.row.scope.label} · {formatBytes(mobileSheet.row.bytes)} · {mobileSheet.row.owner?.displayName ?? t('scope.owner.unknown')}</small>
      </div>
      <Button className={css.sheetAction} type="button" variant="primary" disabled={overviewLoading} icon={<IconCopyOutline16 size={18} />} onClick={() => { closeMobileSheet(); void openOverviewCopy(mobileSheet.row) }}>{t('scope.copy')}</Button>
    </DocumentsMobileSheet>
  ) : mobileSheet?.kind === 'selection' ? (
    <DocumentsMobileSheet
      open
      key="batch-actions"
      kind="batch-actions"
      title={t('selection.actions')}
      closeLabel={t('modal.close')}
      onClose={closeMobileSheet}
    >
      <p className={css.sheetDescription}>{t('selection.selected', { count: String(selected.size) })}</p>
      <div className={css.sheetActions} role="list">
        <Button className={css.sheetAction} type="button" variant="ghost" disabled={busy || writeLocked} icon={<IconFolderOpenOutline16 size={18} />} onClick={() => { performMobileBatchAction('move') }}>{t('selection.move')}</Button>
        <Button className={css.sheetAction} type="button" variant="ghost" disabled={busy} icon={<IconCopyOutline16 size={18} />} onClick={() => { performMobileBatchAction('copy') }}>{t('selection.copy')}</Button>
        <Button className={`${css.sheetAction} ${css.sheetDanger}`} type="button" variant="ghost" disabled={busy || writeLocked} icon={<IconTrashOutline16 size={18} />} onClick={() => { performMobileBatchAction('delete') }}>{t('selection.delete')}</Button>
      </div>
    </DocumentsMobileSheet>
  ) : null

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
        <div className={css.workbench}>
          <aside className={css.scopeRail} aria-label={t('scope.rail.label')}>
            <div className={css.scopeRailHeading}>{t('scope.rail.title')}</div>
            <button type="button" className={`${css.scopeItem} ${overviewMode ? css.scopeItemActive : ''}`} onClick={() => { void openOverview() }} disabled={overviewLoading || loading}>
              <span className={css.scopeItemIcon} aria-hidden="true"><IconBrowseOutline16 size={16} /></span>
              <span><strong>{t('scope.all')}</strong><small>{t('scope.all.description')}</small></span>
            </button>
            <button type="button" className={`${css.scopeItem} ${!overviewMode && alternateSource === null && (scopeView?.scope.kind === 'personal' || (scopeView === null && scope.kind === 'personal')) ? css.scopeItemActive : ''}`} onClick={() => { void openScopeView({ kind: 'personal' }, t('copy.target.personal')) }} disabled={loading || overviewLoading}>
              <span className={css.scopeItemIcon} aria-hidden="true"><IconPaperclipOutline16 size={16} /></span>
              <span><strong>{t('copy.target.personal')}</strong><small>{t('scope.personal.description')}</small></span>
            </button>
            {(scope.projects ?? []).map((project) => {
              const isCurrent = !overviewMode && alternateSource === null && ((scopeView?.scope.kind === 'project' && scopeView.scope.projectId === project.projectId) || (scopeView === null && scope.kind === 'project' && scope.projectId === project.projectId))
              return <button key={project.projectId} type="button" className={`${css.scopeItem} ${isCurrent ? css.scopeItemActive : ''}`} onClick={() => { void openScopeView({ kind: 'project', projectId: project.projectId }, project.name) }} disabled={loading || overviewLoading}>
                <span className={css.scopeItemIcon} aria-hidden="true"><IconFolderClose16 size={16} /></span>
                <span><strong>{project.name}</strong><small>{project.mode.toUpperCase()} · {t('scope.project.description')}</small></span>
              </button>
            })}
          </aside>
          <div className={css.workbenchContent}>
            {phone && (
              <button
                type="button"
                className={css.scopeTrigger}
                data-documents-scope-trigger=""
                data-testid="documents-scope-trigger"
                aria-haspopup="dialog"
                aria-expanded={mobileSheet?.kind === 'scope' && mobileSheet.mode === 'view'}
                disabled={busy || loading || overviewLoading}
                onClick={() => { openMobileScopeSheet('view') }}
              >
                <span className={css.scopeItemIcon} aria-hidden="true"><IconBrowseOutline16 size={18} /></span>
                <span className={css.scopeTriggerCopy}>
                  <strong>{mobileScopeLabel}</strong>
                  <small>{visibleScope}</small>
                </span>
                <IconChevronDownOutline14 className={css.scopeTriggerChevron} size={14} />
              </button>
            )}
            <div
              className={`${css.panel}${dropActive ? ` ${css.dropActive}` : ''}${overviewMode ? ` ${css.overviewPanel}` : ''}`}
              data-documents-panel=""
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              {error !== '' && <div className={css.error} role="alert">{error}</div>}
              {overviewMode && (
                <section className={css.overview} aria-label={t('scope.all')}>
                  <header className={css.overviewHeader}>
                    <div><h2>{t('scope.all')}</h2><p>{t('scope.all.description')}</p></div>
                    <Button type="button" variant="ghost" icon={<IconRefreshOutline16 size={16} />} disabled={overviewLoading} onClick={() => { void openOverview() }}>{t('modal.refresh')}</Button>
                  </header>
                  {overviewError !== '' && <div className={css.error} role="alert">{overviewError}</div>}
                  {overviewLoading ? <p className={css.status}>{t('scope.all.loading')}</p> : overviewRows.length === 0 ? <p className={css.empty}>{t('scope.all.empty')}</p> : (
                    <div className={css.overviewList} role="list">
                      {overviewRows.map(row => <div key={row.catalogId} className={css.overviewRow} role="listitem">
                        <span className={css.fileIcon} aria-hidden="true"><IconBrowseOutline16 size={16} /></span>
                        <div className={css.meta}><span className={css.name}>{row.name}</span><span className={css.size}>{row.scope.label} · {formatBytes(row.bytes)} · {row.owner?.displayName ?? t('scope.owner.unknown')}</span></div>
                        {phone ? (
                          <Button
                            className={css.rowMore}
                            data-documents-row-more="overview"
                            type="button"
                            variant="ghost"
                            aria-label={t('scope.copyNamed', { name: row.name })}
                            aria-haspopup="dialog"
                            disabled={overviewLoading}
                            onClick={() => { setMobileSheet({ kind: 'overview', row }) }}
                          >
                            <IconEllipsisOutline16 size={20} />
                          </Button>
                        ) : (
                          <Button type="button" size="sm" variant="outline" disabled={overviewLoading} onClick={() => { void openOverviewCopy(row) }}>{t('scope.copy')}</Button>
                        )}
                      </div>)}
                    </div>
                  )}
                </section>
              )}

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
                <div className={css.filterGroup} role="group" aria-label={t('modal.filters')}>
                  <Input
                    className={css.search as string}
                    icon={<IconSearchOutline16 size={16} />}
                    placeholder={t('modal.search')}
                    value={query}
                    onChange={(event) => { setQuery(event.target.value) }}
                  />
                  {!phone && (
                    <>
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
                    </>
                  )}
                </div>
                <div className={`${css.actionGroup}${phone ? ` ${css.mobileActionGroup}` : ''}`} role="group" aria-label={t('modal.actions')}>
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
                  {phone ? (
                    <>
                      {uploadButton}
                      <Button
                        className={css.mobileMore}
                        data-documents-toolbar-more=""
                        type="button"
                        variant="outline"
                        aria-label={t('action.more')}
                        aria-haspopup="dialog"
                        aria-expanded={mobileSheet?.kind === 'more'}
                        disabled={busy}
                        icon={<IconEllipsisOutline16 size={18} />}
                        onClick={() => { setMobileSheet({ kind: 'more' }) }}
                      >
                        {t('action.more')}
                      </Button>
                    </>
                  ) : (
                    <>
                      {scopeView === null && alternateSource === null && sourceOptions.length > 0 && (
                        <Button
                          className={css.sourceAction}
                          type="button"
                          variant="outline"
                          disabled={busy}
                          icon={<IconBrowseOutline16 size={16} />}
                          onClick={openSourcePicker}
                        >
                          {t('copy.source')}
                        </Button>
                      )}
                      {(scopeView !== null || alternateSource !== null) && (
                        <Button
                          className={css.sourceAction}
                          type="button"
                          variant="outline"
                          disabled={busy}
                          onClick={() => { void load(ROOT_DIRECTORY_ID) }}
                        >
                          {t('copy.source.current')}
                        </Button>
                      )}
                      <Button
                        className={css.newFolder}
                        type="button"
                        variant="outline"
                        disabled={busy || writeLocked}
                        icon={<IconFolderClose16 size={16} />}
                        onClick={openCreateDirectory}
                      >
                        {t('folder.create')}
                      </Button>
                      {uploadButton}
                      <Button
                        className={css.refresh}
                        type="button"
                        variant="ghost"
                        aria-label={t('modal.refresh')}
                        disabled={busy}
                        icon={<IconRefreshOutline16 size={16} />}
                        onClick={() => { void load(currentDirectoryId) }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy || historyLoading || overviewMode}
                        onClick={() => { void openHistory() }}
                      >
                        {t('history.button')}
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <div className={css.caption}>
                <span>{visibleScope}</span>
                {!loading && <span>{t('modal.count', { count: String(filtered.length) })}</span>}
              </div>

              {selected.size > 0 && (
                <div className={`${css.selectionBar} ${css.desktopSelectionBar}`}>
                  <span>{selectionLabel}</span>
                  {clearSelectionButton}
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy || writeLocked}
                    onClick={() => { void openMove(documents.filter(doc => selected.has(doc.docId))) }}
                  >
                    {t('selection.move')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => { openCopy(documents.filter(doc => selected.has(doc.docId))) }}
                  >
                    {t('selection.copy')}
                  </Button>
                  <Button
                    className={css.selectionDelete}
                    type="button"
                    variant="primary"
                    disabled={busy || writeLocked}
                    onClick={() => {
                      setDeleteTargets(documents.filter(doc => selected.has(doc.docId)))
                    }}
                  >
                    {t('selection.delete')}
                  </Button>
                </div>
              )}

              {progress !== null && (
                <div
                  className={css.progress}
                  role="progressbar"
                  aria-label={uploadLabel}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress.percent}
                >
                  <span style={{ width: `${String(progress.percent)}%` }} />
                </div>
              )}

              {loading ? (
                <p className={css.status}>{t('modal.loading')}</p>
              ) : !hasEntries ? (
                <div className={css.emptyState}>
                  <p className={css.empty}>{t('modal.empty')}</p>
                  {phone && !writeLocked && (
                    <div className={css.emptyActions}>
                      <Button type="button" variant="primary" icon={<IconPlusOutline16 size={16} />} onClick={() => { fileInputRef.current?.click() }}>
                        {t('modal.upload')}
                      </Button>
                      <Button type="button" variant="outline" disabled={busy} icon={<IconFolderClose16 size={16} />} onClick={openCreateDirectory}>
                        {t('folder.create')}
                      </Button>
                    </div>
                  )}
                </div>
              ) : !hasVisibleEntries ? (
                <div className={css.emptyState}>
                  <p className={css.empty}>{t('modal.noResults')}</p>
                  <Button type="button" variant="ghost" onClick={() => {
                    setQuery('')
                    setTypeFilter('all')
                    setSortValue('date:desc')
                  }}>
                    {t('modal.clearFilters')}
                  </Button>
                </div>
              ) : (
                <div className={css.list} role="list" aria-label={t('modal.title')} data-documents-list="">
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
              {phone && selected.size > 0 && (
                <div className={css.mobileSelectionBar} data-documents-batch-bar="" data-testid="documents-batch-bar">
                  <span className={css.mobileSelectionCount}>{selectionLabel}</span>
                  {clearSelectionButton}
                  <Button
                    type="button"
                    variant="primary"
                    aria-haspopup="dialog"
                    onClick={() => { setMobileSheet({ kind: 'selection' }) }}
                  >
                    {t('selection.actions')}
                  </Button>
                </div>
              )}
              <div className={css.drop} aria-hidden="true">{t('modal.drop')}</div>
            </div>
          </div>
        </div>
      </Modal>

      {mobileSheetContent}

      {historyOpen && (
        <Modal
          open
          onClose={() => { if (!historyLoading) setHistoryOpen(false) }}
          title={t('history.title')}
          closeLabel={t('modal.close')}
          className={css.confirmDialog as string}
        >
          {historyLoading ? <p className={css.status}>{t('history.loading')}</p> : historyItems.length === 0 ? <p className={css.empty}>{t('history.empty')}</p> : (
            <ol className={css.historyList}>
              {historyItems.map(item => (
                <li key={item.id}>
                  <span><strong>{item.eventKind}</strong><small>{item.documentName ?? t('history.unknown')} · {item.actor?.displayName ?? t('history.system')}</small></span>
                  <span className={css.size}>{new Date(item.createdAt).toLocaleString()}</span>
                </li>
              ))}
            </ol>
          )}
        </Modal>
      )}

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
              <Button type="button" variant="primary" disabled={busy || writeLocked} onClick={() => { void handleDelete() }}>
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
              <Button type="submit" variant="primary" disabled={busy || writeLocked || folderName.trim() === ''}>
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
              <Button type="button" variant="primary" disabled={busy || writeLocked} onClick={() => { void handleDeleteDirectory() }}>
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
                disabled={busy || writeLocked || moveLoading || moveOptions.length === 0 || moveDirectoryId === currentDirectoryId}
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

      {copyTargets !== null && (
        <Modal
          open
          onClose={() => {
            if (!busy) {
              setCopyTargets(null)
              setOverviewCopyRow(null)
              setModalError('')
            }
          }}
          title={t('copy.title')}
          closeLabel={t('modal.close')}
          className={css.confirmDialog as string}
          footer={(
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => {
                setCopyTargets(null)
                setOverviewCopyRow(null)
                setModalError('')
              }}>
                {t('modal.cancel')}
              </Button>
              <Button type="button" variant="primary" disabled={busy || copyTarget === ''} onClick={() => { void handleCopy() }}>
                {t('copy.confirm')}
              </Button>
            </>
          )}
        >
          {modalError !== '' && <div className={css.error} role="alert">{modalError}</div>}
          <div className={css.form}>
            <p className={css.confirm}>{t('copy.message', { count: String(overviewCopyRow === null ? selected.size : 1) })}</p>
            <label className={css.formLabel} htmlFor="documents-copy-target">{t('copy.target')}</label>
            <select
              id="documents-copy-target"
              className={`${css.select} ${css.moveSelect}`}
              value={copyTarget}
              onChange={(event) => { setCopyTarget(event.currentTarget.value) }}
            >
              {copyTargets.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <label className={css.formLabel} htmlFor="documents-copy-directory">{t('copy.directory')}</label>
            {copyDirectoryLoading ? <p className={css.status}>{t('copy.directory.loading')}</p> : (
              <select
                id="documents-copy-directory"
                className={`${css.select} ${css.moveSelect}`}
                value={copyDirectory}
                onChange={(event) => { setCopyDirectory(event.currentTarget.value as UserDocDirectoryIdType) }}
                disabled={busy}
              >
                <option value="">{t('breadcrumb.root')}</option>
                {copyDirectories.map(directory => (
                  <option key={directory.directoryId} value={directory.directoryId}>{directory.name}</option>
                ))}
              </select>
            )}
            {typeof userDocs.current.createScopeDirectory === 'function' && (
              <div className={css.inlineForm}>
                <Input value={copyFolderName} placeholder={t('copy.directory.new')} onChange={(event) => { setCopyFolderName(event.target.value) }} disabled={copyFolderCreating || busy} />
                <Button type="button" variant="outline" disabled={copyFolderCreating || busy || copyFolderName.trim() === ''} onClick={() => { void createCopyFolder() }}>{t('folder.create')}</Button>
              </div>
            )}
            {copyLoading && <p className={css.status}>{t('copy.loading')}</p>}
            {failedCopyItems.length > 0 && (
              <div className={css.failedCopies}>
                <span className={css.formLabel}>{t('copy.retry.title')}</span>
                {failedCopyItems.map(item => (
                  <div key={item.docId} className={css.failedCopyRow}>
                    <span className={css.name} title={item.name}>{item.name}</span>
                    <Button type="button" size="sm" variant="outline" disabled={copyLoading || retryingCopyId !== null} onClick={() => { void retryCopy(item) }}>
                      {retryingCopyId === item.docId ? t('copy.retry.loading') : t('copy.retry.button')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {sourcePickerOpen && (
        <Modal
          open
          onClose={() => {
            if (!sourcePickerLoading) setSourcePickerOpen(false)
          }}
          title={t('copy.source.title')}
          closeLabel={t('modal.close')}
          className={css.confirmDialog as string}
          footer={(
            <>
              <Button type="button" variant="outline" disabled={sourcePickerLoading} onClick={() => { setSourcePickerOpen(false) }}>
                {t('modal.cancel')}
              </Button>
              <Button type="button" variant="primary" disabled={sourcePickerLoading || sourcePickerValue === ''} onClick={() => { void browseSource() }}>
                {t('copy.source.open')}
              </Button>
            </>
          )}
        >
          <div className={css.form}>
            <p className={css.confirm}>{t('copy.source.message')}</p>
            <label className={css.formLabel} htmlFor="documents-source-scope">{t('copy.source.label')}</label>
            <select
              id="documents-source-scope"
              className={`${css.select} ${css.moveSelect}`}
              value={sourcePickerValue}
              onChange={(event) => { setSourcePickerValue(event.currentTarget.value) }}
            >
              {sourceOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {sourcePickerLoading && <p className={css.status}>{t('copy.source.loading')}</p>}
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
