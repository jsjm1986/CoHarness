/** Observe command-admitted activity through quiescence and preserve a goal's first terminal outcome. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { CommandExecution, JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'

/** One command's SDK completion observer; its listeners end at completion, rejection, or shutdown. */
export class QueryActivity {
  /**
   * Open only across the synchronous `commands.execute()` call entry, where the
   * invocation's own `command/run` is appended synchronously: it claims exactly
   * that command id, this fork's counterpart of upstream's AsyncLocalStorage store.
   */
  invocationOpen = false
  private readonly disposers: (() => void)[] = []
  private readonly openRuns: CommandExecution['commandId'][] = []
  private commandId: CommandExecution['commandId'] | undefined
  private result: CommandExecution['result'] | undefined
  private closed = false
  private input = false
  private inputIdle = false
  private goalId: GoalView['id'] | undefined
  private goalOutcome: 'completed' | 'aborted' | 'error' | undefined
  private goalStopped = false
  private response: string | undefined
  private turnReason = 'completed'

  /**
   * Subscribe before the native command starts so fast input and completion cannot be lost.
   * @param ctx - server-owned context; goal services remain optional for other commands.
   * @param agent - exact receiving Agent.
   * @param transport - SDK notification stream.
   * @param claimed - per-Session set of command ids owned by SDK query activities; nested
   *   native commands stay unclaimed so their events fold into the enclosing owned run.
   * @param signal - server lifetime; abort releases observation without cancelling unrelated work.
   * @param onClose - remove this closed observer from its owner's registry.
   */
  constructor(
    ctx: Context,
    private readonly agent: Agent,
    private readonly transport: JsonRpcTransportPeer,
    private readonly claimed: Set<CommandExecution['commandId']>,
    signal: AbortSignal,
    private readonly onClose: (activity: QueryActivity) => void,
  ) {
    this.disposers.push(ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'command/run') {
        this.openRuns.push(event.data.commandId)
        // Nested native commands retain the outer invocation's completion identity:
        // only the synchronous window claims an id; later runs stay unclaimed.
        if (this.invocationOpen && this.commandId === undefined) {
          this.commandId = event.data.commandId
          claimed.add(event.data.commandId)
        }
      } else if (event.type === 'command/done') {
        const open = this.openRuns.lastIndexOf(event.data.commandId)
        if (open !== -1) this.openRuns.splice(open, 1)
      }
      const own = this.result === undefined && this.commandId !== undefined
        && this.innermostClaimed() === this.commandId
      if (own && event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.source.kind === 'user')) {
        this.input = true
      }
      if (event.type === 'goal/change') {
        const change = event.data
        if (own && (change.operation === 'create' || change.operation === 'resume')) {
          this.goalId = change.goal.id
        }
        if (change.operation === 'clear') {
          if (change.cleared.id === this.goalId) this.goalOutcome ??= 'aborted'
        } else if (change.goal.id === this.goalId && change.goal.phase !== 'active') {
          const goal = change.goal
          this.goalOutcome ??= goal.phase === 'complete'
            ? 'completed'
            : goal.phase === 'paused'
              ? 'aborted'
              : 'error'
        }
      }
      if (this.input || this.goalId !== undefined) {
        if (event.type === 'assistant/message') {
          this.response = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        }
        if (event.type === 'turn/end') this.turnReason = event.data.reason.kind
      }
      this.check()
    }))
    this.disposers.push(ctx.on('goal/activation-changed', (change) => {
      if (change.sessionId !== agent.session.id || change.goal?.id !== this.goalId
        || change.goal?.activation !== 'disarmed') return
      // Terminal mutations also change activation before their durable event is forwarded.
      // Only a still-active goal needs a separate failure report here.
      if (ctx.get('goals')?.get(agent)?.phase === 'active') {
        this.goalStopped = true
        this.check()
      }
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent: current }) => {
      if (current !== agent) return
      this.check()
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent: current }) => {
      if (current === agent && (this.input || this.goalId !== undefined)) this.turnReason = 'error'
    }))
    this.disposers.push(ctx.on('agent/disposed', ({ agent: current }) => {
      if (current === agent) this.finish('error', 'The Session Agent was disposed before the input finished.')
    }))
    const abort = (): void => { this.close() }
    signal.addEventListener('abort', abort, { once: true })
    this.disposers.push(() => { signal.removeEventListener('abort', abort) })
  }

  /**
   * Retain native settlement; admitted input waits through replacement work before completing.
   * @param execution - the already-logged native result.
   */
  accept(execution: CommandExecution): void {
    this.commandId = execution.commandId
    this.result = execution.result
    if (this.input) {
      // A cancelled driver can publish idle before starting the command's queued input.
      void this.agent.whenIdle().then(() => {
        if (this.closed) return
        this.inputIdle = true
        this.check()
      })
    }
    this.check()
  }

  /** Report withdrawal of the optional provider needed by an active goal query. */
  goalUnavailable(): void {
    if (this.goalId !== undefined) this.finish('error', 'The goal service was unloaded before the goal finished.')
  }

  /** Release all listeners when the request fails or the server shuts down. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.commandId !== undefined) this.claimed.delete(this.commandId)
    for (const dispose of this.disposers.splice(0)) dispose()
    this.onClose(this)
  }

  /** The innermost enclosing command interval owned by any SDK query activity on this Session. */
  private innermostClaimed(): CommandExecution['commandId'] | undefined {
    for (let i = this.openRuns.length - 1; i >= 0; i--) {
      const id = this.openRuns[i]
      if (id !== undefined && this.claimed.has(id)) return id
    }
    return undefined
  }

  private check(): void {
    if (this.closed || this.result === undefined) return
    const result = this.result
    if (result.kind === 'error') {
      this.finish('error', result.text)
      return
    }
    if (this.input && !this.inputIdle) return
    if (this.goalId !== undefined) {
      const outcome = this.goalOutcome ?? (this.goalStopped ? 'error' : undefined)
      if (outcome === undefined || this.agent.status !== 'idle') return
      const reason = outcome === 'completed' ? this.turnReason : outcome
      const failure = this.goalOutcome === undefined ? 'Goal execution stopped before reaching a terminal state.' : ''
      this.finish(reason, this.response || failure)
      return
    }
    if (this.input) {
      this.finish(this.turnReason, this.response ?? '')
      return
    }
    this.finish('completed', result.text ?? '')
  }

  private finish(finishReason: string, finalResponse: string): void {
    if (this.closed) return
    try {
      if (this.commandId !== undefined) this.transport.notify('session.query.completed', {
        sessionId: this.agent.session.id, commandId: this.commandId, finishReason, finalResponse,
      })
    } finally {
      this.close()
    }
  }
}
