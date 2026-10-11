/** One-to-one V6 source and content conversion preserving every event coordinate. */

import { defineSessionFormatMigration, SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatEventRun, SessionFormatJsonObject, SessionFormatMigration, SessionFormatMigrationContext, SessionFormatMigrationStage, SessionFormatMigrationStageInput } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV6Header } from '@deepseek-ai/dsh-session-format-v5-to-v6'
import { mapEventMessages, rewriteV6MessageSource } from './sources.ts'
import { liftToolResult } from './tool-role.ts'
import { migrateV6EventContent } from './content.ts'
import { ADMITTED_V6_EVENT_TYPES, namespaceV6OpaqueEvent } from './extension-identities.ts'
import { assertReleasedV7Header, validateDeliveryAccepted } from './validation.ts'
import { catalogFact } from './facts.ts'

/**
 * V6 to V7 rewrites message sources and tool results in place. Every V6 writer
 * already closes an interrupted turn before the next `turn/start`, and crash
 * tails are trimmed before migration, so no event is inserted, removed, or
 * renumbered: `seq`, `surfaceOp`, and `sourceEventSeqs` coordinates carry over.
 */
export const sessionFormatV6ToV7: SessionFormatMigration = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v6-to-v7',
  fromVersion: 6,
  toVersion: 7,
  migrateHeader(header) {
    assertReleasedV6Header(header)
    return { ...header, version: 7 }
  },
  createStage: input => new ReleasedV6ToV7Stage(input),
  validateTargetHeader: assertReleasedV7Header,
})

class ReleasedV6ToV7Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private readonly catalogs: SessionFormatJsonObject[] = []
  private cut: number | undefined
  private nextSeq = 0
  private foreignDeliverySeq: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    this.cut = input.sourceHeader.isSeeded ? undefined : 0
    if (!input.sourceHeader.isSeeded) this.headerInheritedEventCount = 0
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (event.seq !== this.nextSeq++) throw new SessionFormatError('format v6 source events must be dense')
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data) && event.data['inherited'] === true) {
      if (!this.input.sourceHeader.isSeeded) throw new SessionFormatError('unseeded format v6 Session contains an inherited end-seed marker')
      this.cut = event.seq
    } else if (event.type === 'subagent/catalog' && isSessionFormatJsonObject(event.data)) {
      this.catalogs.push(event.data)
    }
    const deliveryId = validateDeliveryAccepted(event, 6)
    if (event.type === 'session-log-deepseek/delivery-accepted') {
      if ((event.data as SessionFormatJsonObject)['sessionFormatVersion'] === 7) {
        throw new SessionFormatUnsupportedMigrationError('format v6 delivery marker claims target format v7')
      }
      if (deliveryId !== undefined && deliveryId !== this.input.sourceHeader.id) this.foreignDeliverySeq = event.seq
    }
    const opaque = namespaceV6OpaqueEvent(event)
    if (opaque !== event) {
      context.emitEvent(opaque)
      return
    }
    if (!ADMITTED_V6_EVENT_TYPES.has(event.type)) {
      throw new SessionFormatUnsupportedMigrationError(
        `format v6 contains unknown event type ${JSON.stringify(event.type)} at seq ${event.seq}`,
      )
    }
    const rewritten = mapEventMessages(event, (message) => {
      const source = message['source']
      if (!isSessionFormatJsonObject(source)) return message
      const converted = rewriteV6MessageSource(source, event.seq, message['role'])
      return converted === source ? message : { ...message, source: converted }
    })
    context.emitEvent(migrateV6EventContent(liftToolResult(rewritten)))
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    for (const event of run.expand()) this.transformEvent(event, context)
  }

  finish(): number {
    const cut = sessionFormatCount(this.cut, 'format v6 inherited event count')
    const existingCatalogs = new Set<string>()
    for (const data of this.catalogs) {
      const id = catalogFact(data)['childId'] as string
      if (existingCatalogs.has(id)) throw new SessionFormatUnsupportedMigrationError(`duplicate catalog child ${id}`)
      existingCatalogs.add(id)
    }
    if (this.input.sourceInheritedEventCount !== undefined && cut !== this.input.sourceInheritedEventCount) {
      throw new SessionFormatError('format v6 inherited cut disagrees with its source marker')
    }
    if (this.foreignDeliverySeq !== undefined
      && (this.input.sourceHeader.parentSession === undefined || this.foreignDeliverySeq >= cut)) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    return cut
  }
}
