/**
 * Durable projection state for dynamic runtime context.
 * @module @deepseek-ai/dsh-agent-loop/runtime-context
 */

import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextSnapshotSection, Message, SystemMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SurfaceIntent, UserMessage } from '@deepseek-ai/dsh-session'
import { isReplacementSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

const SOURCE = '@deepseek-ai/dsh-system-prompt'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

function isOwned(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}

function textOf(message: Message): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}

/** One durable system-prompt surface update selected before request admission. */
export interface SystemPromptCommit {
  message: SystemMessage
  intent: SurfaceIntent
}

/** Model capability and request-series facts used to reconcile the system prompt. */
export interface SystemPromptDecisionInput {
  inHistory: boolean
  startsSeries: boolean
}

/** Track and reconcile the current system-prompt surface nodes. */
export class SystemPromptProjection {
  constructor(private readonly session: Session) {}

  private systemNodes(): { seq: SessionSeq; text: string }[] {
    const nodes: { seq: SessionSeq; text: string }[] = []
    for (const seq of this.session.surface.nodes) {
      const event = this.session.eventAt(seq)
      if (event?.type !== 'system/message') continue
      nodes.push({ seq, text: textOf(event.data.message) ?? '' })
    }
    return nodes
  }

  project(rendered: string, input: SystemPromptDecisionInput): SystemPromptCommit[] {
    const nodes = this.systemNodes()
    const head = nodes[0]
    if (head === undefined) return [{ message: createSystemMessage(rendered, SOURCE), intent: { surfaceOp: 'append' } }]
    const latest = nodes.findLast(node => node.text !== '') ?? head
    if (!input.inHistory || input.startsSeries || rendered.length === 0) {
      const updates = nodes.slice(1).filter(node => node.text !== '').map(node => this.replace(node.seq, ''))
      if (head.text !== rendered) updates.push(this.replace(head.seq, rendered))
      return updates
    }
    if (latest.text === rendered) return []
    return [{ message: createSystemMessage(rendered, SOURCE), intent: { surfaceOp: 'append' } }]
  }

  private replace(seq: SessionSeq, text: string): SystemPromptCommit {
    return {
      message: createSystemMessage(text, SOURCE),
      intent: { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] },
    }
  }
}

/** Tracks the last retained runtime-context snapshot without owning its commit. */
export class RuntimeContextProjection {
  /** `undefined` means no snapshot ever existed; `null` means none is retained. */
  private retained: { seq: SessionSeq; text: string | undefined } | null | undefined

  /**
   * Restore projection state once, then follow authoritative session events.
   * @param ctx - agent-scoped event context.
   * @param session - session receiving projected messages.
   */
  constructor(ctx: Context, session: Session) {
    const surface = new Set(session.surface.nodes)
    for (let index = session.seq - 1; index >= 0; index -= 1) {
      const event = session.eventAt(SessionSeq(index))
      if (event?.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      if (surface.has(event.seq)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
        break
      }
    }

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
      } else if (this.retained
        && isReplacementSurfaceEvent(event)
        && event.sourceEventSeqs?.includes(this.retained.seq) === true) {
        this.retained = null
      }
    })
  }

  /**
   * Create an uncommitted snapshot only when the retained value differs.
   * @param current - fully rendered dynamic context.
   * @param sections - named contributions that formed the current snapshot.
   * @returns a candidate user message, or `undefined` when no update is needed.
   */
  project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      // The cleared marker has no contributions left to attribute.
      source: sections.length === 0
        ? { kind: 'plugin', plugin: SOURCE }
        : { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections },
    })
  }
}
