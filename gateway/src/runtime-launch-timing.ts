/** Operator timings for a single cold Runtime launch, including work after the requesting browser disconnects. */
import { performance } from 'node:perf_hooks'
import type { RuntimeStartIntent, RuntimeTarget } from './instances.ts'

type LaunchStage = 'targetResolved' | 'lifecycleAcquired' | 'capacityRequested' | 'capacityGranted' | 'startAdmitted' | 'contextReady' | 'storageChecked' | 'portReady'
  | 'stampReady' | 'generationClaimed' | 'projectDataReady' | 'profileReady' | 'policiesReady' | 'recoveryReady'
  | 'storageVerified' | 'allocationRequested' | 'creditGranted' | 'allocationAuthorized' | 'launcherReturned'
  | 'readinessAuthenticated' | 'registrationVerified' | 'readyPublished'

/** Monotonic offsets from the first start request, one per completed launch stage. */
export class RuntimeLaunchTiming {
  private readonly stages: Partial<Record<LaunchStage, number>> = {}
  /** The assigned generation is available after the durable startup claim. */
  generation?: number
  /** Number of signed readiness requests issued to the child process. */
  readinessProbes = 0

  /**
   * @param startedAt - Gateway epoch milliseconds before resolving the target.
   * @param start - corresponding monotonic time in milliseconds.
   */
  constructor(private readonly startedAt: number, private readonly start: number) {}

  /**
   * @param stage - first completion of this stage for the observed launch.
   * @param at - monotonic time for a milestone observed before cold startup was confirmed.
   */
  mark(stage: LaunchStage, at = performance.now()): void {
    this.stages[stage] ??= Math.round((at - this.start) * 100) / 100
  }

  /**
   * Emit a single settled attempt without request bodies, credentials or filesystem paths.
   * @param target - exact managed Runtime when the repository supplies an allocation ID.
   * @param intent - reason this attempt was eligible to start.
   * @param outcome - readiness publication or the caller-visible failure after launch cleanup.
   */
  finish(target: RuntimeTarget, intent: RuntimeStartIntent, outcome: 'ready' | 'failed' | 'cancelled'): void {
    console.info(`[runtime-start-timing] ${JSON.stringify({
      runtimeId: target.runtimeId, kind: target.kind, ownerId: target.id, generation: this.generation, intent, outcome,
      startedAt: this.startedAt, elapsedMs: Math.round((performance.now() - this.start) * 100) / 100,
      stagesMs: this.stages, readinessProbes: this.readinessProbes,
    })}`)
  }
}
