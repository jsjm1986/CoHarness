/** Activity panel view store: feed pages, journal page, mode, and the member filter. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ActivityItem, ActivityMode, ProgressPage } from './feed.ts'

/** One activity tab's view state. */
export interface ActivityState {
  /** Feed rows in newest-first order, accumulated across pages. */
  items: readonly ActivityItem[]
  /** Cursor resuming the feed after the last row; absent when exhausted. */
  nextBefore?: string
  /** A page request is in flight. */
  loading: boolean
  /** The last page request rejected; refresh retries it. */
  failed: boolean
  /** Latest journal page; absent until the first read lands. */
  progress?: ProgressPage
  /** The last journal read rejected; refresh retries it. */
  progressFailed: boolean
  /** Active panel mode. */
  grouping: ActivityMode
  /** Member filter: restrict rows to one member's public id, or null for all. */
  member: number | null
}

type ActivityActions = {
  /** Record a page request starting. */
  loading: (draft: ActivityState) => void
  /** Replace the feed with a fresh first page. */
  refreshed: (draft: ActivityState, items: readonly ActivityItem[], nextBefore: string | undefined) => void
  /** Append an older page. */
  appended: (draft: ActivityState, items: readonly ActivityItem[], nextBefore: string | undefined) => void
  /** Mark the in-flight request rejected. */
  failed: (draft: ActivityState) => void
  /** Publish a fresh journal page. */
  progressLoaded: (draft: ActivityState, page: ProgressPage) => void
  /** Mark the journal read rejected. */
  progressFailed: (draft: ActivityState) => void
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
    init: (): ActivityState => ({ items: [], loading: false, failed: false, progressFailed: false, grouping: 'progress', member: null }),
    actions: {
      loading: (draft) => { draft.loading = true; draft.failed = false },
      refreshed: (draft, items, nextBefore) => {
        draft.items = [...items]
        if (nextBefore === undefined) delete draft.nextBefore
        else draft.nextBefore = nextBefore
        draft.loading = false
      },
      appended: (draft, items, nextBefore) => {
        draft.items = [...draft.items, ...items]
        if (nextBefore === undefined) delete draft.nextBefore
        else draft.nextBefore = nextBefore
        draft.loading = false
      },
      failed: (draft) => { draft.loading = false; draft.failed = true },
      progressLoaded: (draft, page) => { draft.progress = page; draft.progressFailed = false },
      progressFailed: (draft) => { draft.progressFailed = true },
      grouped: (draft, grouping) => { draft.grouping = grouping },
      filtered: (draft, member) => { draft.member = member },
    },
  })
}

/** Activity tab store handle type derived from the factory. */
export type ActivityStore = ReturnType<typeof createActivityStore>
