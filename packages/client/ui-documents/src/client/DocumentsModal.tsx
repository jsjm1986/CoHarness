import { parseClientSessionKey, type ClientRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FC, type SyntheticEvent } from 'react'
import {
  Button,
  IconBrowseOutline16,
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconCopyOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderClose16,
  IconFolderOpenOutline16,
  IconInfoOutline16,
  IconInspectOutline12,
  IconPaperclipOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  Input,
  Modal,
  Menu,
  MenuItemButton,
  Tooltip,
  ComputerBadge,
  useMediaQuery,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createUserDocClient, readDocumentsScopeResult, readDocumentLocations, UserDocHttpError, UserDocServiceUnavailableError,
  type DocumentsWorkspaceScope, type UserDocDirectoryIdType, type UserDocDirectoryRef, type UserDocIdType,
  type UserDocCatalogHistoryItem, type UserDocCatalogOverview, type UserDocCatalogRow, type UserDocLimits,
  type UserDocRef, type UserDocScope,
  type UserDocListQuery,
  type UserDocUploadPhase,
  type UserDocTransferListedDocument, type UserDocTransferResponse,
  type UserDocTrashRef,
} from './documents-client.ts'
import type { UserDocLocationPage } from '@deepseek-ai/dsh-userdoc'
import { FileTypeIcon } from './FileTypeIcon.tsx'
import { DocumentDestinationPicker } from './DocumentDestinationPicker.tsx'
import { DocumentSortControl } from './DocumentSortControl.tsx'
import { DocumentPreview } from './DocumentPreview.tsx'
import { DocumentsMobileSheet } from './DocumentsMobileSheet.tsx'
import { formatBytes, getDateGroup } from './format.ts'
import {
  PAGE_SIZE,
  clampPage,
  documentTypeBucket,
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
  /** Presentation comes from the browser entry, while document identities remain fully qualified. */
  showComputer?: boolean
  /** Local entries restrict all location choices to their own computer. */
  allowedNodeId?: UserDocScope['nodeId'] | undefined
  /** Captured conversation identity; changing it clears attachment retry state. */
  attachmentTargetId?: string | undefined
  /** Document destination captured from the addressed composer, independent of the manager's browsing scope. */
  attachmentScope?: ClientRuntimeTarget | undefined
  /** Pin private downloads and previews to the document’s verified account. */
  privateResourceUrl?: ((url: string) => string) | undefined
  open: boolean
  onClose: () => void
  t: (key: DocumentsKey, params?: Record<string, string>) => string
  /** Presentation intent: full management or choosing documents for a draft. */
  mode?: 'manage' | 'select'
  /** Attach one existing durable document to the current conversation. */
  onAttachDocument?: (document: UserDocRef) => boolean
  /** Live preflight for the captured conversation, called before copying and again before attachment. */
  canAttachDocument?: () => boolean
}

interface UploadProgress {
  current: number
  total: number
  percent: number
  phase?: UserDocUploadPhase
}

interface UploadBatch {
  readonly viewKey: string
  generation: number
  readonly directoryId: UserDocDirectoryIdType
  readonly scope: UserDocScope | undefined
  readonly listingScope: UserDocScope
  readonly page: number
  readonly total: number
  published: number
}

interface UploadBatchFeedback {
  readonly viewKey: string
  readonly generation: number
  readonly published: number
  readonly total: number
  readonly reconciling: boolean
  readonly reconciled: boolean
}

function uploadErrorMessage(error: unknown, t: (key: DocumentsKey) => string): string {
  if (!(error instanceof UserDocHttpError)) return t('modal.upload.error')
  if (error.code === 'DOCUMENT_UPLOAD_STORAGE') return t('modal.upload.error.storage')
  if (error.code === 'DOCUMENT_UPLOAD_EXPIRED') return t('modal.upload.error.expired')
  if (error.code === 'DOCUMENT_UPLOAD_HASH') return t('modal.upload.error.hash')
  if (error.code === 'DOCUMENT_UPLOAD_PROTOCOL') return t('modal.upload.error.protocol')
  if (error.code === 'DOCUMENT_UPLOAD_BUSY') return t('modal.upload.error.busy')
  if (error.status === 507) return t('modal.upload.error.storage')
  return t('modal.upload.error')
}

function documentErrorMessage(error: unknown, t: (key: DocumentsKey) => string): string {
  if (error instanceof UserDocHttpError) {
    if (error.code === 'DOCUMENT_ATTACHMENT_TARGET_UNAVAILABLE') return t('action.attach.error')
    if (error.code === 'INSTANCE_STARTING') return t('error.runtimeStarting')
    if (error.code === 'INSTANCE_UNREACHABLE' || error.code === 'COLLABORATION_UNAVAILABLE'
      || error.code === 'DOCUMENT_SCOPE_TIMEOUT') {
      return t('error.runtimeUnavailable')
    }
    if (error.code === 'DOCUMENT_LIST_QUERY') return t('error.listQuery')
    if (error.code === 'DOCUMENT_TRASH_NOT_FOUND') return t('error.trashUnavailable')
    if (error.code === 'DOCUMENT_TRASH_CONFLICT') return t('error.trashConflict')
    if (error.code === 'DOCUMENT_RESTORE_CONFLICT') return t('trash.restore.error')
    if (error.status >= 500 && /<(!doctype|html)\b/iu.test(error.message)) return t('error.runtimeUnavailable')
  }
  return error instanceof Error ? error.message : String(error)
}

/** Whether a rejected listing belongs to a superseded or disposed request. */
function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === 'AbortError')
}

/** Link a component-lifetime signal to one listing controller and return its disposer. */
function linkAbortSignal(primary: AbortSignal | undefined, controller: AbortController): () => void {
  if (primary === undefined) return () => {}
  const abort = (): void => {
    controller.abort((primary as AbortSignal & { reason?: unknown }).reason)
  }
  if (primary.aborted) {
    abort()
    return () => {}
  }
  primary.addEventListener('abort', abort, { once: true })
  return () => { primary.removeEventListener('abort', abort) }
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
  /** Timestamp when this metadata page entered the mounted manager's cache. */
  readonly cachedAt?: number
}

/**
 * Assemble one cached metadata page from a listing response's paging fields.
 * @param response - browse response carrying paging metadata.
 * @param body - resolved row fields for the page.
 * @returns the cache record.
 */
function serverPageRecordFrom(
  response: {
    readonly parentDirectoryId?: UserDocDirectoryIdType
    readonly limits?: UserDocLimits
    readonly totalDocuments?: number
    readonly nextCursor?: string
  },
  body: Pick<ServerPageRecord, 'documents' | 'directories' | 'directoryId'>,
): ServerPageRecord {
  return {
    ...body,
    ...(response.parentDirectoryId === undefined ? {} : { parentDirectoryId: response.parentDirectoryId }),
    limits: response.limits ?? null,
    totalDocuments: typeof response.totalDocuments === 'number' ? response.totalDocuments : null,
    ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
  }
}

interface LegacyListingRecord {
  readonly documents: readonly UserDocRef[]
  readonly directories: readonly UserDocDirectoryRef[]
  readonly directoryId: UserDocDirectoryIdType
  readonly limits: UserDocLimits | null
  /** Timestamp when this metadata listing entered the mounted manager's cache. */
  readonly cachedAt?: number
}

interface ScopeListingResponse {
  readonly documents: readonly (UserDocTransferListedDocument | UserDocRef)[]
  readonly directories?: readonly UserDocDirectoryRef[]
  readonly directoryId?: UserDocDirectoryIdType
  readonly parentDirectoryId?: UserDocDirectoryIdType
  readonly limits?: UserDocLimits
  readonly totalDocuments?: number
  readonly nextCursor?: string
}

type CacheFreshness = 'fresh' | 'stale'

interface CachedListing<T> {
  readonly value: T
  readonly freshness: CacheFreshness
  readonly paged: boolean
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
const MAX_LEGACY_LISTING_CACHE_ENTRIES = 24
/** Metadata remains immediately reusable during normal manager interactions. */
const DOCUMENT_LISTING_FRESH_TTL_MS = 30_000
/** Stale metadata is retained briefly so a slow runtime never blanks the UI. */
const DOCUMENT_LISTING_MAX_AGE_MS = 5 * 60_000

const DEFAULT_SORT: DocumentSort = { key: 'date', dir: 'desc' }

/** Wire sort value used by the paged document endpoint. */
function wireSort(sort: DocumentSort): NonNullable<UserDocListQuery['sort']> {
  const key = sort.key === 'date' ? 'date' : sort.key === 'name' ? 'name' : 'size'
  return `${key}-${sort.dir}`
}

/** Stable key for a scope so page caches never cross an authorization context. */
function scopeCacheKey(value: UserDocScope): string {
  const owner = value.kind === 'personal' ? 'personal' : `project:${String(value.projectId)}`
  return value.nodeId === undefined ? owner : `${owner}@${value.nodeId}`
}

/** Stable cache key for one scope, directory, and listing request. */
function documentListingCacheKey(
  target: UserDocScope,
  directoryId: UserDocDirectoryIdType,
  query: string,
  type: DocumentTypeFilter,
  sort: NonNullable<UserDocListQuery['sort']>,
): string {
  return JSON.stringify({
    scope: scopeCacheKey(target),
    directory: String(directoryId),
    query,
    type,
    sort,
  })
}

/** Compare scope identities without depending on display labels or modes. */
function sameDocumentScope(left: UserDocScope, right: UserDocScope): boolean {
  if (left.kind !== right.kind || left.nodeId !== right.nodeId) return false
  return left.kind === 'personal' || (right.kind === 'project' && left.projectId === right.projectId)
}

function documentScopeOf(value: DocumentsWorkspaceScope): UserDocScope {
  const owner: UserDocScope = value.kind === 'project' && value.projectId !== undefined
    ? { kind: 'project', projectId: value.projectId }
    : { kind: 'personal' }
  return { ...owner, ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }),
    ...(value.nodeName === undefined ? {} : { nodeName: value.nodeName }) }
}

