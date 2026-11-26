/** Operator timings for a single cold Runtime launch, including work after the requesting browser disconnects. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import type { RuntimeStartIntent, RuntimeTarget } from './runtime-instance-types.ts'
import type { LocalSupervisorStages } from './local-runtime-protocol.ts'

type LaunchStage = 'targetResolved' | 'lifecycleAcquired' | 'capacityRequested' | 'capacityGranted' | 'startAdmitted' | 'contextReady' | 'storageChecked' | 'portReady'
  | 'stampReady' | 'generationClaimed' | 'projectDataReady' | 'profileReady' | 'policiesReady' | 'recoveryReady'
  | 'storageVerified' | 'allocationRequested' | 'creditGranted' | 'allocationAuthorized' | 'launcherReturned'
  | 'localBootIdStarted' | 'localBootIdReady' | 'localLeaseAcquired' | 'localReservationWritten'
  | 'localSupervisorSpawnStarted' | 'localSupervisorSpawned' | 'localSupervisorReady'
  | 'readinessAuthenticated' | 'registrationVerified' | 'readyPublished'

/** Metadata-only SQL query count and elapsed duration attributed to one launch or launch stage. */
export interface LaunchSqlSpan {
  readonly count: number
  readonly elapsedMs: number
}

const currentLaunch = new AsyncLocalStorage<RuntimeLaunchTiming>()
const rounded = (ms: number): number => Math.round(Math.max(0, ms) * 100) / 100

/** @returns Whether database dispatch has an active cold-launch observation to preserve across checkout. */
export function hasLaunchTiming(): boolean {
  const active = currentLaunch.getStore()
  return active !== undefined && !active.isClosed()
}

/**
 * Capture the dispatching launch before a reused connection supplies its own async context.
 * @returns a recorder of query duration in milliseconds, or undefined outside an active launch.
 */
export function observeLaunchSql(): ((elapsedMs: number) => void) | undefined {
  const active = currentLaunch.getStore()
  if (active === undefined || active.isClosed()) return undefined
  return elapsedMs => { active.recordSql(elapsedMs) }
}

/** Monotonic offsets and per-stage SQL spans from the first start request. */
export class RuntimeLaunchTiming {
  private readonly stages: Partial<Record<LaunchStage, number>> = {}
  private readonly stageSql: Partial<Record<LaunchStage, LaunchSqlSpan>> = {}
  private sqlTotalCount = 0
  private sqlTotalMs = 0
  private pendingSqlCount = 0
  private pendingSqlMs = 0
  private closed = false
  /** Supervisor-relative offsets, available only from a valid local ready diagnostic. */
  localSupervisorStagesMs?: LocalSupervisorStages
  /** The assigned generation is available after the durable startup claim. */
  generation?: number
  /** Number of signed readiness requests issued to the child process. */
  readinessProbes = 0

  /**
   * @param startedAt - Gateway epoch milliseconds before resolving the target.
   * @param start - corresponding monotonic time in milliseconds.
   */
  constructor(private readonly startedAt: number, private readonly start: number) {}

  /** @returns Whether this launch observation has already ended and ignores late async work. */
  isClosed(): boolean {
    return this.closed
  }

  /**
   * Run cold-launch work with this timing bound to AsyncLocalStorage so checked-out SQL counts attribute cleanly.
   * @param work - asynchronous launch operation.
   * @returns the unmodified result of `work`.
   */
  run<T>(work: () => Promise<T>): Promise<T> {
    return currentLaunch.run(this, work)
  }

  /**
   * Close this observation without emitting a log line (used when a start request attaches to an already-ready Runtime).
   */
  close(): void {
    this.closed = true
  }

  /**
   * Record a completed statement dispatched by this launch, ignoring completions after closure.
   * @param elapsedMs - monotonic query duration in milliseconds.
   */
  recordSql(elapsedMs: number): void {
    if (this.closed || !Number.isFinite(elapsedMs)) return
    const clamped = Math.max(0, elapsedMs)
    this.sqlTotalCount += 1
    this.sqlTotalMs += clamped
    this.pendingSqlCount += 1
    this.pendingSqlMs += clamped
  }

  /**
   * @param stage - first completion of this stage for the observed launch.
   * @param at - monotonic time for a milestone observed before cold startup was confirmed.
   */
  mark(stage: LaunchStage, at = performance.now()): void {
    if (this.closed || this.stages[stage] !== undefined) return
    this.stages[stage] = rounded(at - this.start)
    if (this.pendingSqlCount > 0) {
      this.stageSql[stage] = { count: this.pendingSqlCount, elapsedMs: rounded(this.pendingSqlMs) }
      this.pendingSqlCount = 0
      this.pendingSqlMs = 0
    }
  }

  /**
   * Emit a single settled attempt without request bodies, credentials or filesystem paths.
   * @param target - exact managed Runtime when the repository supplies an allocation ID.
   * @param intent - reason this attempt was eligible to start.
   * @param outcome - readiness publication or the caller-visible failure after launch cleanup.
   */
  finish(target: RuntimeTarget, intent: RuntimeStartIntent, outcome: 'ready' | 'failed' | 'cancelled'): void {
    if (this.closed) return
    this.closed = true
    console.info(`[runtime-start-timing] ${JSON.stringify({
      runtimeId: target.runtimeId, kind: target.kind, ownerId: target.id, generation: this.generation, intent, outcome,
      startedAt: this.startedAt, elapsedMs: rounded(performance.now() - this.start),
      stagesMs: this.stages,
      sqlTotal: { count: this.sqlTotalCount, elapsedMs: rounded(this.sqlTotalMs) },
      stageSql: this.stageSql,
      localSupervisorStagesMs: this.localSupervisorStagesMs, readinessProbes: this.readinessProbes,
    })}`)
  }
}
