import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { WorkflowRunId, WorkflowEngine } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowResult, WorkflowRun,
  WorkflowRunId as WorkflowRunIdType, WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import AgentRegistry, { agentCarrier } from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import PtcWorkflowEngine from '@deepseek-ai/dsh-workflow-ptc'
import { mountWorkflowRuntime } from '../../workflow-ptc/tests/setup.ts'
import * as toolWorkflow from '../src/index.ts'
import type {} from '../src/types.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const testToolSignal = new AbortController().signal

/** A controllable engine standing in behind ctx.workflowEngine (the tool's only seam). */
class StubEngine extends WorkflowEngine {
  requests: WorkflowStartRequest[] = []
  cancels: string[] = []
  disposed = 0
  disposeBarrier: Promise<void> | undefined
  disposeError: unknown
  readonly retainedCompletion = Promise.withResolvers<undefined>()
  settle!: (result: WorkflowResult) => void
  readonly settlements = new Map<WorkflowRunIdType, (result: WorkflowResult) => void>()
  startError: Error | undefined
  onStart: (() => void) | undefined

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startError) throw this.startError
    this.requests.push(request)
    const id = WorkflowRunId(`run-${this.requests.length}`)
    const result = new Promise<WorkflowResult>((resolve) => { this.settle = resolve })
    this.settlements.set(id, this.settle)
    this.onStart?.()
    request.signal?.addEventListener('abort', () => {
      this.settle({ value: null, stopReason: 'cancelled', error: 'signal', agentsStarted: 0 })
    }, { once: true })
    return {
      id,
      meta: request.meta,
      result,
      retainFailedCleanup: () => this.retainedCompletion.promise,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settle({ value: null, stopReason: 'cancelled', ...reason !== undefined ? { error: reason } : {}, agentsStarted: 0 })
      },
      dispose: async () => {
        this.disposed += 1
        await this.disposeBarrier
        this.settlements.delete(id)
        if (this.disposeError) throw this.disposeError
      },
    }
  }

  settleRun(id: WorkflowRunIdType, result: WorkflowResult): void {
    const settle = this.settlements.get(id)
    if (settle === undefined) throw new Error(`unknown stub workflow ${id}`)
    settle(result)
  }

  agentStart(id: WorkflowRunIdType, agent: WorkflowAgentInfo): void {
    this.emitWorkflowEvent('workflow/agent-start', {
      id,
      meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, agent)
  }

  agentEnd(id: WorkflowRunIdType, agent: WorkflowAgentEndInfo): void {
    this.emitWorkflowEvent('workflow/agent-end', {
      id,
      meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, agent)
  }

  phase(id: WorkflowRunIdType, title: string): void {
    this.emitWorkflowEvent('workflow/phase', {
      id,
      meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, title)
  }

  logLine(id: WorkflowRunIdType, message: string): void {
    this.emitWorkflowEvent('workflow/log', {
      id,
      meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, message)
  }
}

async function setup(config?: { toolName?: string; maxResultChars?: number }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const engineScope = ctx.plugin(StubEngine)
  await engineScope.await()
  const toolScope = ctx.plugin(toolWorkflow, config ?? {})
  await toolScope.await()
  const engine = ctx.workflowEngine as StubEngine
  const session = Session.create(SessionId('caller'))
  const parent = { id: session.id, options: {}, session, ctx: ctx.plugin(() => {}).ctx } as unknown as Agent
  return { ctx, engine, parent, session, toolScope, engineScope }
}

const SCRIPT = 'return 1'
const META = { name: 'audit', description: 'd' }

function execute(ctx: Context, args: unknown, extra?: {
  agent?: Agent
  signal?: AbortSignal
  parent?: ToolExecutionToken
}): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId('call-1'),
    name: 'workflow',
    arguments: args,
    ...extra?.agent ? { agent: extra.agent } : {},
    ...extra?.signal ? { signal: extra.signal } : {},
    ...extra?.parent ? { parent: extra.parent } : {},
  })
}

