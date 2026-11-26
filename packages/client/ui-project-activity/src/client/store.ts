/** Activity panel view store: feed pages, journal page, mode, and the member filter. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ActivityItem, ActivityMember, ActivityMode, ActivityPage, ProgressPage } from './feed.ts'
import { feedMembers, hasReadableProgress } from './feed.ts'

/** Whether the panel has a current observation of the Gateway's digest. */
export type ProgressObservation = 'idle' | 'submitting' | 'watching' | ProgressReadFailure

/** A journal operation that needs a fresh status read or a later retry. */
export type ProgressReadFailure = 'load-failed' | 'status-unknown' | 'generate-unavailable'

/** One activity tab's view state. */
export interface ActivityState {
  /** Feed rows in newest-first order, accumulated across pages. */
  items: readonly ActivityItem[]
  /** Current roster and contributors from visible history. */
  members: readonly ActivityMember[]
  /** Cursor resuming the feed after the last row; absent when exhausted. */
  nextBefore?: string
  /** A page request is in flight. */
  loading: boolean
  /** The last page request rejected; refresh retries it. */
  failed: boolean
  /** Latest journal page; absent until the first read lands. */
  progress?: ProgressPage
  /** Request or observation in progress, or why the cached page needs refreshing. */
  progressObservation: ProgressObservation
  /** Active mode, or null until the first journal result or a member selection. */
  grouping: ActivityMode | null
  /** Member filter: restrict rows to one member's public id, or null for all. */
  member: number | null
}

type ActivityActions = {
  /** Record a page request starting. */
  loading: (draft: ActivityState) => void
  /** Replace the feed with a fresh first page. */
  refreshed: (draft: ActivityState, page: ActivityPage) => void
  /** Append an older page. */
  appended: (draft: ActivityState, page: ActivityPage) => void
  /** Mark a failed read. Discard rows and the roster on explicit loss of access. */
  failed: (draft: ActivityState, discard: boolean) => void
  /** Publish a fresh journal page. */
  progressLoaded: (draft: ActivityState, page: ProgressPage) => void
  /** Record the digest request or status watch in progress. */
  progressTracking: (draft: ActivityState, phase: 'submitting' | 'watching') => void
  /** Report a failed operation. Discard the last page on explicit loss of access. */
  progressFailed: (draft: ActivityState, reason: ProgressReadFailure, discard: boolean) => void
  /** Switch the panel mode. */
  grouped: (draft: ActivityState, grouping: ActivityMode) => void
  /** Set the member filter; null shows every member. */
  filtered: (draft: ActivityState, member: number | null) => void
}

/** Create the activity panel's view store.
 * @returns a handle the tab body register declares and the controller binds.
 */
export function createActivityStore(): EngineStoreHandle<ActivityState, ActivityActions> {
  return defineStore({
    init: (): ActivityState => ({ items: [], members: [], loading: true, failed: false, progressObservation: 'idle', grouping: null, member: null }),
    actions: {
      loading: (draft) => { draft.loading = true; draft.failed = false },
      refreshed: (draft, page) => {
        const selected = draft.members.find(member => member.userId === draft.member)
        const roster = page.members ?? []
        const names = selected === undefined || roster.some(member => member.userId === selected.userId) ? roster : [...roster, selected]
        draft.items = [...page.items]
        draft.members = feedMembers(page.items, names)
        if (page.nextBefore === undefined) delete draft.nextBefore
        else draft.nextBefore = page.nextBefore
        draft.loading = false
      },
      appended: (draft, page) => {
        draft.items = [...draft.items, ...page.items]
        draft.members = feedMembers(page.items, draft.members)
        if (page.nextBefore === undefined) delete draft.nextBefore
        else draft.nextBefore = page.nextBefore
        draft.loading = false
      },
      failed: (draft, discard) => {
        draft.loading = false
        draft.failed = true
        if (discard) {
          draft.items = []
          draft.members = []
          draft.member = null
          delete draft.nextBefore
        }
      },
      progressLoaded: (draft, page) => {
        draft.progress = page
        draft.progressObservation = page.status.generating ? 'watching' : 'idle'
        draft.grouping ??= hasReadableProgress(page) ? 'progress' : 'time'
      },
      progressTracking: (draft, phase) => { draft.progressObservation = phase },
      progressFailed: (draft, reason, discard) => {
        draft.progressObservation = reason
        if (discard) delete draft.progress
      },
      grouped: (draft, grouping) => { draft.grouping = grouping },
      filtered: (draft, member) => {
        draft.member = member
        draft.grouping ??= 'time'
        draft.items = []
        draft.loading = true
        draft.failed = false
        delete draft.nextBefore
      },
    },
  })
}

/** Activity tab store handle type derived from the factory. */
export type ActivityStore = ReturnType<typeof createActivityStore>
