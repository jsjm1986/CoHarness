/** Root-owned desktop leases held across driver calls and released only after workflow quiescence. */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ComputerUseAuthorization, DesktopConfirmationController } from '@deepseek-ai/dsh-computer-use'

const grant = z.object({ status: z.enum(['granted', 'held']), grantId: z.string().min(1),
  fencing: z.number().int().positive(), grantTtlMs: z.number().int().min(3) })
const admission = z.union([grant, z.object({ status: z.literal('queued'), queueId: z.string().min(1), position: z.number().int().positive() })])
const heartbeat = z.object({ status: z.enum(['held', 'stopping', 'lost']) })
type Grant = z.infer<typeof grant>

/** Lease loss applies to the shared resource even when the caller changes. */
class DesktopLeaseLostError extends Error {}

/** Deployment-owned transport and live ownership, independent of browser request assertions. */
export interface DesktopExecutionHost {
  /** Capture caller execution, or the root projection after its driver call ends. */
  bind?(agent: Agent, source: 'caller' | 'root'): <T>(operation: () => Promise<T>) => Promise<T>
  /** Resolve the actual root; a historical Session parent is insufficient. */
  root(agent: Agent): Agent
  /** Recheck qualification, confirmation and runtime liveness for the exact caller. */
  authorize(agent: Agent, signal: AbortSignal): Promise<void>
  /** Send a server-authenticated operation for this live caller or retained cleanup root. */
  request(agent: Agent, action: string, body: object, signal: AbortSignal): Promise<unknown>
  /** Whether the complete live root, descendants and owned jobs have settled. */
  idle(root: Agent): boolean
}

interface Workflow {
  root: Agent
  actor: Agent
  binding: <T>(operation: () => Promise<T>) => Promise<T>
  actorGeneration: number
  requestId: string
  controller: AbortController
  watch: AbortController
  tail: Promise<void>
  monitor: Promise<void>
  grant?: Grant
  pending: number
  insideDriver: boolean
  uncertain: boolean
  requested: boolean
  closing?: Promise<void>
}

/** One deployment desktop; actions in one root are serialized while the whole workflow owns its lease. */
export class GatewayDesktopPolicy implements ComputerUseAuthorization {
  private readonly workflows = new Map<Agent, Workflow>()
  private stopped = false

  constructor(
    private readonly host: DesktopExecutionHost,
    private readonly pollMs: number,
    private readonly cleanupMs: number,
    readonly confirmation?: DesktopConfirmationController,
  ) {}

