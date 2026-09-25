/**
 * CoHarness v1 database dialect admission for the shared logical catalog.
 * The gateway writer stamped `permission/preset.origin`, message
 * `source.documents`, and `source.participant.scope.canManage` while v1
 * Sessions were still being committed; the released v1→v2 stage refuses the
 * members its key sets do not name. This edge hides them before released
 * admission and re-attaches them to the emitted event — see
 * {@link hideDialectMembers} — so the recorded fields survive migration and
 * every other payload stays refused exactly as the released stage refuses it.
 */

import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatMigration,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@deepseek-ai/dsh-session-format'
import { sessionFormatV1ToV2 } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import {
  hideDialectMembers,
  isDialectOnlyEvent,
  restoreDialectMembers,
  type DialectEvent,
} from './coharness-dialect-members.ts'

/**
 * CoHarness v1→v2 edge: hide dialect-only members the released vocabulary
 * does not name, apply the released migration unchanged, then re-attach the
 * hidden members on the emit boundary.
 */
export const coharnessV1ToV2Dialect: SessionFormatMigration = Object.freeze({
  name: sessionFormatV1ToV2.name,
  fromVersion: 1,
  toVersion: 2,
  migrateHeader: sessionFormatV1ToV2.migrateHeader.bind(sessionFormatV1ToV2),
  validateTargetHeader: sessionFormatV1ToV2.validateTargetHeader.bind(sessionFormatV1ToV2),
  createStage(input: SessionFormatMigrationStageInput): SessionFormatMigrationStage {
    return new CoharnessV1DialectStage(input)
  },
})

/**
 * Dialect stage: dialect-member carriers emit one-to-one in order while
 * synthesized events never share their types, so an emitted event re-attaches
 * the head ledger entry only when the types match.
 */
class CoharnessV1DialectStage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private readonly released: SessionFormatMigrationStage
  private readonly ledgers: DialectEvent[] = []

  constructor(input: SessionFormatMigrationStageInput) {
    this.released = sessionFormatV1ToV2.createStage(input)
    if (this.released.headerInheritedEventCount !== undefined) {
      this.headerInheritedEventCount = this.released.headerInheritedEventCount
    }
  }

  transformEvent(raw: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    /* Dialect-only types have no released classification and the released
     * stage refuses unknown types; they emit unchanged and the next dialect
     * edge assigns their output position. */
    if (isDialectOnlyEvent(raw)) {
      context.emitEvent(raw)
      return
    }
    const dialect = hideDialectMembers(raw)
    this.ledgers.push(dialect)
    const restoring: SessionFormatMigrationContext = {
      emitEvent: (emitted) => {
        const ledger = this.ledgers[0]
        if (ledger !== undefined && emitted.type === ledger.event.type) {
          this.ledgers.shift()
          context.emitEvent(restoreDialectMembers(emitted, ledger))
          return
        }
        context.emitEvent(emitted)
      },
      emitRun: (run) => { context.emitRun(run) },
    }
    this.released.transformEvent(dialect.event, restoring)
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    /* Packed runs exist only in physical artifacts, which this logical-edge
     * dialect never sees; delegate so released run folding stays intact. Run
     * members never went through this stage's hiding, so nothing restores. */
    this.released.transformRun(run, context)
  }

  finish(context: SessionFormatMigrationContext): number {
    return this.released.finish(context)
  }
}
