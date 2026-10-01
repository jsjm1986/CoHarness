/**
 * Browser-safe background-job domain contract. The registry's live records
 * never cross the wire; a view is the subset a human list needs, minted fresh
 * per push or per output read.
 */

import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/**
 * One background job as the client sees it.
 *
 * Three registry fields are deliberately absent. `ownerSession` is redundant
 * beside the frame's own `sessionId`; `reported` is an internal notice-delivery
 * bit with no user meaning; `outputLimitBytes` is producer-owned model
 * presentation policy that never reaches a human surface. `output` coordinates
 * stay on the view: a settled row offers its retained-output panel exactly
 * when `output.total > 0`.
 */
export interface JobView {
  /** Registry-issued `<kind>-N` identity, stable for the task's whole life. */
  id: JobId
  /**
   * Producer kind (`bash`, `pwsh`, `pty-send`, `subagent`, …). Kept as a bare
   * string because producer plugins extend the kind map by declaration merging,
   * so no client build can enumerate the closed set.
   */
  kind: string
  /** Producer-supplied one-line label: the command, or the delegation description. */
  label: string
  /** Current lifecycle state. */
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** Producer-owned live progress line (`3/10`, the current phase); absent once settled. */
  progress?: string
  /** Kind-specific status detail ('exit code: 3'), present once the producer supplied one. */
  detail?: string
  /** Epoch ms when the task was registered. */
  startedAt: number
  /** Epoch ms when the task settled; absent while live. */
  finishedAt?: number
  /** Retained-output ring coordinates at view-mint time. */
  output: JobOutputCoords
}

/** Stream label of one output chunk; `log` marks producer narration only observers see. */
export type JobChannel = 'stdout' | 'stderr' | 'log'

/**
 * One chunk of a job's retained output ring. Re-declared wire-side rather than
 * imported from `dsh-jobs/view` so api/ stays browser-importable with zero
 * Host-package dependencies; the field set matches, so both sides agree
 * structurally.
 */
export interface JobOutputChunk {
  /** Absolute offset of the chunk's first byte; offsets never move once assigned. */
  at: number
  /** Chunk text exactly as appended (possibly tail-trimmed by retention). */
  text: string
  /** Stream label, when the producer supplied one. */
  channel?: JobChannel
  /** Bytes immediately before this chunk were lost, at the producer or to retention. */
  gapBefore?: true
}

/** The ring's absolute coordinates and its complete-stream spill files. */
export interface JobOutputCoords {
  /** Offset the next appended byte takes; the retained window's upper bound. */
  total: number
  /** Oldest retained byte; greater than zero exactly when retention dropped the head. */
  earliest: number
  /** Complete-stream spill files the producer's pull sources keep, in source order. */
  spillPaths?: string[]
}

/** `jobs.output` value: a fenced ring read plus the job's fresh projection. */
export interface JobOutputValue {
  /** The job's wire view at read time. */
  job: JobView
  /** The ring's coordinates at read time. */
  output: JobOutputCoords
  /** Retained chunks overlapping `[from, total)`, in offset order. */
  chunks: JobOutputChunk[]
  /**
   * Offset to resume from — the ring's current `total`. Always a chunk
   * boundary: consumers concatenate `chunks` under that assumption.
   */
  next: number
  /** Bytes between the requested offset and `chunks` were already evicted. */
  lossy?: true
}

/** `jobs.kill` value: the registry's admission of the human kill request. */
export interface JobKillValue {
  outcome: 'requested' | 'already-finished'
}

/** jobs-domain unary methods (the `jobs.*` rows of RpcMethodMap). */
export interface JobsApi {
  /**
   * Reads a job's retained output ring from an absolute byte offset without
   * moving the model-facing cursor. `from` omitted starts at the oldest
   * retained byte; an offset inside a retained chunk returns the whole chunk
   * (its `at` may precede `from`); an offset below the retained window marks
   * the read `lossy`. `sessionId` supplies the fence: a job owned by another
   * session reads as `job-not-found`, while an unowned job is observable with
   * `sessionId` omitted. A negative or non-integer `from` fails `bad-request`;
   * an unknown or foreign job fails `job-not-found`.
   */
  output(request: RpcRequest<{ sessionId?: SessionId; jobId: JobId; from?: number }>):
  Promise<RpcResponse<JobOutputValue>>

  /**
   * Human-initiated cancellation of one background job visible to a session:
   * the registry marks the job `stopping`, forwards cancellation to the
   * producer, and the row's terminal state converges through the next
   * `session/jobs` frame. A settled or already-killed job resolves
   * `already-finished`; an unknown or foreign job fails `job-not-found`.
   */
  kill(request: RpcRequest<{ sessionId: SessionId; jobId: JobId }>):
  Promise<RpcResponse<JobKillValue>>
}
