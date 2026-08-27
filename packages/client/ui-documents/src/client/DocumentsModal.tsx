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
  createUserDocClient, readDocumentsScopeResult, UserDocHttpError, UserDocServiceUnavailableError,
  type DocumentsWorkspaceScope, type UserDocDirectoryIdType, type UserDocDirectoryRef, type UserDocIdType,
  type UserDocCatalogHistoryItem, type UserDocCatalogOverview, type UserDocCatalogRow, type UserDocLimits,
  type UserDocRef, type UserDocScope,
  type UserDocListQuery,
  type UserDocUploadPhase,
  type UserDocTransferListedDocument, type UserDocTransferResponse,
  type UserDocTrashRef,
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
  /** Presentation intent: full management or choosing documents for a draft. */
  mode?: 'manage' | 'select'
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

function documentErrorMessage(error: unknown, t: (key: DocumentsKey) => string): string {
  if (error instanceof UserDocHttpError) {
    if (error.code === 'INSTANCE_STARTING') return t('error.runtimeStarting')
    if (error.code === 'INSTANCE_UNREACHABLE' || error.code === 'COLLABORATION_UNAVAILABLE') {
      return t('error.runtimeUnavailable')
    }
    if (error.code === 'DOCUMENT_LIST_QUERY') return t('error.listQuery')
    if (error.code === 'DOCUMENT_TRASH_NOT_FOUND') return t('error.trashUnavailable')
    if (error.code === 'DOCUMENT_RESTORE_CONFLICT') return t('trash.restore.error')
  }
  return error instanceof Error ? error.message : String(error)
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
  mode: 'ro' | 'rw'
}

/** Compatibility view for a client record that may expose alternate-scope browsing. */
type BrowseScopeFunction = (
  scope: UserDocScope,
  directoryId: UserDocDirectoryIdType,
  signal?: AbortSignal,
  query?: UserDocListQuery,
) => Promise<{
  readonly documents: readonly UserDocRef[]
  readonly directories: readonly UserDocDirectoryRef[]
  readonly directoryId: UserDocDirectoryIdType
  readonly limits?: UserDocLimits
  readonly parentDirectoryId?: UserDocDirectoryIdType
  readonly totalDocuments?: number
  readonly nextCursor?: string
}>

function browseScopeOf(value: unknown): BrowseScopeFunction | undefined {
  return typeof value === 'function' ? value as BrowseScopeFunction : undefined
}

/** Metadata-only view selected from the workbench scope rail. */
interface ScopeView {
  value: string
  label: string
  scope: UserDocScope
  mode: 'ro' | 'rw'
  canUpload: boolean
}

type MobileScopeOption =
  | { value: string; label: string; description: string; kind: 'all' | 'personal' | 'source' }
  | { value: string; label: string; description: string; kind: 'project'; projectId: number }

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

interface ServerPageRecord {
  readonly documents: readonly UserDocRef[]
  readonly directories: readonly UserDocDirectoryRef[]
  readonly directoryId: UserDocDirectoryIdType
  readonly parentDirectoryId?: UserDocDirectoryIdType
  readonly limits: UserDocLimits | null
  readonly totalDocuments: number | null
  readonly nextCursor?: string
}

type MobileSheetState =
  | { kind: 'scope'; mode: 'view' | 'source' | 'upload'; query: string }
  | { kind: 'more' }
  | { kind: 'document'; document: UserDocRef }
  | { kind: 'directory'; directory: UserDocDirectoryRef }
  | { kind: 'overview'; row: UserDocCatalogRow }
  | { kind: 'selection' }

const MAX_PREVIEW_TEXT_BYTES = 256 * 1024
const ROOT_DIRECTORY_ID = '' as UserDocDirectoryIdType
const MAX_SERVER_PAGE_CACHE_KEYS = 24
const MAX_SERVER_PAGES_PER_KEY = 8

const DEFAULT_SORT: DocumentSort = { key: 'date', dir: 'desc' }

/** Wire sort value used by the paged document endpoint. */
function wireSort(sort: DocumentSort): NonNullable<UserDocListQuery['sort']> {
  const key = sort.key === 'date' ? 'date' : sort.key === 'name' ? 'name' : 'size'
  return `${key}-${sort.dir}`
}

/** Stable key for a scope so page caches never cross an authorization context. */
function scopeCacheKey(value: UserDocScope): string {
  return value.kind === 'personal' ? 'personal' : `project:${String(value.projectId)}`
}

/** Compare scope identities without depending on display labels or modes. */
function sameDocumentScope(left: UserDocScope, right: UserDocScope): boolean {
  if (left.kind !== right.kind) return false
  return left.kind === 'personal' || (right.kind === 'project' && left.projectId === right.projectId)
}

function documentScopeOf(value: DocumentsWorkspaceScope): UserDocScope {
  return value.kind === 'project' && value.projectId !== undefined
    ? { kind: 'project', projectId: value.projectId }
    : { kind: 'personal' }
}

function catalogRowScope(row: UserDocCatalogRow): UserDocScope {
  return row.scope.kind === 'project' && row.scope.id !== undefined
    ? { kind: 'project', projectId: row.scope.id }
    : { kind: 'personal' }
}

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

function projectModeLabel(mode: 'ro' | 'rw', t: (key: DocumentsKey) => string): string {
  return t(mode === 'rw' ? 'scope.project.mode.editable' : 'scope.project.mode.readOnly')
}

function documentMetaLabel(
  document: Pick<UserDocRef, 'bytes' | 'modifiedAt'>,
  t: (key: DocumentsKey, params?: Record<string, string>) => string,
  includeDate: boolean,
): string {
  const size = formatBytes(document.bytes)
  if (!includeDate) return size
  return t('document.meta', {
    size,
    date: getDateGroup(document.modifiedAt, t('date.unknown')),
  })
}

function overviewMetaLabel(
  row: UserDocCatalogRow,
  t: (key: DocumentsKey, params?: Record<string, string>) => string,
): string {
  return t('overview.meta', {
    scope: row.scope.label,
    size: formatBytes(row.bytes),
    owner: row.owner?.displayName ?? t('scope.owner.unknown'),
  })
}

