/** Process-group payload types; group snapshots carry these in `ChatGroupSnapshot.data`. */

/** Tool-category buckets counted for group titles, in display order of decreasing frequency. */
export type ProcessActivity =
  | 'read' | 'readImage' | 'search' | 'write' | 'edit' | 'commands' | 'code'
  | 'webSearch' | 'webFetch' | 'subagents' | 'plan' | 'questions' | 'tools'

/** Distinct-call category ranking plus the current live task detail for one group. */
export interface ProcessActivitySummary {
  readonly counts: readonly { readonly kind: ProcessActivity; readonly count: number }[]
  readonly running: ProcessActivity | undefined
  readonly runningDetail: string
  /** Present only while the selected live activity has not reached tool/call. */
  readonly preparing?: true
}

/** Business data carried by `ChatGroupSnapshot.data` for chat process groups. */
export interface ProcessGroupData {
  readonly turn: number
  /** Set when the run ended (another member followed it or the turn closed); closed groups show the settled category title. */
  readonly closed: boolean
  readonly summary: ProcessActivitySummary
}