  /**
   * Admit the exact caller, then execute under root ownership and live lease renewal.
   * @param execution - original tool caller and cancellation.
   * @param operation - actual native or MCP effect.
   * @returns the result only if cancellation and current authority still permit delivery.
   */
  async run<T>(execution: ToolExecution, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopped || execution.agent === undefined) throw new Error('Desktop execution policy is unavailable.')
    execution.signal.throwIfAborted()
    const actor = execution.agent, root = this.host.root(actor)
    const binding = this.bind(actor, 'caller')
    let workflow = this.workflows.get(root)
    if (workflow?.closing !== undefined) {
      await workflow.closing
      return binding(() => this.run(execution, operation))
    }
    if (workflow === undefined) {
      workflow = { root, actor, binding, actorGeneration: 0, requestId: randomUUID(),
        controller: new AbortController(), watch: new AbortController(),
        tail: Promise.resolve(), monitor: Promise.resolve(), pending: 0, insideDriver: false, uncertain: false, requested: false }
      this.workflows.set(root, workflow)
    }
    const current = workflow
    current.pending++
    const work = current.tail.then(async () => {
      const signal = AbortSignal.any([execution.signal, current.controller.signal])
      signal.throwIfAborted()
      current.actor = actor
      current.binding = binding
      current.actorGeneration++
      await binding(() => this.host.authorize(actor, signal))
      if (this.host.root(actor) !== root) throw new Error('Desktop runtime ownership changed.')
      if (current.grant === undefined) await this.acquire(current, signal)
      await binding(() => this.checkLease(current, actor, signal))
      signal.throwIfAborted()
      if (this.host.root(actor) !== root) throw new Error('Desktop runtime ownership changed.')
      current.insideDriver = true
      try {
        const result = await operation(signal)
        signal.throwIfAborted()
        await binding(() => this.host.authorize(actor, signal))
        await binding(() => this.checkLease(current, actor, signal))
        signal.throwIfAborted()
        return result
      } catch (error) {
        current.uncertain = true
        current.controller.abort(error)
        throw error
      } finally {
        current.insideDriver = false
        current.actor = root
        current.binding = this.bind(root, 'root')
        current.actorGeneration++
      }
    }).catch((error: unknown) => { current.controller.abort(error); throw error })
    current.tail = work.then(() => undefined, () => undefined)
    try { return await work } finally {
      current.pending--
      if (current.pending === 0 && (current.controller.signal.aborted || this.host.idle(root))) await this.close(current)
    }
  }

  /**
   * Release an idle root after every driver call and owned job has settled.
   * @param root - exact root from the live registry, or its disposal event.
   */
  async settled(root: Agent): Promise<void> {
    const workflow = this.workflows.get(root)
    if (workflow !== undefined && workflow.pending === 0 && this.host.idle(root)) await this.close(workflow)
  }

  /**
   * Stop new calls, cancel admitted work and await every owned cleanup operation.
   * Unknown driver drainage remains stopping at the coordinator.
   */
  async dispose(): Promise<void> {
    this.stopped = true
    const workflows = [...this.workflows.values()]
    for (const workflow of workflows) workflow.controller.abort(new Error('Desktop execution policy stopped.'))
    await Promise.all(workflows.map(async (workflow) => { await workflow.tail; await this.close(workflow) }))
  }

  private bind(agent: Agent, source: 'caller' | 'root'): <T>(operation: () => Promise<T>) => Promise<T> {
    return this.host.bind?.(agent, source) ?? (operation => operation())
  }

  private async acquire(workflow: Workflow, signal: AbortSignal): Promise<void> {
    workflow.requested = true
    let response = admission.parse(await workflow.binding(() => this.host.request(workflow.actor, 'acquire', { requestId: workflow.requestId }, signal)))
    while (response.status === 'queued') {
      await delay(this.pollMs, undefined, { signal })
      await workflow.binding(() => this.host.authorize(workflow.actor, signal))
      response = admission.parse(await workflow.binding(() => this.host.request(workflow.actor, 'status', { requestId: workflow.requestId }, signal)))
    }
    workflow.grant = response
    workflow.monitor = this.renew(workflow)
  }

  private async renew(workflow: Workflow): Promise<void> {
    const held = workflow.grant
    /* v8 ignore next -- acquire() assigns workflow.grant synchronously before starting this monitor. */
    if (held === undefined) throw new Error('Desktop lease is not held.')
    const interval = Math.min(this.pollMs, Math.floor(held.grantTtlMs / 3))
    const signal = AbortSignal.any([workflow.controller.signal, workflow.watch.signal])
    try {
      while (!signal.aborted) {
        await delay(interval, undefined, { signal })
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(interval)])
        const generation = workflow.actorGeneration, actor = workflow.actor, binding = workflow.binding
        try {
          await binding(() => this.host.authorize(actor, deadline))
          if (generation !== workflow.actorGeneration) continue
          await binding(() => this.checkLease(workflow, actor, deadline))
        } catch (error) {
          if (generation !== workflow.actorGeneration && !(error instanceof DesktopLeaseLostError)) continue
          throw error
        }
      }
    } catch (error) {
      if (workflow.watch.signal.aborted) return
      if (workflow.insideDriver) workflow.uncertain = true
      workflow.controller.abort(error)
    }
  }

  private async checkLease(workflow: Workflow, actor: Agent, signal: AbortSignal): Promise<void> {
    const grantId = workflow.grant?.grantId
    /* v8 ignore next -- run() and renew() invoke this only while workflow.grant is assigned. */
    if (grantId === undefined) throw new Error('Desktop lease is not held.')
    const result = heartbeat.parse(await this.host.request(actor, 'heartbeat', { grantId }, signal))
    signal.throwIfAborted()
    if (result.status !== 'held') throw new DesktopLeaseLostError('Desktop lease is stopping or lost.')
  }

  private close(workflow: Workflow): Promise<void> {
    return workflow.closing ??= (async () => {
      workflow.watch.abort()
      await workflow.monitor
      await workflow.tail
      const signal = AbortSignal.timeout(this.cleanupMs)
      try {
        if (workflow.grant === undefined) {
          if (workflow.requested) await this.host.request(workflow.root, 'cancel', { requestId: workflow.requestId }, signal)
        } else {
          await this.host.request(workflow.root, workflow.uncertain ? 'stop' : 'release', { grantId: workflow.grant.grantId }, signal)
        }
      } finally {
        this.workflows.delete(workflow.root)
      }
    })()
  }
}
