import { defineSessionFormatMigration } from './chain.ts'
import { createSessionFormatCatalog } from './catalog.ts'
import type { SessionFormatArtifact, SessionFormatHeader } from './types.ts'
import type { SessionFormatEvent, SessionFormatMigrationContext, SessionFormatMigrationStage } from './types.ts'

const bump = (fromVersion: number) => defineSessionFormatMigration({
  name: `@deepseek-ai/dsh-session-format-v${fromVersion}-to-v${fromVersion + 1}`,
  fromVersion,
  toVersion: fromVersion + 1,
  migrateHeader: (header: SessionFormatHeader) => ({ ...header, version: fromVersion + 1 }),
  migrate: (artifact: SessionFormatArtifact) => ({ ...artifact, header: { ...artifact.header, version: fromVersion + 1 } }),
  createStage: () => ({ transformEvent: (event, context) => { context.emitEvent(event) }, finish: () => {} }),
  validateTargetHeader: () => {},
  validateTarget: () => {},
})

/**
 * Convert the CoHarness v2 request-header system prompt into a durable surface
 * node. The migration keeps the existing logical event vocabulary and remaps
 * surface references when the inserted system node shifts later sequences.
 */
const v2ToV3 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v2-to-v3',
  fromVersion: 2,
  toVersion: 3,
  migrateHeader: (header: SessionFormatHeader) => ({
    ...header,
    version: 3,
    ...header.agentPreset === 'code' ? { agentPreset: 'ptc' } : {},
  }),
  migrate: (artifact: SessionFormatArtifact) => {
    const output: SessionFormatEvent[] = []
    const stream = v2ToV3.createStage?.({
      sourceHeader: artifact.header,
      targetHeader: { ...artifact.header, version: 3 },
      sourceInheritedEventCount: artifact.inheritedEventCount,
    })
    if (stream === undefined) throw new Error('v2-to-v3 migration stage is unavailable')
    const context: SessionFormatMigrationContext = { emitEvent: event => output.push(event) }
    for (const event of artifact.events) stream.transformEvent(event, context)
    const cut = stream.finish(context)
    return {
      ...artifact,
      header: { ...artifact.header, version: 3 },
      events: output,
      inheritedEventCount: cut ?? artifact.inheritedEventCount,
    }
  },
  createStage: ({ sourceHeader, sourceInheritedEventCount }) => (
    new V2ToV3Stage(sourceHeader, sourceInheritedEventCount)
  ),
  validateTargetHeader: () => {},
  validateTarget: () => {},
})

class V2ToV3Stage implements SessionFormatMigrationStage {
  private readonly mapping: number[] = []
  private readonly sourceMessageIds = new Set<string>()
  private readonly generatedMessageIds = new Set<string>()
  private targetSeq = 0
  private inheritedCut = 0
  private systemSeq: number | undefined
  private step: { turn: number; step: number } | undefined

  constructor(private readonly sourceHeader: SessionFormatHeader, private readonly sourceCut: number) {}

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    this.observeMessageIds(event)
    if (event.type === 'step/start') {
      const data = event.data as Record<string, unknown>
      if (typeof data.turn !== 'number' || typeof data.step !== 'number') throw new Error('v2 step/start lacks turn or step')
      this.step = { turn: data.turn, step: data.step }
    }
    if (event.type === 'request/header') {
      const data = event.data as Record<string, unknown>
      const header = data.header as Record<string, unknown> | undefined
      const system = typeof header?.system === 'string' ? header.system : ''
      if (this.step === undefined) throw new Error('v2 request/header appears outside an open step')
      this.emitSystem(system, event, context)
      const { system: _system, ...withoutSystem } = header ?? {}
      this.emitMapped({ ...event, data: { ...data, header: withoutSystem } as never }, context)
    } else {
      this.emitMapped(event, context)
    }
    if (event.type === 'step/end' || event.type === 'turn/end') this.step = undefined
    if (event.seq < this.sourceCut) this.inheritedCut = this.targetSeq
  }

  finish(): number { return this.inheritedCut }

  private emitMapped(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    const targetSeq = this.targetSeq++
    this.mapping[event.seq] = targetSeq
    const raw = event as SessionFormatEvent & { surfaceOp?: unknown; sourceEventSeqs?: unknown }
    const surfaceOp = raw.surfaceOp
    const sourceEventSeqs = Array.isArray(raw.sourceEventSeqs)
      ? raw.sourceEventSeqs.map(value => this.mappingNumber(value))
      : raw.sourceEventSeqs
    const mappedOp = surfaceOp === 'append' || surfaceOp === undefined
      ? surfaceOp
      : {
        ...surfaceOp as Record<string, unknown>,
        start: this.mappingNumber((surfaceOp as Record<string, unknown>).start),
        end: this.mappingNumber((surfaceOp as Record<string, unknown>).end),
      }
    context.emitEvent({
      ...event,
      seq: targetSeq,
      ...mappedOp === undefined ? {} : { surfaceOp: mappedOp },
      ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs },
    } as unknown as SessionFormatEvent)
  }

  private emitSystem(text: string, anchor: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    if (this.step === undefined) throw new Error('v2 system prompt appears outside an open step')
    const id = `v2-to-v3-system-${this.sourceHeader.id}-${anchor.seq}`
    if (this.sourceMessageIds.has(id) || this.generatedMessageIds.has(id)) throw new Error('v2-to-v3 generated system message id collides with a source message')
    this.generatedMessageIds.add(id)
    const seq = this.targetSeq++
    const surfaceOp = this.systemSeq === undefined ? 'append' : { op: 'replace', start: this.systemSeq, end: this.systemSeq }
    context.emitEvent({
      type: 'system/message',
      seq,
      time: anchor.time,
      data: {
        turn: this.step.turn,
        step: this.step.step,
        message: {
          id,
          role: 'system',
          source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
          content: text === '' ? [] : [{ type: 'text', text }],
        },
      },
      surfaceOp,
      ...this.systemSeq === undefined ? {} : { sourceEventSeqs: [this.systemSeq] },
    })
    this.systemSeq = seq
  }

  private mappingNumber(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || this.mapping[value] === undefined) throw new Error('v2-to-v3 surface reference does not name an earlier event')
    return this.mapping[value]
  }

  private observeMessageIds(event: SessionFormatEvent): void {
    const data = event.data as Record<string, unknown>
    const values: unknown[] = event.type === 'user/message' ? [data]
      : event.type === 'assistant/message' || event.type === 'tool/result' ? [data.message]
        : event.type === 'agent/inbox/spliced' ? (Array.isArray(data.inserted) ? data.inserted : [])
          : event.type === 'session/title-llm-request' ? (Array.isArray(data.messages) ? data.messages : []) : []
    for (const value of values) {
      if (typeof value !== 'object' || value === null) continue
      const id = (value as Record<string, unknown>).id
      if (typeof id !== 'string') continue
      if (this.generatedMessageIds.has(id)) throw new Error('v2 source message id collides with a generated system message')
      this.sourceMessageIds.add(id)
    }
  }
}

/** The complete static v0→v1→v2→v3 chain used by provider adapters. */
export const sessionFormatCatalog = createSessionFormatCatalog({
  currentVersion: 3,
  migrations: [bump(0), bump(1), v2ToV3],
  restoreCurrentHeader: header => header,
  restoreCurrent: artifact => artifact,
})