function catalogRowScope(row: UserDocCatalogRow): UserDocScope {
  const owner: UserDocScope = row.scope.kind === 'project' && row.scope.id !== undefined
    ? { kind: 'project', projectId: row.scope.id }
    : { kind: 'personal' }
  return { ...owner, ...(row.scope.nodeId === undefined ? {} : { nodeId: row.scope.nodeId }) }
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

function sameTrashEntry(left: UserDocTrashRef, right: UserDocTrashRef): boolean {
  if (left.trashId !== undefined || right.trashId !== undefined) return left.trashId === right.trashId
  if (left.identity !== undefined || right.identity !== undefined) {
    return left.docId === right.docId && left.identity?.incarnationId === right.identity?.incarnationId
  }
  return left.docId === right.docId && left.trashedAt === right.trashedAt
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

function parentDirectory(directoryId: UserDocDirectoryIdType): UserDocDirectoryIdType {
  const segments = String(directoryId).split('/').filter(Boolean)
  segments.pop()
  return segments.join('/') as UserDocDirectoryIdType
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
export const DocumentsModal: FC<DocumentsModalProps> = ({
  open, onClose, t, mode = 'manage', showComputer = false, allowedNodeId, onAttachDocument, canAttachDocument, privateResourceUrl, attachmentScope, attachmentTargetId,
}) => {
  const phone = useMediaQuery('(max-width: 767px)')
  const touch = useMediaQuery('(pointer: coarse)')
  const compactNavigation = useMediaQuery('(max-width: 1100px)')
  const [documents, setDocuments] = useState<UserDocRef[]>([])
  const [directories, setDirectories] = useState<UserDocDirectoryRef[]>([])
  const [currentDirectoryId, setCurrentDirectoryId] = useState<UserDocDirectoryIdType>(ROOT_DIRECTORY_ID)
  const directoryNavigation = useRef<{ directoryId: UserDocDirectoryIdType } | null>(null)
  const [limits, setLimits] = useState<UserDocLimits | null>(null)
  const [totalDocuments, setTotalDocuments] = useState<number | null>(null)
  const [scope, setScope] = useState<DocumentsWorkspaceScope>({ kind: 'personal' })
  const [allLocations, setLocations] = useState<UserDocLocationPage | undefined>()
  const locations = useMemo(() => allLocations === undefined ? undefined : allowedNodeId === undefined ? allLocations
    : { ...allLocations, items: allLocations.items.filter(item => item.scope.nodeId === allowedNodeId) }, [allLocations, allowedNodeId])
  const [locationsCursor, setLocationsCursor] = useState<string | undefined>()
  const [locationsError, setLocationsError] = useState(false)
  const [locationsLoading, setLocationsLoading] = useState(false)
  useEffect(() => { setLocationsCursor(undefined) }, [allowedNodeId])
  useEffect(() => {
    if (!open || scope.nodeId === undefined) return
    const controller = new AbortController()
    setLocationsLoading(true)
    void readDocumentLocations(controller.signal, locationsCursor).then((page) => {
      if (!controller.signal.aborted) {
        setLocations((previous) => {
          if (page === undefined || locationsCursor === undefined) return page
          const items = new Map((previous?.items ?? []).map(item => [scopeCacheKey(item.scope), item]))
          for (const item of page.items) items.set(scopeCacheKey(item.scope), item)
          return { items: [...items.values()], nextCursor: page.nextCursor }
        })
        setLocationsError(false)
      }
    }, () => { if (!controller.signal.aborted) setLocationsError(true) }).finally(() => {
      if (!controller.signal.aborted) setLocationsLoading(false)
    })
    return () => { controller.abort() }
  }, [open, locationsCursor, scope.nodeId, scope.accountId, allowedNodeId])
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
  const [refreshing, setRefreshing] = useState(false)
  const [pendingScopeLabel, setPendingScopeLabel] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<UserDocRef[]>([])
  const copiedAttachments = useRef(new Map<string, UserDocRef>())
  const attachmentGeneration = useRef(0)
  useLayoutEffect(() => {
    attachmentGeneration.current++
    copiedAttachments.current = new Map()
    setPendingAttachments([])
  }, [attachmentTargetId, scope.accountId])
  useEffect(() => {
    if (!open && pendingAttachments.length === 0) copiedAttachments.current.clear()
  }, [open, pendingAttachments.length])
  const [modalError, setModalError] = useState('')
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<DocumentTypeFilter>('all')
  const [sortValue, setSortValue] = useState('date:desc')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [selectedRecords, setSelectedRecords] = useState<Map<string, UserDocRef>>(() => new Map())
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [uploadFeedback, setUploadFeedback] = useState<UploadBatchFeedback | null>(null)
  const uploadBatch = useRef<UploadBatch | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [deleteTargets, setDeleteTargets] = useState<UserDocRef[] | null>(null)
  const [folderEditor, setFolderEditor] = useState<FolderEditor | null>(null)
  const [folderName, setFolderName] = useState('')
  const [deleteDirectory, setDeleteDirectory] = useState<UserDocDirectoryRef | null>(null)
  const [moveTargets, setMoveTargets] = useState<UserDocRef[] | null>(null)
  const [moveDirectories, setMoveDirectories] = useState<UserDocDirectoryRef[]>([])
  const [moveDirectoryId, setMoveDirectoryId] = useState<UserDocDirectoryIdType>(ROOT_DIRECTORY_ID)
  const [moveLoading, setMoveLoading] = useState(false)
  const [copySourceScope, setCopySourceScope] = useState<UserDocScope | null>(null)
  const [copyTargets, setCopyTargets] = useState<CopyTargetOption[] | null>(null)
  const [singleCopyDocument, setSingleCopyDocument] = useState<UserDocRef | null>(null)
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
  const [previewContext, setPreviewContext] = useState('')
  const [rowMenuId, setRowMenuId] = useState<string | null>(null)
  const [scopeFilter, setScopeFilter] = useState('')
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const previewTriggers = useRef(new Map<string, HTMLButtonElement>())
  const actionReturnTarget = useRef<HTMLButtonElement | null>(null)
  const focusActionAnchor = () => {
    if (actionReturnTarget.current?.isConnected === true) actionReturnTarget.current.focus({ preventScroll: true })
  }
  const overlayGeneration = useRef(0)
  const trashReturnFocusPending = useRef(false)
  const copyDialogGeneration = useRef(0)
  useEffect(() => {
    return () => { overlayGeneration.current += 1 }
  }, [open])
  useEffect(() => {
    copyDialogGeneration.current += 1
    setCopyFolderCreating(false)
    setRetryingCopyId(null)
  }, [copyTargets])
  const [overviewMode, setOverviewMode] = useState(false)
  const [overviewRows, setOverviewRows] = useState<UserDocCatalogRow[]>([])
  const [overviewPage, setOverviewPage] = useState(1)
  const [overviewServerPaging, setOverviewServerPaging] = useState(false)
  const [overviewEntry, setOverviewEntry] = useState(allowedNodeId)
  const [overviewTotalDocuments, setOverviewTotalDocuments] = useState<number | null>(null)
  const [overviewNextCursor, setOverviewNextCursor] = useState<string | undefined>()
  const overviewCursors = useRef<string[]>([])
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [overviewCopyRow, setOverviewCopyRow] = useState<OverviewCopyTarget | null>(null)
  const [overviewError, setOverviewError] = useState('')
  const [unavailableDocumentComputers, setUnavailableDocumentComputers] = useState(0)
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
  const pendingRuntimePages = useRef<{
    readonly generation: number
    readonly directoryId: UserDocDirectoryIdType
    readonly query: string
    readonly type: DocumentTypeFilter
    readonly sort: NonNullable<UserDocListQuery['sort']>
    readonly pages: Map<number, ServerPageRecord>
  } | null>(null)
  const pendingRuntimeLegacy = useRef<{
    readonly generation: number
    readonly directoryId: UserDocDirectoryIdType
    readonly query: string
    readonly type: DocumentTypeFilter
    readonly sort: NonNullable<UserDocListQuery['sort']>
    readonly listing: LegacyListingRecord
  } | null>(null)
  /** True while a refreshed account context is still deciding the runtime scope. */
  const scopeResolutionPending = useRef(false)
  const listingController = useRef<AbortController | null>(null)
  const overviewRequestGeneration = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const headerCheckRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const loadGeneration = useRef(0)
  const requestScope = useRef(attachmentScope)
  requestScope.current = attachmentScope ?? documentScopeOf(scope)
  const userDocs = useRef(createUserDocClient(privateResourceUrl, () => requestScope.current))
  const listingCache = useRef(new Map<string, LegacyListingRecord>())
  const scopeCache = useRef<DocumentsWorkspaceScope | null>(null)
  const overviewCache = useRef<{ readonly key: string; readonly response: UserDocCatalogOverview } | null>(null)
  const overviewLoadedKey = useRef<string | null>(null)

  const beginListingRequest = (): { controller: AbortController; signal: AbortSignal } => {
    listingController.current?.abort()
    const controller = new AbortController()
    listingController.current = controller
    return { controller, signal: controller.signal }
  }

  const finishListingRequest = (controller: AbortController): void => {
    if (listingController.current === controller) listingController.current = null
  }

  const cacheFreshness = (cachedAt: number | undefined, now = Date.now()): CacheFreshness | 'expired' => {
    if (cachedAt === undefined || !Number.isFinite(cachedAt)) return 'expired'
    const age = Math.max(0, now - cachedAt)
    if (age > DOCUMENT_LISTING_MAX_AGE_MS) return 'expired'
    return age <= DOCUMENT_LISTING_FRESH_TTL_MS ? 'fresh' : 'stale'
  }

  const rememberLegacyListing = (key: string, value: LegacyListingRecord): void => {
    const now = Date.now()
    const stored: LegacyListingRecord = {
      ...value,
      cachedAt: value.cachedAt ?? now,
    }
    serverPages.current.delete(key)
    listingCache.current.delete(key)
    listingCache.current.set(key, stored)
    while (listingCache.current.size > MAX_LEGACY_LISTING_CACHE_ENTRIES) {
      const oldestKey = listingCache.current.keys().next().value
      if (oldestKey === undefined) break
      listingCache.current.delete(oldestKey)
    }
  }

  const readCachedLegacyListing = (key: string): CachedListing<LegacyListingRecord> | undefined => {
    const record = listingCache.current.get(key)
    if (record === undefined) return undefined
    const freshness = cacheFreshness(record.cachedAt)
    if (freshness === 'expired') {
      listingCache.current.delete(key)
      return undefined
    }
    listingCache.current.delete(key)
    listingCache.current.set(key, record)
    return { value: record, freshness, paged: false }
  }

  const remoteListingKey = (target: UserDocScope): string => documentListingCacheKey(
    target, ROOT_DIRECTORY_ID, '', typeFilter, wireSort(parseSort(sortValue)),
  )

  const readCachedServerPage = (key: string, pageNumber: number): CachedListing<ServerPageRecord> | undefined => {
    const pages = serverPages.current.get(key)
    const record = pages?.get(pageNumber)
    if (record === undefined) return undefined
    const freshness = cacheFreshness(record.cachedAt)
    if (freshness === 'expired') {
      pages?.delete(pageNumber)
      if (pages !== undefined && pages.size === 0) serverPages.current.delete(key)
      return undefined
    }
    pages?.delete(pageNumber)
    pages?.set(pageNumber, record)
    if (pages !== undefined) {
      serverPages.current.delete(key)
      serverPages.current.set(key, pages)
    }
    return { value: record, freshness, paged: true }
  }

  const readCachedListing = (key: string, pageNumber = 1): CachedListing<ServerPageRecord> | undefined => {
    const server = readCachedServerPage(key, pageNumber)
    if (server !== undefined) return server
    const legacy = readCachedLegacyListing(key)
    if (legacy === undefined) return undefined
    return {
      value: {
        documents: legacy.value.documents,
        directories: legacy.value.directories,
        directoryId: legacy.value.directoryId,
        limits: legacy.value.limits,
        totalDocuments: legacy.value.documents.length,
        ...(legacy.value.cachedAt === undefined ? {} : { cachedAt: legacy.value.cachedAt }),
      },
      freshness: legacy.freshness,
      paged: false,
    }
  }

  const cachedRemoteListing = (target: UserDocScope): CachedListing<ServerPageRecord> | undefined => {
    return readCachedListing(remoteListingKey(target))
  }

  const rememberServerPage = (key: string, pageNumber: number, record: ServerPageRecord): void => {
    const now = Date.now()
    const stored: ServerPageRecord = {
      ...record,
      cachedAt: record.cachedAt ?? now,
    }
    listingCache.current.delete(key)
    let pages = serverPages.current.get(key)
    if (pages === undefined) {
      pages = new Map<number, ServerPageRecord>()
      serverPages.current.set(key, pages)
    }
    pages.delete(pageNumber)
    pages.set(pageNumber, stored)
    serverPages.current.delete(key)
    serverPages.current.set(key, pages)
    while (pages.size > MAX_SERVER_PAGES_PER_KEY) {
      const keys = [...pages.keys()]
      const oldest = keys.find(value => value !== 1) ?? keys[0]
      if (oldest === undefined) break
      pages.delete(oldest)
    }
    while (serverPages.current.size > MAX_SERVER_PAGE_CACHE_KEYS) {
      const oldestKey = serverPages.current.keys().next().value
      if (oldestKey === undefined) break
      serverPages.current.delete(oldestKey)
    }
  }

  /** Remove expired metadata opportunistically so it does not consume cache capacity. */
  const pruneDocumentCaches = (): void => {
    for (const [key, record] of listingCache.current) {
      if (cacheFreshness(record.cachedAt) === 'expired') listingCache.current.delete(key)
    }
    for (const [key, pages] of serverPages.current) {
      for (const [pageNumber, record] of pages) {
        if (cacheFreshness(record.cachedAt) === 'expired') pages.delete(pageNumber)
      }
      if (pages.size === 0) serverPages.current.delete(key)
    }
  }

  /** Expire freshness without discarding visible or scope-pending continuation chains. */
  const markDocumentCachesStale = (): void => {
    const staleAt = Date.now() - DOCUMENT_LISTING_FRESH_TTL_MS - 1
    const stale = <T extends { readonly cachedAt?: number }>(record: T): T => ({
      ...record, cachedAt: Math.min(record.cachedAt ?? staleAt, staleAt),
    })
    for (const [key, record] of listingCache.current) listingCache.current.set(key, stale(record))
    for (const pages of serverPages.current.values()) {
      for (const [number, record] of pages) pages.set(number, stale(record))
    }
    const pending = pendingRuntimePages.current
    if (pending !== null) {
      for (const [number, record] of pending.pages) pending.pages.set(number, stale(record))
    }
    const legacy = pendingRuntimeLegacy.current
    if (legacy !== null) pendingRuntimeLegacy.current = { ...legacy, listing: stale(legacy.listing) }
  }

  const pendingRuntimePageMatches = (
    pending: {
      readonly generation: number
      readonly directoryId: UserDocDirectoryIdType
      readonly query: string
      readonly type: DocumentTypeFilter
      readonly sort: NonNullable<UserDocListQuery['sort']>
      readonly pages: Map<number, ServerPageRecord>
    },
    generation: number,
    directoryId: UserDocDirectoryIdType,
  ): boolean => pending.generation === generation
    && pending.directoryId === directoryId
    && pending.query === query.trim()
    && pending.type === typeFilter
    && pending.sort === wireSort(parseSort(sortValue))

  const rememberPendingRuntimePage = (
    pending: {
      readonly pages: Map<number, ServerPageRecord>
    },
    pageNumber: number,
    record: ServerPageRecord,
  ): void => {
    pending.pages.set(pageNumber, record)
    while (pending.pages.size > MAX_SERVER_PAGES_PER_KEY) {
      const keys = [...pending.pages.keys()]
      const oldest = keys.find(value => value !== 1) ?? keys[0]
      if (oldest === undefined) break
      pending.pages.delete(oldest)
    }
  }

  /** Move an initial runtime page chain into the scope-qualified cache. */
  const settlePendingRuntimePages = (target: UserDocScope, generation: number): string | null => {
    const pending = pendingRuntimePages.current
    if (pending !== null && pending.generation === generation) {
      const key = documentListingCacheKey(target, pending.directoryId, pending.query, pending.type, pending.sort)
      for (const [pageNumber, record] of pending.pages) rememberServerPage(key, pageNumber, record)
      pendingRuntimePages.current = null
      return key
    }
    const legacy = pendingRuntimeLegacy.current
    if (legacy !== null && legacy.generation === generation) {
      const key = documentListingCacheKey(target, legacy.directoryId, legacy.query, legacy.type, legacy.sort)
      rememberLegacyListing(key, legacy.listing)
      pendingRuntimeLegacy.current = null
      return key
    }
    return null
  }

  const runtimeListingScopePending = (): boolean => (scopeCache.current === null || scopeResolutionPending.current)
    && scopeView === null
    && alternateSource === null

  const discardPendingRuntimePages = (): void => {
    pendingRuntimePages.current = null
    pendingRuntimeLegacy.current = null
    scopeResolutionPending.current = false
  }

  const runtimeScope = (): UserDocScope => documentScopeOf(scope)
  const locate = (target: UserDocScope): UserDocScope => {
    if (target.nodeId !== undefined) return target
    const match = target.kind === 'project' ? locations?.items.find(item => item.scope.kind === 'project' && item.scope.projectId === target.projectId) : undefined
    if (match !== undefined) return match.scope
    const nodeId = attachmentScope?.nodeId ?? scope.nodeId
    const nodeName = attachmentScope?.nodeName ?? scope.nodeName
    return target.kind === 'personal' && nodeId !== undefined ? { ...target, nodeId, ...(nodeName === undefined ? {} : { nodeName }) } : target
  }

  const cachedRuntimeScope = (): UserDocScope => scopeCache.current === null
    ? { kind: 'personal' }
    : documentScopeOf(scopeCache.current)

  const listingScope = (): UserDocScope => scopeView?.scope ?? alternateSource?.scope ?? runtimeScope()

  const overviewFilterKey = (): string => JSON.stringify({
    entry: allowedNodeId,
    query: query.trim(),
    type: typeFilter,
    sort: wireSort(parseSort(sortValue)),
  })

  const clearSelection = (): void => {
    setSelected(new Set())
    setSelectedRecords(new Map())
  }

  const dropSelection = (docId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(docId)
      return next
    })
    setSelectedRecords((prev) => {
      if (!prev.has(docId)) return prev
      const next = new Map(prev)
      next.delete(docId)
      return next
    })
  }

  const selectedDocumentList = (): UserDocRef[] => {
    const result: UserDocRef[] = []
    for (const id of selected) {
      const document = selectedRecords.get(id) ?? documents.find(candidate => candidate.docId === id)
      if (document !== undefined) result.push(document)
    }
    return result
  }

  const listingKeyFor = (target: UserDocScope, directoryId: UserDocDirectoryIdType): string => documentListingCacheKey(
    target, directoryId, query.trim(), typeFilter, wireSort(parseSort(sortValue)),
  )

  const emptyListingKey = (target: UserDocScope, directoryId: UserDocDirectoryIdType): string => documentListingCacheKey(
    target, directoryId, '', typeFilter, wireSort(parseSort(sortValue)),
  )

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

  const fetchScopeListing = async (
    target: UserDocScope,
    directoryId: UserDocDirectoryIdType,
    listingQuery: UserDocListQuery,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    return userDocs.current.browseScope(target, directoryId, signal, listingQuery)
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

  const applyScopeListingResponse = (
    response: ScopeListingResponse,
    fallbackDirectoryId: UserDocDirectoryIdType,
    scope: UserDocScope,
  ): void => {
    const nextDirectoryId = response.directoryId ?? fallbackDirectoryId
    const nextDocuments = response.documents.map(document => ({ ...document, path: '' }))
    const nextDirectories = response.directories?.map(normalizeDirectoryRef) ?? []
    const key = emptyListingKey(scope, nextDirectoryId)
    setDocuments(nextDocuments)
    setDirectories(nextDirectories)
    setCurrentDirectoryId(nextDirectoryId)
    setLimits(response.limits ?? null)
    setTotalDocuments(typeof response.totalDocuments === 'number' ? response.totalDocuments : nextDocuments.length)
    if (isServerPage(response)) {
      const pageRecord = serverPageRecordFrom(response, {
        documents: nextDocuments,
        directories: nextDirectories,
        directoryId: nextDirectoryId,
      })
      rememberServerPage(key, 1, pageRecord)
      serverLoadedKey.current = key
      setServerPaging(true)
      setServerTotalDocuments(pageRecord.totalDocuments)
      setServerNextCursor(pageRecord.nextCursor)
      serverPagingRef.current = true
    } else {
      rememberLegacyListing(key, {
        documents: nextDocuments,
        directories: nextDirectories,
        directoryId: nextDirectoryId,
        limits: response.limits ?? null,
      })
      setServerPaging(false)
      setServerTotalDocuments(null)
      setServerNextCursor(undefined)
      serverPagingRef.current = false
    }
  }

  const applyCachedListing = (cached: CachedListing<ServerPageRecord>): void => {
    applyServerPage(cached.value)
    setServerPaging(cached.paged)
    setServerTotalDocuments(cached.paged ? cached.value.totalDocuments : null)
    setServerNextCursor(cached.paged ? cached.value.nextCursor : undefined)
    serverPagingRef.current = cached.paged
    listingReadyRef.current = true
    setLoading(false)
  }

  const loadServerPage = async (
    requestedPage: number,
    directoryId: UserDocDirectoryIdType = currentDirectoryId,
    force = false,
  ): Promise<boolean> => {
    pruneDocumentCaches()
    const generation = serverRequestGeneration.current + 1
    serverRequestGeneration.current = generation
    const listingRequest = beginListingRequest()
    const requestSignal = listingRequest.signal
    const key = listingKey(directoryId)
    const runtimeScopePending = runtimeListingScopePending()
    let pagesForKey: Map<number, ServerPageRecord>
    if (runtimeScopePending) {
      // The first runtime listing can finish before account context tells us
      // which scope owns it. Keep its cursor chain out of the scope cache.
      let pending = pendingRuntimePages.current
      if (pending === null || !pendingRuntimePageMatches(pending, loadGeneration.current, directoryId) || force) {
        pending = {
          generation: loadGeneration.current,
          directoryId,
          query: query.trim(),
          type: typeFilter,
          sort: wireSort(parseSort(sortValue)),
          pages: new Map(),
        }
        pendingRuntimePages.current = pending
      }
      pagesForKey = pending.pages
      if (force) pagesForKey.clear()
    } else {
      serverLoadedKey.current = key
      pagesForKey = serverPages.current.get(key) ?? new Map<number, ServerPageRecord>()
      if (force) pagesForKey.clear()
      serverPages.current.set(key, pagesForKey)
    }
    const cachedLookup = force
      ? undefined
      : runtimeScopePending
        ? (() => {
          const pendingRecord = pagesForKey.get(requestedPage)
          return pendingRecord === undefined
            ? undefined
            : { value: pendingRecord, freshness: 'fresh' as const, paged: true as const }
        })()
        : readCachedServerPage(key, requestedPage)
    const cached = cachedLookup?.value
    const shouldRevalidate = force || cached === undefined || cachedLookup?.freshness === 'stale'
    const keepVisibleListing = listingReadyRef.current || cached !== undefined
    if (cached !== undefined) {
      applyServerPage(cached)
      setPage(requestedPage)
      serverPagingRef.current = true
      setServerPaging(true)
      listingReadyRef.current = true
    }
    setPendingScopeLabel('')
    setRefreshing(shouldRevalidate && keepVisibleListing)
    if (!keepVisibleListing) setLoading(true)
    else setLoading(false)
    setError('')
    setNotice('')
    try {
      let pageRecord = shouldRevalidate ? undefined : cached
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
        const response = await fetchListingPage(directoryId, queryForPage(cursor), requestSignal) as {
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
        if (runtimeListingScopePending()) {
          const activePending = pendingRuntimePages.current
          if (activePending !== null && pendingRuntimePageMatches(activePending, loadGeneration.current, directoryId)) {
            rememberPendingRuntimePage(activePending, requestedPage, pageRecord)
          } else if (requestedPage === 1) {
            pendingRuntimePages.current = {
              generation: loadGeneration.current,
              directoryId,
              query: query.trim(),
              type: typeFilter,
              sort: wireSort(parseSort(sortValue)),
              pages: new Map(),
            }
            rememberPendingRuntimePage(pendingRuntimePages.current, requestedPage, pageRecord)
          }
        } else {
          rememberServerPage(key, requestedPage, pageRecord)
        }
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
      if (!isAbortError(cause, requestSignal)) setError(documentErrorMessage(cause, t))
      return false
    } finally {
      if (generation === serverRequestGeneration.current) {
        setLoading(false)
        setRefreshing(false)
        finishListingRequest(listingRequest.controller)
      }
    }
  }

  const load = async (
    directoryId: UserDocDirectoryIdType = currentDirectoryId,
    signal?: AbortSignal,
    options: { readonly refreshScope?: boolean } = {},
  ) => {
    const refreshScope = options.refreshScope === true
    setMobileSheet(null)
    clearSelection()
    overviewRequestGeneration.current += 1
    overviewLoadedKey.current = null
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    const listingRequest = beginListingRequest()
    const unlinkAbortSignal = linkAbortSignal(signal, listingRequest.controller)
    const requestSignal = listingRequest.signal
    discardPendingRuntimePages()
    pruneDocumentCaches()
    const shouldReadScope = scopeCache.current === null || refreshScope
    scopeResolutionPending.current = shouldReadScope
    // `load` is always the active runtime path. State setters below do not
    // change the closure synchronously when the user leaves an alternate
    // scope, so bypass the selected-scope dispatcher here explicitly.
    const cachedScope = scopeCache.current
    const cachedListing = cachedScope === null
      ? undefined
      : readCachedListing(listingKeyFor(documentScopeOf(cachedScope), directoryId))
    if (cachedListing !== undefined) applyCachedListing(cachedListing)
    const shouldFetchListing = cachedListing === undefined || cachedListing.freshness === 'stale'
    const keepVisibleListing = listingReadyRef.current || cachedListing !== undefined
    setPendingScopeLabel('')
    setRefreshing(shouldFetchListing && keepVisibleListing)
    if (!keepVisibleListing) setLoading(true)
    else setLoading(false)
    setError('')
    setNotice('')
    setOverviewMode(false)
    setTrashMode(false)
    setScopeView(null)
    setAlternateSource(null)
    setUploadScopePickerOpen(false)
    serverRequestGeneration.current += 1
    if (!keepVisibleListing) {
      serverPagingRef.current = false
      setServerPaging(false)
      setServerTotalDocuments(null)
      setServerNextCursor(undefined)
    }
    if (scopeStatus !== 'ready') setScopeStatus('loading')
    if (scopeCache.current !== null) {
      setScope(scopeCache.current)
      setScopeStatus('ready')
    }
    const scopeRequest = (shouldReadScope || cachedScope === null
      ? readDocumentsScopeResult(requestSignal)
      : Promise.resolve({ scope: cachedScope, available: true as const })).then((result) => {
      if (requestSignal.aborted || generation !== loadGeneration.current) {
        return { changed: false, confirmed: false }
      }
      if (result.available) {
        const previousScope = scopeCache.current
        const changed = previousScope !== null
          && !sameDocumentScope(documentScopeOf(previousScope), documentScopeOf(result.scope))
        scopeResolutionPending.current = false
        const settledKey = settlePendingRuntimePages(documentScopeOf(result.scope), generation)
        if (settledKey !== null) serverLoadedKey.current = settledKey
        setScope(result.scope)
        scopeCache.current = result.scope
        setScopeStatus('ready')
        return { changed, confirmed: true }
      } else {
        setScopeStatus('stale')
        return { changed: false, confirmed: false }
      }
    }).catch((cause: unknown) => {
      if (isAbortError(cause, requestSignal) || generation !== loadGeneration.current) {
        return { changed: false, confirmed: false }
      }
      setScopeStatus('stale')
      if (cause instanceof UserDocHttpError) setError(documentErrorMessage(cause, t))
      return { changed: false, confirmed: false }
    })
    if (!shouldFetchListing) {
      const scopeResult = await scopeRequest
      unlinkAbortSignal()
      if (generation === loadGeneration.current) {
        scopeResolutionPending.current = !scopeResult.confirmed
        setLoading(false)
        setRefreshing(false)
        finishListingRequest(listingRequest.controller)
      }
      if (scopeResult.changed && !requestSignal.aborted && generation === loadGeneration.current) {
        await load(directoryId, signal)
      }
      return
    }
    try {
      const response = await userDocs.current.browse(directoryId, requestSignal, queryForPage()) as {
        readonly documents: readonly UserDocRef[]
        readonly directories?: readonly UserDocDirectoryRef[]
        readonly directoryId?: UserDocDirectoryIdType
        readonly parentDirectoryId?: UserDocDirectoryIdType
        readonly limits?: UserDocLimits
        readonly totalDocuments?: number
        readonly nextCursor?: string
      }
      if (requestSignal.aborted || generation !== loadGeneration.current) return
      if (isServerPage(response)) {
        const requestQuery = query.trim()
        const requestSort = wireSort(parseSort(sortValue))
        const pageRecord = serverPageRecordFrom(response, {
          documents: response.documents,
          directories: response.directories ?? [],
          directoryId: response.directoryId ?? directoryId,
        })
        const resolvedScope = scopeResolutionPending.current || scopeCache.current === null
          ? undefined
          : documentScopeOf(scopeCache.current)
        if (resolvedScope !== undefined) {
          const key = documentListingCacheKey(resolvedScope, directoryId, requestQuery, typeFilter, requestSort)
          rememberServerPage(key, 1, pageRecord)
          serverLoadedKey.current = key
          pendingRuntimePages.current = null
          pendingRuntimeLegacy.current = null
        } else {
          pendingRuntimeLegacy.current = null
          pendingRuntimePages.current = {
            generation,
            directoryId,
            query: requestQuery,
            type: typeFilter,
            sort: requestSort,
            pages: new Map([[1, pageRecord]]),
          }
          serverLoadedKey.current = null
        }
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
        const legacyRecord: LegacyListingRecord = {
          documents: [...legacyResponse.documents],
          directories: [...legacyResponse.directories],
          directoryId: legacyResponse.directoryId,
          limits: legacyResponse.limits ?? null,
        }
        setDocuments([...legacyResponse.documents])
        setDirectories([...legacyResponse.directories])
        setCurrentDirectoryId(legacyResponse.directoryId)
        setLimits(legacyResponse.limits ?? null)
        setTotalDocuments(legacyResponse.documents.length)
        const resolvedScope = scopeResolutionPending.current || scopeCache.current === null
          ? undefined
          : documentScopeOf(scopeCache.current)
        if (resolvedScope !== undefined) {
          pendingRuntimePages.current = null
          pendingRuntimeLegacy.current = null
          rememberLegacyListing(listingKeyFor(resolvedScope, legacyResponse.directoryId), legacyRecord)
        } else {
          pendingRuntimePages.current = null
          pendingRuntimeLegacy.current = {
            generation,
            directoryId: legacyResponse.directoryId,
            query: query.trim(),
            type: typeFilter,
            sort: wireSort(parseSort(sortValue)),
            listing: legacyRecord,
          }
        }
      }
      setScopeView(null)
      setAlternateSource(null)
      listingReadyRef.current = true
    } catch (cause) {
      if (isAbortError(cause, requestSignal) || generation !== loadGeneration.current) return
      if (cause instanceof UserDocServiceUnavailableError) {
        setError(t('error.unavailable'))
      } else {
        setError(documentErrorMessage(cause, t))
      }
    } finally {
      // A superseded load still owns the component-lifetime listener even
      // though it no longer owns loading state or the active controller.
      unlinkAbortSignal()
      if (generation === loadGeneration.current) {
        setLoading(false)
        setRefreshing(false)
        finishListingRequest(listingRequest.controller)
      }
    }
    const scopeResult = await scopeRequest
    if (generation === loadGeneration.current) {
      scopeResolutionPending.current = !scopeResult.confirmed
    }
  }

  const openOverview = async (force = false): Promise<boolean> => {
    discardPendingRuntimePages()
    const key = overviewFilterKey()
    const generation = overviewRequestGeneration.current + 1
    overviewRequestGeneration.current = generation
    const listingRequest = beginListingRequest()
    const requestSignal = listingRequest.signal
    loadGeneration.current += 1
    serverRequestGeneration.current += 1
    setPendingScopeLabel('')
    setRefreshing(false)
    clearSelection()
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
          }, requestSignal)
          : await userDocs.current.overview(requestSignal)
      if (requestSignal.aborted || generation !== overviewRequestGeneration.current) return false
      overviewCache.current = response.partial ? null : { key, response }
      overviewLoadedKey.current = key
      setUnavailableDocumentComputers(response.unavailableNodes?.length ?? 0)
      setOverviewRows([...response.documents])
      setOverviewEntry(allowedNodeId)
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
      if (!isAbortError(cause, requestSignal)) {
        const message = documentErrorMessage(cause, t)
        setOverviewError(message)
        setError(message)
      }
      return false
    } finally {
      if (generation === overviewRequestGeneration.current) setOverviewLoading(false)
      finishListingRequest(listingRequest.controller)
    }
  }

  const loadOverviewPage = async (requestedPage: number, cursor?: string): Promise<void> => {
    discardPendingRuntimePages()
    const pageMethod = (userDocs.current as unknown as Record<string, unknown>).overviewPage
    if (typeof pageMethod !== 'function') {
      setOverviewPage(requestedPage)
      return
    }
    setOverviewLoading(true)
    setOverviewError('')
    const generation = overviewRequestGeneration.current + 1
    overviewRequestGeneration.current = generation
    const listingRequest = beginListingRequest()
    const requestSignal = listingRequest.signal
    serverRequestGeneration.current += 1
    const key = overviewFilterKey()
    try {
      const response = await (pageMethod as (query?: UserDocListQuery, signal?: AbortSignal) => Promise<UserDocCatalogOverview>)({
        limit: PAGE_SIZE,
        query: query.trim(),
        type: typeFilter,
        sort: wireSort(parseSort(sortValue)),
        ...(cursor === undefined ? {} : { cursor }),
      }, requestSignal)
      if (requestSignal.aborted || generation !== overviewRequestGeneration.current) return
      setUnavailableDocumentComputers(response.unavailableNodes?.length ?? 0)
      setOverviewRows([...response.documents])
      setOverviewEntry(allowedNodeId)
      setOverviewNextCursor(response.nextCursor)
      setOverviewTotalDocuments(typeof response.totalDocuments === 'number' ? response.totalDocuments : null)
      setOverviewPage(requestedPage)
      overviewCache.current = null
      overviewLoadedKey.current = key
      setOverviewServerPaging(true)
    } catch (cause) {
      if (!isAbortError(cause, requestSignal)) setOverviewError(documentErrorMessage(cause, t))
    } finally {
      if (generation === overviewRequestGeneration.current) setOverviewLoading(false)
      finishListingRequest(listingRequest.controller)
    }
  }

  const openHistory = async () => {
    const generation = overlayGeneration.current
    setHistoryLoading(true)
    setError('')
    try {
      const response = await userDocs.current.history(undefined, listingScope())
      if (generation !== overlayGeneration.current) return
      setHistoryItems([...response.items])
      setHistoryOpen(true)
    } catch (cause) {
      if (generation === overlayGeneration.current) setError(documentErrorMessage(cause, t))
    } finally {
      if (generation === overlayGeneration.current) setHistoryLoading(false)
    }
  }

  const openTrash = async (cursor?: string, pageNumber = 1): Promise<boolean> => {
    discardPendingRuntimePages()
    setTrashLoading(true)
    setError('')
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    const listingRequest = beginListingRequest()
    const requestSignal = listingRequest.signal
    serverRequestGeneration.current += 1
    setPendingScopeLabel('')
    setRefreshing(false)
    clearSelection()
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
          }, requestSignal)
          : await (pageMethod as (
            query?: UserDocListQuery,
            signal?: AbortSignal,
          ) => Promise<{ documents: readonly UserDocTrashRef[]; nextCursor?: string }>).call(userDocs.current, {
            limit: PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
            state: 'trash',
          }, requestSignal)
        : remoteScopeView
          ? await userDocs.current.listTrashInScope(selectedScope, requestSignal)
          : await userDocs.current.listTrash(requestSignal)
      if (requestSignal.aborted || generation !== loadGeneration.current) return false
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
      if (generation === loadGeneration.current && !isAbortError(cause, requestSignal)) {
        setError(documentErrorMessage(cause, t))
      }
      return false
    } finally {
      if (generation === loadGeneration.current) setTrashLoading(false)
      finishListingRequest(listingRequest.controller)
    }
  }

  const openScopeView = async (target: UserDocScope, label: string): Promise<boolean> => {
    target = locate(target)
    discardPendingRuntimePages()
    pruneDocumentCaches()
    overviewRequestGeneration.current += 1
    overviewLoadedKey.current = null
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    if (sameDocumentScope(target, runtimeScope())) {
      await load(ROOT_DIRECTORY_ID)
      return true
    }
    const project = target.kind === 'project'
      ? scope.projects?.find(candidate => candidate.projectId === target.projectId)
      : undefined
    const mode = locations?.items.find(item => sameDocumentScope(item.scope, target))?.mode ?? project?.mode ?? (target.kind === 'project' && scope.kind === 'project' && scope.projectId === target.projectId
      ? scope.mode ?? 'rw'
      : 'rw')
    const nextScopeView: ScopeView = {
      value: scopeCacheKey(target),
      label,
      scope: target,
      mode,
      canUpload: target.kind === 'personal' || mode === 'rw',
    }
    const cached = cachedRemoteListing(target)
    const shouldFetchListing = cached === undefined || cached.freshness === 'stale'
    const listingRequest = beginListingRequest()
    const requestSignal = listingRequest.signal
    const keepVisibleListing = listingReadyRef.current || cached !== undefined
    setPendingScopeLabel(shouldFetchListing ? label : '')
    setRefreshing(shouldFetchListing && keepVisibleListing)
    clearSelection()
    if (!keepVisibleListing) setLoading(true)
    else setLoading(false)
    setError('')
    serverRequestGeneration.current += 1
    if (cached !== undefined) {
      applyCachedListing(cached)
      if (cached.paged) serverLoadedKey.current = remoteListingKey(target)
      setScopeView(nextScopeView)
      setAlternateSource(null)
      setOverviewMode(false)
      setTrashMode(false)
      clearSelection()
      setQuery('')
      setPage(1)
    }
    if (!shouldFetchListing) {
      setRefreshing(false)
      finishListingRequest(listingRequest.controller)
      return true
    }
    try {
      const initialQuery: UserDocListQuery = {
        limit: PAGE_SIZE,
        query: '',
        type: typeFilter,
        sort: wireSort(parseSort(sortValue)),
      }
      const response = await fetchScopeListing(target, ROOT_DIRECTORY_ID, initialQuery, requestSignal)
      if (requestSignal.aborted || generation !== loadGeneration.current) return false
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
      setScopeView(nextScopeView)
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
        const key = emptyListingKey(target, ROOT_DIRECTORY_ID)
        rememberServerPage(key, 1, pageRecord)
        serverLoadedKey.current = key
      } else {
        rememberLegacyListing(emptyListingKey(target, ROOT_DIRECTORY_ID), {
          documents: nextDocuments,
          directories: listedDirectories,
          directoryId: listed.directoryId ?? ROOT_DIRECTORY_ID,
          limits: listed.limits ?? null,
        })
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
      if (generation === loadGeneration.current && !isAbortError(cause, requestSignal)) {
        setError(documentErrorMessage(cause, t))
      }
      return cached !== undefined
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false)
        setRefreshing(false)
        setPendingScopeLabel('')
        finishListingRequest(listingRequest.controller)
      }
    }
  }

  useEffect(() => {
    /* v8 ignore next -- modal is always open in tests */
    if (!open) return
    // The manager stays mounted between opens. Keep the last committed scope
    // and listing visible immediately, then re-read account context in the
    // background so project switches made elsewhere still update labels and
    // permissions without turning the dialog into a blank loading state.
    const controller = new AbortController()
    const previous = scopeCache.current
    if (previous === null) {
      // First open and every reopen before the scope settles share this path;
      // the destination folder survives in component state, so refresh that
      // listing rather than the root folder.
      void load(currentDirectoryId, controller.signal, { refreshScope: true })
    } else {
      void (async () => {
        try {
          const result = await readDocumentsScopeResult(controller.signal)
          if (controller.signal.aborted) return
          if (!result.available) {
            setScopeStatus('stale')
            setLoading(false)
            return
          }
          const changed = previous.accountId !== result.scope.accountId
            || !sameDocumentScope(documentScopeOf(previous), documentScopeOf(result.scope))
          scopeCache.current = result.scope
          setScope(result.scope)
          setScopeStatus('ready')
          if (changed) {
            listingCache.current.clear()
            serverPages.current.clear()
            serverLoadedKey.current = null
            overviewCache.current = null
            setDocuments([])
            setDirectories([])
            setOverviewRows([])
            setTrashDocuments([])
            setLocations(undefined)
            setLocationsCursor(undefined)
            setQuery('')
            await load(ROOT_DIRECTORY_ID, controller.signal)
          } else if (overviewMode) {
            await openOverview(true)
          } else if (trashMode || scopeView !== null || alternateSource !== null) {
            await refreshDisplayed(true)
          } else {
            // The manager stays mounted between opens, so the destination
            // folder and its search survive; refresh that listing rather than
            // bouncing the user back to the root folder.
            await load(currentDirectoryId, controller.signal)
          }
        } catch (cause) {
          if (!controller.signal.aborted) {
            setScopeStatus('stale')
            setLoading(false)
            setError(documentErrorMessage(cause, t))
          }
        }
      })()
    }
    return () => {
      controller.abort()
      listingController.current?.abort()
      listingController.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open || !phone) setMobileSheet(null)
    if (!open) {
      listingController.current?.abort()
      listingController.current = null
      listingReadyRef.current = false
      setLoading(true)
      setRefreshing(false)
      setPendingScopeLabel('')
      setPreviewDoc(null)
      setDeleteTargets(null)
      setFolderEditor(null)
      setDeleteDirectory(null)
      setMoveTargets(null)
      setCopyTargets(null)
      setPurgeTarget(null)
      setHistoryOpen(false)
      setHistoryLoading(false)
      setLimitsOpen(false)
      setToolsOpen(false)
      setRowMenuId(null)
      setUploadScopePickerOpen(false)
      setSourcePickerOpen(false)
    }
  }, [open, phone])

  useEffect(() => {
    if (copyTargets === null) return
    const option = copyTargets.find(candidate => candidate.value === copyTarget)
    if (option === undefined
      || allowedNodeId !== undefined && option.target.nodeId !== undefined && option.target.nodeId !== allowedNodeId) {
      setCopyDirectoryLoading(false)
      return
    }
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
    setCopyDirectory(ROOT_DIRECTORY_ID)
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
  }, [copyTarget, copyTargets, allowedNodeId])

  useEffect(() => {
    setPage(1)
    setOverviewPage(1)
  }, [query, typeFilter, sortValue, currentDirectoryId])

  useEffect(() => {
    if (!open || overviewMode || trashMode || !listingReadyRef.current || !serverPagingRef.current) return
    // Keep filter reads behind a pending folder change so they address its
    // committed destination instead of cancelling it to reload the old folder.
    if (directoryNavigation.current !== null && directoryNavigation.current.directoryId !== currentDirectoryId) return
    // The initial local page may arrive before account context. Its cursor
    // chain is held separately until the scope is known; do not start a
    // duplicate first-page request while that hand-off is pending.
    const pending = pendingRuntimePages.current
    if (pending !== null && pendingRuntimePageMatches(pending, loadGeneration.current, currentDirectoryId)) return
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
  }, [open, overviewMode, query, typeFilter, sortValue, allowedNodeId])

  const sort = parseSort(sortValue)
  const filtered = useMemo(
    () => sortDocuments(filterDocuments(documents, query, typeFilter), parseSort(sortValue)),
    [documents, query, typeFilter, sortValue],
  )
  const filteredDirectories = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return directories.filter(directory => needle === '' || directory.name.toLowerCase().includes(needle))
  }, [directories, query])

  const overviewVisibleRows = useMemo(() => allowedNodeId === undefined ? overviewRows
    : overviewRows.filter(row => row.scope.nodeId === allowedNodeId), [overviewRows, allowedNodeId])
  const overviewPaging = overviewServerPaging && overviewEntry === allowedNodeId
  const overviewFiltered = useMemo(
    () => overviewPaging ? [...overviewVisibleRows]
      : sortDocuments(filterDocuments(overviewVisibleRows, query, typeFilter), parseSort(sortValue)),
    [overviewVisibleRows, overviewPaging, query, typeFilter, sortValue],
  )
  const overviewPages = overviewPaging
    ? overviewTotalDocuments === null
      ? Math.max(overviewPage, overviewNextCursor === undefined ? overviewPage : overviewPage + 1)
      : pageCount(overviewTotalDocuments)
    : pageCount(overviewFiltered.length)
  const overviewLength = overviewPaging
    ? overviewTotalDocuments ?? overviewFiltered.length
    : overviewFiltered.length
  const overviewCurrentPage = overviewPaging && overviewTotalDocuments === null
    ? Math.max(1, overviewPage)
    : clampPage(overviewPage, overviewLength)
  const overviewPageRows = overviewPaging ? overviewVisibleRows : pageSlice(overviewFiltered, overviewCurrentPage)

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
    if (!open || uploadBatch.current !== null || uploading || overviewMode || alternateSource !== null
      || (scopeView !== null ? !scopeView.canUpload : scope.kind === 'project' && scope.mode === 'ro')) return
    const files = fileListOf(list)
    if (files.length === 0) return
    const batch: UploadBatch = {
      viewKey: uploadView.current.key,
      generation: loadGeneration.current,
      directoryId: currentDirectoryId,
      scope: scopeView?.scope,
      listingScope: selectedScope,
      page,
      total: files.length,
      published: 0,
    }
    uploadBatch.current = batch
    const client = userDocs.current
    const input = fileInputRef.current
    const ownsView = (): boolean => uploadBatch.current === batch && uploadView.current.open
      && loadGeneration.current === batch.generation && uploadView.current.key === batch.viewKey
    const publishFeedback = (reconciling = false, reconciled = false): void => {
      if (ownsView()) setUploadFeedback({
        viewKey: batch.viewKey, generation: batch.generation, published: batch.published,
        total: batch.total, reconciling, reconciled,
      })
    }
    setUploading(true)
    setError('')
    setProgress({ current: 0, total: files.length, percent: 0 })
    publishFeedback()
    let failure = ''
    let currentFileName = ''
    try {
      for (const [index, file] of files.entries()) {
        currentFileName = file.name
        const report = (loaded: number, total: number, phase?: UserDocUploadPhase): void => {
          if (!ownsView() || index !== batch.published) return
          setProgress({
            current: index + 1,
            total: files.length,
            percent: total === 0 ? 0 : Math.round((loaded / total) * 100),
            ...(phase === undefined ? {} : { phase }),
          })
        }
        if (batch.scope !== undefined) {
          await client.uploadToScope(batch.scope, file, batch.directoryId, undefined, report)
        } else {
          await client.upload(file, batch.directoryId, undefined, report)
        }
        batch.published += 1
        publishFeedback()
      }
    } catch (cause) {
      const unstarted = files.length - batch.published - 1
      failure = unstarted > 0
        ? `${uploadErrorMessage(cause, t)} ${t('modal.upload.incomplete', {
          name: currentFileName, remaining: String(unstarted),
        })}`
        : uploadErrorMessage(cause, t)
    } finally {
      let reconciled = batch.published === 0
      let listingError = ''
      if (batch.published > 0) {
        overviewCache.current = null
        if (ownsView()) {
          discardPendingRuntimePages()
          listingCache.current.clear()
          serverPages.current.clear()
          serverLoadedKey.current = null
          batch.generation = ++loadGeneration.current
          serverRequestGeneration.current += 1
          const request = beginListingRequest()
          setRefreshing(true)
          publishFeedback(true)
          try {
            const key = listingKeyFor(batch.listingScope, batch.directoryId)
            let cursor: string | undefined
            for (let number = 1; number <= batch.page; number++) {
              const response = await fetchListingPage(batch.directoryId, queryForPage(cursor), request.signal) as ScopeListingResponse
              if (!ownsView() || request.signal.aborted) break
              const paged = isServerPage(response)
              const record = serverPageRecordFrom(response, {
                documents: batch.scope === undefined ? response.documents as readonly UserDocRef[]
                  : response.documents.map(document => ({ ...document, path: '' })),
                directories: response.directories?.map(normalizeDirectoryRef) ?? [],
                directoryId: response.directoryId ?? batch.directoryId,
              })
              if (paged) rememberServerPage(key, number, record)
              else rememberLegacyListing(key, record)
              if (!paged || number === batch.page || response.nextCursor === undefined) {
                applyServerPage(record)
                setTotalDocuments(record.totalDocuments ?? record.documents.length)
                setPage(paged ? number : batch.page)
                setServerPaging(paged)
                serverPagingRef.current = paged
                if (!paged) {
                  setServerTotalDocuments(null)
                  setServerNextCursor(undefined)
                }
                serverLoadedKey.current = key
                listingReadyRef.current = true
                reconciled = true
                break
              }
              cursor = response.nextCursor
            }
          } catch (cause) {
            if (ownsView() && !isAbortError(cause, request.signal)) listingError = documentErrorMessage(cause, t)
          } finally {
            if (ownsView()) setRefreshing(false)
            finishListingRequest(request.controller)
          }
        } else markDocumentCachesStale()
      }
      if (ownsView()) {
        setError([failure, listingError].filter(Boolean).join(' '))
        if (failure === '' && reconciled) setUploadFeedback(null)
        else publishFeedback(false, reconciled)
      }
      if (input !== null) input.value = ''
      if (uploadBatch.current === batch) {
        uploadBatch.current = null
        setUploading(false)
        setProgress(null)
      }
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
        dropSelection(doc.docId)
        setProgress({
          current: index + 1,
          total: targets.length,
          percent: Math.round(((index + 1) / targets.length) * 100),
        })
      }
      setDeleteTargets(null)
      clearSelection()
      await refreshDisplayed()
    } catch (cause) {
      await refreshDisplayed()
      setModalError(cause instanceof UserDocHttpError && cause.code === 'DOCUMENT_TRASH_CONFLICT'
        ? documentErrorMessage(cause, t) : t('delete.error'))
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
        ? document.trashId === undefined
          ? await userDocs.current.restoreInScope(selectedScope, document.docId)
          : await userDocs.current.restoreInScope(selectedScope, document.docId, undefined, undefined, undefined, document.trashId)
        : document.trashId === undefined
          ? await userDocs.current.restore(document.docId)
          : await userDocs.current.restore(document.docId, undefined, undefined, undefined, document.trashId)
      listingCache.current.clear()
      serverPages.current.clear()
      serverLoadedKey.current = null
      setTrashDocuments(previous => previous.filter(item => !sameTrashEntry(item, document)))
      setError('')
      void restored
    } catch (cause) {
      setError(documentErrorMessage(cause, t))
    } finally {
      setUploading(false)
    }
  }

  const purgeTrashDocument = (document: UserDocTrashRef): void => {
    if (!writeLocked) {
      setError('')
      setPurgeTarget(document)
    }
  }

  const confirmPurgeTrash = async () => {
    if (purgeTarget === null || writeLocked) return
    const document = purgeTarget
    setUploading(true)
    setError('')
    try {
      if (remoteScopeView) {
        if (document.trashId === undefined) await userDocs.current.purgeInScope(selectedScope, document.docId)
        else await userDocs.current.purgeInScope(selectedScope, document.docId, undefined, document.trashId)
      } else if (document.trashId === undefined) await userDocs.current.purge(document.docId)
      else await userDocs.current.purge(document.docId, undefined, document.trashId)
      setTrashDocuments(previous => previous.filter(item => !sameTrashEntry(item, document)))
      setPurgeTarget(null)
    } catch (cause) {
      setError(documentErrorMessage(cause, t))
    } finally {
      setUploading(false)
    }
  }

  const returnFromTrash = (): void => {
    trashReturnFocusPending.current = true
    setTrashMode(false)
    setMobileSheet(null)
    navigate(currentDirectoryId)
  }

  const focusTrashReturn = (element: HTMLDivElement | null): void => {
    if (trashMode || !trashReturnFocusPending.current || element === null) return
    const manager = element.closest('[role="dialog"]')
    if (manager === null) return
    const target = manager.querySelector<HTMLButtonElement>(compactNavigation
      ? '[data-documents-toolbar-more]'
      : '[data-documents-trash-toggle]')
    if (target === null) return
    trashReturnFocusPending.current = false
    target.focus({ preventScroll: true })
  }

  const navigate = (directoryId: UserDocDirectoryIdType) => {
    clearSelection()
    setQuery('')
    setPage(1)
    const navigation = { directoryId }
    directoryNavigation.current = navigation
    const finishNavigation = (): void => {
      if (directoryNavigation.current === navigation) directoryNavigation.current = null
    }
    if (!remoteScopeView) {
      void load(directoryId).finally(finishNavigation)
      return
    }
    pruneDocumentCaches()
    const key = emptyListingKey(selectedScope, directoryId)
    const cached = readCachedListing(key)
    const shouldFetchListing = cached === undefined || cached.freshness === 'stale'
    const listingRequest = beginListingRequest()
    const requestSignal = listingRequest.signal
    const keepVisibleListing = listingReadyRef.current || cached !== undefined
    setPendingScopeLabel('')
    setRefreshing(shouldFetchListing && keepVisibleListing)
    if (!keepVisibleListing) setLoading(true)
    else setLoading(false)
    setError('')
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    serverRequestGeneration.current += 1
    if (cached !== undefined) {
      applyCachedListing(cached)
      if (cached.paged) serverLoadedKey.current = key
    }
    if (!shouldFetchListing) {
      setRefreshing(false)
      finishListingRequest(listingRequest.controller)
      finishNavigation()
      return
    }
    void fetchScopeListing(selectedScope, directoryId, {
      limit: PAGE_SIZE, query: '', type: typeFilter, sort: wireSort(parseSort(sortValue)),
    }, requestSignal).then((rawResponse) => {
      if (requestSignal.aborted || generation !== loadGeneration.current) return
      const response = rawResponse as ScopeListingResponse
      const nextDirectoryId = response.directoryId ?? directoryId
      const nextKey = emptyListingKey(selectedScope, nextDirectoryId)
      serverLoadedKey.current = nextKey
      applyScopeListingResponse(response, directoryId, selectedScope)
      listingReadyRef.current = true
    }).catch((cause: unknown) => {
      if (generation === loadGeneration.current && !isAbortError(cause, requestSignal)) {
        setError(documentErrorMessage(cause, t))
      }
    }).finally(() => {
      finishNavigation()
      if (generation === loadGeneration.current) {
        setLoading(false)
        setRefreshing(false)
        finishListingRequest(listingRequest.controller)
      }
    })
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

  const handleFolderSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
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

  const attachmentReady = (): boolean => onAttachDocument !== undefined && (canAttachDocument?.() ?? true)

  const addToCapturedConversation = (documents: readonly UserDocRef[]): UserDocRef[] => {
    const remaining: UserDocRef[] = []
    for (const document of documents) {
      try {
        if (!attachmentReady() || onAttachDocument?.(document) !== true) remaining.push(document)
      } catch {
        // A removed Session can invalidate the composer while a transfer finishes; the durable copy remains available.
        remaining.push(document)
      }
    }
    return remaining
  }

  const retryPendingAttachments = (): void => {
    const remaining = addToCapturedConversation(pendingAttachments)
    setPendingAttachments(remaining)
    if (remaining.length === 0) onClose()
    else setError(t('copy.attachPending', { names: remaining.map(document => document.name).join('、') }))
  }

  const attachDocument = (doc: UserDocRef) => {
    setError('')
    if (!attachmentReady()) { setError(t('action.attach.error')); return }
    if (!sameDocumentScope(listingScope(), currentScopeDescriptor())) {
      void copyRemoteDocumentsToConversation([doc])
      return
    }
    if (addToCapturedConversation([doc]).length === 0) onClose()
    else setError(t('action.attach.error'))
  }

  const copyRemoteDocumentsToConversation = async (targets: readonly UserDocRef[]): Promise<void> => {
    if (!attachmentReady()) {
      setError(t('action.attach.error'))
      return
    }
    const generation = attachmentGeneration.current
    const source = listingScope()
    const target = currentScopeDescriptor()
    const address = attachmentTargetId === undefined ? undefined : parseClientSessionKey(attachmentTargetId)
    const runtimeId = attachmentScope?.runtimeId ?? address?.runtime.runtimeId
    if (address && (address.runtime.kind !== target.kind
      || address.runtime.runtimeId !== undefined && address.runtime.runtimeId !== runtimeId
      || address.runtime.kind === 'project' && target.kind === 'project' && address.runtime.projectId !== target.projectId)) {
      setError(t('action.attach.error'))
      return
    }
    const keyOf = (doc: UserDocRef): string => `${scopeCacheKey(source)}:${doc.docId}`
    const missing = targets.filter(document => !copiedAttachments.current.has(keyOf(document)))
    setUploading(true)
    setCopyLoading(true)
    setError('')
    setModalError('')
    setProgress({ current: 0, total: targets.length, percent: 0 })
    try {
      const response = missing.length === 0 ? undefined : await userDocs.current.transfer({
        version: 1, source, target: { ...target, ...(runtimeId === undefined ? {} : { runtimeId }) },
        ...(attachmentTargetId && runtimeId && target.nodeId
          ? { targetSessionId: address?.sessionId ?? attachmentTargetId } : {}),
        documents: missing.map(document => ({ docId: document.docId })),
      })
      if (generation !== attachmentGeneration.current) return
      for (const [index, item] of (response?.items ?? []).entries()) {
        const original = missing[index]
        if (item.status === 'copied' && original !== undefined) copiedAttachments.current.set(keyOf(original), { ...item.target, path: '' })
      }
      const copied = targets.flatMap((document) => {
        const ref = copiedAttachments.current.get(keyOf(document))
        return ref === undefined ? [] : [ref]
      })
      const historyUnconfirmed=response?.items.some(item=>item.status==='copied'&&item.historyUnconfirmed)
      const failedNames = response?.items.flatMap(item => item.status === 'failed' ? [item.source.name] : []) ?? []
      if (copied.length === 0) {
        setError(t('copy.partial', { count: String(failedNames.length) }))
        return
      }
      setProgress({ current: targets.length, total: targets.length, percent: 100 })
      const remaining = addToCapturedConversation(copied)
      setPendingAttachments(previous => [...new Map([...previous, ...remaining].map(document => [document.docId, document])).values()]
        .filter(document => !copied.some(ref => ref.docId === document.docId) || remaining.some(ref => ref.docId === document.docId)))
      if (remaining.length > 0) {
        setError(t('copy.attachPending', { names: remaining.map(document => document.name).join('、') })
          + (failedNames.length === 0 ? '' : ` ${t('copy.partialAttached', { names: failedNames.join('、') })}`))
      } else if (failedNames.length > 0) {
        clearSelection()
        setError(t('copy.partialAttached', { names: failedNames.join('、') }))
      } else if(historyUnconfirmed){clearSelection();setNotice(t('copy.historyUnconfirmed'))} else onClose()
    } catch (cause) {
      if (generation === attachmentGeneration.current) setError(documentErrorMessage(cause, t))
    } finally {
      setCopyLoading(false)
      setUploading(false)
      setProgress(null)
    }
  }

  const attachSelectedDocuments = async (): Promise<void> => {
    const targets = selectedDocumentList()
    setMobileSheet(null)
    if (targets.length === 0 || !attachmentReady()) { setError(t('action.attach.error')); return }
    if (!sameDocumentScope(listingScope(), currentScopeDescriptor())) {
      await copyRemoteDocumentsToConversation(targets)
      return
    }
    if (addToCapturedConversation(targets).length === 0) onClose()
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
        dropSelection(doc.docId)
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

  const openCopy = (targets: UserDocRef[], single = false) => {
    if (targets.length === 0) return
    setSingleCopyDocument(single ? targets[0] ?? null : null)
    setOverviewCopyRow(null)
    const source = listingScope()
    const current = currentScopeDescriptor()
    const options: CopyTargetOption[] = uploadScopeOptions
      .filter(item => !sameDocumentScope(item.scope, source) && (mode !== 'select' || sameDocumentScope(item.scope, current)))
      .map(item => ({ value: item.value, label: item.label, target: locate(item.scope) }))
    if (options.length === 0) {
      setError(t('copy.unavailable'))
      return
    }
    setCopySourceScope(source)
    setCopyTargets(options)
    setCopyTarget(options[0]?.value ?? '')
    setCopyDirectory(ROOT_DIRECTORY_ID)
    setCopyFolderName('')
    setFailedCopyItems([])
    setMoveTargets(null)
    setModalError('')
  }

  const currentScopeDescriptor = (): UserDocScope => locate(attachmentScope ?? runtimeScope())

  const locationOptions: SourceOption[] = locations?.items.map(item => ({
    value: scopeCacheKey(item.scope),
    label: `${item.scope.kind === 'personal' ? t('copy.target.personal') : item.name}${showComputer ? ` · ${item.nodeName}` : ''}`,
    scope: item.scope, mode: item.mode,
  })) ?? []

  const sourceOptions: SourceOption[] = locationOptions.length > 0
    ? locationOptions.filter(item => !sameDocumentScope(item.scope, currentScopeDescriptor())) : [
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
  const uploadScopeOptions: SourceOption[] = locationOptions.length > 0 ? locationOptions.filter(item => item.mode === 'rw') : [
    { value: 'personal', label: t('copy.target.personal'), scope: { kind: 'personal' }, mode: 'rw' },
    ...(scope.projects ?? []).filter(project => project.mode === 'rw').map(project => ({
      value: `project:${String(project.projectId)}`,
      label: project.name,
      scope: { kind: 'project', projectId: project.projectId } as const,
      mode: project.mode,
    })),
  ]

  const mobileViewOptions = useMemo<MobileScopeOption[]>(() => locationOptions.length > 0 ? [
    { value: 'all', label: t('scope.all'), description: t('scope.all.description'), kind: 'all' },
    ...locationOptions.map(item => ({ value: item.value, label: item.label, description: item.mode === 'ro' ? t('scope.readOnly') : t('scope.manage.editable'), kind: 'source' as const })),
  ] : [
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
  ], [scope.projects, locations, showComputer, t])

  const mobileScopeValue = overviewMode ? 'all' : scopeView?.value ?? scopeCacheKey(currentScopeDescriptor())

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
    const location = locationOptions.find(item => item.value === value)
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
    } else if (location !== undefined) {
      succeeded = await openScopeView(location.scope, location.label)
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
    discardPendingRuntimePages()
    pruneDocumentCaches()
    setError('')
    const generation = loadGeneration.current + 1
    loadGeneration.current = generation
    const cached = cachedRemoteListing(option.scope)
    const shouldFetchListing = cached === undefined || cached.freshness === 'stale'
    const listingRequest = beginListingRequest()
    const requestSignal = listingRequest.signal
    const keepVisibleListing = listingReadyRef.current || cached !== undefined
    setSourcePickerLoading(shouldFetchListing)
    setPendingScopeLabel(shouldFetchListing ? option.label : '')
    setRefreshing(shouldFetchListing && keepVisibleListing)
    clearSelection()
    if (!keepVisibleListing) setLoading(true)
    else setLoading(false)
    serverRequestGeneration.current += 1
    if (cached !== undefined) {
      applyCachedListing(cached)
      if (cached.paged) serverLoadedKey.current = remoteListingKey(option.scope)
      setScopeView(null)
      setAlternateSource(option)
      setTrashMode(false)
      clearSelection()
      setQuery('')
      setPage(1)
    }
    if (!shouldFetchListing) {
      setSourcePickerOpen(false)
      setSourcePickerLoading(false)
      setRefreshing(false)
      finishListingRequest(listingRequest.controller)
      return true
    }
    try {
      const initialQuery: UserDocListQuery = {
        limit: PAGE_SIZE,
        query: '',
        type: typeFilter,
        sort: wireSort(parseSort(sortValue)),
      }
      const response = await fetchScopeListing(option.scope, ROOT_DIRECTORY_ID, initialQuery, requestSignal)
      if (requestSignal.aborted || generation !== loadGeneration.current) return false
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
        const key = emptyListingKey(option.scope, ROOT_DIRECTORY_ID)
        rememberServerPage(key, 1, pageRecord)
        serverLoadedKey.current = key
        setServerPaging(true)
        setServerTotalDocuments(pageRecord.totalDocuments)
        serverPagingRef.current = true
      } else {
        rememberLegacyListing(emptyListingKey(option.scope, ROOT_DIRECTORY_ID), {
          documents,
          directories: listedDirectories,
          directoryId: listed.directoryId ?? ROOT_DIRECTORY_ID,
          limits: listed.limits ?? null,
        })
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
      if (generation === loadGeneration.current && !isAbortError(error, requestSignal)) {
        setError(documentErrorMessage(error, t))
      }
      return cached !== undefined
    } finally {
      if (generation === loadGeneration.current) {
        setSourcePickerLoading(false)
        setRefreshing(false)
        setPendingScopeLabel('')
        finishListingRequest(listingRequest.controller)
      }
    }
  }

  const refreshDisplayed = async (preserveQuery = false): Promise<void> => {
    discardPendingRuntimePages()
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
      const listingRequest = beginListingRequest()
      const requestSignal = listingRequest.signal
      setRefreshing(true)
      serverRequestGeneration.current += 1
      try {
        const target = selectedScope
        const response = await fetchScopeListing(target, currentDirectoryId, {
          limit: PAGE_SIZE, query: preserveQuery ? query.trim() : '', type: typeFilter, sort: wireSort(parseSort(sortValue)),
        }, requestSignal) as ScopeListingResponse
        if (requestSignal.aborted || generation !== loadGeneration.current) return
        applyScopeListingResponse(response, currentDirectoryId, target)
        listingReadyRef.current = true
        clearSelection()
        if (!preserveQuery) setQuery('')
        setPage(1)
      } catch (cause) {
        if (generation === loadGeneration.current && !isAbortError(cause, requestSignal)) {
          setError(documentErrorMessage(cause, t))
        }
      } finally {
        if (generation === loadGeneration.current) {
          setRefreshing(false)
          finishListingRequest(listingRequest.controller)
        }
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
    setError('')
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
    setError('')
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
    const generation = overlayGeneration.current
    const source = catalogRowScope(row)
    if (mode === 'select' && !attachmentReady()) { setOverviewError(t('action.attach.error')); return }
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
      if (generation !== overlayGeneration.current) return
      const candidates = locationOptions.length > 0
        ? locationOptions.map(item => ({ scope: item.scope, label: item.label, canWrite: item.mode === 'rw' }))
        : capabilities.targets
      const options = candidates
        .filter(target => target.canWrite && !sameDocumentScope(target.scope, source)
          && (mode !== 'select' || sameDocumentScope(target.scope, currentScopeDescriptor())))
        .map(target => ({ value: scopeCacheKey(target.scope), label: target.label, target: target.scope }))
      if (options.length === 0) {
        setOverviewError(t('copy.unavailable'))
        return
      }
      setOverviewCopyRow({ row, source })
      setSingleCopyDocument(null)
      setCopySourceScope(source)
      setCopyTargets(options)
      setCopyTarget(options[0]?.value ?? '')
      setCopyDirectory(ROOT_DIRECTORY_ID)
      setCopyFolderName('')
      setFailedCopyItems([])
      setModalError('')
    } catch (cause) {
      if (generation === overlayGeneration.current) setOverviewError(documentErrorMessage(cause, t))
    }
  }

  const openOverviewView = async (row: UserDocCatalogRow): Promise<void> => {
    const target = catalogRowScope(row)
    await openScopeView(target, row.scope.label)
  }

  const handleCopy = async () => {
    if (mode === 'select' && !attachmentReady()) { setModalError(t('action.attach.error')); return }
    if (copyTargets === null || (overviewCopyRow === null && singleCopyDocument === null && selected.size === 0)) return
    const option = copyTargets.find(candidate => candidate.value === copyTarget)
    if (option === undefined) return
    const capturedSource = copySourceScope ?? overviewCopyRow?.source ?? listingScope()
    if (allowedNodeId !== undefined && [capturedSource, option.target].some(target => target.nodeId !== undefined && target.nodeId !== allowedNodeId)) { setModalError(t('scope.entryUnavailable')); return }
    const targets = overviewCopyRow === null
      ? singleCopyDocument === null ? selectedDocumentList() : [singleCopyDocument]
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
      const source: UserDocScope = copySourceScope ?? overviewCopyRow?.source ?? listingScope()
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
      const historyUnconfirmed=response.items.some(item=>item.status==='copied'&&item.historyUnconfirmed)
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
        const remaining = addToCapturedConversation(copied.map(ref => ({ ...ref, path: '' })))
        setPendingAttachments(remaining)
        if (remaining.length === 0 && failed === 0 && !historyUnconfirmed) onClose()
        else if (remaining.length > 0) setError(t('copy.attachPending', { names: remaining.map(ref => ref.name).join('、') }))
      }
      if (failed > 0) setModalError(t('copy.partial', { count: String(failed) }))
      else {
        setCopyTargets(null)
        if(historyUnconfirmed)noticeAfterCopy=t('copy.historyUnconfirmed')
        else if (!attachToCurrent && copied.length > 0) noticeAfterCopy = t('copy.success', { target: option.label })
      }
      clearSelection()
      if (overviewCopyRow !== null) {
        setOverviewCopyRow(null)
        overviewCache.current = null
        await openOverview(true)
      } else if (remoteScopeView) {
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
    const generation = copyDialogGeneration.current
    setRetryingCopyId(item.docId)
    try {
      const response = await userDocs.current.retry({
        version: 1,
        source: item.source,
        target: item.target,
        documents: [{ docId: item.docId }],
      })
      if (generation !== copyDialogGeneration.current) return
      if (response.items.some(result => result.status === 'copied')) {
        setFailedCopyItems(prev => prev.filter(candidate => candidate.docId !== item.docId))
        if (overviewMode) await openOverview(true)
        else if (remoteScopeView) await refreshDisplayed()
        else await load(currentDirectoryId)
      } else {
        setModalError(t('copy.retry.failed'))
      }
    } catch (cause) {
      if (generation === copyDialogGeneration.current) setModalError(cause instanceof Error ? cause.message : t('copy.retry.failed'))
    } finally {
      if (generation === copyDialogGeneration.current) setRetryingCopyId(null)
    }
  }

  const createCopyFolder = async () => {
    const generation = copyDialogGeneration.current
    if (copyTargets === null || copyFolderName.trim() === '') return
    const option = copyTargets.find(candidate => candidate.value === copyTarget)
    if (option === undefined || typeof userDocs.current.createScopeDirectory !== 'function') return
    if (allowedNodeId !== undefined && option.target.nodeId !== undefined && option.target.nodeId !== allowedNodeId) { setModalError(t('scope.entryUnavailable')); return }
    setCopyFolderCreating(true)
    setModalError('')
    try {
      const created = await userDocs.current.createScopeDirectory(option.target, copyDirectory, copyFolderName.trim())
      if (generation !== copyDialogGeneration.current) return
      setCopyDirectories(prev => [...prev, { directoryId: created.directoryId, name: created.name }])
      setCopyDirectory(created.directoryId)
      setCopyFolderName('')
    } catch (cause) {
      if (generation === copyDialogGeneration.current) setModalError(cause instanceof Error ? cause.message : t('folder.create.error'))
    } finally {
      if (generation === copyDialogGeneration.current) setCopyFolderCreating(false)
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

  const displayLocationLabel = (target: UserDocScope, captured: string): string => showComputer ? captured
    : target.kind === 'personal' ? t('copy.target.personal')
      : locations?.items.find(item => sameDocumentScope(item.scope, target))?.name
        ?? scope.projects?.find(project => project.projectId === target.projectId)?.name ?? t('selection.currentSpace')
  const scopeViewLabel = scopeView === null ? '' : displayLocationLabel(scopeView.scope, scopeView.label)
  const alternateSourceLabel = alternateSource === null ? '' : displayLocationLabel(alternateSource.scope, alternateSource.label)
  const selectedCopyTarget = copyTargets?.find(option => option.value === copyTarget)
  const copyUnavailable = allowedNodeId !== undefined
    && [copySourceScope, selectedCopyTarget?.target].some(target => target?.nodeId !== undefined && target.nodeId !== allowedNodeId)
  const title = scopeView === null && alternateSource === null && scope.kind === 'project'
    ? t('modal.title.project', { name: scope.projectName })
    : t('modal.title')
  const directoryTrail = breadcrumbs(currentDirectoryId, (scopeViewLabel || alternateSourceLabel) || t('breadcrumb.root'))
  const readOnlyProject = scope.kind === 'project' && scope.mode === 'ro'
  const selectedScope = scopeView?.scope ?? alternateSource?.scope
    ?? (scope.kind === 'project' && scope.projectId !== undefined
      ? { kind: 'project' as const, projectId: scope.projectId }
      : { kind: 'personal' as const })
  const selectedScopeMode = scopeView?.mode ?? alternateSource?.mode
    ?? (readOnlyProject ? 'ro' : 'rw')
  const unavailableScope = allowedNodeId !== undefined && listingScope().nodeId !== undefined && listingScope().nodeId !== allowedNodeId
  const writeLocked = unavailableScope || overviewMode || selectedScopeMode === 'ro'
  const uploadLocked = unavailableScope || overviewMode || selectedScopeMode === 'ro'
  const remoteScopeView = scopeView !== null || alternateSource !== null
  const uploadView = useRef({ open, key: '' })
  uploadView.current = {
    open,
    key: JSON.stringify([listingKeyFor(selectedScope, currentDirectoryId), page, overviewMode, trashMode]),
  }
  const visibleUploadFeedback = open && uploadFeedback !== null
    && uploadFeedback.generation === loadGeneration.current && uploadFeedback.viewKey === uploadView.current.key
    ? uploadFeedback : null
  const selectedScopeUrl = remoteScopeView ? selectedScope : undefined
  const documentContentUrl = (docId: UserDocIdType, inline = false): string => {
    const url = selectedScopeUrl === undefined ? userDocs.current.contentUrl(docId, inline)
      : userDocs.current.scopedContentUrl(selectedScopeUrl, docId, inline)
    return privateResourceUrl?.(url) ?? url
  }

  const projectExtra = scope.kind === 'project' ? t('delete.confirm.project.extra') : ''
  const visibility = scope.kind === 'project'
    ? t('modal.visibility.project')
    : t('modal.visibility.personal')
  const visibleScope = scopeView !== null
    ? scopeView.canUpload
      ? t('scope.upload.target', { name: scopeViewLabel })
      : t('scope.viewing', { name: scopeViewLabel })
    : alternateSource === null
      ? visibility
      : t('copy.source.viewing', { name: alternateSourceLabel })
  const mobileScopeLabel = overviewMode
    ? t('scope.all')
    : alternateSource !== null
      ? t('copy.source.viewing', { name: alternateSourceLabel })
      : scopeView !== null
        ? scopeViewLabel
        : scope.kind === 'project'
          ? scope.projectName
          : t('copy.target.personal')

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepth.current += 1
    if (uploadBatch.current === null && !uploading) setDropActive(true)
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

  const folderFormId = useId()
  const busy = unavailableScope || uploading
  const displayedProgress = uploadBatch.current === null || visibleUploadFeedback !== null ? progress : null
  const uploadLabel = visibleUploadFeedback?.reconciling === true ? t('modal.refreshing')
    : displayedProgress !== null && uploading
      ? t(displayedProgress.phase === 'verifying' ? 'modal.upload.verifyingCount' : 'modal.upload.progressCount', {
        current: String(displayedProgress.current),
        total: String(displayedProgress.total),
        percent: String(displayedProgress.percent),
      })
      : t('modal.upload')

  const uploadButton = (
    <Button
      className={css.upload}
      type="button"
      variant="soft"
      size="toolbar"
      disabled={busy || uploadLocked}
      aria-label={uploading ? uploadLabel : t('modal.upload')}
      title={scopeView !== null && !scopeView.canUpload ? t('scope.upload.readOnly', { name: scopeViewLabel }) : undefined}
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
      size="toolbar"
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
  const emptyReadPending = !hasEntries && (loading || refreshing)
  const emptyUploadPending = !hasEntries && visibleUploadFeedback !== null && !visibleUploadFeedback.reconciled
  const hasVisibleEntries = filteredDirectories.length > 0 || filtered.length > 0
    || (serverPaging && (serverTotalDocuments ?? 0) > 0)
  const moveOptions = [
    { directoryId: ROOT_DIRECTORY_ID, name: t('breadcrumb.root') },
    ...moveDirectories.map(directory => ({
      directoryId: directory.directoryId,
      name: directory.name,
    })),
  ].filter(directory => directory.directoryId !== currentDirectoryId)

  const viewContext = `${scopeCacheKey(listingScope())}:${String(currentDirectoryId)}`
  const previewVisible = open && previewDoc !== null && previewContext === viewContext && !overviewMode && !trashMode
    && documents.some(document => document.docId === previewDoc.docId)
  const attachmentDestination = currentScopeDescriptor()
  const attachmentLocation = locationOptions.find(item => sameDocumentScope(item.scope, attachmentDestination))
  const attachmentDestinationLabel = attachmentLocation?.label ?? [
    attachmentDestination.kind === 'personal' ? t('copy.target.personal')
      : scope.kind === 'project' && scope.projectId === attachmentDestination.projectId ? scope.projectName : t('selection.currentSpace'),
    showComputer ? attachmentDestination.nodeName : undefined,
  ].filter(value => value !== undefined).join(' · ')
  const attachmentSourceLabel = locationOptions.find(item => sameDocumentScope(item.scope, listingScope()))?.label
    ?? (scopeViewLabel || alternateSourceLabel || mobileScopeLabel)
  const crossScopeAttachment = !sameDocumentScope(listingScope(), currentScopeDescriptor())
  const nextLocationCursor = locations?.nextCursor
  const displayedDocumentScope = listingScope()
  const displayedComputerName = displayedDocumentScope.nodeName
    ?? locations?.items.find(item => item.scope.nodeId === displayedDocumentScope.nodeId)?.nodeName
  const attachLabel = crossScopeAttachment ? t('scope.copyAndAttach') : t('action.attach')
  const batchAttachLabel = t(crossScopeAttachment ? 'selection.copyAttachCount' : 'selection.attachCount', { count: String(selected.size) })
  const openPreview = (document: UserDocRef) => {
    setPreviewContext(viewContext)
    setPreviewDoc(document)
    setRowMenuId(null)
  }
  const closePreview = () => {
    setPreviewDoc(null)
    if (previewDoc !== null) previewTriggers.current.get(previewDoc.docId)?.focus({ preventScroll: true })
  }
  const renderDirectory = (directory: UserDocDirectoryRef) => (
    <div key={directory.directoryId} className={`${css.row} ${css.folderRow}`} role="listitem" data-documents-row-kind="folder">
      <span className={css.folderAlign} aria-hidden="true" />
      <button type="button" className={css.folderOpen} aria-label={t('folder.openNamed', { name: directory.name })} onClick={() => { navigate(directory.directoryId) }}>
        <span className={css.fileIcon} aria-hidden="true"><IconFolderClose16 size={16} /></span>
        <span className={css.name} title={directory.name}>{directory.name}</span>
      </button>
      {phone ? <Button className={css.rowMore} data-documents-row-more="folder" type="button" variant="ghost" aria-label={t('action.moreFolderNamed', { name: directory.name })} aria-haspopup="dialog" onClick={(event) => { actionReturnTarget.current = event.currentTarget; setMobileSheet({ kind: 'directory', directory }) }}><IconEllipsisOutline16 size={16} /></Button> :
        <Menu open={rowMenuId === `folder:${directory.directoryId}`} portal autoFocus compact={!touch} align="end" onClose={() => { setRowMenuId(null) }}
          anchor={<Button className={css.rowMore} size="toolbar" type="button" variant="ghost" aria-label={t('action.moreFolderNamed', { name: directory.name })} aria-haspopup="menu" aria-expanded={rowMenuId === `folder:${directory.directoryId}`} onClick={(event) => { actionReturnTarget.current = event.currentTarget; setRowMenuId(rowMenuId === `folder:${directory.directoryId}` ? null : `folder:${directory.directoryId}`) }}><IconEllipsisOutline16 size={16} /></Button>}>
          <MenuItemButton icon={<IconEditOutline16 size={16} />} disabled={busy || writeLocked} onSelect={() => { focusActionAnchor(); setRowMenuId(null); openRenameDirectory(directory) }}>{t('folder.rename')}</MenuItemButton>
          <MenuItemButton icon={<IconTrashOutline16 size={16} />} danger disabled={busy || writeLocked} onSelect={() => { focusActionAnchor(); setRowMenuId(null); setDeleteDirectory(directory) }}>{t('folder.delete')}</MenuItemButton>
        </Menu>}
    </div>
  )

  const renderRow = (doc: UserDocRef) => (
    <div key={doc.docId} className={`${css.row}${selected.has(doc.docId) ? ` ${css.rowSelected}` : ''}${previewVisible && previewDoc.docId === doc.docId ? ` ${css.rowPreviewing}` : ''}`} role="listitem" data-documents-row-kind="document">
      <label className={css.check}><input type="checkbox" checked={selected.has(doc.docId)} aria-label={doc.name} onChange={() => { toggleId(doc.docId) }} /></label>
      <button type="button" className={css.documentName} aria-label={t('action.previewNamed', { name: doc.name })} aria-current={previewVisible && previewDoc.docId === doc.docId ? 'true' : undefined}
        ref={(element) => {
          if (element === null) previewTriggers.current.delete(doc.docId)
          else previewTriggers.current.set(doc.docId, element)
        }} onClick={() => { openPreview(doc) }}>
        <span className={css.fileIcon} aria-hidden="true"><FileTypeIcon name={doc.name} mediaType={doc.mediaType} /></span>
        <span className={css.meta}><span className={css.name} title={doc.name}>{doc.name}</span><span className={css.size}>{phone ? documentMetaLabel(doc, t, true) : `${t(`modal.type.${documentTypeBucket(doc.mediaType)}`)} · ${getDateGroup(doc.modifiedAt, t('date.unknown'))}`}</span></span>
      </button>
      <span className={css.rowBytes}>{formatBytes(doc.bytes)}</span>
      <span className={css.rowPrimaryActions}>
        <Button className={css.quickAttach} type="button" size="toolbar" variant="soft" aria-label={t('action.attachNamed', { name: doc.name })} disabled={busy || onAttachDocument === undefined} onClick={() => { attachDocument(doc) }}>{attachLabel}</Button>
        {phone ? <Button className={css.rowMore} data-documents-row-more="document" type="button" variant="ghost" aria-label={t('action.moreNamed', { name: doc.name })} aria-haspopup="dialog" onClick={(event) => { actionReturnTarget.current = event.currentTarget; setMobileSheet({ kind: 'document', document: doc }) }}><IconEllipsisOutline16 size={16} /></Button> :
          <Menu open={rowMenuId === `document:${doc.docId}`} portal autoFocus compact={!touch} align="end" onClose={() => { setRowMenuId(null) }}
            anchor={<Button className={css.rowMore} size="toolbar" type="button" variant="ghost" aria-label={t('action.moreNamed', { name: doc.name })} aria-haspopup="menu" aria-expanded={rowMenuId === `document:${doc.docId}`} onClick={(event) => { actionReturnTarget.current = event.currentTarget; setRowMenuId(rowMenuId === `document:${doc.docId}` ? null : `document:${doc.docId}`) }}><IconEllipsisOutline16 size={16} /></Button>}>
            <MenuItemButton icon={<IconInspectOutline12 size={16} />} onSelect={() => { focusActionAnchor(); openPreview(doc) }}>{t('action.preview')}</MenuItemButton>
            <MenuItemButton icon={<IconFolderOpenOutline16 size={16} />} disabled={busy || writeLocked} onSelect={() => { focusActionAnchor(); setRowMenuId(null); void openMove([doc]) }}>{t('action.move')}</MenuItemButton>
            <MenuItemButton icon={<IconCopyOutline16 size={16} />} disabled={busy} onSelect={() => { focusActionAnchor(); setRowMenuId(null); openCopy([doc], true) }}>{t('scope.copy')}</MenuItemButton>
            <MenuItemButton icon={<IconDownloadOutline16 size={16} />} onSelect={() => {
              setRowMenuId(null)
              window.open(documentContentUrl(doc.docId), '_blank', 'noopener,noreferrer')
            }}>{t('action.download')}</MenuItemButton>
            <MenuItemButton icon={<IconTrashOutline16 size={16} />} danger separatorBefore disabled={busy || writeLocked} onSelect={() => { focusActionAnchor(); setRowMenuId(null); setDeleteTargets([doc]) }}>{t('action.delete')}</MenuItemButton>
          </Menu>}
      </span>
    </div>
  )

  const closeMobileSheet = () => {
    focusActionAnchor()
    if (mobileSheet?.kind === 'scope' && mobileSheet.mode === 'upload') setUploadScopePickerOpen(false)
    setMobileSheet(null)
  }

  const performMobileDocumentAction = (action: 'attach' | 'preview' | 'move' | 'download' | 'delete', doc: UserDocRef) => {
    closeMobileSheet()
    switch (action) {
      case 'attach':
        attachDocument(doc)
        return
      case 'preview':
        openPreview(doc)
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
    closeMobileSheet()
    if (action === 'rename') openRenameDirectory(directory)
    else setDeleteDirectory(directory)
  }

  const performMobileBatchAction = (action: 'move' | 'copy' | 'delete') => {
    const targets = selectedDocumentList()
    closeMobileSheet()
    if (action === 'move') void openMove(targets)
    else if (action === 'copy') openCopy(targets)
    else setDeleteTargets(targets)
  }

  const renderOperationDocuments = (items: readonly Pick<UserDocRef, 'docId' | 'name' | 'mediaType' | 'bytes'>[]) => (
    <ul className={css.operationFiles} aria-label={t('operation.documents')}>
      {items.map(item => <li key={item.docId}>
        <FileTypeIcon name={item.name} mediaType={item.mediaType} />
        <span>{item.name}</span><small>{formatBytes(item.bytes)}</small>
      </li>)}
    </ul>
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
      {(loading || refreshing || overviewLoading || sourcePickerLoading) && (
        <p className={css.sheetStatus} aria-live="polite">{pendingScopeLabel === '' ? t('modal.loading') : t('scope.switch.loading', { name: pendingScopeLabel })}</p>
      )}
      {error !== '' && <div className={css.sheetError} role="alert">{error}</div>}
      {overviewError !== '' && mobileSheet.mode === 'view' && <div className={css.sheetError} role="alert">{overviewError}</div>}
      <div className={css.sheetOptions} role="group" aria-label={t('scope.rail.label')}>
        {filteredMobileScopeOptions.length === 0 ? (
          <p className={css.sheetStatus}>{t('modal.noResults')}</p>
        ) : filteredMobileScopeOptions.map((option) => {
          const selectedOption = mobileSheet.mode === 'source'
            ? option.value === sourcePickerValue
            : mobileSheet.mode === 'upload'
              ? option.value === uploadScopePickerValue
              : option.value === mobileScopeValue
          const disabled = busy || overviewLoading || sourcePickerLoading
          return (
            <button
              key={option.value}
              type="button"
              aria-current={selectedOption ? 'true' : undefined}
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
              {selectedOption && <span className={css.sheetCheck} aria-hidden="true"><IconCheckOutline16 size={16} /></span>}
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
        onClick={() => { closeMobileSheet(); if (trashMode) returnFromTrash(); else void openTrash() }}
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
          <DocumentSortControl sort={sort} onChange={setSortValue} t={t} inline disabled={busy} />
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
        <Button className={css.sheetAction} type="button" variant="soft" disabled={busy} icon={<IconPaperclipOutline16 size={18} />} onClick={() => { performMobileDocumentAction('attach', mobileSheet.document) }}>{attachLabel}</Button>
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
        <Button className={css.sheetAction} type="button" variant="ghost" disabled={busy} icon={<IconCopyOutline16 size={18} />} onClick={() => { const document = mobileSheet.document; closeMobileSheet(); openCopy([document], true) }}>{t('scope.copy')}</Button>
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
      <Button className={css.sheetAction} type="button" variant="soft" disabled={overviewLoading} icon={<IconCopyOutline16 size={18} />} onClick={() => { closeMobileSheet(); void openOverviewCopy(mobileSheet.row) }}>{mode === 'select' && sameDocumentScope(catalogRowScope(mobileSheet.row), currentScopeDescriptor()) ? t('action.attach') : mode === 'select' ? t('scope.copyAndAttach') : t('scope.copy')}</Button>
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
          <Button className={css.sheetAction} type="button" variant="soft" disabled={busy || onAttachDocument === undefined} icon={<IconPaperclipOutline16 size={18} />} onClick={() => { void attachSelectedDocuments() }}>{t('selection.attach')}</Button>
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

  const filterControls = (
    <>
      <Input
        className={css.search as string}
        icon={<IconSearchOutline16 size={16} />}
        aria-label={t('modal.search')}
        placeholder={t('modal.search')}
        value={query}
        onChange={(event) => { setQuery(event.target.value) }}
      />
      {!phone && (
        <>
          <select className={css.select} aria-label={t('modal.type')} value={typeFilter} onChange={(event) => { setTypeFilter(event.currentTarget.value as DocumentTypeFilter) }}>
            {TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
          </select>
          <DocumentSortControl sort={sort} onChange={setSortValue} t={t} disabled={busy} />
        </>
      )}
    </>
  )

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={title}
        headless
        className={css.dialog as string}
        onKeyDownCapture={(event) => {
          if (!phone && previewVisible && event.key === 'Escape' && event.target instanceof Element && event.target.closest('[data-document-preview]') !== null) {
            event.preventDefault(); event.stopPropagation(); closePreview()
          }
        }}
      >
        <div className={css.shell}>
          <header className={css.managerHeader}>
            <h2>{title}</h2>
            {showComputer && !overviewMode && displayedComputerName !== undefined && <ComputerBadge name={displayedComputerName} label={t('computer.source')} />}
            <div className={css.managerHeaderActions}>
              {limitsText !== '' && <Tooltip label={t('manager.info')} disabled={phone}><Button className={css.infoButton} size="toolbar" type="button" variant="ghost" aria-label={t('manager.info')} onClick={() => { setLimitsOpen(true) }}><IconInfoOutline16 size={18} /></Button></Tooltip>}
              <Button className={css.managerClose} type="button" variant="ghost" aria-label={t('modal.close')} onClick={onClose}><IconCloseOutline16 size={18} /></Button>
            </div>
          </header>
          {unavailableScope && <p role="alert" className={css.error}>{t('scope.entryUnavailable')}</p>}
          <div className={css.workbench} ref={focusTrashReturn}>
            <aside className={css.scopeRail} aria-label={t('scope.rail.label')}>
              <Input className={css.scopeSearch as string} icon={<IconSearchOutline16 size={14} />} aria-label={t(showComputer ? 'scope.search' : 'scope.searchLocal')} placeholder={t(showComputer ? 'scope.search' : 'scope.searchLocal')} value={scopeFilter} onChange={(event) => { setScopeFilter(event.currentTarget.value) }} />
              {scopeStatus === 'stale' && <div className={css.scopeStale} role="status"><span>{t('scope.stale')}</span><button type="button" onClick={() => { scopeCache.current = null; void load(ROOT_DIRECTORY_ID) }}>{t('scope.retry')}</button></div>}
              {locationsError && <div className={css.scopeStale} role="status">{t('computer.locationsFailed')}</div>}
              <button type="button" className={`${css.scopeItem} ${overviewMode ? css.scopeItemActive : ''}`} onClick={() => { void openOverview() }} disabled={busy || overviewLoading}>
                <span className={css.scopeItemIcon} aria-hidden="true"><IconBrowseOutline16 size={16} /></span>
                <span><strong>{t('scope.all')}</strong><small>{t('scope.all.description')}</small></span>
              </button>
              {locationOptions.filter(item => item.scope.kind === 'personal' && item.label.toLowerCase().includes(scopeFilter.trim().toLowerCase())).map(item => <button key={item.value} type="button"
                className={`${css.scopeItem} ${!overviewMode && sameDocumentScope(item.scope, listingScope()) ? css.scopeItemActive : ''}`}
                onClick={() => { void openScopeView(item.scope, item.label) }} disabled={busy || overviewLoading}>
                <span className={css.scopeItemIcon} aria-hidden="true"><IconBrowseOutline16 size={16} /></span>
                <span><strong>{t('copy.target.personal')}</strong>{showComputer && <small>{item.scope.nodeName}</small>}</span>
              </button>)}
              {locationOptions.length === 0 && <button type="button" className={`${css.scopeItem} ${!overviewMode && alternateSource === null && (scopeView?.scope.kind === 'personal' || (scopeView === null && scope.kind === 'personal')) ? css.scopeItemActive : ''}`} onClick={() => { void openScopeView({ kind: 'personal' }, t('copy.target.personal')) }} disabled={busy || overviewLoading}>
                <span className={css.scopeItemIcon} aria-hidden="true"><IconPaperclipOutline16 size={16} /></span>
                <span><strong>{t('copy.target.personal')}</strong><small>{t('scope.personal.description')}</small></span>
              </button>}
              <div className={css.scopeRailHeading}>{t('scope.rail.title')}</div>
              {locationOptions.filter(item => item.scope.kind === 'project' && item.label.toLowerCase().includes(scopeFilter.trim().toLowerCase())).map(item => <button
                key={item.value} type="button" className={`${css.scopeItem} ${!overviewMode && sameDocumentScope(item.scope, listingScope()) ? css.scopeItemActive : ''}`}
                onClick={() => { void openScopeView(item.scope, item.label) }} disabled={busy || overviewLoading}>
                <span className={css.scopeItemIcon} aria-hidden="true"><IconFolderClose16 size={16} /></span>
                <span><strong>{locations?.items.find(location => sameDocumentScope(location.scope, item.scope))?.name}</strong>
                  <small>{showComputer ? `${item.scope.nodeName} · ` : ''}{projectModeLabel(item.mode, t)}</small></span>
              </button>)}
              {(scope.projects ?? [])
                .filter(() => locationOptions.length === 0)
                .filter(project => project.name.toLowerCase().includes(scopeFilter.trim().toLowerCase()))
                .map((project) => {
                  const isCurrent = !overviewMode && alternateSource === null && ((scopeView?.scope.kind === 'project' && scopeView.scope.projectId === project.projectId) || (scopeView === null && scope.kind === 'project' && scope.projectId === project.projectId))
                  return <button key={project.projectId} type="button" className={`${css.scopeItem} ${isCurrent ? css.scopeItemActive : ''}`} onClick={() => { void openScopeView({ kind: 'project', projectId: project.projectId }, project.name) }} disabled={busy || overviewLoading}>
                    <span className={css.scopeItemIcon} aria-hidden="true"><IconFolderClose16 size={16} /></span>
                    <span><strong>{project.name}</strong><small>{t('scope.project.meta', { mode: projectModeLabel(project.mode, t), description: t('scope.project.description') })}</small></span>
                  </button>
                })}
              {nextLocationCursor !== null && nextLocationCursor !== undefined && <Button type="button" size="toolbar" variant="ghost" disabled={locationsLoading}
                onClick={() => { setLocationsCursor(nextLocationCursor) }}>{t('computer.more')}</Button>}
              <div className={css.railBottom}>
                <Button type="button" size="toolbar" variant="ghost" data-documents-trash-toggle="" disabled={busy || trashLoading || overviewMode} icon={<IconTrashOutline16 size={16} />} onClick={() => { if (trashMode) returnFromTrash(); else void openTrash() }}>{trashMode ? t('trash.back') : t('trash.button')}</Button>
                <Button type="button" size="toolbar" variant="ghost" disabled={busy || historyLoading || overviewMode} onClick={() => { void openHistory() }}>{t('history.button')}</Button>
              </div>
            </aside>
            <div className={css.workbenchContent}>
              {mode === 'select' && <div className={css.selectionModeNotice} role="status">
                {t('selection.destination', { name: attachmentDestinationLabel })}
                {crossScopeAttachment && !overviewMode && <span className={css.attachmentSource}>
                  {t('selection.copySource', { name: attachmentSourceLabel })}
                </span>}
              </div>}
              {compactNavigation && (
                <>
                  <button
                    type="button"
                    className={css.scopeTrigger}
                    data-documents-scope-trigger=""
                    data-testid="documents-scope-trigger"
                    aria-haspopup="dialog"
                    aria-expanded={mobileSheet?.kind === 'scope' && mobileSheet.mode === 'view'}
                    disabled={busy || overviewLoading}
                    onClick={(event) => { actionReturnTarget.current = event.currentTarget; openMobileScopeSheet('view') }}
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
                {pendingAttachments.length > 0 && <div className={css.notice} role="status"><span>{t('copy.attachPending', { names: pendingAttachments.map(document => document.name).join('、') })}</span><Button type="button" variant="soft" disabled={busy} onClick={retryPendingAttachments}>{t('copy.retryAttachment')}</Button></div>}
                {onAttachDocument === undefined && <div className={css.notice} role="status">{t('action.attach.noTarget')}</div>}
                {notice !== '' && <div className={css.notice} role="status">{notice}</div>}
                {overviewMode && (
                  <section className={css.overview} aria-label={t('scope.all')}>
                    <header className={css.overviewHeader}>
                      <div><h2>{t('scope.all')}</h2><p>{t('scope.all.description')}</p></div>
                      <div className={css.overviewActions}>
                        <Button size="toolbar" type="button" variant="soft" icon={<IconPlusOutline16 size={16} />} disabled={overviewLoading || busy} onClick={(event) => { actionReturnTarget.current = event.currentTarget; openUploadScopePicker() }}>{t('scope.upload.choose')}</Button>
                        <Button size="toolbar" type="button" variant="ghost" icon={<IconRefreshOutline16 size={16} />} disabled={overviewLoading || busy} onClick={() => { void openOverview(true) }}>{t('modal.refresh')}</Button>
                      </div>
                    </header>
                    <div className={css.overviewToolbar} role="group" aria-label={t('modal.filters')}>{filterControls}{phone && <Button className={css.rowMore} size="toolbar" type="button" variant="ghost" aria-label={t('action.more')} onClick={(event) => { actionReturnTarget.current = event.currentTarget; setMobileSheet({ kind: 'more' }) }}><IconEllipsisOutline16 size={16} /></Button>}</div>
                    {unavailableDocumentComputers > 0 && <div className={css.notice} role="status">{t('overview.unavailable', { count: String(unavailableDocumentComputers) })}</div>}
                    {overviewError !== '' && <div className={css.error} role="alert">{overviewError}</div>}
                    {overviewLoading ? <p className={css.status}>{t('scope.all.loading')}</p> : overviewFiltered.length === 0 ? <p className={css.empty}>{t('scope.all.empty')}</p> : (
                      <div className={css.overviewList} role="list" data-documents-scrollport="overview">
                        {overviewPageRows.map(row => <div key={row.catalogId} className={css.overviewRow} role="listitem">
                          <span className={css.fileIcon} aria-hidden="true"><FileTypeIcon name={row.name} mediaType={row.mediaType} /></span>
                          <div className={css.meta}>
                            <span className={css.name} title={row.name}>{row.name}</span>
                            <span className={css.size}>{overviewMetaLabel(row, t)}</span>{!showComputer || row.scope.nodeId === undefined ? null : <ComputerBadge label={t('computer.source')}
                              name={locations?.items.find(item => item.scope.nodeId === row.scope.nodeId)?.nodeName
                                ?? row.scope.nodeId.slice(0, 8)}
                              details={[]} />}
                          </div>
                          {mode === 'select' ? (
                            <Button className={css.overviewAttach} type="button" size="sm" variant="soft" disabled={overviewLoading} onClick={() => { void openOverviewCopy(row) }}>{sameDocumentScope(catalogRowScope(row), currentScopeDescriptor()) ? t('action.attach') : t('scope.copyAndAttach')}</Button>
                          ) : phone ? (
                            <Button
                              className={css.rowMore}
                              data-documents-row-more="overview"
                              type="button"
                              variant="ghost"
                              aria-label={t('scope.copyNamed', { name: row.name })}
                              aria-haspopup="dialog"
                              disabled={overviewLoading}
                              onClick={(event) => { actionReturnTarget.current = event.currentTarget; setMobileSheet({ kind: 'overview', row }) }}
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
                        if (overviewPaging) {
                          void loadOverviewPage(
                            previous,
                            previous <= 1 ? undefined : overviewCursors.current[previous - 1],
                          )
                        }
                        else setOverviewPage(previous)
                      }}>{t('pager.prev')}</Button>
                      <span>{t('pager.status', {
                        page: String(overviewCurrentPage),
                        pages: overviewPaging && overviewTotalDocuments === null ? '…' : String(overviewPages),
                      })}</span>
                      <Button type="button" variant="outline" disabled={overviewPaging ? overviewNextCursor === undefined || overviewLoading : overviewCurrentPage >= overviewPages || overviewLoading} onClick={() => {
                        const next = overviewCurrentPage + 1
                        if (overviewPaging && overviewNextCursor !== undefined) {
                          overviewCursors.current[overviewCurrentPage] = overviewNextCursor
                          void loadOverviewPage(next, overviewNextCursor)
                        } else setOverviewPage(next)
                      }}>{t('pager.next')}</Button>
                    </div>}
                  </section>
                )}
                {trashMode && (
                  <section className={css.trash} aria-label={t('trash.title')}>
                    <header className={css.trashHeader} data-documents-trash-header>
                      <div><h2>{t('trash.title')}</h2><p>{visibleScope}</p></div>
                      <div className={css.trashActions}><Button type="button" variant="soft" disabled={busy || trashLoading} onClick={returnFromTrash}>{t('trash.back')}</Button>
                        <Button type="button" variant="ghost" disabled={busy || trashLoading} onClick={() => { void openTrash() }}>{t('modal.refresh')}</Button></div>
                    </header>
                    {trashLoading ? <p className={css.status}>{t('modal.loading')}</p> : trashDocuments.length === 0 ? <p className={css.empty}>{t('trash.empty')}</p> : (
                      <div className={css.trashList} role="list">
                        {trashDocuments.map(document => (
                          <div key={document.trashId ?? `${document.docId}:${document.identity?.incarnationId ?? document.trashedAt}`} className={css.trashRow} role="listitem">
                            <span className={css.fileIcon} aria-hidden="true"><FileTypeIcon name={document.name} mediaType={document.mediaType} /></span>
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

                <div className={css.directoryChrome} inert={overviewMode || trashMode} aria-hidden={overviewMode || trashMode}>
                  <div className={css.locationIdentity}>
                    {!compactNavigation && <h3 className={css.locationHeading}>{mobileScopeLabel}</h3>}
                    <div className={css.breadcrumbBar}>
                      {currentDirectoryId !== ROOT_DIRECTORY_ID && (
                        <button
                          type="button"
                          className={css.parentBack}
                          disabled={loading && !listingReadyRef.current}
                          onClick={() => { navigate(parentDirectory(currentDirectoryId)) }}
                        >
                          {t('breadcrumb.parent')}
                        </button>
                      )}
                      <nav className={css.breadcrumbs} aria-label={t('breadcrumb.label')}>
                        {directoryTrail.map((crumb, index) => (
                          <span key={crumb.directoryId || 'root'} className={css.crumbSeat}>
                            {index > 0 && <IconChevronRightOutline14 size={12} className={css.crumbChevron} />}
                            <button
                              type="button"
                              className={css.crumb}
                              aria-current={index === directoryTrail.length - 1 ? 'page' : undefined}
                              disabled={(loading && !listingReadyRef.current) || index === directoryTrail.length - 1}
                              onClick={() => { navigate(crumb.directoryId) }}
                            >
                              {crumb.directoryId === ROOT_DIRECTORY_ID ? t('breadcrumb.root') : crumb.name}
                            </button>
                          </span>
                        ))}
                      </nav>
                    </div>

                    {scopeView !== null && (
                      <div className={`${css.scopeNotice} ${scopeView.canUpload ? css.scopeNoticeTarget : css.scopeNoticeReadOnly}`} role="status">
                        <span className={css.scopeNoticeIcon} aria-hidden="true"><IconFolderClose16 size={16} /></span>
                        <span className={css.scopeNoticeCopy}>
                          <strong>{scopeView.canUpload
                            ? t('scope.upload.target', { name: scopeViewLabel })
                            : scopeViewLabel}</strong>
                          <small>{scopeView.canUpload ? t('scope.manage.editable') : t('scope.upload.readOnly', { name: scopeViewLabel })}</small>
                        </span>
                      </div>
                    )}
                    {alternateSource !== null && (
                      <div className={`${css.scopeNotice} ${alternateSource.mode === 'rw' ? css.scopeNoticeTarget : css.scopeNoticeReadOnly}`} role="status">
                        <span className={css.scopeNoticeIcon} aria-hidden="true"><IconBrowseOutline16 size={16} /></span>
                        <span className={css.scopeNoticeCopy}>
                          <strong>{alternateSourceLabel}</strong>
                          <small>{alternateSource.mode === 'rw' ? t('scope.manage.editable') : t('scope.source.readOnly')}</small>
                        </span>
                      </div>
                    )}

                  </div>
                  <div className={css.toolbar}>
                    <div className={css.filterGroup} role="group" aria-label={t('modal.filters')}>{filterControls}</div>
                    <div className={`${css.actionGroup}${phone ? ` ${css.mobileActionGroup}` : ''}`} role="group" aria-label={t('modal.actions')}>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        hidden
                        disabled={busy || uploadLocked}
                        onChange={(event) => {
                          const files = event.currentTarget.files
                          /* v8 ignore next -- the file input always exposes a FileList */
                          if (files !== null) void uploadFiles(files)
                        }}
                      />
                      {phone ? (
                        <>
                          {trashMode ? (
                            <Button size="toolbar"
                              className={css.trashToggle}
                              type="button"
                              variant="ghost"
                              disabled={busy || trashLoading}
                              onClick={returnFromTrash}
                            >
                              {t('trash.back')}
                            </Button>
                          ) : alternateSource === null && !overviewMode && uploadButton}
                          <Button size="toolbar"
                            className={css.mobileMore}
                            data-documents-toolbar-more=""
                            type="button"
                            variant="ghost"
                            aria-label={t('action.more')}
                            aria-haspopup="dialog"
                            aria-expanded={mobileSheet?.kind === 'more'}
                            disabled={busy}
                            icon={<IconEllipsisOutline16 size={18} />}
                            onClick={(event) => { actionReturnTarget.current = event.currentTarget; setMobileSheet({ kind: 'more' }) }}
                          >
                            {t('action.more.compact')}
                          </Button>
                        </>
                      ) : (
                        <>
                          {!trashMode && <Button size="toolbar" className={css.newFolder} type="button" variant="ghost" disabled={busy || writeLocked} icon={<IconPlusOutline16 size={16} />} onClick={openCreateDirectory}>{t('folder.create')}</Button>}
                          {!trashMode && alternateSource === null && !overviewMode && uploadButton}
                          <Menu open={toolsOpen} onClose={() => { setToolsOpen(false) }} portal compact={!touch} autoFocus align="end"
                            anchor={<Button size="toolbar" className={css.desktopMore} data-documents-toolbar-more="" type="button" variant="ghost" aria-label={t('action.more')} aria-haspopup="menu" aria-expanded={toolsOpen} disabled={busy} onClick={(event) => { actionReturnTarget.current = event.currentTarget; setToolsOpen(!toolsOpen) }}><IconEllipsisOutline16 size={16} /></Button>}>
                            {compactNavigation && <MenuItemButton icon={<IconTrashOutline16 size={16} />} disabled={busy || trashLoading} onSelect={() => { setToolsOpen(false); if (trashMode) returnFromTrash(); else void openTrash() }}>{trashMode ? t('trash.back') : t('trash.button')}</MenuItemButton>}
                            {!trashMode && scopeView === null && alternateSource === null && sourceOptions.length > 0 && <MenuItemButton icon={<IconBrowseOutline16 size={16} />} disabled={busy} onSelect={() => { focusActionAnchor(); setToolsOpen(false); openSourcePicker() }}>{t('copy.source')}</MenuItemButton>}
                            {!trashMode && (scopeView !== null || alternateSource !== null) && <MenuItemButton disabled={busy} onSelect={() => { focusActionAnchor(); setToolsOpen(false); void load(ROOT_DIRECTORY_ID) }}>{t('copy.source.current')}</MenuItemButton>}
                            <MenuItemButton icon={<IconRefreshOutline16 size={16} />} disabled={busy} onSelect={() => { focusActionAnchor(); setToolsOpen(false); void refreshDisplayed() }}>{t('modal.refresh')}</MenuItemButton>
                            {compactNavigation && <MenuItemButton disabled={busy || historyLoading || overviewMode} onSelect={() => { focusActionAnchor(); setToolsOpen(false); void openHistory() }}>{t('history.button')}</MenuItemButton>}
                          </Menu>
                        </>
                      )}
                    </div>
                  </div>

                  <div className={css.caption}>
                    <span className={css.captionLeading}>
                      {pageDocs.length > 0 && (
                        <label className={css.check}>
                          <input
                            ref={headerCheckRef}
                            type="checkbox"
                            checked={headerState === 'all'}
                            aria-label={t('selection.selectPage')}
                            onChange={togglePage}
                          />
                        </label>
                      )}
                      {visibleUploadFeedback === null ? <span>{visibleScope}</span> : (
                        <span role="status" aria-live="polite">{t('modal.upload.published', {
                          published: String(visibleUploadFeedback.published), total: String(visibleUploadFeedback.total),
                        })}</span>
                      )}
                      {refreshing && !emptyReadPending && visibleUploadFeedback === null && <span className={css.refreshingStatus} role="status" aria-live="polite">{pendingScopeLabel === '' ? t('modal.refreshing') : t('scope.switch.loading', { name: pendingScopeLabel })}</span>}
                    </span>
                    {!loading && !emptyReadPending && !emptyUploadPending && <span>{t('listing.entries', { folders: String(filteredDirectories.length), documents: String(totalDocuments ?? filtered.length) })}</span>}
                  </div>

                </div>

                {displayedProgress !== null && (
                  <div
                    className={css.progress}
                    role="progressbar"
                    aria-label={uploadLabel}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={displayedProgress.percent}
                  >
                    <span style={{ width: `${String(displayedProgress.percent)}%` }} />
                  </div>
                )}

                <div className={css.browseBody} data-documents-browse-body="" inert={overviewMode || trashMode} aria-hidden={overviewMode || trashMode}>
                  {!hasEntries && busy ? null : emptyUploadPending ? null : emptyReadPending ? (
                    <div className={css.loadingState} role="status" aria-live="polite">
                      <span className={css.visuallyHidden}>{t('modal.loading')}</span>
                      {[0, 1, 2].map(index => <span key={index} className={css.loadingRow} aria-hidden="true" />)}
                    </div>
                  ) : !hasEntries ? (
                    <div className={css.emptyState}>
                      <span className={css.emptyIcon} aria-hidden="true"><IconBrowseOutline16 size={24} /></span>
                      <p className={css.empty}>{t('modal.empty')}</p>
                      {!uploadLocked && (
                        <div className={css.emptyActions}>
                          <Button type="button" variant="soft" aria-label={t('modal.upload')} icon={<IconPlusOutline16 size={16} />} onClick={() => { fileInputRef.current?.click() }}>
                            {phone ? t('modal.upload.compact') : t('modal.upload')}
                          </Button>
                          <Button type="button" variant="outline" aria-label={t('folder.create')} disabled={busy} icon={<IconFolderClose16 size={16} />} onClick={openCreateDirectory}>
                            {phone ? t('folder.create.compact') : t('folder.create')}
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : !hasVisibleEntries ? (
                    <div className={css.emptyState}>
                      <span className={css.emptyIcon} aria-hidden="true"><IconSearchOutline16 size={24} /></span>
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
                  {previewVisible && <DocumentPreview
                    doc={previewDoc}
                    privateResourceUrl={privateResourceUrl}
                    {...((scopeView?.scope ?? alternateSource?.scope) === undefined
                      ? {} : { scope: scopeView?.scope ?? alternateSource?.scope })}
                    maxTextBytes={MAX_PREVIEW_TEXT_BYTES}
                    embedded={!phone}
                    sourceLabel={mobileScopeLabel}
                    onClose={closePreview}
                    t={t}
                    actions={<>
                      <p className={css.previewTarget}>{t('preview.destination')}{selected.size > 0 && <><br />{t('preview.singleHint')}</>}</p>
                      <Button className={css.previewAttach} size="toolbar" type="button" variant="soft" disabled={busy} icon={<IconPaperclipOutline16 size={16} />} onClick={() => { attachDocument(previewDoc) }}>{selected.size > 0 ? t(crossScopeAttachment ? 'preview.copyAttachOne' : 'preview.attachOne') : attachLabel}</Button>
                      <div className={css.previewSecondary}>
                        <a href={documentContentUrl(previewDoc.docId)} target="_blank" rel="noopener noreferrer"><IconDownloadOutline16 size={16} />{t('action.download')}</a>
                        <Tooltip label={t('action.move')} disabled={phone}><Button size="toolbar" type="button" variant="ghost" aria-label={t('action.move')} disabled={busy || writeLocked} onClick={() => { void openMove([previewDoc]) }}><IconFolderOpenOutline16 size={16} />{phone && t('action.move')}</Button></Tooltip>
                        <Tooltip label={t('scope.copy')} disabled={phone}><Button size="toolbar" type="button" variant="ghost" aria-label={t('scope.copy')} disabled={busy} onClick={() => { openCopy([previewDoc], true) }}><IconCopyOutline16 size={16} />{phone && t('scope.copy')}</Button></Tooltip>
                        <Tooltip label={t('action.delete')} disabled={phone}><Button className={css.delete} size="toolbar" type="button" variant="ghost" aria-label={t('action.delete')} disabled={busy || writeLocked} onClick={() => { setDeleteTargets([previewDoc]) }}><IconTrashOutline16 size={16} />{phone && t('action.delete')}</Button></Tooltip>
                      </div>
                    </>}
                  />}
                </div>
                {selected.size > 0 && (
                  <div className={`${css.selectionBar} ${css.desktopSelectionBar}`}>
                    <span>{selectionLabel}</span>
                    {clearSelectionButton}
                    {onAttachDocument !== undefined && (
                      <Button
                        type="button"
                        variant="soft"
                        size="toolbar"
                        disabled={busy}
                        onClick={() => { void attachSelectedDocuments() }}
                      >
                        {batchAttachLabel}
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
                      variant="ghost"
                      disabled={busy || writeLocked}
                      onClick={() => {
                        setDeleteTargets(selectedDocumentList())
                      }}
                    >
                      {t('selection.delete')}
                    </Button>
                  </div>
                )}

                {phone && selected.size > 0 && (
                  <div className={css.mobileSelectionBar} data-documents-batch-bar="" data-testid="documents-batch-bar">
                    <span className={css.mobileSelectionCount}>{selectionLabel}</span>
                    {clearSelectionButton}
                    {onAttachDocument !== undefined && <Button type="button" variant="soft" className={css.mobileBatchAttach} disabled={busy} onClick={() => { void attachSelectedDocuments() }}>{batchAttachLabel}</Button>}
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={t('selection.actions')}
                      aria-haspopup="dialog"
                      onClick={(event) => { actionReturnTarget.current = event.currentTarget; setMobileSheet({ kind: 'selection' }) }}
                    >
                      {t('selection.actions.compact')}
                    </Button>
                  </div>
                )}
                <div className={css.drop} aria-hidden="true">{t('modal.drop')}</div>
              </div>
            </div>
          </div>
          {!overviewMode && !trashMode && pager}
        </div>
      </Modal>

      {open && <>
        {mobileSheetContent}
        {limitsOpen && <DocumentsMobileSheet open onClose={() => { setLimitsOpen(false) }} kind="upload-info"
          title={t('manager.info')} closeLabel={t('modal.close')}><p className={css.confirm}>{limitsText}</p></DocumentsMobileSheet>}

        {historyOpen && (
          <DocumentsMobileSheet
            open
            onClose={() => { if (!historyLoading) setHistoryOpen(false) }}
            kind="history"
            wide
            title={t('history.title')}
            closeLabel={t('modal.close')}
          >
            {historyLoading ? <p className={css.operationStatus} role="status">{t('history.loading')}</p> : historyItems.length === 0 ? <p className={css.operationStatus} role="status">{t('history.empty')}</p> : (
              <ol className={css.historyList}>
                {historyItems.map(item => (
                  <li key={item.id}>
                    <span><strong>{item.eventKind}</strong><small>{item.documentName ?? t('history.unknown')} · {item.actor?.displayName ?? t('history.system')}</small></span>
                    <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time>
                  </li>
                ))}
              </ol>
            )}
          </DocumentsMobileSheet>
        )}

        {purgeTarget !== null && (
          <DocumentsMobileSheet
            open
            onClose={() => { if (!busy) setPurgeTarget(null) }}
            kind="purge"
            title={t('trash.purge')}
            closeLabel={t('modal.close')}
            footer={(
              <>
                <Button type="button" variant="outline" disabled={busy} onClick={() => { setPurgeTarget(null) }}>
                  {t('modal.cancel')}
                </Button>
                <Button type="button" variant="soft" className={css.dangerAction} disabled={busy || writeLocked} onClick={() => { void confirmPurgeTrash() }}>
                  {t('trash.purge')}
                </Button>
              </>
            )}
          >
            <p className={css.confirm}>{t('trash.purge.confirm')}</p>
            {renderOperationDocuments([purgeTarget])}
            {error !== '' && <div className={css.error} role="alert">{error}</div>}
          </DocumentsMobileSheet>
        )}

        {deleteTargets !== null && deleteTargets.length > 0 && (
          <DocumentsMobileSheet
            open
            onClose={closeDelete}
            kind="delete"
            title={t('delete.confirm.title')}
            closeLabel={t('modal.close')}
            footer={(
              <>
                <Button type="button" variant="outline" onClick={closeDelete}>
                  {t('modal.cancel')}
                </Button>
                <Button type="button" variant="soft" className={css.dangerAction} disabled={busy || writeLocked} onClick={() => { void handleDelete() }}>
                  {t('delete.confirm.button')}
                </Button>
              </>
            )}
          >
            {modalError !== '' && <div className={css.error} role="alert">{modalError}</div>}
            {renderOperationDocuments(deleteTargets)}
            <p className={css.confirm}>{confirmMessage}</p>
          </DocumentsMobileSheet>
        )}

        {folderEditor !== null && (
          <DocumentsMobileSheet
            open
            onClose={() => {
              if (!busy) {
                setFolderEditor(null)
                setModalError('')
              }
            }}
            footer={(<>

              <Button type="button" variant="outline" disabled={busy} onClick={() => {
                setFolderEditor(null)
                setModalError('')
              }}>
                {t('modal.cancel')}
              </Button>
              <Button form={folderFormId} type="submit" variant="soft" disabled={busy || writeLocked || folderName.trim() === ''}>
                {t(folderEditor.mode === 'create' ? 'folder.create.confirm' : 'folder.rename.confirm')}
              </Button>

            </>)}
            kind="folder-editor"
            title={t(folderEditor.mode === 'create' ? 'folder.create.title' : 'folder.rename.title')}
            closeLabel={t('modal.close')}
          >
            <form id={folderFormId} className={css.form} onSubmit={(event) => { void handleFolderSubmit(event) }}>
              {modalError !== '' && <div className={css.error} role="alert">{modalError}</div>}
              <label className={css.formLabel} htmlFor="documents-folder-name">{t('folder.name')}</label>
              <Input
                id="documents-folder-name"
                className={css.operationInput as string}
                value={folderName}
                onChange={(event) => { setFolderName(event.target.value) }}
                data-modal-autofocus={phone ? undefined : true}
                maxLength={255}
                required
              />

            </form>
          </DocumentsMobileSheet>
        )}

        {deleteDirectory !== null && (
          <DocumentsMobileSheet
            open
            onClose={() => {
              if (!busy) {
                setDeleteDirectory(null)
                setModalError('')
              }
            }}
            kind="delete-folder"
            title={t('folder.delete.title')}
            closeLabel={t('modal.close')}
            footer={(
              <>
                <Button type="button" variant="outline" disabled={busy} onClick={() => {
                  setDeleteDirectory(null)
                  setModalError('')
                }}>
                  {t('modal.cancel')}
                </Button>
                <Button type="button" variant="soft" className={css.dangerAction} disabled={busy || writeLocked} onClick={() => { void handleDeleteDirectory() }}>
                  {t('folder.delete.confirm')}
                </Button>
              </>
            )}
          >
            {modalError !== '' && <div className={css.error} role="alert">{modalError}</div>}
            <p className={css.confirm}>{t('folder.delete.message', { name: deleteDirectory.name })}</p>
          </DocumentsMobileSheet>
        )}

        {moveTargets !== null && moveTargets.length > 0 && (
          <DocumentsMobileSheet
            open
            onClose={() => {
              if (!busy) {
                setMoveTargets(null)
                setModalError('')
              }
            }}
            kind="move"
            title={t('move.title')}
            closeLabel={t('modal.close')}
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
                  variant="soft"
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
              {renderOperationDocuments(moveTargets)}
              {moveLoading ? (
                <p className={css.operationStatus} role="status">{t('move.loading')}</p>
              ) : moveOptions.length === 0 ? (
                <p className={css.operationStatus} role="status">{t('move.noDestinations')}</p>
              ) : (
                <DocumentDestinationPicker label={t('move.destination')}
                  options={moveOptions.map(option => ({ value: option.directoryId, label: option.name }))}
                  value={moveDirectoryId} onChange={(value) => { setMoveDirectoryId(value as UserDocDirectoryIdType) }}
                  searchPlaceholder={t('destination.searchFolders')} emptyLabel={t('destination.empty')}
                  selectedLabel={name => t('destination.selected', { name })} />
              )}
            </div>
          </DocumentsMobileSheet>
        )}

        {copyTargets !== null && (
          <DocumentsMobileSheet
            open
            onClose={() => {
              if (!busy) {
                setCopyTargets(null)
                setOverviewCopyRow(null)
                setModalError('')
              }
            }}
            kind="copy"
            wide
            title={t('copy.title')}
            closeLabel={t('modal.close')}
            footer={(
              <>
                <Button type="button" variant="outline" disabled={busy} onClick={() => {
                  setCopyTargets(null)
                  setOverviewCopyRow(null)
                  setModalError('')
                }}>
                  {t('modal.cancel')}
                </Button>
                <Button type="button" variant="soft" disabled={busy || copyUnavailable || copyDirectoryLoading || copyFolderCreating || retryingCopyId !== null || copyTarget === '' || (overviewCopyRow === null && singleCopyDocument === null && selected.size === 0)} onClick={() => { void handleCopy() }}>
                  {t('copy.confirm')}
                </Button>
              </>
            )}
          >
            {modalError !== '' && <div className={css.error} role="alert">{modalError}</div>}
            {copyUnavailable && <p className={css.error} role="alert">{t('scope.entryUnavailable')}</p>}
            <div className={css.form}>
              {!showComputer || copySourceScope?.nodeId === undefined ? null : <p className={css.confirm}>{t('computer.source')}: <ComputerBadge label={t('computer.source')}
                name={copySourceScope.nodeName
                  ?? locations?.items.find(item => item.scope.nodeId === copySourceScope.nodeId)?.nodeName
                  ?? copySourceScope.nodeId.slice(0, 8)} /> </p>}
              <p className={css.confirm}>{t('copy.message', { count: String(overviewCopyRow !== null || singleCopyDocument !== null ? 1 : selected.size) })}</p>
              {renderOperationDocuments(overviewCopyRow !== null
                ? [overviewCopyRow.row] : singleCopyDocument !== null ? [singleCopyDocument] : selectedDocumentList())}
              <div className={css.destinationColumns}>
                <DocumentDestinationPicker label={t('copy.target')}
                  options={copyTargets.map(option => ({ value: option.value, label: displayLocationLabel(option.target, option.label), kind: 'scope' as const }))}
                  value={copyTarget} onChange={setCopyTarget} disabled={busy || copyFolderCreating || retryingCopyId !== null} searchPlaceholder={t('scope.switch.search')}
                  emptyLabel={t('destination.empty')} selectedLabel={name => t('destination.selected', { name })} />
                {copyDirectoryLoading ? <p className={css.operationStatus} role="status">{t('copy.directory.loading')}</p> : (
                  <DocumentDestinationPicker key={copyTarget} label={t('copy.directory')}
                    options={[{ value: '', label: t('breadcrumb.root') }, ...copyDirectories.map(directory => ({
                      value: directory.directoryId, label: directory.name,
                    }))]}
                    value={copyDirectory} onChange={(value) => { setCopyDirectory(value as UserDocDirectoryIdType) }}
                    disabled={busy || copyFolderCreating || retryingCopyId !== null}
                    searchPlaceholder={t('destination.searchFolders')} emptyLabel={t('destination.empty')}
                    selectedLabel={name => t('destination.selected', { name })} />
                )}
              </div>
              {typeof userDocs.current.createScopeDirectory === 'function' && (
                <div className={css.inlineForm}>
                  <Input className={css.operationInput as string} aria-label={t('copy.directory.new')} value={copyFolderName} placeholder={t('copy.directory.new')} onChange={(event) => { setCopyFolderName(event.target.value) }} disabled={copyDirectoryLoading || copyFolderCreating || busy || retryingCopyId !== null} />
                  <Button type="button" variant="outline" disabled={copyDirectoryLoading || copyFolderCreating || busy || retryingCopyId !== null || copyFolderName.trim() === ''} onClick={() => { void createCopyFolder() }}>{t('folder.create')}</Button>
                </div>
              )}
              {copyLoading && <p className={css.operationStatus} role="status">{t('copy.loading')}</p>}
              {failedCopyItems.length > 0 && (
                <div className={css.failedCopies}>
                  <span className={css.formLabel}>{t('copy.retry.title')}</span>
                  {failedCopyItems.map(item => (
                    <div key={item.docId} className={css.failedCopyRow}>
                      <span className={css.failedCopyName}>{item.name}</span>
                      <Button type="button" size="sm" variant="outline" disabled={copyLoading || retryingCopyId !== null} onClick={() => { void retryCopy(item) }}>
                        {retryingCopyId === item.docId ? t('copy.retry.loading') : t('copy.retry.button')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </DocumentsMobileSheet>
        )}

        {sourcePickerOpen && (
          <DocumentsMobileSheet
            open
            onClose={() => {
              if (!sourcePickerLoading) setSourcePickerOpen(false)
            }}
            kind="source"
            title={t('copy.source.title')}
            closeLabel={t('modal.close')}
            footer={(
              <>
                <Button type="button" variant="outline" disabled={sourcePickerLoading} onClick={() => { setSourcePickerOpen(false) }}>
                  {t('modal.cancel')}
                </Button>
                <Button type="button" variant="soft" disabled={sourcePickerLoading || sourcePickerValue === ''} onClick={() => { void browseSource() }}>
                  {t('copy.source.open')}
                </Button>
              </>
            )}
          >
            <div className={css.form}>
              <p className={css.confirm}>{t('copy.source.message')}</p>
              {error !== '' && <div className={css.error} role="alert">{error}</div>}
              <DocumentDestinationPicker label={t('copy.source.label')}
                options={sourceOptions.map(option => ({ value: option.value, label: option.label, kind: 'scope' as const,
                  description: `${option.mode === 'rw' ? t('scope.project.mode.editable') : t('scope.project.mode.readOnly')} · ${t('scope.source.readOnly')}` }))}
                value={sourcePickerValue} onChange={setSourcePickerValue} disabled={sourcePickerLoading}
                query={sourcePickerQuery} onQueryChange={setSourcePickerQuery} searchable={sourceOptions.length > 1}
                searchPlaceholder={t('scope.switch.search')} emptyLabel={t('destination.empty')}
                selectedLabel={name => t('destination.selected', { name })} />
              {sourcePickerLoading && <p className={css.operationStatus} role="status">{t('copy.source.loading')}</p>}
            </div>
          </DocumentsMobileSheet>
        )}

        {uploadScopePickerOpen && !phone && (
          <DocumentsMobileSheet
            open
            onClose={() => { if (!busy) setUploadScopePickerOpen(false) }}
            kind="upload-scope"
            title={t('scope.upload.choose')}
            closeLabel={t('modal.close')}
            footer={(
              <>
                <Button type="button" variant="outline" disabled={busy} onClick={() => { setUploadScopePickerOpen(false) }}>
                  {t('modal.cancel')}
                </Button>
                <Button type="button" variant="soft" disabled={busy || uploadScopePickerValue === ''} onClick={() => { void chooseUploadScope() }}>
                  {t('scope.upload.confirm')}
                </Button>
              </>
            )}
          >
            <div className={css.form}>
              <p className={css.confirm}>{t('scope.upload.root')}</p>
              {error !== '' && <div className={css.error} role="alert">{error}</div>}
              <DocumentDestinationPicker label={t('scope.upload.choose')}
                options={uploadScopeOptions.map(option => ({ value: option.value, label: option.label, kind: 'scope' as const,
                  description: `${t('scope.project.mode.editable')} · ${t('scope.upload.root')}` }))}
                value={uploadScopePickerValue} onChange={setUploadScopePickerValue} disabled={busy}
                query={uploadScopePickerQuery} onQueryChange={setUploadScopePickerQuery} searchable={uploadScopeOptions.length > 1}
                searchPlaceholder={t('scope.switch.search')} emptyLabel={t('destination.empty')}
                selectedLabel={name => t('destination.selected', { name })} />
            </div>
          </DocumentsMobileSheet>
        )}


      </>}
    </>
  )
}
