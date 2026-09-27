/**
 * CoHarness v0 database dialect admission for the shared logical catalog.
 * SQLite/PostgreSQL-backed Sessions were committed while the format still
 * carried vocabulary that predates the released v0 rules:
 *
 * - `permission/preset` already stamped `origin` (`default`, `selection`,
 *   `inferred`), a member the released v0 key set does not name but the
 *   current schema records; it is hidden from the released stage and
 *   re-attached to the emitted event rather than dropped.
 * - `subagent/descriptor` was stamped `version: 2` with the field set the
 *   v3 schema later froze; the stamp is rewritten to 3 so the descriptor
 *   stays consumable, matching the released rule that only v0 admission is
 *   version-strict.
 * - message `source.documents` and `source.participant.scope.canManage`
 *   came from the gateway attachment and collaboration vocabularies; they
 *   are hidden and re-attached like `origin`.
 *
 * Every other event reaches the released v0→v1 stage unchanged, so payloads
 * the released stage does not classify are refused exactly as before.
 */

import { SessionFormatError } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatMigration,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import {
  isReleasedAssistantChunkRun,
  sessionFormatV0ToV1,
} from '@deepseek-ai/dsh-session-format-v0-to-v1'
import {
  hideDialectMembers,
  isDialectOnlyEvent,
  restoreDialectMembers,
  type DialectEvent,
} from './coharness-dialect-members.ts'

/**
 * CoHarness v0→v1 edge: hide dialect-only members the released vocabulary
 * does not name, apply the released admission and normalization rules, then
 * re-attach the hidden members to the emitted event. Header migration and
 * target-header validation reuse the released edge unchanged.
 */
export const coharnessV0ToV1Dialect: SessionFormatMigration = Object.freeze({
  name: sessionFormatV0ToV1.name,
  fromVersion: 0,
  toVersion: 1,
  migrateHeader: sessionFormatV0ToV1.migrateHeader.bind(sessionFormatV0ToV1),
  validateTargetHeader: sessionFormatV0ToV1.validateTargetHeader.bind(sessionFormatV0ToV1),
  createStage(input: SessionFormatMigrationStageInput): SessionFormatMigrationStage {
    return new CoharnessV0DialectStage(input)
  },
})

/**
 * Dialect stage: the released stage emits exactly one event per admitted
 * source event in order, so a per-event ledger of hidden members re-attaches
 * deterministically on the emit boundary.
 */
class CoharnessV0DialectStage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private readonly released: SessionFormatMigrationStage
  private readonly ledgers: DialectEvent[] = []

  constructor(input: SessionFormatMigrationStageInput) {
    this.released = sessionFormatV0ToV1.createStage(input)
    /* v8 ignore else -- the released v0 stage always reports its inherited event count. */
    if (this.released.headerInheritedEventCount !== undefined) {
      this.headerInheritedEventCount = this.released.headerInheritedEventCount
    }
  }

  transformEvent(raw: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    /* Dialect-only types have no released classification; they emit
     * unchanged and the restore gate validates them at the chain's end. */
    if (isDialectOnlyEvent(raw)) {
      context.emitEvent(raw)
      return
    }
    const dialect = hideDialectMembers(raw)
    this.ledgers.push(dialect)
    const restoring: SessionFormatMigrationContext = {
      emitEvent: (emitted) => {
        const ledger = this.ledgers.shift()
        /* v8 ignore next 3 -- the released v0 stage emits exactly one event per transformEvent, so a ledger is always queued. */
        if (ledger === undefined) {
          throw new SessionFormatError('v0 dialect emit boundary lost its hidden-member ledger')
        }
        context.emitEvent(restoreDialectMembers(emitted, ledger))
      },
      /* v8 ignore next -- the released v0 stage emits runs only from transformRun, which this stage delegates directly. */
      emitRun: (run) => { context.emitRun(run) },
    }
    this.released.transformEvent(dialect.event, restoring)
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    /* Assistant chunk runs hold no dialect members; every other run expands
     * so each member event receives its own ledger entry. */
    if (isReleasedAssistantChunkRun(run)) {
      this.released.transformRun(run, context)
      return
    }
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(context: SessionFormatMigrationContext): number {
    return this.released.finish(context)
  }
}
