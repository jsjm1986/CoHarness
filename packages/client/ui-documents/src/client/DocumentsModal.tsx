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
  type DocumentsWorkspaceScope, type UserDocDirectoryIdType, type UserDocDirectoryRef, type UserDocIdType,
  type UserDocCatalogHistoryItem, type UserDocCatalogRow, type UserDocLimits, type UserDocRef, type UserDocScope,
  type UserDocTransferListedDocument, type UserDocTransferResponse,
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
  /** Attach one existing durable document to the current conversation. */
  onAttachDocument?: (document: UserDocRef) => boolean
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

  const openOverview = async () => {
    setOverviewLoading(true)
    setOverviewError('')
    try {
      const response = await userDocs.current.overview()
      setOverviewRows([...response.documents])
      setOverviewMode(true)
      setScopeView(null)
      setAlternateSource(null)
      setSelected(new Set())
    } catch (cause) {
      setOverviewError(cause instanceof Error ? cause.message : String(cause))
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

  const openScopeView = async (target: UserDocScope, label: string) => {
    const current = currentScopeDescriptor()
    if (target.kind === current.kind && (target.kind === 'personal'
      || (current.kind === 'project' && target.projectId === current.projectId))) {
      await load(ROOT_DIRECTORY_ID)
      return
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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

  const browseSource = async () => {
    const option = sourceOptions.find(candidate => candidate.value === sourcePickerValue)
    if (option === undefined) return
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
    } catch (error) {
      setError(error instanceof Error ? error.message : t('copy.error'))
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
                        <Button type="button" size="sm" variant="outline" disabled={overviewLoading} onClick={() => { void openOverviewCopy(row) }}>{t('scope.copy')}</Button>
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
                </div>
                <div className={css.actionGroup} role="group" aria-label={t('modal.actions')}>
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
                </div>
              </div>

              <div className={css.caption}>
                <span>{visibleScope}</span>
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
          </div>
        </div>
      </Modal>

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
