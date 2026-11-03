import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorkflowEngineDefault, {
  isFatalWorkflowError,
  WorkflowError,
  WorkflowRunId,
  WorkflowEngine,
} from '../src/index.ts'
import type { WorkflowRun, WorkflowRunInfo, WorkflowStartRequest } from '../src/index.ts'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

/** A minimal concrete subclass exposing the protected emit helper for tests. */
class StubEngine extends WorkflowEngine {
  start(request: WorkflowStartRequest): WorkflowRun {
    void request
    throw new Error('not under test')
  }

  emit(name: Parameters<WorkflowEngine['emitWorkflowEvent']>[0], ...args: unknown[]): void {
    this.emitWorkflowEvent(name, ...args)
  }
}

const INFO: WorkflowRunInfo = { id: WorkflowRunId('run-1'), meta: { name: 'w', description: 'd' } }

describe('dsh-workflow (interface)', () => {
  it('retains the exact foreground parent until withdrawal joins cleanup', async () => {
    const ctx = new Context(), scope = ctx.plugin(StubEngine)
    await scope.await()
    const engine = ctx.workflowEngine
    const parent = { id: SessionId('foreground-parent') } as Agent
    const replacement = { ...parent } as Agent
    const entered = Promise.withResolvers<AbortSignal>(), released = Promise.withResolvers<undefined>()
    const pending = engine.withForeground(parent, new AbortController().signal, async (signal) => {
      entered.resolve(signal)
      await released.promise
      return 'cleaned'
    })
    const signal = await entered.promise
    const withdrawing = scope.dispose()
    try {
      await vi.waitFor(() => { expect(signal.aborted).toBe(true) })
      expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBe('busy')
      expect(ctx.bail(agentCarrier(replacement), 'agent/idle-release-check', { agent: replacement })).toBeUndefined()
      const refused = vi.fn(async () => 'unstarted')
      await expect(engine.withForeground(parent, new AbortController().signal, refused)).rejects.toThrow('being withdrawn')
      expect(refused).not.toHaveBeenCalled()
      released.resolve(undefined)
      expect(await pending).toBe('cleaned')
      await withdrawing
      expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBeUndefined()
    } finally {
      released.resolve(undefined)
      await pending
      await withdrawing
      await ctx.fiber.dispose()
    }
  })

  it('rejects cancelled admission and releases failed Consumers without closing the engine', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const engine = ctx.workflowEngine, parent = { id: SessionId('foreground-parent') } as Agent
    const caller = new AbortController(), refused = vi.fn(async () => 'unstarted')
    const failure = new Error('caller cancelled')
    try {
      caller.abort(failure)
      await expect(engine.withForeground(parent, caller.signal, refused)).rejects.toBe(failure)
      expect(refused).not.toHaveBeenCalled()
      await expect(engine.withForeground(parent, new AbortController().signal, () => Promise.reject(failure))).rejects.toBe(failure)
      expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBeUndefined()
      await expect(engine.withForeground(parent, new AbortController().signal, async () => 'next')).resolves.toBe('next')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('WorkflowRunId brands a string (identity at runtime)', () => {
    expect(WorkflowRunId('abc')).toBe('abc')
  })

  it('WorkflowError carries code + fatal (default true) and reads as a HarnessError', () => {
    const error = new WorkflowError('cap hit', 'AGENT_CAP')
    expect(error.code).toBe('AGENT_CAP')
    expect(error.fatal).toBe(true)
    expect(error.name).toBe('WorkflowError')
    const soft = new WorkflowError('advisory', 'ITEM_CAP', { fatal: false })
    expect(soft.fatal).toBe(false)
  })

  it('isFatalWorkflowError: true only for a fatal WorkflowError', () => {
    expect(isFatalWorkflowError(new WorkflowError('x', 'CANCELLED'))).toBe(true)
    expect(isFatalWorkflowError(new WorkflowError('x', 'CANCELLED', { fatal: false }))).toBe(false)
    expect(isFatalWorkflowError(new Error('plain'))).toBe(false)
    expect(isFatalWorkflowError('string')).toBe(false)
  })

  it('registers as ctx.workflowEngine and unregisters when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubEngine)
    expect(ctx.get('workflowEngine')).toBeInstanceOf(StubEngine)
    await fiber.dispose()
    expect(ctx.get('workflowEngine')).toBeUndefined()
  })

  it('emitWorkflowEvent dispatches to every listener with the payload tuple', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const seen: unknown[][] = []
    ctx.on('workflow/log', (info, message) => { seen.push([info, message]) })
    ctx.on('workflow/agent-start', (info, agent) => { seen.push([info, agent]) })
    const engine = ctx.workflowEngine as StubEngine
    engine.emit('workflow/start', INFO)
    engine.emit('workflow/log', INFO, 'hello')
    engine.emit('workflow/agent-start', INFO, { seq: 1, label: 'l', childId: 'c' })
    engine.emit('workflow/agent-end', INFO, { seq: 1, label: 'l', childId: 'c', outcome: 'completed' })
    engine.emit('workflow/end', INFO, { stopReason: 'completed', agentsStarted: 1 })
    expect(seen).toEqual([
      [INFO, 'hello'],
      [INFO, { seq: 1, label: 'l', childId: 'c' }],
    ])
  })

  it('contains an asynchronously rejected listener without starving peers', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const seen: string[] = []
    // Runtime listeners may return thenables even though the declaration's observable result is void.
    // oxlint-disable-next-line typescript/no-misused-promises -- exercises rejected-listener containment
    ctx.on('workflow/agent-start', async () => { throw new Error('async observer failed') })
    ctx.on('workflow/agent-start', (_info, agent) => { seen.push(agent.label) })
    const engine = ctx.workflowEngine as StubEngine
    const payload = { seq: 1, label: 'original', childId: 'c' }
    engine.emit('workflow/start', INFO)
    engine.emit('workflow/agent-start', INFO, payload)
    await Promise.resolve()
    engine.emit('workflow/agent-end', INFO, { ...payload, outcome: 'completed' })
    engine.emit('workflow/end', INFO, { stopReason: 'completed', agentsStarted: 1 })
    expect(seen).toEqual(['original'])
    expect(String(warn.mock.calls[0]![0])).toContain('listener rejected')
  })

  it('contains a throwing listener PER LISTENER: later listeners still run, nothing propagates', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const reached: string[] = []
    ctx.on('workflow/phase', () => { throw new Error('bad listener') })
    ctx.on('workflow/phase', (_info, title) => { reached.push(title) })
    const engine = ctx.workflowEngine as StubEngine
    engine.emit('workflow/start', INFO)
    expect(() => { engine.emit('workflow/phase', INFO, 'Scan') }).not.toThrow()
    engine.emit('workflow/end', INFO, { stopReason: 'completed', agentsStarted: 0 })
    expect(reached).toEqual(['Scan'])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('workflow/phase listener threw')
  })

  it('containment is total: a listener throwing a value whose coercion throws neither propagates nor starves later listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(StubEngine)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => ctx.logger)
    const reached: string[] = []
    ctx.on('workflow/phase', () => {
      throw { toString: () => { throw new Error('coercion trap') } }
    })
    ctx.on('workflow/phase', (_info, title) => { reached.push(title) })
    const engine = ctx.workflowEngine as StubEngine
    engine.emit('workflow/start', INFO)
    expect(() => { engine.emit('workflow/phase', INFO, 'Scan') }).not.toThrow()
    engine.emit('workflow/end', INFO, { stopReason: 'completed', agentsStarted: 0 })
    expect(reached).toEqual(['Scan'])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('[unrenderable thrown value]')
  })

  it('has the expected exports (default = the abstract service class)', () => {
    expect(WorkflowEngineDefault).toBe(WorkflowEngine)
  })
})
