/** Managed deployments refuse opaque external turns before startup or recovery. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { type StreamChunk } from '@deepseek-ai/dsh-llm'
import Subagents from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { expect, it, vi } from 'vitest'
import * as acp from '../src/index.ts'
import { parentAgent } from './agent-fixture.ts'

const controls = ['model-required', 'model-owner', 'budget-required', 'budget-owner', 'execution-required', 'execution-owner'] as const

it.each(controls.flatMap(control => [false, true].map(isolated => ({ control, isolated }))))(
  'refuses opaque one-shot, member creation and resumed inference with $control and isolated=$isolated', async ({ control, isolated }) => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-external-model-control-'))
    const ctx = new Context()
    try {
      provideWorkingDirectoryFixture(ctx)
      await ctx.plugin(Subagents)
      await ctx.plugin(LocalSubprocess)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(acp, { providerName: 'acp', args: [], permission: 'reject', env: {},
        stateDir: directory, resume: true, command: process.execPath })
      const service = control === 'model-required' ? 'modelAccessRequired' : control === 'model-owner' ? 'modelAccess'
        : control === 'budget-required' ? 'resourceBudgetRequired' : control === 'budget-owner' ? 'resourceBudget'
          : control === 'execution-required' ? 'executionAuthorityRequired' : 'executionAuthority'
      const owner = isolated ? ctx.isolate(service) : ctx
      const acquire = vi.fn(async () => { throw new Error('Opaque inference must not allocate parent capacity.') })
      if (control === 'model-required') owner.provide('modelAccessRequired', true)
      if (control === 'model-owner') owner.provide('modelAccess', { decide: () => ({ allowed: true }) })
      if (control === 'budget-required') owner.provide('resourceBudgetRequired', true)
      if (control === 'budget-owner') owner.provide('resourceBudget', { acquire })
      if (control === 'execution-required') owner.provide('executionAuthorityRequired', true)
      if (control === 'execution-owner') owner.provide('executionAuthority', {
        capture: () => ({ parentSessionId: SessionId('managed-parent'), inputs: [], unverifiedHistory: false }),
        runCaptured: <T>(_agent: unknown, _scope: unknown, work: () => T): T => work(),
      })
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const parent = parentAgent(directory, 'managed-parent', owner)
      ctx.agents.register(parentAgent(directory, 'external-child', owner))
      const signal = new AbortController().signal
      const provider = ctx.subagents.getProvider('acp')!
      await expect(ctx.subagents.start('acp', { parent, signal, prompt: [{ type: 'text', text: 'Task' }] }))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
      await expect(provider.prepareContinuable!({ parent, signal, sessionId: SessionId('external-child'), cwd: directory }))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({ ...provider.agentRouteDefaults!, sessionId: SessionId('external-child'), messages: [] })) chunks.push(chunk)
      expect(acquire).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      const code = control === 'model-required' && !isolated ? 'MODEL_POLICY_UNAVAILABLE' : 'UNSUPPORTED_CAPABILITY'
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code } } })
    } finally {
      try { await ctx.fiber.dispose() }
      finally { rmSync(directory, { recursive: true, force: true }) }
    }
  },
)