describe('dsh-tool-workflow', () => {
  it('joins foreground cancellation and cleanup when its engine withdraws', async () => {
    const { ctx, engine, parent, engineScope } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    try {
      await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
      await engineScope.dispose()
      expect(engine.cancels).toEqual(['parent step aborted'])
      expect(engine.disposed).toBe(1)
      expect((await pending).isError).toBe(true)
    } finally {
      engine.settle({ value: null, stopReason: 'completed', agentsStarted: 0 })
      await pending
      await ctx.fiber.dispose()
    }
  })

  it('bridges cancellation arriving while the workflow is starting', async () => {
    const { ctx, engine, parent } = await setup()
    const caller = new AbortController()
    engine.onStart = () => { caller.abort('startup cancelled') }
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent, signal: caller.signal })
    try {
      await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
      expect(engine.requests[0]!.signal?.aborted).toBe(true)
      expect(engine.requests[0]!.signal?.reason).toBe('startup cancelled')
      expect(engine.cancels).toEqual(['parent step aborted'])
      expect((await pending).isError).toBe(true)
    } finally {
      engine.settle({ value: null, stopReason: 'completed', agentsStarted: 0 })
      await pending
      await ctx.fiber.dispose()
    }
  })

  it.each(['running', 'recovering'] as const)('retains %s durable records after the tool plugin withdraws', async (phase) => {
    const { ctx, engine, parent, session, toolScope } = await setup()
    const append = vi.spyOn(session, 'append')
    const runId = WorkflowRunId('run-1')
    let pending: Promise<ToolExecutionResult> | undefined
    try {
      if (phase === 'recovering') engine.disposeError = new Error('cleanup still owned')
      pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
      await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
      engine.agentStart(runId, { seq: 1, label: 'child', childId: SessionId('child') })
      if (phase === 'recovering') {
        engine.settle({ value: null, stopReason: 'completed', agentsStarted: 1 })
        expect((await pending).isError).toBe(true)
      }
      await toolScope.dispose()
      expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBe('busy')
      expect(ctx.bail(agentCarrier({ ...parent }), 'agent/idle-release-check', { agent: { ...parent } })).toBeUndefined()
      engine.agentEnd(runId, { seq: 1, label: 'child', childId: SessionId('child'), outcome: 'completed' })
      if (phase === 'running') engine.settle({ value: null, stopReason: 'completed', agentsStarted: 1 })
      else engine.retainedCompletion.resolve(undefined)
      await pending
      await vi.waitFor(() => {
        expect(append.mock.calls.map(call => call[0]).filter(type => type.startsWith('tool-workflow/')))
          .toEqual(['tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end'])
      })
      expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBeUndefined()
    } finally {
      engine.retainedCompletion.resolve(undefined)
      engine.settlements.get(runId)?.({ value: null, stopReason: 'completed', agentsStarted: 1 })
      await pending
      await ctx.fiber.dispose()
    }
  })

  it('retains the exact parent until recovered cleanup writes its durable ending', async () => {
    const { ctx, engine, parent, session } = await setup()
    try {
      engine.disposeError = new Error('cleanup remains unconfirmed')
      const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
      await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
      engine.settle({ value: null, stopReason: 'completed', agentsStarted: 0 })
      expect((await pending).isError).toBe(true)
      expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBe('busy')
      const replacement = { ...parent } as Agent
      expect(ctx.bail(agentCarrier(replacement), 'agent/idle-release-check', { agent: replacement })).toBeUndefined()
      expect(session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-end')).toHaveLength(0)
      engine.retainedCompletion.resolve(undefined)
      await vi.waitFor(() => {
        expect(session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-end')).toHaveLength(1)
      })
      expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBeUndefined()
    } finally {
      engine.retainedCompletion.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('drops only the original record when its parent scope ends', async () => {
    const { ctx, engine, parent, session } = await setup()
    const append = vi.spyOn(session, 'append')
    let pending: Promise<ToolExecutionResult> | undefined
    try {
      pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
      await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
      await parent.ctx.fiber.dispose()
      engine.agentStart(WorkflowRunId('run-1'), { seq: 1, label: 'late child', childId: SessionId('late-child') })
      engine.settle({ value: null, stopReason: 'completed', agentsStarted: 1 })
      await pending
      expect(append.mock.calls.map(call => call[0]).filter(type => type.startsWith('tool-workflow/')))
        .toEqual(['tool-workflow/run-start'])
      expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBeUndefined()
    } finally {
      engine.settlements.get(WorkflowRunId('run-1'))?.({ value: null, stopReason: 'completed', agentsStarted: 1 })
      await pending
      await ctx.fiber.dispose()
    }
  })

  it.each(['top-level', 'nested'] as const)('contains retained confirmation rejection for a %s call', async (kind) => {
    const { ctx, engine, parent, session, toolScope } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const append = vi.spyOn(session, 'append')
    const failure = new Error('retained confirmation unavailable')
    let pending: Promise<ToolExecutionResult> | undefined
    try {
      engine.disposeError = new Error('initial cleanup unconfirmed')
      pending = execute(ctx, { script: SCRIPT, meta: META }, {
        agent: parent, ...kind === 'nested' ? { parent: Symbol('outer') as ToolExecutionToken } : {},
      })
      await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
      engine.settle({ value: null, stopReason: 'completed', agentsStarted: 0 })
      expect((await pending).isError).toBe(true)
      await toolScope.dispose()
      engine.retainedCompletion.reject(failure)
      await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('retained confirmation unavailable')) })
      engine.agentStart(WorkflowRunId('run-1'), { seq: 1, label: 'late', childId: SessionId('late') })
      expect(append.mock.calls.map(call => call[0]).filter(type => type.startsWith('tool-workflow/')))
        .toEqual(kind === 'nested' ? [] : ['tool-workflow/run-start'])
      expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBeUndefined()
    } finally {
      engine.retainedCompletion.resolve(undefined)
      engine.settlements.get(WorkflowRunId('run-1'))?.({ value: null, stopReason: 'completed', agentsStarted: 0 })
      await pending
      warn.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('starts a run with the script/args/parent/signal and renders the completed value', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    const pending = execute(ctx, { script: SCRIPT, meta: META, args: { files: ['a.ts'] } }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    expect(engine.requests[0]).toMatchObject({ script: SCRIPT, meta: META, args: { files: ['a.ts'] } })
    expect(engine.requests[0]!.parent).toBe(parent)
    expect(engine.requests[0]!.signal).not.toBe(controller.signal)
    expect(engine.requests[0]!.signal?.aborted).toBe(false)
    engine.settle({ value: { findings: [1, 2] }, stopReason: 'completed', agentsStarted: 7 })
    const result = await pending
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected workflow success')
    expect(result.value).toEqual({ kind: 'foreground', runId: 'run-1', agentsStarted: 7, result: { findings: [1, 2] } })
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered).toContain('workflow "audit" completed (7 agents)')
    expect(rendered).toContain('"findings"')
    expect(engine.disposed).toBe(1)
  })

  it('records one top-level run and its members in the calling Session after cleanup', async () => {
    const { ctx, engine, parent, session } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    const runId = WorkflowRunId('run-1')
    engine.agentStart(runId, {
      seq: 1,
      label: '',
      phase: '',
      childId: SessionId('child-1'),
    })
    engine.agentEnd(runId, {
      seq: 1,
      label: '',
      phase: '',
      childId: SessionId('child-1'),
      outcome: 'completed',
    })
    engine.settleRun(runId, { value: 1, stopReason: 'completed', agentsStarted: 1 })
    expect((await pending).isError).toBe(false)
    expect(engine.disposed).toBe(1)
    expect(session.snapshotEvents().map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/run-start', { runId: 'run-1', name: 'audit' }],
      ['tool-workflow/agent-start', {
        runId: 'run-1', seq: 1, label: '', phase: '', childId: 'child-1',
      }],
      ['tool-workflow/agent-end', { runId: 'run-1', seq: 1, outcome: 'completed' }],
      ['tool-workflow/run-end', { runId: 'run-1', stopReason: 'completed' }],
    ])
  })

  it('writes run-end only after run disposal reaches quiescence', async () => {
    const { ctx, engine, parent, session } = await setup()
    const barrier = Promise.withResolvers<undefined>()
    engine.disposeBarrier = barrier.promise
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settleRun(WorkflowRunId('run-1'), {
      value: null, stopReason: 'completed', agentsStarted: 0,
    })
    await vi.waitFor(() => { expect(engine.disposed).toBe(1) })
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['tool-workflow/run-start'])
    barrier.resolve(undefined)
    expect((await pending).isError).toBe(false)
    expect(session.snapshotEvents().map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/run-end',
    ])
  })

  it('records zero-member and concurrent runs independently', async () => {
    const { ctx, engine, parent, session } = await setup()
    const first = execute(ctx, { script: SCRIPT, meta: { ...META, name: 'first' } }, { agent: parent })
    const second = execute(ctx, { script: SCRIPT, meta: { ...META, name: 'second' } }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(2) })
    const secondId = WorkflowRunId('run-2')
    engine.agentStart(secondId, {
      seq: 1, label: 'member', childId: SessionId('child-2'),
    })
    engine.agentEnd(secondId, {
      seq: 1, label: 'member', childId: SessionId('child-2'), outcome: 'failed',
    })
    engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'completed', agentsStarted: 0 })
    engine.settleRun(secondId, { value: null, stopReason: 'error', error: 'child failed', agentsStarted: 1 })
    expect((await first).isError).toBe(false)
    expect((await second).isError).toBe(true)
    expect(session.snapshotEvents().filter(event => event.type === 'tool-workflow/agent-start'))
      .toHaveLength(1)
    expect(session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-end').map(event => event.data))
      .toEqual([
        { runId: 'run-1', stopReason: 'completed' },
        { runId: 'run-2', stopReason: 'error' },
      ])
  })

  it('does not record nested transport executions', async () => {
    const { ctx, engine, parent, session } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, {
      agent: parent,
      parent: Symbol('outer') as ToolExecutionToken,
    })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'completed', agentsStarted: 0 })
    expect((await pending).isError).toBe(false)
    expect(session.snapshotEvents()).toEqual([])
  })

  it.each([
    'tool-workflow/run-start',
    'tool-workflow/agent-start',
    'tool-workflow/agent-end',
    'tool-workflow/run-end',
  ] as const)('isolates a first append failure at %s and preserves a valid prefix', async (failedType) => {
    const { ctx, engine, parent, session } = await setup()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const append = session.append.bind(session)
    session.append = ((type: Parameters<Session['append']>[0], data: never) => {
      if (type === failedType) throw new Error(`injected ${failedType} failure`)
      return append(type, data)
    }) as Session['append']

    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    const runId = WorkflowRunId('run-1')
    engine.agentStart(runId, {
      seq: 1, label: 'member', childId: SessionId('child-1'),
    })
    engine.agentEnd(runId, {
      seq: 1, label: 'member', childId: SessionId('child-1'), outcome: 'completed',
    })
    engine.settleRun(runId, { value: null, stopReason: 'completed', agentsStarted: 1 })
    expect((await pending).isError).toBe(false)
    expect(engine.disposed).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(failedType)
    const types = session.snapshotEvents().map(event => event.type)
    const expectedPrefixes = {
      'tool-workflow/run-start': [],
      'tool-workflow/agent-start': ['tool-workflow/run-start'],
      'tool-workflow/agent-end': ['tool-workflow/run-start', 'tool-workflow/agent-start'],
      'tool-workflow/run-end': [
        'tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end',
      ],
    } as const
    expect(types).toEqual(expectedPrefixes[failedType])
  })

  it('contains an append failure whose thrown value cannot be rendered', async () => {
    const { ctx, engine, parent, session } = await setup()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    session.append = () => {
      throw { toString: () => { throw new Error('coercion trap') } }
    }
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settleRun(WorkflowRunId('run-1'), {
      value: null, stopReason: 'completed', agentsStarted: 0,
    })
    expect((await pending).isError).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[unrenderable thrown value]')
  })

  it('maps a non-completed stop reason to an isError result (and still disposes)', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'error', error: 'script threw: boom', agentsStarted: 2 })
    const result = await pending
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('workflow run failed: script threw: boom')
    expect(engine.disposed).toBe(1)
  })

  it('reports a cancelled run distinctly (with and without a reason)', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'cancelled', error: 'user', agentsStarted: 0 })
    const result = await pending
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('workflow run was cancelled (user)')

    const bare = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(2) })
    engine.settle({ value: null, stopReason: 'cancelled', agentsStarted: 0 })
    expect(((await bare).content[0] as { text: string }).text.trim().endsWith('cancelled')).toBe(true)
  })

  it('an error result without a message renders the unknown-error fallback', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'error', agentsStarted: 0 })
    expect(((await pending).content[0] as { text: string }).text).toContain('unknown error')
  })

  it('cancels the run when exec.signal aborts MID-FLIGHT (the abort bridge)', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(engine.cancels).toContain('parent step aborted')
    expect(engine.disposed).toBe(1)
  })

  it('a synchronous engine start throw (meta/parse failure) becomes an isError result', async () => {
    const { ctx, engine, parent } = await setup()
    engine.startError = new Error('invalid meta: meta.name must be a non-empty string')
    const result = await execute(ctx, { script: 'nope', meta: { name: '', description: 'd' } }, { agent: parent })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('meta.name must be a non-empty string')
  })

  it('requires a calling agent (fails loud without exec.agent)', async () => {
    const { ctx, engine } = await setup()
    const result = await execute(ctx, { script: SCRIPT, meta: META })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('requires a calling agent')
    expect(engine.requests.length).toBe(0)
  })

  it('validates its own arguments via the schema DSL (missing script)', async () => {
    const { ctx, parent } = await setup()
    const result = await execute(ctx, {}, { agent: parent })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
  })

  it('skips workflow startup when exec.signal is already aborted', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    controller.abort()
    const result = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent, signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    })
    expect(engine.requests).toHaveLength(0)
    expect(engine.cancels).toHaveLength(0)
    expect(engine.disposed).toBe(0)
  })

  it('truncates an oversized rendered value with a notice (maxResultChars)', async () => {
    const { ctx, engine, parent } = await setup({ maxResultChars: 40 })
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: { blob: 'x'.repeat(500) }, stopReason: 'completed', agentsStarted: 1 })
    const result = await pending
    if (result.isError) throw new Error('expected workflow success')
    expect(result.value).toEqual({ kind: 'foreground', runId: 'run-1', agentsStarted: 1, result: { blob: 'x'.repeat(500) } })
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered).toContain('[truncated:')
    expect(rendered.length).toBeLessThan(400)
  })

  it('registers under a configured toolName and unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubEngine)
    const fiber = await ctx.plugin(toolWorkflow, { toolName: 'orchestrate' })
    expect(ctx.tools.get('orchestrate')).toBeDefined()
    expect(ctx.tools.get('workflow')).toBeUndefined()
    // The usage-policy prompt section rides the same registration: present
    // under the CONFIGURED name (its guidance names the tool it describes)…
    const sections = (await ctx.systemPrompt.assemble()).sections
    const section = sections.find(s => s.name === 'tool:orchestrate')
    expect(section?.text).toContain('orchestrate')
    expect(sections.some(s => s.name === 'tool:workflow')).toBe(false)
    ctx.systemPrompt.section({ name: 'tool:cordis-order-probe', order: 115.5, text: 'Cordis' })
    expect((await ctx.systemPrompt.assemble()).sections
      .filter(s => s.name === 'tool:cordis-order-probe' || s.name === 'tool:orchestrate')
      .map(s => s.name)).toEqual(['tool:cordis-order-probe', 'tool:orchestrate'])
    await fiber.dispose()
    expect(ctx.tools.get('orchestrate')).toBeUndefined()
    // …and gone with the fiber — a reload must not leak a stale section.
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'tool:orchestrate')).toBe(false)
  })

  it('presents a generic pending card titled by the meta name, with the script as rawInput', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('workflow')!
    const view = tool.presentCall!({ script: SCRIPT, meta: META })
    expect(view).toMatchObject({ card: 'generic', title: 'workflow: audit', rawInput: SCRIPT })
  })

  it('presentResult keeps the generic card; presentation is pure and replay-safe on malformed args', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('workflow')!
    expect(tool.presentResult!({ script: SCRIPT, meta: META }, { content: [], isError: false })).toEqual({ card: 'generic' })
    // defineTool soft-validates presentation args: a malformed logged shape
    // (wrong fields entirely, or a call missing its meta) falls back to
    // undefined instead of throwing mid-replay.
    expect(tool.presentCall!({ not: 'the schema' })).toBeUndefined()
    expect(tool.presentCall!({ script: SCRIPT })).toBeUndefined()
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in toolWorkflow).toBe(false)
    expect(toolWorkflow.name).toBe('tool-workflow')
    expect(toolWorkflow.inject).toEqual(['tools', 'workflowEngine', 'systemPrompt'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolWorkflow) as Record<string, unknown>
    expect(unwrapped).toBe(toolWorkflow)
    expect(typeof unwrapped.apply).toBe('function')
  })

  describe('run_in_background', () => {
    /** The stub-engine bench plus a live job registry and a registered owner. */
    async function setupBackground(config?: { enableRunInBackground?: boolean }) {
      const ctx = new Context()
      onTestFinished(async () => { await ctx.fiber.dispose() })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(ToolTasks)
      await ctx.plugin(StubEngine)
      const toolScope = ctx.plugin(toolWorkflow, config ?? {})
      await toolScope.await()
      const engine = ctx.workflowEngine as StubEngine
      const session = Session.create(SessionId('caller'))
      const parent: Agent = {
        id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx: ctx.plugin(() => {}).ctx,
        send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
        runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
      }
      await ctx.agents.register(parent)
      return { ctx, engine, parent, session, toolScope }
    }

    /** The ring's retained text from offset 0, read as the owner. */
    function retained(ctx: Context, jobId: JobId, owner: Agent): string {
      return ctx.jobs.readAt(jobId, 0, owner.id).chunks.map(chunk => chunk.text).join('')
    }

    it('keeps a background durable record after its tool plugin withdraws', async () => {
      const { ctx, engine, parent, session, toolScope } = await setupBackground()
      const append = vi.spyOn(session, 'append')
      const accepted = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      const job = ctx.jobs.list(parent.id)[0]!
      try {
        expect(accepted.isError).toBe(false)
        await toolScope.dispose()
        engine.agentStart(WorkflowRunId('run-1'), { seq: 1, label: 'background child', childId: SessionId('background-child') })
        engine.agentEnd(WorkflowRunId('run-1'), { seq: 1, label: 'background child', childId: SessionId('background-child'), outcome: 'completed' })
        engine.settle({ value: null, stopReason: 'completed', agentsStarted: 1 })
        await ctx.jobs.wait(job.id, 5000, parent.id)
        expect(append.mock.calls.map(call => call[0]).filter(type => type.startsWith('tool-workflow/')))
          .toEqual(['tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end'])
      } finally {
        engine.settlements.get(WorkflowRunId('run-1'))?.({ value: null, stopReason: 'completed', agentsStarted: 1 })
        await ctx.jobs.wait(job.id, 5000, parent.id)
      }
    })

    it('keeps background progress separate across tool replacement', async () => {
      const { ctx, engine, parent, toolScope } = await setupBackground()
      await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      const first = ctx.jobs.list(parent.id)[0]!
      const firstRun = WorkflowRunId('run-1'), secondRun = WorkflowRunId('run-2')
      try {
        await toolScope.dispose()
        await ctx.plugin(toolWorkflow)
        await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
        const second = ctx.jobs.list(parent.id).find(job => job.id !== first.id)!
        engine.phase(firstRun, 'Original phase')
        engine.logLine(firstRun, 'Original log')
        engine.agentStart(firstRun, { seq: 1, label: 'original child', childId: SessionId('original-child') })
        engine.agentEnd(firstRun, { seq: 1, label: 'original child', childId: SessionId('original-child'), outcome: 'completed' })
        engine.phase(secondRun, 'Replacement phase')
        engine.logLine(secondRun, 'Replacement log')
        expect(ctx.jobs.get(first.id, parent.id).progress).toBe('Original phase')
        expect(retained(ctx, first.id, parent)).toBe('▸ Original phase\nOriginal log\nagent #1 original child started\nagent #1 completed\n')
        expect(retained(ctx, second.id, parent)).toBe('▸ Replacement phase\nReplacement log\n')
        engine.settleRun(firstRun, { value: null, stopReason: 'completed', agentsStarted: 1 })
        await ctx.jobs.wait(first.id, 5000, parent.id)
        engine.phase(firstRun, 'Stale original')
        engine.logLine(secondRun, 'Replacement still live')
        expect(retained(ctx, first.id, parent)).not.toContain('Stale original')
        expect(retained(ctx, second.id, parent)).toContain('Replacement still live')
      } finally {
        for (const run of [firstRun, secondRun]) {
          engine.settlements.get(run)?.({ value: null, stopReason: 'completed', agentsStarted: 1 })
        }
        await Promise.all(ctx.jobs.list(parent.id).map(job => ctx.jobs.wait(job.id, 5000, parent.id)))
      }
    })

    it('keeps background progress while its original parent waits for cleanup', async () => {
      const { ctx, engine, parent } = await setupBackground()
      const released = Promise.withResolvers<undefined>()
      engine.disposeBarrier = released.promise
      await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      const job = ctx.jobs.list(parent.id)[0]!
      const disposing = parent.ctx.fiber.dispose()
      try {
        await vi.waitFor(() => { expect(engine.cancels).toHaveLength(1) })
        engine.phase(WorkflowRunId('run-1'), 'Releasing child')
        engine.logLine(WorkflowRunId('run-1'), 'Final cleanup log')
        expect(ctx.jobs.get(job.id, parent.id).progress).toBe('Releasing child')
        expect(retained(ctx, job.id, parent)).toBe('▸ Releasing child\nFinal cleanup log\n')
      } finally {
        released.resolve(undefined)
        await disposing
      }
      expect(engine.cancels).toHaveLength(1)
    })

    it('records background cancellation before its parent scope finishes', async () => {
      const { ctx, engine, parent, session } = await setupBackground()
      const append = vi.spyOn(session, 'append')
      await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      await parent.ctx.fiber.dispose()
      expect(engine.cancels).toHaveLength(1)
      expect(append.mock.calls.map(call => call[0]).filter(type => type.startsWith('tool-workflow/')))
        .toEqual(['tool-workflow/run-start', 'tool-workflow/run-end'])
    })

    it('registers an owned job, mirrors progress into its ring, and settles with the rendered value', async () => {
      const { ctx, engine, parent, session } = await setupBackground()
      const result = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected background acceptance')
      const jobId = (result.value as { jobId: JobId }).jobId
      expect(jobId).toMatch(/^workflow-[0-9a-f]{16}$/)
      expect(result.value).toEqual({ kind: 'background', jobId, runId: 'run-1' })
      expect((result.content[0] as { text: string }).text)
        .toContain(`workflow "audit" started in the background as job ${jobId}`)
      // The engine run carries no tool-step signal: the job owns cancellation.
      expect(engine.requests[0]!.signal).toBeUndefined()

      const jobs = ctx.jobs
      const job = jobs.get(jobId, parent.id)
      expect(job).toMatchObject({ kind: 'workflow', label: 'audit', status: 'running', owner: parent.id })
      expect(job.output.total).toBe(0)

      const runId = WorkflowRunId('run-1')
      engine.phase(runId, 'Scan')
      engine.logLine(runId, '3/10 found')
      engine.agentStart(runId, { seq: 1, label: 'scan a.ts', phase: 'Scan', childId: SessionId('child-1') })
      engine.agentEnd(runId, { seq: 1, label: 'scan a.ts', phase: 'Scan', childId: SessionId('child-1'), outcome: 'completed' })
      expect(retained(ctx, job.id, parent)).toBe('▸ Scan\n3/10 found\nagent #1 scan a.ts started\nagent #1 completed\n')
      expect(jobs.get(job.id, parent.id).progress).toBe('Scan')
      // Narration is observer-only: every chunk rides the log channel, so the
      // model's job_output before settlement sees status only.
      expect(jobs.readAt(job.id, 0, parent.id).chunks.map(chunk => chunk.channel)).toEqual(['log', 'log', 'log', 'log'])
      const early = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('call-early-read'),
        name: 'job_output',
        arguments: { job_id: jobId },
        agent: parent,
      })
      expect((early.content[0] as { text: string }).text).toBe('(no new output)\n[status: running, Scan]')

      engine.settleRun(runId, { value: { findings: 2 }, stopReason: 'completed', agentsStarted: 4 })
      await vi.waitFor(() => { expect(jobs.get(job.id, parent.id).status).toBe('completed') })
      const settled = jobs.get(job.id, parent.id)
      expect(settled.detail).toBe('4 agents')
      expect(settled.progress).toBeUndefined()
      const read = jobs.read(job.id, parent.id)
      expect(read.result).toContain('workflow "audit" completed (4 agents)')
      expect(read.result).toContain('"findings": 2')
      expect(engine.disposed).toBe(1)
      // The durable session record still brackets the background run.
      expect(session.snapshotEvents().map(event => event.type)).toEqual([
        'tool-workflow/run-start', 'job/registered', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end', 'job/settled',
      ])
      // A straggling event after settlement finds no tracked run and is dropped.
      engine.phase(runId, 'Late')
      expect(retained(ctx, job.id, parent)).not.toContain('Late')
    })

    it('a registry kill cancels the run and the reason lands in the killed detail', async () => {
      const { ctx, engine, parent } = await setupBackground()
      const result = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      if (result.isError) throw new Error('expected background acceptance')
      const jobs = ctx.jobs
      const jobId = (result.value as { jobId: string }).jobId as JobId
      expect(jobs.kill(jobId, parent.id, 'operator stop')).toBe('requested')
      expect(engine.cancels).toEqual(['operator stop'])
      await vi.waitFor(() => { expect(jobs.get(jobId, parent.id).status).toBe('killed') })
      expect(jobs.get(jobId, parent.id).detail).toBe('operator stop')
      expect(engine.disposed).toBe(1)

      // A reasonless kill falls back to the producer's default cancel reason.
      const second = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      if (second.isError) throw new Error('expected background acceptance')
      const secondId = (second.value as { jobId: string }).jobId as JobId
      expect(jobs.kill(secondId, parent.id)).toBe('requested')
      expect(engine.cancels).toEqual(['operator stop', 'background workflow job killed'])
      await vi.waitFor(() => { expect(jobs.get(secondId, parent.id).status).toBe('killed') })
    })

    it('reports the singular child count after a successful background cleanup', async () => {
      const { ctx, engine, parent } = await setupBackground()
      const accepted = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      if (accepted.isError) throw new Error('expected background acceptance')
      const jobId = (accepted.value as { jobId: JobId }).jobId
      engine.settleRun(WorkflowRunId('run-1'), { value: 'ok', stopReason: 'completed', agentsStarted: 1 })
      const settled = await ctx.jobs.wait(jobId, 5000, parent.id)
      expect(settled.status).toBe('completed')
      expect(settled.detail).toBe('1 agent')
    })

    it('a run that stops with an error fails the job with the script failure', async () => {
      const { ctx, engine, parent } = await setupBackground()
      const result = await execute(ctx, { script: SCRIPT, meta: META, args: { files: ['a.ts'] }, run_in_background: true }, { agent: parent })
      if (result.isError) throw new Error('expected background acceptance')
      const firstId = (result.value as { jobId: JobId }).jobId
      expect(engine.requests[0]).toMatchObject({ args: { files: ['a.ts'] } })
      engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'error', error: 'script exploded', agentsStarted: 2 })
      const jobs = ctx.jobs
      await vi.waitFor(() => { expect(jobs.get(firstId, parent.id).status).toBe('failed') })
      expect(jobs.get(firstId, parent.id).detail).toBe('script exploded')

      // A failure without a message falls back to the unknown-error detail.
      const second = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      if (second.isError) throw new Error('expected background acceptance')
      const secondId = (second.value as { jobId: JobId }).jobId
      engine.settleRun(WorkflowRunId('run-2'), { value: null, stopReason: 'error', agentsStarted: 0 })
      await vi.waitFor(() => { expect(jobs.get(secondId, parent.id).status).toBe('failed') })
      expect(jobs.get(secondId, parent.id).detail).toBe('unknown error')
    })

    it('keeps a nested job live after disposal failure and retries cleanup on termination', async () => {
      const { ctx, engine, parent, session } = await setupBackground()
      engine.disposeError = new Error('worker already gone')
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      const result = await execute(
        ctx,
        { script: SCRIPT, meta: META, run_in_background: true },
        { agent: parent, parent: {} as ToolExecutionToken },
      )
      if (result.isError) throw new Error('expected background acceptance')
      const jobId = (result.value as { jobId: JobId }).jobId
      engine.settleRun(WorkflowRunId('run-1'), { value: 'ok', stopReason: 'completed', agentsStarted: 1 })
      const jobs = ctx.jobs
      try {
        await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
        expect(jobs.get(jobId, parent.id).status).toBe('running')
        expect(jobs.get(jobId, parent.id).progress).toContain('cleanup')
        expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBe('busy')
        expect(session.snapshotEvents().map(event => event.type)).toEqual(['job/registered'])
        engine.disposeError = undefined
        expect(jobs.kill(jobId, parent.id, 'retry cleanup')).toBe('requested')
        const settled = await jobs.wait(jobId, 5000, parent.id)
        expect(settled.status).toBe('failed')
        expect(settled.detail).toContain('worker already gone')
        expect(engine.disposed).toBe(2)
        expect(ctx.bail(agentCarrier(parent), 'agent/idle-release-check', { agent: parent })).toBeUndefined()
        expect(session.snapshotEvents().map(event => event.type)).toEqual(['job/registered', 'job/settled'])
      } finally {
        engine.disposeError = undefined
        jobs.kill(jobId, parent.id, 'test cleanup')
        await jobs.wait(jobId, 5000, parent.id)
      }
    })

    it('defers durable completion until retry confirms cleanup after an unrenderable failure', async () => {
      const { ctx, engine, parent, session } = await setupBackground()
      engine.disposeError = Object.create(null)
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      const accepted = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      if (accepted.isError) throw new Error('expected background acceptance')
      const { jobId, runId } = accepted.value as { jobId: JobId; runId: WorkflowRunIdType }
      engine.settleRun(runId, { value: 'ok', stopReason: 'completed', agentsStarted: 0 })
      try {
        await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
        expect(ctx.jobs.get(jobId, parent.id).status).toBe('running')
        expect(session.snapshotEvents().map(event => event.type)).toEqual(['tool-workflow/run-start', 'job/registered'])
        engine.phase(runId, 'Late phase')
        expect(retained(ctx, jobId, parent)).not.toContain('Late phase')
        expect(warn.mock.calls.map(args => String(args[0])).join('\n')).toContain('dispose failed: [unrenderable thrown value]')
        engine.disposeError = undefined
        ctx.jobs.kill(jobId, parent.id, 'retry cleanup')
        expect((await ctx.jobs.wait(jobId, 5000, parent.id)).status).toBe('failed')
        expect(session.snapshotEvents().at(-2)?.type).toBe('tool-workflow/run-end')
        expect(session.snapshotEvents().at(-1)?.type).toBe('job/settled')
      } finally {
        engine.disposeError = undefined
        ctx.jobs.kill(jobId, parent.id, 'test cleanup')
        await ctx.jobs.wait(jobId, 5000, parent.id)
      }
    })

    it('a synchronous engine rejection registers no job', async () => {
      const { ctx, engine, parent } = await setupBackground()
      engine.startError = new Error('META_INVALID: name required')
      const result = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('META_INVALID')
      expect(ctx.jobs.list(parent.id)).toEqual([])
    })

    it('fails loud without a job registry', async () => {
      const { ctx, parent } = await setup()
      const result = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text)
        .toContain('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
    })

    it('a disabled composition hides the parameter and rejects the call', async () => {
      const { ctx, parent } = await setupBackground({ enableRunInBackground: false })
      const tool = ctx.tools.get('workflow')!
      expect(JSON.stringify(tool.parameters)).not.toContain('run_in_background')
      expect(tool.description).not.toContain('run_in_background')
      const result = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('run_in_background is disabled')
    })

    it('advertises the background semantics in the parameter', async () => {
      const { ctx } = await setupBackground()
      const tool = ctx.tools.get('workflow')!
      expect(JSON.stringify(tool.parameters)).toContain('return a job id immediately instead of waiting')
    })
  })

  describe('composition with the sandboxed PTC workflow engine', () => {
    it('retries failed foreground child cleanup before admitting another child', async () => {
      const ctx = new Context()
      let allowCleanup = false, starts = 0
      const active = new Set<number>()
      const cleanup: Array<() => Promise<void>> = []
      onTestFinished(async () => {
        allowCleanup = true
        await Promise.all(cleanup.map(dispose => dispose()))
        await ctx.fiber.dispose()
      })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      provideWorkingDirectoryFixture(ctx)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      ctx.subagents.registerProvider({
        name: 'spawn',
        capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
        inheritsParentContext: false,
        start: () => {
          const id = ++starts
          active.add(id)
          const dispose = async (): Promise<void> => {
            if (id === 1 && !allowCleanup) throw new Error('foreground child cleanup remains unconfirmed')
            active.delete(id)
          }
          cleanup.push(dispose)
          return Promise.resolve({ id: SessionId(`foreground-child-${id}`), localAgent: undefined,
            result: Promise.resolve({ output: [], stopReason: 'completed' as const }), dispose })
        },
      })
      await mountWorkflowRuntime(ctx)
      await ctx.plugin(PtcWorkflowEngine, {})
      await ctx.plugin(toolWorkflow, {})
      const session = ctx.sessions.create(SessionId('foreground-caller'))
      const parent = { id: session.id, session, options: {}, ctx: ctx.plugin(() => {}).ctx } as unknown as Agent
      const args = { script: "return await agent('owned child')", meta: META }
      expect((await execute(ctx, args, { agent: parent })).isError).toBe(true)
      const runStart = session.snapshotEvents().find(event => event.type === 'tool-workflow/run-start')!
      if (runStart.type !== 'tool-workflow/run-start') throw new Error('Expected a durable workflow start')
      const firstRunId = runStart.data.runId
      const endings = () => session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-end' && event.data.runId === firstRunId)
      const ended = Promise.withResolvers<undefined>()
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'tool-workflow/run-end' && event.data.runId === firstRunId) ended.resolve(undefined)
      })
      expect(endings()).toHaveLength(0)
      expect([...active]).toEqual([1])
      expect((await execute(ctx, args, { agent: parent })).isError).toBe(true)
      expect(starts).toBe(1)
      expect([...active]).toEqual([1])
      allowCleanup = true
      expect((await execute(ctx, args, { agent: parent })).isError).toBe(false)
      await ended.promise
      expect(endings()).toHaveLength(1)
      expect(starts).toBe(2)
      expect(active.size).toBe(0)
    })

    it('an abort releases the tool even when the script parks on a promise no hook owns', async () => {
      const ctx = new Context()
      onTestFinished(async () => { await ctx.fiber.dispose() })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      provideWorkingDirectoryFixture(ctx)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      ctx.subagents.registerProvider({
        name: 'spawn',
        capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
        inheritsParentContext: false,
        start: () => Promise.reject(new Error('the parked-script fixture must not start a child')),
      })
      await mountWorkflowRuntime(ctx)
      await ctx.plugin(PtcWorkflowEngine, {})
      await ctx.plugin(toolWorkflow, {})
      const session = Session.create(SessionId('caller'))
      const parent = { id: session.id, options: {}, session, ctx: ctx.plugin(() => {}).ctx } as unknown as Agent
      const controller = new AbortController()
      const ready = Promise.withResolvers<undefined>()
      ctx.on('workflow/log', () => { ready.resolve(undefined) })
      const pending = execute(ctx, {
        script: 'log("ready"); await new Promise(() => {})\nreturn 1',
        meta: { name: 'stuck', description: 'parks forever' },
      }, { agent: parent, signal: controller.signal })
      await ready.promise
      controller.abort('user abort')
      const result = await pending
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('cancelled')
    })

    it('a background run over the sandboxed PTC engine settles its job with the rendered return value', async () => {
      const ctx = new Context()
      onTestFinished(async () => { await ctx.fiber.dispose() })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(ToolTasks)
      provideWorkingDirectoryFixture(ctx)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      ctx.subagents.registerProvider({
        name: 'spawn',
        capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
        inheritsParentContext: false,
        start: () => Promise.reject(new Error('the scriptonly fixture must not start a child')),
      })
      await mountWorkflowRuntime(ctx)
      await ctx.plugin(PtcWorkflowEngine, {})
      await ctx.plugin(toolWorkflow, {})
      const session = Session.create(SessionId('caller'))
      const parent: Agent = {
        id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx,
        send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
        runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
      }
      await ctx.agents.register(parent)

      const result = await execute(ctx, {
        script: 'log("halfway")\nreturn { ok: true }',
        meta: { name: 'scriptonly', description: 'returns without agents' },
        run_in_background: true,
      }, { agent: parent })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected background acceptance')
      const { jobId } = result.value as { jobId: JobId }
      const jobs = ctx.jobs

      await vi.waitFor(() => { expect(jobs.get(jobId, parent.id).status).toBe('completed') }, { timeout: 10_000 })
      expect(jobs.get(jobId, parent.id).detail).toBe('0 agents')
      const ring = jobs.readAt(jobId, 0, parent.id).chunks.map(chunk => chunk.text).join('')
      expect(ring).toContain('halfway')
      expect(jobs.read(jobId, parent.id).result).toContain('"ok": true')
    }, 15_000)
  })
})
