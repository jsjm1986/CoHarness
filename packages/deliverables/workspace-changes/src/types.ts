/** Per-turn workspace change summaries, the Session event announcing them, and the Host service serving them with their comparisons. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Content identity of one immutable, Session-owned historical review. */
export type WorkspaceReviewId = Branded<'WorkspaceReviewId'>

/** One file changed during a turn, with line counts from git or from the whole-file captures around its file-tool edits. */
export interface WorkspaceChangedFile {
  /** Path relative to the Session working directory, or an absolute Host path outside it. */
  path: string
  /**
   * Sort key and label: the relative path inside the working directory, a
   * `../` path for repository files above it, a `~` path under the home
   * directory, otherwise the absolute path. Always slash-separated.
   */
  display: string
  /** Lines added; zero for a binary or oversized file. */
  added: number
  /** Lines deleted; zero for a binary or oversized file. */
  deleted: number
  /** Present when git reported the file as binary, or when a captured side holds a NUL byte. */
  binary?: true
  /** Present when a captured side exceeded the plugin's `maxFileBytes`; the file is listed without counts or comparison. */
  oversized?: true
}

/** Historical files changed during one top-level turn. */
export interface WorkspaceChangesSummary {
  /** Storage failed; file effects may have occurred and the comparison is incomplete. */
  incomplete?: true
  /** The turn whose file changes this summary describes. */
  turn: number
  /** The Session working directory `path` values are relative to. */
  cwd: string
  /** Changed files in `display` order, capped at the plugin's `maxFiles`. */
  files: WorkspaceChangedFile[]
  /** Complete changed-file count, including files omitted by the cap. */
  total: number
  /** Lines added over every changed file, including files omitted by the cap. */
  added: number
  /** Lines deleted over every changed file, including files omitted by the cap. */
  deleted: number
  /** Git tree ids of the turn-start and turn-end snapshots; absent when no snapshot was taken. */
  snapshot?: { before: string; after: string }
}

/** One unified-diff hunk with three context lines; every line keeps its `+`, `-`, or space prefix. */
export interface WorkspaceDiffHunk {
  /** First line of the hunk in the turn-start content, 1-based; a side without lines starts at 1 with zero lines. */
  oldStart: number
  /** Lines of the hunk taken from the turn-start content. */
  oldLines: number
  /** First line of the hunk in the turn-end content, 1-based; a side without lines starts at 1 with zero lines. */
  newStart: number
  /** Lines of the hunk taken from the turn-end content. */
  newLines: number
  /** Hunk body in order, each line prefixed with `+`, `-`, or a space. */
  lines: string[]
}

/** The comparison of one listed file's turn-start and turn-end contents, recorded before its announcement. */
export type WorkspaceFileDiff =
  | {
    kind: 'text'
    /** The listed file's `path`. */
    path: string
    /** The listed file's `display`. */
    display: string
    /** Whether the file existed at turn start. */
    before: boolean
    /** Whether the file existed at turn end. */
    after: boolean
    /** Hunks in file order; empty when both sides hold the same lines. */
    hunks: WorkspaceDiffHunk[]
    /** True when the line comparison exceeded the plugin's `diffTimeoutMs` and every line is shown as replaced. */
    coarse: boolean
  }
  /** A side git reported as binary or that holds a NUL byte; no lines are served. */
  | { kind: 'binary'; path: string; display: string }
  /** A side larger than the plugin's `maxFileBytes`; no lines are served. */
  | { kind: 'oversized'; path: string; display: string }

/** Serves live and durably recorded historical comparisons. */
export interface WorkspaceChanges {
  /**
   * Remove stored reviews for an explicitly purged, released Session.
   * @param sessionId - identity selected by the authenticated archive owner.
   * @param signal - purge cancellation.
   * @returns after its immutable artifacts have been removed.
   */
  removeStored(sessionId: SessionId, signal?: AbortSignal): Promise<void>
  /**
   * The summary announced by one `workspace/changes` event.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @param signal - optional cancellation for a persisted read.
   * @returns the summary, or undefined when no historical record is available.
   */
  summary(sessionId: SessionId, seq: number, signal?: AbortSignal):
    WorkspaceChangesSummary | undefined | Promise<WorkspaceChangesSummary | undefined>
  /**
   * Compare one listed file's contents at turn start and turn end.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @param index - the file's index in the summary's `files`.
   * @param signal - cancels the reads.
   * @returns the comparison, or undefined when the artifact or file index is unavailable.
   * @throws when historical data is corrupt or storage cannot be read.
   */
  diff(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A top-level turn's historical review was durably recorded, or storage failed.
     * Old records without reviewId may depend on an unavailable temporary recorder.
     * The latest event for one turn replaces earlier ones.
     */
    'workspace/changes': { turn: number; reviewId?: WorkspaceReviewId; incomplete?: true; requiredReviewBytes?: number }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-turn historical changed-file summaries and comparisons. */
    workspaceChanges: WorkspaceChanges
  }
}