function trashMetaLabel(
  document: UserDocTrashRef,
  t: (key: DocumentsKey, params?: Record<string, string>) => string,
): string {
  const days = Math.max(0, Math.ceil((document.purgeAfter - Date.now()) / 86_400_000))
  return t('trash.meta', { date: getDateGroup(document.trashedAt, t('date.unknown')), days: String(days) })
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

function normalizeDirectoryRef(value: {
  readonly directoryId: string
  readonly name: string
  readonly path?: string
  readonly modifiedAt?: number
}): UserDocDirectoryRef {
  return {
    directoryId: value.directoryId as UserDocDirectoryIdType,
    name: value.name,
    path: value.path ?? '',
    modifiedAt: value.modifiedAt ?? 0,
  }
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
export const DocumentsModal: FC<DocumentsModalProps> = ({ open, onClose, t, mode = 'manage', onAttachDocument }) => {
  const phone = useMediaQuery('(max-width: 767px)')
  const [documents, setDocuments] = useState<UserDocRef[]>([])
  const [directories, setDirectories] = useState<UserDocDirectoryRef[]>([])
  const [currentDirectoryId, setCurrentDirectoryId] = useState<UserDocDirectoryIdType>(ROOT_DIRECTORY_ID)
  const [limits, setLimits] = useState<UserDocLimits | null>(null)
  const [totalDocuments, setTotalDocuments] = useState<number | null>(null)
  const [scope, setScope] = useState<DocumentsWorkspaceScope>({ kind: 'personal' })
  const [scopeStatus, setScopeStatus] = useState<'loading' | 'ready' | 'stale'>('loading')
  const [scopeView, setScopeView] = useState<ScopeView | null>(null)
  const [alternateSource, setAlternateSource] = useState<SourceOption | null>(null)
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false)
  const [sourcePickerValue, setSourcePickerValue] = useState('')
  const [sourcePickerQuery, setSourcePickerQuery] = useState('')
  const [sourcePickerLoading, setSourcePickerLoading] = useState(false)
  const [uploadScopePickerOpen, setUploadScopePickerOpen] = useState(false)
  const [uploadScopePickerValue, setUploadScopePickerValue] = useState('')
  const [uploadScopePickerQuery, setUploadScopePickerQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [modalError, setModalError] = useState('')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<DocumentTypeFilter>('all')
  const [sortValue, setSortValue] = useState('date:desc')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [selectedRecords, setSelectedRecords] = useState<Map<string, UserDocRef>>(() => new Map())
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
  const [overviewPage, setOverviewPage] = useState(1)
  const [overviewServerPaging, setOverviewServerPaging] = useState(false)
  const [overviewTotalDocuments, setOverviewTotalDocuments] = useState<number | null>(null)
  const [overviewNextCursor, setOverviewNextCursor] = useState<string | undefined>()
  const overviewCursors = useRef<string[]>([])
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [overviewCopyRow, setOverviewCopyRow] = useState<OverviewCopyTarget | null>(null)
  const [overviewError, setOverviewError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyItems, setHistoryItems] = useState<UserDocCatalogHistoryItem[]>([])
  const [mobileSheet, setMobileSheet] = useState<MobileSheetState | null>(null)
  const [trashMode, setTrashMode] = useState(false)
  const [trashDocuments, setTrashDocuments] = useState<UserDocTrashRef[]>([])
  const [trashLoading, setTrashLoading] = useState(false)
  const [trashNextCursor, setTrashNextCursor] = useState<string | undefined>()
  const [trashPage, setTrashPage] = useState(1)
  const trashCursors = useRef<string[]>([])
  const [purgeTarget, setPurgeTarget] = useState<UserDocTrashRef | null>(null)
  /** Whether the current provider answered with the cursor-based listing contract. */
  const [serverPaging, setServerPaging] = useState(false)
  const [serverTotalDocuments, setServerTotalDocuments] = useState<number | null>(null)
  const [serverNextCursor, setServerNextCursor] = useState<string | undefined>()
  const serverPagingRef = useRef(false)
  const listingReadyRef = useRef(false)
  const serverPages = useRef(new Map<string, Map<number, ServerPageRecord>>())
  const serverRequestGeneration = useRef(0)
  const serverLoadedKey = useRef<string | null>(null)
  const overviewRequestGeneration = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const headerCheckRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const loadGeneration = useRef(0)
  const userDocs = useRef(createUserDocClient())
  const listingCache = useRef(new Map<string, {
    readonly documents: readonly UserDocRef[]
    readonly directories: readonly UserDocDirectoryRef[]
    readonly directoryId: UserDocDirectoryIdType
    readonly limits: UserDocLimits | null
  }>())
  const scopeCache = useRef<DocumentsWorkspaceScope | null>(null)
  const overviewCache = useRef<{ readonly key: string; readonly response: UserDocCatalogOverview } | null>(null)
  const overviewLoadedKey = useRef<string | null>(null)

  const rememberServerPage = (key: string, pageNumber: number, record: ServerPageRecord): void => {
    let pages = serverPages.current.get(key)
    if (pages === undefined) {
      pages = new Map<number, ServerPageRecord>()
      serverPages.current.set(key, pages)
    }
    pages.set(pageNumber, record)
    while (pages.size > MAX_SERVER_PAGES_PER_KEY) {
      const keys = [...pages.keys()]
      const oldest = keys.find(value => value !== 1) ?? keys[0]
      if (oldest === undefined) break
      pages.delete(oldest)
    }
    while (serverPages.current.size > MAX_SERVER_PAGE_CACHE_KEYS) {
      const oldestKey = serverPages.current.keys().next().value
      if (oldestKey === undefined || oldestKey === key) break
      serverPages.current.delete(oldestKey)
    }
  }

  const runtimeScope = (): UserDocScope => documentScopeOf(scope)

  const cachedRuntimeScope = (): UserDocScope => scopeCache.current === null
    ? { kind: 'personal' }
    : documentScopeOf(scopeCache.current)

  const listingScope = (): UserDocScope => scopeView?.scope ?? alternateSource?.scope ?? runtimeScope()

  const overviewFilterKey = (): string => JSON.stringify({
    query: query.trim(),
    type: typeFilter,
    sort: wireSort(parseSort(sortValue)),
  })

  const clearSelection = (): void => {
    setSelected(new Set())
    setSelectedRecords(new Map())
  }

  const selectedDocumentList = (): UserDocRef[] => {
    const result: UserDocRef[] = []
    for (const id of selected) {
      const document = selectedRecords.get(id) ?? documents.find(candidate => candidate.docId === id)
      if (document !== undefined) result.push(document)
    }
    return result
  }

  const listingKeyFor = (target: UserDocScope, directoryId: UserDocDirectoryIdType): string => JSON.stringify({
    scope: scopeCacheKey(target),
    directory: String(directoryId),
    query: query.trim(),
    type: typeFilter,
    sort: wireSort(parseSort(sortValue)),
  })

  const listingKey = (directoryId: UserDocDirectoryIdType): string => listingKeyFor(
    scopeView?.scope ?? alternateSource?.scope ?? cachedRuntimeScope(), directoryId,
  )

  const queryForPage = (cursor?: string): UserDocListQuery => ({
    limit: PAGE_SIZE,
    query: query.trim(),
    type: typeFilter,
    sort: wireSort(parseSort(sortValue)),
    ...(cursor === undefined ? {} : { cursor }),
  })

  /**
   * Request one directory from an explicitly selected scope.
   *
   * `browseScope` is the full browser contract. Older clients only expose the
   * metadata transfer listing, whose extra arguments are intentionally ignored;
   * keeping that fallback here means folder navigation does not become a
   * dead-end when a runtime is upgraded before the browser bundle.
   */
  const fetchScopeListing = async (
    target: UserDocScope,
    directoryId: UserDocDirectoryIdType,
    listingQuery: UserDocListQuery,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const clientRecord = userDocs.current as unknown as Record<string, unknown>
    const browseScope = browseScopeOf(clientRecord.browseScope)
    if (browseScope !== undefined) return browseScope(target, directoryId, signal, listingQuery)
    const client = userDocs.current
    const listScope = client.listScope.bind(client)
    // Older metadata-only clients expose a one-argument function. Preserve its
    // exact call shape; newer clients advertise the directory/query form.
    return listScope.length >= 2
      ? listScope(target, signal, directoryId, listingQuery)
      : listScope(target)
  }

  const isServerPage = (value: unknown): value is {
    readonly documents: readonly UserDocRef[]
    readonly directories?: readonly UserDocDirectoryRef[]
    readonly directoryId?: UserDocDirectoryIdType
    readonly parentDirectoryId?: UserDocDirectoryIdType
    readonly limits?: UserDocLimits
    readonly totalDocuments?: number
    readonly nextCursor?: string
  } => {
    if (value === null || typeof value !== 'object') return false
    const candidate = value as Record<string, unknown>
    return Array.isArray(candidate.documents)
      && (Object.hasOwn(candidate, 'totalDocuments') || Object.hasOwn(candidate, 'nextCursor'))
  }

  const fetchListingPage = async (
    directoryId: UserDocDirectoryIdType,
    listingQuery: UserDocListQuery,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const target = listingScope()
    const remote = scopeView !== null || alternateSource !== null
    if (!remote) return userDocs.current.browse(directoryId, signal, listingQuery)
    return fetchScopeListing(target, directoryId, listingQuery, signal)
  }

  const applyServerPage = (pageRecord: ServerPageRecord): void => {
    setDocuments([...pageRecord.documents])
    setDirectories([...pageRecord.directories])
    setCurrentDirectoryId(pageRecord.directoryId)
    setLimits(pageRecord.limits)
    setTotalDocuments(pageRecord.totalDocuments)
    setServerTotalDocuments(pageRecord.totalDocuments)
    setServerNextCursor(pageRecord.nextCursor)
  }

  const loadServerPage = async (
    requestedPage: number,
    directoryId: UserDocDirectoryIdType = currentDirectoryId,
    force = false,
  ): Promise<boolean> => {
    const generation = serverRequestGeneration.current + 1
    serverRequestGeneration.current = generation
    const key = listingKey(directoryId)
    serverLoadedKey.current = key
    let pagesForKey = serverPages.current.get(key)
    if (pagesForKey === undefined || force) {
      pagesForKey = new Map<number, ServerPageRecord>()
      serverPages.current.set(key, pagesForKey)
    }
    const cached = force ? undefined : pagesForKey.get(requestedPage)
    setLoading(true)
    setError('')
    setNotice('')
    try {
      let pageRecord = cached
      if (pageRecord === undefined) {
        let cursor: string | undefined
        if (requestedPage > 1) {
          const previous = pagesForKey.get(requestedPage - 1)
          cursor = previous?.nextCursor
          // The visible pager advances one page at a time, so a missing
          // predecessor means the continuation chain is no longer usable.
          if (cursor === undefined) {
            if (serverLoadedKey.current === key) serverLoadedKey.current = null
            return false
          }
        }
        const response = await fetchListingPage(directoryId, queryForPage(cursor)) as {
          readonly documents: readonly UserDocRef[]
          readonly directories?: readonly UserDocDirectoryRef[]
          readonly directoryId?: UserDocDirectoryIdType
          readonly parentDirectoryId?: UserDocDirectoryIdType
          readonly limits?: UserDocLimits
          readonly totalDocuments?: number
          readonly nextCursor?: string
        }
        if (!isServerPage(response)) {
          if (serverLoadedKey.current === key) serverLoadedKey.current = null
          return false
        }
        const existingDirectories = pagesForKey.get(1)?.directories ?? []
        pageRecord = {
          documents: response.documents,
          directories: response.directories ?? existingDirectories,
          directoryId: response.directoryId ?? directoryId,
          ...(response.parentDirectoryId === undefined ? {} : { parentDirectoryId: response.parentDirectoryId }),
          limits: response.limits ?? (scopeView === null && alternateSource === null ? limits : null),
          totalDocuments: typeof response.totalDocuments === 'number' ? response.totalDocuments : null,
          ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
        }
        rememberServerPage(key, requestedPage, pageRecord)
      }
      if (generation !== serverRequestGeneration.current) return false
      applyServerPage(pageRecord)
      setPage(requestedPage)
      serverPagingRef.current = true
      setServerPaging(true)
      listingReadyRef.current = true
      return true
    } catch (cause) {
      if (generation !== serverRequestGeneration.current) return false
      if (serverLoadedKey.current === key) serverLoadedKey.current = null
      setError(documentErrorMessage(cause, t))
      return false
    } finally {
      if (generation === serverRequestGeneration.current) setLoading(false)
    }
  }

  const load = async (directoryId: UserDocDirectoryIdType = currentDirectoryId, signal?: AbortSignal) => {
    setMobileSheet(null)
    overviewRequestGeneration.current += 1
    overviewLoadedKey.current = null
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    setLoading(true)
    setError('')
    setNotice('')
    setOverviewMode(false)
    setTrashMode(false)
    setScopeView(null)
    setAlternateSource(null)
    setUploadScopePickerOpen(false)
    serverRequestGeneration.current += 1
    serverPagingRef.current = false
    listingReadyRef.current = false
    setServerPaging(false)
    setServerTotalDocuments(null)
    setServerNextCursor(undefined)
    // `load` is always the active runtime path. State setters below do not
    // change the closure synchronously when the user leaves an alternate
    // scope, so bypass the selected-scope dispatcher here explicitly.
    const cachedScope = scopeCache.current
    const cachedPage = cachedScope === null
      ? undefined
      : serverPages.current.get(listingKeyFor(documentScopeOf(cachedScope), directoryId))?.get(1)
    if (cachedPage !== undefined) {
      applyServerPage(cachedPage)
      setServerPaging(true)
      setServerTotalDocuments(cachedPage.totalDocuments)
      serverPagingRef.current = true
      listingReadyRef.current = true
      setLoading(false)
    }
    const cached = cachedScope === null
      ? undefined
      : listingCache.current.get(`${scopeCacheKey(documentScopeOf(cachedScope))}:${String(directoryId)}`)
    if (cached !== undefined) {
      setDocuments([...cached.documents])
      setDirectories([...cached.directories])
      setCurrentDirectoryId(cached.directoryId)
      setLimits(cached.limits)
      setTotalDocuments(cached.documents.length)
      setLoading(false)
    }
    if (scopeStatus !== 'ready') setScopeStatus('loading')
    if (scopeCache.current !== null) {
      setScope(scopeCache.current)
      setScopeStatus('ready')
    }
    const scopeRequest = (scopeCache.current === null
      ? readDocumentsScopeResult(signal)
      : Promise.resolve({ scope: scopeCache.current, available: true as const })).then((result) => {
      if (signal?.aborted || generation !== loadGeneration.current) return
      if (result.available) {
        setScope(result.scope)
        scopeCache.current = result.scope
        setScopeStatus('ready')
      } else {
        setScopeStatus('stale')
      }
    }).catch((cause: unknown) => {
      if (signal?.aborted || generation !== loadGeneration.current) return
      setScopeStatus('stale')
      if (cause instanceof UserDocHttpError) setError(documentErrorMessage(cause, t))
    })
    try {
      const response = await userDocs.current.browse(directoryId, signal, queryForPage()) as {
        readonly documents: readonly UserDocRef[]
        readonly directories?: readonly UserDocDirectoryRef[]
        readonly directoryId?: UserDocDirectoryIdType
        readonly parentDirectoryId?: UserDocDirectoryIdType
        readonly limits?: UserDocLimits
        readonly totalDocuments?: number
        readonly nextCursor?: string
      }
      if (signal?.aborted || generation !== loadGeneration.current) return
      if (isServerPage(response)) {
        const key = listingKeyFor(runtimeScope(), directoryId)
        const pageRecord: ServerPageRecord = {
          documents: response.documents,
          directories: response.directories ?? [],
          directoryId: response.directoryId ?? directoryId,
          ...(response.parentDirectoryId === undefined ? {} : { parentDirectoryId: response.parentDirectoryId }),
          limits: response.limits ?? null,
          totalDocuments: typeof response.totalDocuments === 'number' ? response.totalDocuments : null,
          ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
        }
        rememberServerPage(key, 1, pageRecord)
        serverLoadedKey.current = key
        applyServerPage(pageRecord)
        setPage(1)
        setServerPaging(true)
        setServerTotalDocuments(pageRecord.totalDocuments)
        setServerNextCursor(pageRecord.nextCursor)
        serverPagingRef.current = true
      } else {
        const legacyResponse = response as unknown as {
          readonly documents: readonly UserDocRef[]
          readonly directories: readonly UserDocDirectoryRef[]
          readonly directoryId: UserDocDirectoryIdType
          readonly limits?: UserDocLimits
        }
        setDocuments([...legacyResponse.documents])
        setDirectories([...legacyResponse.directories])
        setCurrentDirectoryId(legacyResponse.directoryId)
        setLimits(legacyResponse.limits ?? null)
        setTotalDocuments(legacyResponse.documents.length)
        listingCache.current.set(`${scopeCacheKey(cachedRuntimeScope())}:${String(legacyResponse.directoryId)}`, {
          documents: [...legacyResponse.documents],
          directories: [...legacyResponse.directories],
          directoryId: legacyResponse.directoryId,
          limits: legacyResponse.limits ?? null,
        })
      }
      listingReadyRef.current = true
    } catch (cause) {
      if (signal?.aborted || generation !== loadGeneration.current) return
      if (cause instanceof UserDocServiceUnavailableError) {
        setError(t('error.unavailable'))
      } else {
        setError(documentErrorMessage(cause, t))
      }
    } finally {
      if (!signal?.aborted && generation === loadGeneration.current) setLoading(false)
    }
    await scopeRequest
  }

  const openOverview = async (force = false): Promise<boolean> => {
    const key = overviewFilterKey()
    const generation = overviewRequestGeneration.current + 1
    overviewRequestGeneration.current = generation
    setOverviewLoading(true)
    setOverviewError('')
    try {
      const clientRecord = userDocs.current as unknown as Record<string, unknown>
      const pageMethod = clientRecord.overviewPage
      const cached = !force && overviewCache.current?.key === key ? overviewCache.current.response : undefined
      const response = cached !== undefined
        ? cached
        : typeof pageMethod === 'function'
          ? await (pageMethod as (query?: UserDocListQuery, signal?: AbortSignal) => Promise<UserDocCatalogOverview>)({
            limit: PAGE_SIZE,
            query: query.trim(),
            type: typeFilter,
            sort: wireSort(parseSort(sortValue)),
          })
          : await userDocs.current.overview()
      if (generation !== overviewRequestGeneration.current) return false
      overviewCache.current = { key, response }
      overviewLoadedKey.current = key
      setOverviewRows([...response.documents])
      setOverviewPage(1)
      setOverviewNextCursor(response.nextCursor)
      setOverviewTotalDocuments(typeof response.totalDocuments === 'number' ? response.totalDocuments : null)
      setOverviewServerPaging(typeof response.totalDocuments === 'number' || response.nextCursor !== undefined)
      overviewCursors.current = []
      setOverviewMode(true)
      setTrashMode(false)
      setTrashNextCursor(undefined)
      setTrashPage(1)
      serverPagingRef.current = false
      setServerPaging(false)
      setServerTotalDocuments(null)
      setServerNextCursor(undefined)
      setScopeView(null)
      setAlternateSource(null)
      setUploadScopePickerOpen(false)
      clearSelection()
      return true
    } catch (cause) {
      if (generation === overviewRequestGeneration.current) overviewLoadedKey.current = null
      setOverviewError(documentErrorMessage(cause, t))
      return false
    } finally {
      setOverviewLoading(false)
    }
  }

  const loadOverviewPage = async (requestedPage: number, cursor?: string): Promise<void> => {
    const pageMethod = (userDocs.current as unknown as Record<string, unknown>).overviewPage
    if (typeof pageMethod !== 'function') {
      setOverviewPage(requestedPage)
      return
    }
    setOverviewLoading(true)
    setOverviewError('')
    const generation = overviewRequestGeneration.current + 1
    overviewRequestGeneration.current = generation
    const key = overviewFilterKey()
    try {
      const response = await (pageMethod as (query?: UserDocListQuery, signal?: AbortSignal) => Promise<UserDocCatalogOverview>)({
        limit: PAGE_SIZE,
        query: query.trim(),
        type: typeFilter,
        sort: wireSort(parseSort(sortValue)),
        ...(cursor === undefined ? {} : { cursor }),
      })
      if (generation !== overviewRequestGeneration.current) return
      setOverviewRows([...response.documents])
      setOverviewNextCursor(response.nextCursor)
      setOverviewTotalDocuments(typeof response.totalDocuments === 'number' ? response.totalDocuments : null)
      setOverviewPage(requestedPage)
      overviewCache.current = null
      overviewLoadedKey.current = key
      setOverviewServerPaging(true)
    } catch (cause) {
      setOverviewError(documentErrorMessage(cause, t))
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
      setError(documentErrorMessage(cause, t))
    } finally {
      setHistoryLoading(false)
    }
  }

  const openTrash = async (cursor?: string, pageNumber = 1): Promise<boolean> => {
    setTrashLoading(true)
    setError('')
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    if (cursor === undefined && pageNumber === 1) trashCursors.current = []
    try {
      const clientRecord = userDocs.current as unknown as Record<string, unknown>
      const pageMethod = remoteScopeView ? clientRecord.listTrashInScopePage : clientRecord.listTrashPage
      const response = typeof pageMethod === 'function'
        ? remoteScopeView
          ? await (pageMethod as (
            scope: UserDocScope,
            query?: UserDocListQuery,
            signal?: AbortSignal,
          ) => Promise<{ documents: readonly UserDocTrashRef[]; nextCursor?: string }>).call(userDocs.current, selectedScope, {
            limit: PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
            state: 'trash',
          })
          : await (pageMethod as (
            query?: UserDocListQuery,
            signal?: AbortSignal,
          ) => Promise<{ documents: readonly UserDocTrashRef[]; nextCursor?: string }>).call(userDocs.current, {
            limit: PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
            state: 'trash',
          })
        : remoteScopeView
          ? await userDocs.current.listTrashInScope(selectedScope)
          : await userDocs.current.listTrash()
      if (generation !== loadGeneration.current) return false
      setTrashDocuments([...response.documents])
      setTrashNextCursor('nextCursor' in response ? response.nextCursor : undefined)
      setTrashPage(pageNumber)
      setTrashMode(true)
      setOverviewMode(false)
      serverPagingRef.current = false
      setServerPaging(false)
      setServerTotalDocuments(null)
      setServerNextCursor(undefined)
      clearSelection()
      setMobileSheet(null)
      return true
    } catch (cause) {
      if (generation === loadGeneration.current) setError(documentErrorMessage(cause, t))
      return false
    } finally {
      if (generation === loadGeneration.current) setTrashLoading(false)
    }
  }

  const openScopeView = async (target: UserDocScope, label: string): Promise<boolean> => {
    overviewRequestGeneration.current += 1
    overviewLoadedKey.current = null
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    const current = currentScopeDescriptor()
    if (target.kind === current.kind && (target.kind === 'personal'
      || (current.kind === 'project' && target.projectId === current.projectId))) {
      await load(ROOT_DIRECTORY_ID)
      return true
    }
    setLoading(true)
    setError('')
    serverRequestGeneration.current += 1
    try {
      const initialQuery: UserDocListQuery = {
        limit: PAGE_SIZE,
        query: '',
        type: typeFilter,
        sort: wireSort(parseSort(sortValue)),
      }
      const response = await fetchScopeListing(target, ROOT_DIRECTORY_ID, initialQuery)
      if (generation !== loadGeneration.current) return false
      const listed = response as {
        readonly documents: readonly (UserDocTransferListedDocument | UserDocRef)[]
        readonly directories?: readonly UserDocDirectoryRef[]
        readonly directoryId?: UserDocDirectoryIdType
        readonly parentDirectoryId?: UserDocDirectoryIdType
        readonly limits?: UserDocLimits
        readonly totalDocuments?: number
        readonly nextCursor?: string
      }
      const nextDocuments: UserDocRef[] = listed.documents.map((document: UserDocTransferListedDocument | UserDocRef) => ({ ...document, path: '' }))
      setDocuments(nextDocuments)
      const listedDirectories = listed.directories?.map(normalizeDirectoryRef) ?? []
      setDirectories(listedDirectories)
      setLimits(listed.limits ?? null)
      setTotalDocuments(typeof listed.totalDocuments === 'number' ? listed.totalDocuments : nextDocuments.length)
      if (isServerPage(listed)) {
        setServerPaging(true)
        setServerTotalDocuments(typeof listed.totalDocuments === 'number' ? listed.totalDocuments : null)
        setServerNextCursor(listed.nextCursor)
        serverPagingRef.current = true
      } else {
        setServerPaging(false)
        setServerTotalDocuments(null)
        setServerNextCursor(undefined)
        serverPagingRef.current = false
      }
      setCurrentDirectoryId(ROOT_DIRECTORY_ID)
      const project = target.kind === 'project'
        ? scope.projects?.find(candidate => candidate.projectId === target.projectId)
        : undefined
      const mode = project?.mode ?? (target.kind === 'project' && scope.kind === 'project' && scope.projectId === target.projectId
        ? scope.mode ?? 'rw'
        : 'rw')
      setScopeView({
        value: target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`,
        label,
        scope: target,
        mode,
        canUpload: target.kind === 'personal' || mode === 'rw',
      })
      if (isServerPage(listed)) {
        const pageRecord: ServerPageRecord = {
          documents: nextDocuments,
          directories: listedDirectories,
          directoryId: listed.directoryId ?? ROOT_DIRECTORY_ID,
          ...(listed.parentDirectoryId === undefined ? {} : { parentDirectoryId: listed.parentDirectoryId }),
          limits: listed.limits ?? null,
          totalDocuments: typeof listed.totalDocuments === 'number' ? listed.totalDocuments : null,
          ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
        }
        const key = JSON.stringify({
          scope: scopeCacheKey(target), directory: '', query: '', type: typeFilter, sort: wireSort(parseSort(sortValue)),
        })
        rememberServerPage(key, 1, pageRecord)
        serverLoadedKey.current = key
      }
      setAlternateSource(null)
      setOverviewMode(false)
      setTrashMode(false)
      clearSelection()
      setQuery('')
      setPage(1)
      listingReadyRef.current = true
      return true
    } catch (cause) {
      if (generation === loadGeneration.current) setError(documentErrorMessage(cause, t))
      return false
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }

  useEffect(() => {
    /* v8 ignore next -- modal is always open in tests */
    if (!open) return
    // The manager stays mounted between opens. Re-read the account context at
    // each open so a project switch made elsewhere cannot leave stale scope
    // labels or permissions in the workbench.
    scopeCache.current = null
    const controller = new AbortController()
    void load(ROOT_DIRECTORY_ID, controller.signal)
    return () => { controller.abort() }
  }, [open])

  useEffect(() => {
    if (!open || !phone) setMobileSheet(null)
    if (!open) {
      setPreviewDoc(null)
      setDeleteTargets(null)
      setFolderEditor(null)
      setDeleteDirectory(null)
      setMoveTargets(null)
      setCopyTargets(null)
      setPurgeTarget(null)
      setHistoryOpen(false)
      setUploadScopePickerOpen(false)
      setSourcePickerOpen(false)
    }
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
    setOverviewPage(1)
  }, [query, typeFilter, sortValue, currentDirectoryId])

  useEffect(() => {
    if (!open || overviewMode || trashMode || !listingReadyRef.current || !serverPagingRef.current) return
    const key = listingKey(currentDirectoryId)
    if (serverLoadedKey.current === key) return
    serverLoadedKey.current = key
    clearSelection()
    void loadServerPage(1, currentDirectoryId, true)
  }, [open, overviewMode, trashMode, currentDirectoryId, query, typeFilter, sortValue])

  useEffect(() => {
    if (!open || !overviewMode) return
    const key = overviewFilterKey()
    if (overviewLoadedKey.current === key) return
    overviewLoadedKey.current = key
    overviewCursors.current = []
    void openOverview(true)
  }, [open, overviewMode, query, typeFilter, sortValue])

  const sort = parseSort(sortValue)
  const filtered = useMemo(
    () => sortDocuments(filterDocuments(documents, query, typeFilter), parseSort(sortValue)),
    [documents, query, typeFilter, sortValue],
  )
  const filteredDirectories = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return directories.filter(directory => needle === '' || directory.name.toLowerCase().includes(needle))
  }, [directories, query])

  const overviewFiltered = useMemo(
    () => overviewServerPaging ? [...overviewRows] : sortDocuments(filterDocuments(overviewRows, query, typeFilter), parseSort(sortValue)),
    [overviewRows, overviewServerPaging, query, typeFilter, sortValue],
  )
  const overviewPages = overviewServerPaging
    ? overviewTotalDocuments === null
      ? Math.max(overviewPage, overviewNextCursor === undefined ? overviewPage : overviewPage + 1)
      : pageCount(overviewTotalDocuments)
    : pageCount(overviewFiltered.length)
  const overviewLength = overviewServerPaging
    ? overviewTotalDocuments ?? overviewFiltered.length
    : overviewFiltered.length
  const overviewCurrentPage = overviewServerPaging && overviewTotalDocuments === null
    ? Math.max(1, overviewPage)
    : clampPage(overviewPage, overviewLength)
  const overviewPageRows = overviewServerPaging ? overviewRows : pageSlice(overviewFiltered, overviewCurrentPage)

  useEffect(() => {
    if (serverPagingRef.current) return
    const visibleIds = filtered.map(doc => doc.docId)
    const visibleIdSet = new Set(visibleIds.map(String))
    setSelected((prev) => {
      const next = pruneSelection(prev, visibleIds)
      if (next.size === prev.size) return prev
      return next
    })
    setSelectedRecords((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const id of prev.keys()) {
        if (!visibleIdSet.has(id)) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [filtered])

  const pages = serverPaging
    ? serverTotalDocuments === null
      ? Math.max(page, serverNextCursor === undefined ? page : page + 1)
      : pageCount(serverTotalDocuments)
    : pageCount(filtered.length)
  const currentPage = serverPaging && serverTotalDocuments === null
    ? Math.max(1, page)
    : clampPage(page, serverPaging ? serverTotalDocuments ?? documents.length : filtered.length)
  const pageDocs = serverPaging ? documents : pageSlice(filtered, currentPage)
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
    if (overviewMode || alternateSource !== null
      || (scopeView !== null ? !scopeView.canUpload : scope.kind === 'project' && scope.mode === 'ro')) return
    const files = fileListOf(list)
    if (files.length === 0) return
    setUploading(true)
    setError('')
    setProgress({ current: 0, total: files.length, percent: 0 })
    try {
      for (const [index, file] of files.entries()) {
        const report = (loaded: number, total: number, phase?: UserDocUploadPhase): void => {
          setProgress({
            current: index + 1,
            total: files.length,
            percent: total === 0 ? 0 : Math.round((loaded / total) * 100),
            ...(phase === undefined ? {} : { phase }),
          })
        }
        if (scopeView !== null) {
          await userDocs.current.uploadToScope(scopeView.scope, file, currentDirectoryId, undefined, report)
        } else {
          await userDocs.current.upload(file, currentDirectoryId, undefined, report)
        }
      }
      /* v8 ignore next -- the hidden input stays mounted for the modal lifetime */
      if (fileInputRef.current) fileInputRef.current.value = ''
      await refreshDisplayed()
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
        const clientRecord = userDocs.current as unknown as Record<string, unknown>
        if (remoteScopeView && typeof clientRecord.trashInScope === 'function') {
          await userDocs.current.trashInScope(selectedScope, doc.docId)
        } else if (!remoteScopeView && typeof clientRecord.trash === 'function') {
          await userDocs.current.trash(doc.docId)
        } else if (remoteScopeView) {
          await userDocs.current.removeInScope(selectedScope, doc.docId)
        } else {
          await userDocs.current.remove(doc.docId)
        }
        setSelected((prev) => {
          const next = new Set(prev)
          next.delete(doc.docId)
          return next
        })
        setSelectedRecords((prev) => {
          if (!prev.has(doc.docId)) return prev
          const next = new Map(prev)
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
      clearSelection()
      await refreshDisplayed()
    } catch {
      await refreshDisplayed()
      setModalError(t('delete.error'))
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  const restoreTrashDocument = async (document: UserDocTrashRef) => {
    if (writeLocked) return
    setUploading(true)
    setError('')
    try {
      const restored = remoteScopeView
        ? await userDocs.current.restoreInScope(selectedScope, document.docId)
        : await userDocs.current.restore(document.docId)
      setTrashDocuments(previous => previous.filter(item => item.docId !== document.docId))
      setError('')
      void restored
    } catch (cause) {
      setError(documentErrorMessage(cause, t))
    } finally {
      setUploading(false)
    }
  }

  const purgeTrashDocument = (document: UserDocTrashRef): void => {
    if (!writeLocked) setPurgeTarget(document)
  }

  const confirmPurgeTrash = async () => {
    if (purgeTarget === null || writeLocked) return
    const document = purgeTarget
    setUploading(true)
    setError('')
    try {
      if (remoteScopeView) await userDocs.current.purgeInScope(selectedScope, document.docId)
      else await userDocs.current.purge(document.docId)
      setTrashDocuments(previous => previous.filter(item => item.docId !== document.docId))
      setPurgeTarget(null)
    } catch (cause) {
      setError(documentErrorMessage(cause, t))
    } finally {
      setUploading(false)
    }
  }

  const navigate = (directoryId: UserDocDirectoryIdType) => {
    clearSelection()
    setQuery('')
    setPage(1)
    if (!remoteScopeView) {
      void load(directoryId)
      return
    }
    setLoading(true)
    setError('')
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    serverRequestGeneration.current += 1
    void fetchScopeListing(selectedScope, directoryId, {
      limit: PAGE_SIZE, query: '', type: typeFilter, sort: wireSort(parseSort(sortValue)),
    }).then((rawResponse) => {
      if (generation !== loadGeneration.current) return
      const response = rawResponse as {
        readonly documents: readonly (UserDocTransferListedDocument | UserDocRef)[]
        readonly directories?: readonly UserDocDirectoryRef[]
        readonly directoryId?: UserDocDirectoryIdType
        readonly parentDirectoryId?: UserDocDirectoryIdType
        readonly limits?: UserDocLimits
        readonly totalDocuments?: number
        readonly nextCursor?: string
      }
      const nextDirectoryId = response.directoryId ?? directoryId
      const nextDocuments = response.documents.map(document => ({ ...document, path: '' }))
      const nextDirectories = response.directories?.map(normalizeDirectoryRef) ?? []
      const key = JSON.stringify({
        scope: scopeCacheKey(selectedScope), directory: String(nextDirectoryId), query: '',
        type: typeFilter, sort: wireSort(parseSort(sortValue)),
      })
      serverLoadedKey.current = JSON.stringify({
        scope: scopeCacheKey(selectedScope), directory: String(nextDirectoryId), query: '',
        type: typeFilter, sort: wireSort(parseSort(sortValue)),
      })
      setDocuments(nextDocuments)
      setDirectories(nextDirectories)
      setCurrentDirectoryId(nextDirectoryId)
      setLimits(response.limits ?? null)
      setTotalDocuments(typeof response.totalDocuments === 'number' ? response.totalDocuments : nextDocuments.length)
      if (isServerPage(response)) {
        const pageRecord: ServerPageRecord = {
          documents: nextDocuments,
          directories: nextDirectories,
          directoryId: nextDirectoryId,
          ...(response.parentDirectoryId === undefined ? {} : { parentDirectoryId: response.parentDirectoryId }),
          limits: response.limits ?? null,
          totalDocuments: typeof response.totalDocuments === 'number' ? response.totalDocuments : null,
          ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
        }
        rememberServerPage(key, 1, pageRecord)
        serverLoadedKey.current = key
        setServerPaging(true)
        setServerTotalDocuments(pageRecord.totalDocuments)
        setServerNextCursor(pageRecord.nextCursor)
        serverPagingRef.current = true
      } else {
        setServerPaging(false)
        setServerTotalDocuments(null)
        setServerNextCursor(undefined)
        serverPagingRef.current = false
      }
      listingReadyRef.current = true
    }).catch((cause: unknown) => {
      if (generation === loadGeneration.current) setError(documentErrorMessage(cause, t))
    }).finally(() => { if (generation === loadGeneration.current) setLoading(false) })
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
        if (remoteScopeView) await userDocs.current.createDirectoryInScope(selectedScope, folderEditor.parentDirectoryId, folderName.trim())
        else await userDocs.current.createDirectory(folderEditor.parentDirectoryId, folderName.trim())
      } else {
        if (remoteScopeView) {
          await userDocs.current.renameDirectoryInScope(
            selectedScope, folderEditor.directory.directoryId, folderName.trim(),
          )
        }
        else await userDocs.current.renameDirectory(folderEditor.directory.directoryId, folderName.trim())
      }
      setFolderEditor(null)
      await refreshDisplayed()
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
      if (remoteScopeView) await userDocs.current.removeDirectoryInScope(selectedScope, deleteDirectory.directoryId)
      else await userDocs.current.removeDirectory(deleteDirectory.directoryId)
      setDeleteDirectory(null)
      await refreshDisplayed()
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
      const response = remoteScopeView
        ? await userDocs.current.listScopeDirectories(selectedScope)
        : await userDocs.current.listDirectories()
      const available: UserDocDirectoryRef[] = response.directories.map(directory => ({
        ...directory,
        path: 'path' in directory ? directory.path : '',
        modifiedAt: 'modifiedAt' in directory ? directory.modifiedAt : 0,
      }))
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
    if (remoteScopeView) {
      void copyRemoteDocumentToConversation(doc)
      return
    }
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

  const copyRemoteDocumentToConversation = async (doc: UserDocRef): Promise<void> => {
    await copyRemoteDocumentsToConversation([doc])
  }

  const copyRemoteDocumentsToConversation = async (targets: readonly UserDocRef[]): Promise<void> => {
    if (onAttachDocument === undefined) {
      setError(t('action.attach.error'))
      return
    }
    setUploading(true)
    setCopyLoading(true)
    setError('')
    setModalError('')
    setProgress({ current: 0, total: targets.length, percent: 0 })
    try {
      const response = await userDocs.current.transfer({
        version: 1,
        source: selectedScope,
        target: currentScopeDescriptor(),
        documents: targets.map(document => ({ docId: document.docId })),
      })
      const copied = response.items.flatMap(item => item.status === 'copied' ? [item.target] : [])
      const failed = response.items.filter(item => item.status === 'failed').length
      if (copied.length === 0) {
        setError(failed > 0 ? t('copy.partial', { count: String(failed) }) : t('action.attach.error'))
        return
      }
      setProgress({ current: targets.length, total: targets.length, percent: 100 })
      let attached = false
      for (const document of copied) attached = onAttachDocument({ ...document, path: '' }) || attached
      if (!attached) {
        setError(t('action.attach.error'))
        return
      }
      if (failed > 0) setError(t('copy.partial', { count: String(failed) }))
      else onClose()
    } catch (cause) {
      setError(documentErrorMessage(cause, t))
    } finally {
      setCopyLoading(false)
      setUploading(false)
      setProgress(null)
    }
  }

  const attachSelectedDocuments = async (): Promise<void> => {
    const targets = selectedDocumentList()
    setMobileSheet(null)
    if (targets.length === 0 || onAttachDocument === undefined) {
      setError(t('action.attach.error'))
      return
    }
    if (remoteScopeView) {
      await copyRemoteDocumentsToConversation(targets)
      return
    }
    let attached = false
    for (const document of targets) attached = onAttachDocument(document) || attached
    if (attached) onClose()
    else setError(t('action.attach.error'))
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
        if (remoteScopeView) await userDocs.current.moveInScope(selectedScope, doc.docId, moveDirectoryId)
        else await userDocs.current.move(doc.docId, moveDirectoryId)
        setSelected((prev) => {
          const next = new Set(prev)
          next.delete(doc.docId)
          return next
        })
        setSelectedRecords((prev) => {
          if (!prev.has(doc.docId)) return prev
          const next = new Map(prev)
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
      clearSelection()
      await refreshDisplayed()
    } catch {
      await refreshDisplayed()
      setModalError(t('move.error'))
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  const openCopy = (targets: UserDocRef[]) => {
    if (targets.length === 0) return
    const source = scopeView?.scope ?? alternateSource?.scope ?? currentScopeDescriptor()
    const current = currentScopeDescriptor()
    const options: CopyTargetOption[] = (scope.projects ?? [])
      .filter(project => project.mode === 'rw' && !(source.kind === 'project' && source.projectId === project.projectId)
        && (mode !== 'select' || sameDocumentScope({ kind: 'project', projectId: project.projectId }, current)))
      .map(project => ({
        value: `project:${String(project.projectId)}`,
        label: project.name,
        target: { kind: 'project', projectId: project.projectId } as const,
      }))
    if (!(source.kind === 'personal') && (mode !== 'select' || sameDocumentScope({ kind: 'personal' }, current))) {
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

  const currentScopeDescriptor = runtimeScope

  const sourceOptions: SourceOption[] = [
    ...((scope.kind !== 'personal' || scopeView?.scope.kind === 'project') && scopeView?.scope.kind !== 'personal'
      ? [{ value: 'personal', label: t('copy.target.personal'), scope: { kind: 'personal' } as const, mode: 'rw' as const }]
      : []),
    ...(scope.projects ?? [])
      .filter(project => !(scope.kind === 'project' && scope.projectId === project.projectId)
        && !(scopeView?.scope.kind === 'project' && scopeView.scope.projectId === project.projectId))
      .map(project => ({
        value: `project:${String(project.projectId)}`,
        label: project.name,
        scope: { kind: 'project', projectId: project.projectId } as const,
        mode: project.mode,
      })),
  ]
  const filteredSourceOptions = sourceOptions.filter((option) => {
    const needle = sourcePickerQuery.trim().toLowerCase()
    return needle === '' || option.label.toLowerCase().includes(needle)
  })
  const uploadScopeOptions: SourceOption[] = [
    { value: 'personal', label: t('copy.target.personal'), scope: { kind: 'personal' }, mode: 'rw' },
    ...(scope.projects ?? []).filter(project => project.mode === 'rw').map(project => ({
      value: `project:${String(project.projectId)}`,
      label: project.name,
      scope: { kind: 'project', projectId: project.projectId } as const,
      mode: project.mode,
    })),
  ]
  const filteredUploadScopeOptions = uploadScopeOptions.filter((option) => {
    const needle = uploadScopePickerQuery.trim().toLowerCase()
    return needle === '' || option.label.toLowerCase().includes(needle)
  })

  const mobileViewOptions = useMemo<MobileScopeOption[]>(() => [
    {
      value: 'all',
      label: t('scope.all'),
      description: t('scope.all.description'),
      kind: 'all',
    },
    {
      value: 'personal',
      label: t('copy.target.personal'),
      description: t('scope.personal.description'),
      kind: 'personal',
    },
    ...(scope.projects ?? []).map(project => ({
      value: `project:${String(project.projectId)}`,
      label: project.name,
      description: t('scope.project.meta', {
        mode: projectModeLabel(project.mode, t),
        description: t('scope.project.description'),
      }),
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

  const uploadMobileScopeOptions = useMemo<MobileScopeOption[]>(() => (
    uploadScopeOptions.reduce<MobileScopeOption[]>((result, option) => {
      if (option.scope.kind === 'project') {
        result.push({
          value: option.value,
          label: option.label,
          description: `${t('scope.project.mode.editable')} · ${t('scope.upload.root')}`,
          kind: 'project',
          projectId: option.scope.projectId,
        })
      } else {
        result.push({
          value: option.value,
          label: option.label,
          description: `${t('scope.project.mode.editable')} · ${t('scope.upload.root')}`,
          kind: 'personal',
        })
      }
      return result
    }, [])
  ), [scope.projects, t])

  const mobileScopeOptions: MobileScopeOption[] = mobileSheet?.kind === 'scope' && mobileSheet.mode === 'source'
    ? sourceOptions.map(option => ({
      value: option.value,
      label: option.label,
      description: `${option.mode === 'rw' ? t('scope.project.mode.editable') : t('scope.project.mode.readOnly')} · ${t('scope.source.readOnly')}`,
      kind: 'source' as const,
    }))
    : mobileSheet?.kind === 'scope' && mobileSheet.mode === 'upload'
      ? uploadMobileScopeOptions
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
    } else if (mobileSheet.mode === 'upload') {
      const uploadOption = uploadScopeOptions.find(candidate => candidate.value === value)
      if (uploadOption !== undefined) succeeded = await openScopeView(uploadOption.scope, uploadOption.label)
      if (succeeded) setUploadScopePickerOpen(false)
      if (succeeded) setMobileSheet(null)
      return
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
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    serverRequestGeneration.current += 1
    try {
      const initialQuery: UserDocListQuery = {
        limit: PAGE_SIZE,
        query: '',
        type: typeFilter,
        sort: wireSort(parseSort(sortValue)),
      }
      const response = await fetchScopeListing(option.scope, ROOT_DIRECTORY_ID, initialQuery)
      if (generation !== loadGeneration.current) return false
      const listed = response as {
        readonly documents: readonly (UserDocTransferListedDocument | UserDocRef)[]
        readonly directories?: readonly UserDocDirectoryRef[]
        readonly directoryId?: UserDocDirectoryIdType
        readonly limits?: UserDocLimits
        readonly totalDocuments?: number
        readonly nextCursor?: string
      }
      const documents: UserDocRef[] = listed.documents.map((document: UserDocTransferListedDocument | UserDocRef) => ({
        ...document,
        path: '',
      }))
      setDocuments(documents)
      const listedDirectories = listed.directories?.map(normalizeDirectoryRef) ?? []
      setDirectories(listedDirectories)
      setLimits(listed.limits ?? null)
      setTotalDocuments(typeof listed.totalDocuments === 'number' ? listed.totalDocuments : documents.length)
      if (isServerPage(listed)) {
        const pageRecord: ServerPageRecord = {
          documents,
          directories: listedDirectories,
          directoryId: listed.directoryId ?? ROOT_DIRECTORY_ID,
          limits: listed.limits ?? null,
          totalDocuments: typeof listed.totalDocuments === 'number' ? listed.totalDocuments : null,
          ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
        }
        const key = JSON.stringify({
          scope: scopeCacheKey(option.scope), directory: '', query: '', type: typeFilter, sort: wireSort(parseSort(sortValue)),
        })
        rememberServerPage(key, 1, pageRecord)
        serverLoadedKey.current = key
        setServerPaging(true)
        setServerTotalDocuments(pageRecord.totalDocuments)
        serverPagingRef.current = true
      } else {
        setServerPaging(false)
        setServerTotalDocuments(null)
        serverPagingRef.current = false
      }
      setCurrentDirectoryId(ROOT_DIRECTORY_ID)
      setScopeView(null)
      setAlternateSource(option)
      setTrashMode(false)
      clearSelection()
      setQuery('')
      setPage(1)
      listingReadyRef.current = true
      setSourcePickerOpen(false)
      return true
    } catch (error) {
      if (generation === loadGeneration.current) setError(documentErrorMessage(error, t))
      return false
    } finally {
      if (generation === loadGeneration.current) setSourcePickerLoading(false)
    }
  }

  const refreshDisplayed = async (): Promise<void> => {
    listingCache.current.clear()
    // A mutation can change both the count and the cursor chain. Drop every
    // cached page before requesting the refreshed first page.
    serverPages.current.clear()
    serverLoadedKey.current = null
    overviewCache.current = null
    if (trashMode) {
      await openTrash()
      return
    }
    if (remoteScopeView) {
      const generation = loadGeneration.current + 1
      loadGeneration.current = generation
      serverRequestGeneration.current += 1
      try {
        const target = selectedScope
        const response = await fetchScopeListing(target, currentDirectoryId, {
          limit: PAGE_SIZE, query: '', type: typeFilter, sort: wireSort(parseSort(sortValue)),
        }) as {
          readonly documents: readonly (UserDocTransferListedDocument | UserDocRef)[]
          readonly directories?: readonly UserDocDirectoryRef[]
          readonly directoryId?: UserDocDirectoryIdType
          readonly parentDirectoryId?: UserDocDirectoryIdType
          readonly limits?: UserDocLimits
          readonly totalDocuments?: number
          readonly nextCursor?: string
        }
        if (generation !== loadGeneration.current) return
        const nextDirectoryId = response.directoryId ?? currentDirectoryId
        const nextDocuments = response.documents.map(document => ({ ...document, path: '' }))
        const nextDirectories = response.directories?.map(normalizeDirectoryRef) ?? []
        const key = JSON.stringify({
          scope: scopeCacheKey(target), directory: String(nextDirectoryId), query: '',
          type: typeFilter, sort: wireSort(parseSort(sortValue)),
        })
        setDocuments(nextDocuments)
        setDirectories(nextDirectories)
        setCurrentDirectoryId(nextDirectoryId)
        setLimits(response.limits ?? null)
        setTotalDocuments(typeof response.totalDocuments === 'number' ? response.totalDocuments : nextDocuments.length)
        if (isServerPage(response)) {
          const pageRecord: ServerPageRecord = {
            documents: nextDocuments,
            directories: nextDirectories,
            directoryId: nextDirectoryId,
            ...(response.parentDirectoryId === undefined ? {} : { parentDirectoryId: response.parentDirectoryId }),
            limits: response.limits ?? null,
            totalDocuments: typeof response.totalDocuments === 'number' ? response.totalDocuments : null,
            ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
          }
          rememberServerPage(key, 1, pageRecord)
          serverLoadedKey.current = key
          setServerPaging(true)
          setServerTotalDocuments(pageRecord.totalDocuments)
          setServerNextCursor(pageRecord.nextCursor)
          serverPagingRef.current = true
        } else {
          setServerPaging(false)
          setServerTotalDocuments(null)
          setServerNextCursor(undefined)
          serverPagingRef.current = false
        }
        listingReadyRef.current = true
        clearSelection()
        setQuery('')
        setPage(1)
      } catch (cause) {
        if (generation === loadGeneration.current) setError(documentErrorMessage(cause, t))
      }
      return
    }
    // An explicit refresh is also the user's way to reconcile membership and
    // project labels while this long-lived dialog remains mounted.
    scopeCache.current = null
    await load(currentDirectoryId)
  }

  const openSourcePicker = () => {
    if (sourceOptions.length === 0) {
      setError(t('copy.source.unavailable'))
      return
    }
    setSourcePickerValue(sourceOptions[0]?.value ?? '')
    setSourcePickerQuery('')
    setSourcePickerOpen(true)
    setModalError('')
  }

  const openUploadScopePicker = () => {
    if (uploadScopeOptions.length === 0) {
      setError(t('scope.upload.unavailable'))
      return
    }
    if (phone) {
      setUploadScopePickerValue(uploadScopeOptions[0]?.value ?? '')
      setUploadScopePickerOpen(true)
      setMobileSheet({ kind: 'scope', mode: 'upload', query: '' })
      return
    }
    setUploadScopePickerValue(uploadScopeOptions[0]?.value ?? '')
    setUploadScopePickerQuery('')
    setUploadScopePickerOpen(true)
    setModalError('')
  }

  const chooseUploadScope = async () => {
    const option = uploadScopeOptions.find(candidate => candidate.value === uploadScopePickerValue)
    if (option === undefined) return
    const succeeded = await openScopeView(option.scope, option.label)
    if (succeeded) setUploadScopePickerOpen(false)
  }

  const openMobileScopeSheet = (mode: 'view' | 'source') => {
    if (mode === 'source' && sourceOptions.length === 0) {
      setError(t('copy.source.unavailable'))
      return
    }
    if (mode === 'source') setSourcePickerValue(sourceOptions[0]?.value ?? '')
    setError('')
    setMobileSheet({ kind: 'scope', mode, query: '' })
  }

  const openOverviewCopy = async (row: UserDocCatalogRow) => {
    const source = catalogRowScope(row)
    if (mode === 'select' && sameDocumentScope(source, currentScopeDescriptor())) {
      try {
        if (onAttachDocument?.({
          docId: row.docId,
          path: '',
          name: row.name,
          bytes: row.bytes,
          mediaType: row.mediaType,
          modifiedAt: row.modifiedAt,
        }) === true) {
          onClose()
          return
        }
      } catch {
        // Session teardown can race the overview click; keep the manager open.
      }
      setOverviewError(t('action.attach.error'))
      return
    }
    try {
      const capabilities = await userDocs.current.capabilities()
      const options = capabilities.targets
        .filter(target => target.canWrite && !(target.scope.kind === source.kind
          && (target.scope.kind === 'personal' || target.scope.projectId === (source.kind === 'project' ? source.projectId : -1)))
          && (mode !== 'select' || sameDocumentScope(target.scope, currentScopeDescriptor())))
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
      setOverviewError(documentErrorMessage(cause, t))
    }
  }

  const openOverviewView = async (row: UserDocCatalogRow): Promise<void> => {
    const target = catalogRowScope(row)
    await openScopeView(target, row.scope.label)
  }

  const handleCopy = async () => {
    if (copyTargets === null || (overviewCopyRow === null && selected.size === 0)) return
    const option = copyTargets.find(candidate => candidate.value === copyTarget)
    if (option === undefined) return
    const targets = overviewCopyRow === null
      ? selectedDocumentList()
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
    setNotice('')
    setProgress({ current: 0, total: targets.length, percent: 0 })
    let noticeAfterCopy: string | undefined
    try {
      const source: UserDocScope = overviewCopyRow?.source ?? scopeView?.scope ?? alternateSource?.scope ?? currentScopeDescriptor()
      const resolvedTarget = option.target
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
      if (copied.length === 0 && failed === 0) {
        setModalError(t('copy.error'))
        return
      }
      const attachToCurrent = copied.length > 0 && onAttachDocument !== undefined
        && sameDocumentScope(resolvedTarget, currentScopeDescriptor())
      if (attachToCurrent) {
        let attached = false
        for (const ref of copied) {
          attached = onAttachDocument({ ...ref, path: '' }) || attached
        }
        if (attached) onClose()
      }
      if (failed > 0) setModalError(t('copy.partial', { count: String(failed) }))
      else {
        setCopyTargets(null)
        if (!attachToCurrent && copied.length > 0) noticeAfterCopy = t('copy.success', { target: option.label })
      }
      clearSelection()
      if (overviewCopyRow !== null) {
        setOverviewCopyRow(null)
        overviewCache.current = null
        await openOverview(true)
      } else if (alternateSource !== null) {
        await refreshDisplayed()
      } else {
        await load(currentDirectoryId)
      }
      if (noticeAfterCopy !== undefined) setNotice(noticeAfterCopy)
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
        if (overviewMode) await openOverview(true)
        else if (alternateSource !== null) await refreshDisplayed()
        else await load(currentDirectoryId)
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
    const document = documents.find(candidate => candidate.docId === id)
    const wasSelected = selected.has(id)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSelectedRecords((prev) => {
      const next = new Map(prev)
      if (wasSelected) next.delete(id)
      else if (document !== undefined) next.set(id, document)
      return next
    })
  }

  const togglePage = () => {
    const shouldSelect = headerState !== 'all'
    setSelected((prev) => {
      const next = new Set(prev)
      if (headerState === 'all') {
        for (const id of pageIds) next.delete(id)
      } else {
        for (const id of pageIds) next.add(id)
      }
      return next
    })
    setSelectedRecords((prev) => {
      const next = new Map(prev)
      for (const document of pageDocs) {
        if (shouldSelect) next.set(document.docId, document)
        else next.delete(document.docId)
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
  const selectedScope = scopeView?.scope ?? alternateSource?.scope
    ?? (scope.kind === 'project' && scope.projectId !== undefined
      ? { kind: 'project' as const, projectId: scope.projectId }
      : { kind: 'personal' as const })
  const selectedScopeMode = scopeView?.mode ?? alternateSource?.mode
    ?? (readOnlyProject ? 'ro' : 'rw')
  const writeLocked = overviewMode || selectedScopeMode === 'ro'
  const uploadLocked = overviewMode || selectedScopeMode === 'ro'
  const remoteScopeView = scopeView !== null || alternateSource !== null
  const selectedScopeUrl = remoteScopeView ? selectedScope : undefined
  const documentContentUrl = (docId: UserDocIdType, inline = false): string => {
    if (selectedScopeUrl === undefined) return userDocs.current.contentUrl(docId, inline)
    return userDocs.current.scopedContentUrl(selectedScopeUrl, docId, inline)
  }

  const projectExtra = scope.kind === 'project' ? t('delete.confirm.project.extra') : ''
  const visibility = scope.kind === 'project'
    ? t('modal.visibility.project')
    : t('modal.visibility.personal')
  const visibleScope = scopeView !== null
    ? scopeView.canUpload
      ? t('scope.upload.target', { name: scopeView.label })
      : t('scope.viewing', { name: scopeView.label })
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
      disabled={busy || uploadLocked}
      aria-label={uploading ? uploadLabel : t('modal.upload')}
      title={scopeView !== null && !scopeView.canUpload ? t('scope.upload.readOnly', { name: scopeView.label }) : undefined}
      icon={<IconPlusOutline16 size={16} />}
      onClick={() => fileInputRef.current?.click()}
    >
      {phone && !uploading ? t('modal.upload.compact') : uploadLabel}
    </Button>
  )

  const selectionLabel = t('selection.selected', { count: String(selected.size) })
  const clearSelectionButton = (
    <Button
      type="button"
      variant="ghost"
      aria-label={t('selection.clear')}
      onClick={clearSelection}
    >
      {phone ? t('selection.clear.compact') : t('selection.clear')}
    </Button>
  )

  const confirmMessage = deleteTargets !== null && deleteTargets.length > 1
    ? t('delete.confirm.message.many', { count: String(deleteTargets.length), projectExtra })
    : t('delete.confirm.message', { projectExtra })

  const showPager = serverPaging
    ? serverTotalDocuments === null ? serverNextCursor !== undefined || currentPage > 1 : pages > 1
    : filtered.length > PAGE_SIZE
  const hasEntries = directories.length > 0 || documents.length > 0
    || (serverPaging && (serverTotalDocuments ?? 0) > 0)
  const hasVisibleEntries = filteredDirectories.length > 0 || filtered.length > 0
    || (serverPaging && (serverTotalDocuments ?? 0) > 0)
  const moveOptions = [
    { directoryId: ROOT_DIRECTORY_ID, name: t('breadcrumb.root') },
    ...moveDirectories.map(directory => ({
      directoryId: directory.directoryId,
      name: directory.name,
    })),
  ].filter(directory => directory.directoryId !== currentDirectoryId)

  const renderDirectory = (directory: UserDocDirectoryRef) => (
    <div key={directory.directoryId} className={`${css.row} ${css.folderRow}`} role="listitem" data-documents-row-kind="folder">
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
    <div key={doc.docId} className={css.row} role="listitem" data-documents-row-kind="document">
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
          {documentMetaLabel(doc, t, phone || sort.key !== 'date')}
        </span>
      </div>
      {phone ? (
        !overviewMode ? (
          <>
            <span className={css.mobileCoreActions}>
              <Button
                className={css.mobileCoreAction}
                type="button"
                size="sm"
                variant="ghost"
                aria-label={t('action.attachNamed', { name: doc.name })}
                title={t('action.attach')}
                disabled={busy}
                icon={<IconPaperclipOutline16 size={18} />}
                onClick={() => { attachDocument(doc) }}
              >
                <span className={css.mobileCoreLabel}>{t('action.attach')}</span>
              </Button>
              <Button
                className={css.mobileCoreAction}
                type="button"
                size="sm"
                variant="ghost"
                aria-label={t('action.previewNamed', { name: doc.name })}
                title={t('action.preview')}
                disabled={busy}
                icon={<IconInspectOutline12 size={18} />}
                onClick={() => { setPreviewDoc(doc) }}
              >
                <span className={css.mobileCoreLabel}>{t('action.preview')}</span>
              </Button>
            </span>
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
          </>
        ) : (
          <span className={css.readOnlyBadge}>{t('scope.readOnly')}</span>
        )
      ) : (
        <span className={css.actions}>
          {!overviewMode && (
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
                href={documentContentUrl(doc.docId)}
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

  const closeMobileSheet = () => {
    if (mobileSheet?.kind === 'scope' && mobileSheet.mode === 'upload') setUploadScopePickerOpen(false)
    setMobileSheet(null)
  }

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
    const targets = selectedDocumentList()
    setMobileSheet(null)
    if (action === 'move') void openMove(targets)
    else if (action === 'copy') openCopy(targets)
    else setDeleteTargets(targets)
  }

  const renderScopePickerOption = (
    option: SourceOption,
    selectedValue: string,
    disabled: boolean,
    detail: string,
    onSelect: (value: string) => void,
  ) => (
    <button
      key={option.value}
      type="button"
      role="option"
      aria-selected={selectedValue === option.value}
      className={`${css.scopePickerOption} ${selectedValue === option.value ? css.scopePickerOptionSelected : ''}`}
      disabled={disabled}
      onClick={() => { onSelect(option.value) }}
    >
      <span className={css.scopeItemIcon} aria-hidden="true">
        {option.scope.kind === 'project' ? <IconFolderClose16 size={18} /> : <IconBrowseOutline16 size={18} />}
      </span>
      <span className={css.scopePickerCopy}>
        <strong>{option.label}</strong>
        <small>{detail}</small>
      </span>
      {selectedValue === option.value && <span className={css.sheetCheck} aria-hidden="true">✓</span>}
    </button>
  )

  const mobileSheetContent = mobileSheet?.kind === 'scope' ? (
    <DocumentsMobileSheet
      open
      key={`scope-${mobileSheet.mode}`}
      kind={`scope-${mobileSheet.mode}`}
      title={mobileSheet.mode === 'source' ? t('copy.source.title') : mobileSheet.mode === 'upload' ? t('scope.upload.choose') : t('scope.switch.title')}
      closeLabel={t('modal.close')}
      onClose={closeMobileSheet}
    >
      <p className={css.sheetDescription}>
        {mobileSheet.mode === 'source' ? t('copy.source.message') : mobileSheet.mode === 'upload' ? t('scope.upload.root') : t('scope.switch.message')}
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
          const selectedOption = mobileSheet.mode === 'source'
            ? option.value === sourcePickerValue
            : mobileSheet.mode === 'upload'
              ? option.value === uploadScopePickerValue
              : option.value === mobileScopeValue
          const disabled = busy || loading || overviewLoading || sourcePickerLoading
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
      <Button
        className={css.sheetAction}
        type="button"
        variant="ghost"
        disabled={busy || trashLoading}
        onClick={() => { closeMobileSheet(); void (trashMode ? load(ROOT_DIRECTORY_ID) : openTrash()) }}
      >
        {trashMode ? t('trash.back') : t('trash.button')}
      </Button>
      {!trashMode && <>
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
            onClick={() => { closeMobileSheet(); void refreshDisplayed() }}
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
      </>}
    </DocumentsMobileSheet>
  ) : mobileSheet?.kind === 'document' ? (
    <DocumentsMobileSheet
      open
      key={`document-${mobileSheet.document.docId}`}
      kind="document-actions"
      title={t('action.more')}
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
          href={documentContentUrl(mobileSheet.document.docId)}
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
      title={t('action.more')}
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
      <Button className={css.sheetAction} type="button" variant="outline" disabled={overviewLoading} onClick={() => { closeMobileSheet(); void openOverviewView(mobileSheet.row) }}>{t('scope.view')}</Button>
      <Button className={css.sheetAction} type="button" variant="primary" disabled={overviewLoading} icon={<IconCopyOutline16 size={18} />} onClick={() => { closeMobileSheet(); void openOverviewCopy(mobileSheet.row) }}>{mode === 'select' && sameDocumentScope(catalogRowScope(mobileSheet.row), currentScopeDescriptor()) ? t('action.attach') : mode === 'select' ? t('scope.copyAndAttach') : t('scope.copy')}</Button>
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
        {mode === 'select' && (
          <Button className={css.sheetAction} type="button" variant="primary" disabled={busy || onAttachDocument === undefined} icon={<IconPaperclipOutline16 size={18} />} onClick={() => { void attachSelectedDocuments() }}>{t('selection.attach')}</Button>
        )}
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
          onClick={() => {
            const next = currentPage - 1
            if (serverPaging) void loadServerPage(next)
            else setPage(next)
          }}
        >
          {t('pager.prev')}
        </Button>
        <span>{t('pager.status', {
          page: String(currentPage), pages: serverPaging && serverTotalDocuments === null ? '…' : String(pages),
        })}</span>
        <Button
          type="button"
          variant="outline"
          disabled={busy || (serverPaging
            ? serverNextCursor === undefined
            : currentPage >= pages)}
          onClick={() => {
            const next = currentPage + 1
            if (serverPaging) void loadServerPage(next)
            else setPage(next)
          }}
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
        className={css.dialog as string}
        contentClassName={css.shell as string}
        {...(pager === undefined ? {} : { footer: pager })}
      >
        {limitsText !== '' && <p className={css.limits}>{limitsText}</p>}
        <div className={css.workbench}>
          <aside className={css.scopeRail} aria-label={t('scope.rail.label')}>
            <div className={css.scopeRailHeading}>{t('scope.rail.title')}</div>
            {scopeStatus === 'stale' && <div className={css.scopeStale} role="status"><span>{t('scope.stale')}</span><button type="button" onClick={() => { scopeCache.current = null; void load(ROOT_DIRECTORY_ID) }}>{t('scope.retry')}</button></div>}
            <button type="button" className={`${css.scopeItem} ${overviewMode ? css.scopeItemActive : ''}`} onClick={() => { void openOverview() }} disabled={busy || overviewLoading || loading}>
              <span className={css.scopeItemIcon} aria-hidden="true"><IconBrowseOutline16 size={16} /></span>
              <span><strong>{t('scope.all')}</strong><small>{t('scope.all.description')}</small></span>
            </button>
            <button type="button" className={`${css.scopeItem} ${!overviewMode && alternateSource === null && (scopeView?.scope.kind === 'personal' || (scopeView === null && scope.kind === 'personal')) ? css.scopeItemActive : ''}`} onClick={() => { void openScopeView({ kind: 'personal' }, t('copy.target.personal')) }} disabled={busy || loading || overviewLoading}>
              <span className={css.scopeItemIcon} aria-hidden="true"><IconPaperclipOutline16 size={16} /></span>
              <span><strong>{t('copy.target.personal')}</strong><small>{t('scope.personal.description')}</small></span>
            </button>
            {(scope.projects ?? []).map((project) => {
              const isCurrent = !overviewMode && alternateSource === null && ((scopeView?.scope.kind === 'project' && scopeView.scope.projectId === project.projectId) || (scopeView === null && scope.kind === 'project' && scope.projectId === project.projectId))
              return <button key={project.projectId} type="button" className={`${css.scopeItem} ${isCurrent ? css.scopeItemActive : ''}`} onClick={() => { void openScopeView({ kind: 'project', projectId: project.projectId }, project.name) }} disabled={busy || loading || overviewLoading}>
                <span className={css.scopeItemIcon} aria-hidden="true"><IconFolderClose16 size={16} /></span>
                <span><strong>{project.name}</strong><small>{t('scope.project.meta', { mode: projectModeLabel(project.mode, t), description: t('scope.project.description') })}</small></span>
              </button>
            })}
          </aside>
          <div className={css.workbenchContent}>
            {mode === 'select' && <div className={css.selectionModeNotice} role="status">{t('selection.mode.hint')}</div>}
            {phone && (
              <>
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
                {scopeStatus === 'stale' && <div className={css.scopeStaleMobile} role="status"><span>{t('scope.stale')}</span><button type="button" onClick={() => { scopeCache.current = null; void load(ROOT_DIRECTORY_ID) }}>{t('scope.retry')}</button></div>}
              </>
            )}
            <div
              className={`${css.panel}${dropActive ? ` ${css.dropActive}` : ''}${overviewMode ? ` ${css.overviewPanel}` : ''}${trashMode ? ` ${css.trashPanel}` : ''}`}
              data-documents-panel=""
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              {error !== '' && <div className={css.error} role="alert">{error}</div>}
              {notice !== '' && <div className={css.notice} role="status">{notice}</div>}
              {overviewMode && (
                <section className={css.overview} aria-label={t('scope.all')}>
                  <header className={css.overviewHeader}>
                    <div><h2>{t('scope.all')}</h2><p>{t('scope.all.description')}</p></div>
                    <div className={css.overviewActions}>
                      <Button type="button" variant="primary" icon={<IconPlusOutline16 size={16} />} disabled={overviewLoading || busy} onClick={openUploadScopePicker}>{t('scope.upload.choose')}</Button>
                      <Button type="button" variant="ghost" icon={<IconRefreshOutline16 size={16} />} disabled={overviewLoading || busy} onClick={() => { void openOverview(true) }}>{t('modal.refresh')}</Button>
                    </div>
                  </header>
                  <div className={css.overviewToolbar} role="group" aria-label={t('modal.filters')}>
                    <Input
                      className={css.search as string}
                      icon={<IconSearchOutline16 size={16} />}
                      placeholder={t('modal.search')}
                      value={query}
                      onChange={(event) => { setQuery(event.target.value) }}
                    />
                    {!phone && <>
                      <select className={css.select} aria-label={t('modal.type')} value={typeFilter} onChange={(event) => { setTypeFilter(event.currentTarget.value as DocumentTypeFilter) }}>
                        {TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
                      </select>
                      <select className={css.select} aria-label={t('modal.sort')} value={sortValue} onChange={(event) => { setSortValue(event.currentTarget.value) }}>
                        {SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
                      </select>
                    </>}
                  </div>
                  {overviewError !== '' && <div className={css.error} role="alert">{overviewError}</div>}
                  {overviewLoading ? <p className={css.status}>{t('scope.all.loading')}</p> : overviewFiltered.length === 0 ? <p className={css.empty}>{t('scope.all.empty')}</p> : (
                    <div className={css.overviewList} role="list" data-documents-scrollport="overview">
                      {overviewPageRows.map(row => <div key={row.catalogId} className={css.overviewRow} role="listitem">
                        <span className={css.fileIcon} aria-hidden="true"><IconBrowseOutline16 size={16} /></span>
                        <div className={css.meta}>
                          <span className={css.name} title={row.name}>{row.name}</span>
                          <span className={css.size}>{overviewMetaLabel(row, t)}</span>
                        </div>
                        {mode === 'select' ? (
                          <Button className={css.overviewAttach} type="button" size="sm" variant="primary" disabled={overviewLoading} onClick={() => { void openOverviewCopy(row) }}>{sameDocumentScope(catalogRowScope(row), currentScopeDescriptor()) ? t('action.attach') : t('scope.copyAndAttach')}</Button>
                        ) : phone ? (
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
                          <span className={css.overviewRowActions}>
                            <Button type="button" size="sm" variant="ghost" disabled={overviewLoading} onClick={() => { void openOverviewView(row) }}>{t('scope.view')}</Button>
                            <Button type="button" size="sm" variant="outline" disabled={overviewLoading} onClick={() => { void openOverviewCopy(row) }}>{t('scope.copy')}</Button>
                          </span>
                        )}
                      </div>)}
                    </div>
                  )}
                  {overviewPages > 1 && <div className={css.overviewPager}>
                    <Button type="button" variant="outline" disabled={overviewCurrentPage <= 1 || overviewLoading} onClick={() => {
                      const previous = overviewCurrentPage - 1
                      if (overviewServerPaging) {
                        void loadOverviewPage(
                          previous,
                          previous <= 1 ? undefined : overviewCursors.current[previous - 1],
                        )
                      }
                      else setOverviewPage(previous)
                    }}>{t('pager.prev')}</Button>
                    <span>{t('pager.status', {
                      page: String(overviewCurrentPage),
                      pages: overviewServerPaging && overviewTotalDocuments === null ? '…' : String(overviewPages),
                    })}</span>
                    <Button type="button" variant="outline" disabled={overviewServerPaging ? overviewNextCursor === undefined || overviewLoading : overviewCurrentPage >= overviewPages || overviewLoading} onClick={() => {
                      const next = overviewCurrentPage + 1
                      if (overviewServerPaging && overviewNextCursor !== undefined) {
                        overviewCursors.current[overviewCurrentPage] = overviewNextCursor
                        void loadOverviewPage(next, overviewNextCursor)
                      } else setOverviewPage(next)
                    }}>{t('pager.next')}</Button>
                  </div>}
                </section>
              )}
              {trashMode && (
                <section className={css.trash} aria-label={t('trash.title')}>
                  <header className={css.trashHeader}>
                    <div><h2>{t('trash.title')}</h2><p>{visibleScope}</p></div>
                    <Button type="button" variant="ghost" disabled={busy || trashLoading} onClick={() => { void openTrash() }}>
                      {t('modal.refresh')}
                    </Button>
                  </header>
                  {trashLoading ? <p className={css.status}>{t('modal.loading')}</p> : trashDocuments.length === 0 ? <p className={css.empty}>{t('trash.empty')}</p> : (
                    <div className={css.trashList} role="list">
                      {trashDocuments.map(document => (
                        <div key={document.docId} className={css.trashRow} role="listitem">
                          <span className={css.fileIcon} aria-hidden="true"><IconBrowseOutline16 size={16} /></span>
                          <div className={css.meta}>
                            <span className={css.name} title={document.name}>{document.name}</span>
                            <span className={css.size}>{formatBytes(document.bytes)} · {trashMetaLabel(document, t)}</span>
                          </div>
                          <div className={css.trashActions}>
                            <Button type="button" size="sm" variant="outline" aria-label={t('trash.restoreNamed', { name: document.name })} disabled={busy || writeLocked} onClick={() => { void restoreTrashDocument(document) }}>{t('trash.restore')}</Button>
                            <Button type="button" size="sm" variant="ghost" className={css.delete} aria-label={t('trash.purgeNamed', { name: document.name })} disabled={busy || writeLocked} onClick={() => { purgeTrashDocument(document) }}>{t('trash.purge')}</Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {!trashLoading && (trashNextCursor !== undefined || trashPage > 1) && <div className={css.overviewPager}>
                    <Button type="button" variant="outline" disabled={trashPage <= 1 || busy} onClick={() => {
                      const previous = trashPage - 1
                      void openTrash(previous <= 1 ? undefined : trashCursors.current[previous - 1], previous)
                    }}>{t('pager.prev')}</Button>
                    <span>{t('pager.status', { page: String(trashPage), pages: trashNextCursor === undefined ? String(trashPage) : '…' })}</span>
                    <Button type="button" variant="outline" disabled={trashNextCursor === undefined || busy} onClick={() => {
                      if (trashNextCursor === undefined) return
                      trashCursors.current[trashPage] = trashNextCursor
                      void openTrash(trashNextCursor, trashPage + 1)
                    }}>{t('pager.next')}</Button>
                  </div>}
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

              {scopeView !== null && (
                <div className={`${css.scopeNotice} ${scopeView.canUpload ? css.scopeNoticeTarget : css.scopeNoticeReadOnly}`} role="status">
                  <span className={css.scopeNoticeIcon} aria-hidden="true"><IconFolderClose16 size={16} /></span>
                  <span className={css.scopeNoticeCopy}>
                    <strong>{scopeView.canUpload
                      ? t('scope.upload.target', { name: scopeView.label })
                      : scopeView.label}</strong>
                    <small>{scopeView.canUpload ? t('scope.manage.editable') : t('scope.upload.readOnly', { name: scopeView.label })}</small>
                  </span>
                </div>
              )}
              {alternateSource !== null && (
                <div className={`${css.scopeNotice} ${alternateSource.mode === 'rw' ? css.scopeNoticeTarget : css.scopeNoticeReadOnly}`} role="status">
                  <span className={css.scopeNoticeIcon} aria-hidden="true"><IconBrowseOutline16 size={16} /></span>
                  <span className={css.scopeNoticeCopy}>
                    <strong>{alternateSource.label}</strong>
                    <small>{alternateSource.mode === 'rw' ? t('scope.manage.editable') : t('scope.source.readOnly')}</small>
                  </span>
                </div>
              )}

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
                      {trashMode ? (
                        <Button
                          className={css.trashToggle}
                          type="button"
                          variant="outline"
                          disabled={busy || trashLoading}
                          onClick={() => { void load(ROOT_DIRECTORY_ID) }}
                        >
                          {t('trash.back')}
                        </Button>
                      ) : alternateSource === null && !overviewMode && uploadButton}
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
                        {t('action.more.compact')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        className={css.trashToggle}
                        type="button"
                        variant="outline"
                        disabled={busy || trashLoading}
                        onClick={() => { void (trashMode ? load(ROOT_DIRECTORY_ID) : openTrash()) }}
                      >
                        {trashMode ? t('trash.back') : t('trash.button')}
                      </Button>
                      {!trashMode && scopeView === null && alternateSource === null && sourceOptions.length > 0 && (
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
                      {!trashMode && (scopeView !== null || alternateSource !== null) && (
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
                      {!trashMode && <Button
                        className={css.newFolder}
                        type="button"
                        variant="outline"
                        disabled={busy || writeLocked}
                        icon={<IconFolderClose16 size={16} />}
                        onClick={openCreateDirectory}
                      >
                        {t('folder.create')}
                      </Button>}
                      {!trashMode && alternateSource === null && !overviewMode && uploadButton}
                      {!trashMode && <Button
                        className={css.refresh}
                        type="button"
                        variant="ghost"
                        aria-label={t('modal.refresh')}
                        disabled={busy}
                        icon={<IconRefreshOutline16 size={16} />}
                        onClick={() => { void refreshDisplayed() }}
                      />}
                      {!trashMode && <Button
                        type="button"
                        variant="ghost"
                        disabled={busy || historyLoading || overviewMode}
                        onClick={() => { void openHistory() }}
                      >
                        {t('history.button')}
                      </Button>}
                    </>
                  )}
                </div>
              </div>

              <div className={css.caption}>
                <span>{visibleScope}</span>
                {!loading && <span>{t('modal.count', { count: String(totalDocuments ?? filtered.length) })}</span>}
              </div>

              {selected.size > 0 && (
                <div className={`${css.selectionBar} ${css.desktopSelectionBar}`}>
                  <span>{selectionLabel}</span>
                  {clearSelectionButton}
                  {mode === 'select' && (
                    <Button
                      type="button"
                      variant="primary"
                      disabled={busy || onAttachDocument === undefined}
                      onClick={() => { void attachSelectedDocuments() }}
                    >
                      {t('selection.attach')}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy || writeLocked}
                    onClick={() => { void openMove(selectedDocumentList()) }}
                  >
                    {t('selection.move')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => { openCopy(selectedDocumentList()) }}
                  >
                    {t('selection.copy')}
                  </Button>
                  <Button
                    className={css.selectionDelete}
                    type="button"
                    variant="primary"
                    disabled={busy || writeLocked}
                    onClick={() => {
                      setDeleteTargets(selectedDocumentList())
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
                <div className={css.loadingState} role="status" aria-live="polite">
                  <span className={css.visuallyHidden}>{t('modal.loading')}</span>
                  {[0, 1, 2].map(index => <span key={index} className={css.loadingRow} aria-hidden="true" />)}
                </div>
              ) : !hasEntries ? (
                <div className={css.emptyState}>
                  <p className={css.empty}>{t('modal.empty')}</p>
                  {phone && !uploadLocked && (
                    <div className={css.emptyActions}>
                      <Button type="button" variant="primary" aria-label={t('modal.upload')} icon={<IconPlusOutline16 size={16} />} onClick={() => { fileInputRef.current?.click() }}>
                        {t('modal.upload.compact')}
                      </Button>
                      <Button type="button" variant="outline" aria-label={t('folder.create')} disabled={busy} icon={<IconFolderClose16 size={16} />} onClick={openCreateDirectory}>
                        {t('folder.create.compact')}
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
                <div className={css.list} role="list" aria-label={t('modal.title')} data-documents-list="" data-documents-scrollport="list">
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
                    aria-label={t('selection.actions')}
                    aria-haspopup="dialog"
                    onClick={() => { setMobileSheet({ kind: 'selection' }) }}
                  >
                    {t('selection.actions.compact')}
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

      {purgeTarget !== null && (
        <Modal
          open
          onClose={() => { if (!busy) setPurgeTarget(null) }}
          title={t('trash.purge')}
          closeLabel={t('modal.close')}
          className={css.confirmDialog as string}
          footer={(
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => { setPurgeTarget(null) }}>
                {t('modal.cancel')}
              </Button>
              <Button type="button" variant="primary" disabled={busy || writeLocked} onClick={() => { void confirmPurgeTrash() }}>
                {t('trash.purge')}
              </Button>
            </>
          )}
        >
          <p className={css.confirm}>{t('trash.purge.confirm')}</p>
          <p className={css.confirm}>{purgeTarget.name}</p>
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
            <label className={css.formLabel} htmlFor="documents-source-scope-search">{t('copy.source.label')}</label>
            {sourceOptions.length > 1 && (
              <Input
                id="documents-source-scope-search"
                icon={<IconSearchOutline16 size={16} />}
                placeholder={t('scope.switch.search')}
                value={sourcePickerQuery}
                onChange={(event) => { setSourcePickerQuery(event.target.value) }}
              />
            )}
            <div className={css.scopePickerOptions} role="listbox" aria-label={t('copy.source.label')}>
              {filteredSourceOptions.length === 0 ? (
                <p className={css.status}>{t('modal.noResults')}</p>
              ) : filteredSourceOptions.map(option => renderScopePickerOption(
                option,
                sourcePickerValue,
                sourcePickerLoading,
                `${option.mode === 'rw' ? t('scope.project.mode.editable') : t('scope.project.mode.readOnly')} · ${t('scope.source.readOnly')}`,
                setSourcePickerValue,
              ))}
            </div>
            {sourcePickerLoading && <p className={css.status}>{t('copy.source.loading')}</p>}
          </div>
        </Modal>
      )}

      {uploadScopePickerOpen && !phone && (
        <Modal
          open
          onClose={() => { if (!busy) setUploadScopePickerOpen(false) }}
          title={t('scope.upload.choose')}
          closeLabel={t('modal.close')}
          className={css.confirmDialog as string}
          footer={(
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => { setUploadScopePickerOpen(false) }}>
                {t('modal.cancel')}
              </Button>
              <Button type="button" variant="primary" disabled={busy || uploadScopePickerValue === ''} onClick={() => { void chooseUploadScope() }}>
                {t('scope.upload.confirm')}
              </Button>
            </>
          )}
        >
          <div className={css.form}>
            <p className={css.confirm}>{t('scope.upload.root')}</p>
            {uploadScopeOptions.length > 1 && (
              <Input
                autoFocus
                icon={<IconSearchOutline16 size={16} />}
                placeholder={t('scope.switch.search')}
                value={uploadScopePickerQuery}
                onChange={(event) => { setUploadScopePickerQuery(event.target.value) }}
              />
            )}
            <div className={css.scopePickerOptions} role="listbox" aria-label={t('scope.upload.choose')}>
              {filteredUploadScopeOptions.length === 0 ? (
                <p className={css.status}>{t('scope.upload.unavailable')}</p>
              ) : filteredUploadScopeOptions.map(option => renderScopePickerOption(
                option,
                uploadScopePickerValue,
                busy,
                `${t('scope.project.mode.editable')} · ${t('scope.upload.root')}`,
                setUploadScopePickerValue,
              ))}
            </div>
          </div>
        </Modal>
      )}

      {previewDoc && (
        <DocumentPreview
          doc={previewDoc}
          {...((scopeView?.scope ?? alternateSource?.scope) === undefined
            ? {}
            : { scope: scopeView?.scope ?? alternateSource?.scope })}
          maxTextBytes={MAX_PREVIEW_TEXT_BYTES}
          onClose={() => { setPreviewDoc(null) }}
          t={t}
        />
      )}
    </>
  )
}
