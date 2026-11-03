/** Coordinated model transport/process ownership through Codex provider failure paths. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SshConnection } from '@deepseek-ai/dsh-ssh'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ExternalBindingStore } from '@deepseek-ai/dsh-subagent/external'
import Subagents, { snapshotSubagentDescriptor, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as codex from '../src/index.ts'
import { startManagedCodexModel, type ManagedCodexModel } from '../src/managed-model.ts'
import { startCodexRun } from '../src/run.ts'
import { parentAgent } from './agent-fixture.ts'

vi.mock('../src/managed-model.ts', async original => ({
  ...await original<typeof import('../src/managed-model.ts')>(), startManagedCodexModel: vi.fn(),
}))
vi.mock('../src/run.ts', async original => ({
  ...await original<typeof import('../src/run.ts')>(), startCodexRun: vi.fn(),
}))

async function fixture(inheritModel = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-model-lifecycle-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
  })
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(Subagents)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(codex, { ...inheritModel ? {} : { modelProvider: 'parent-responses', model: 'm' }, stateDir: directory })
  const provider = ctx.subagents.getProvider('codex')
  if (provider === undefined) throw new Error('The Codex provider must be registered.')
  const modelClose = vi.fn(async () => {})
  const processClose = vi.fn(async () => {})
  const model: ManagedCodexModel = { model: 'm', config: [], env: {}, close: modelClose }
  const native: SubagentRun = { id: SessionId('native-managed-child'), localAgent: undefined,
    result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: processClose }
  vi.mocked(startManagedCodexModel).mockReset().mockResolvedValue(model)
  vi.mocked(startCodexRun).mockReset().mockResolvedValue(native)
  const parent = parentAgent(directory, 'native-managed-parent', ctx)
  const request = { parent, signal: new AbortController().signal, prompt: [], cwd: directory,
    descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'codex' }) }
  return { ctx, provider, modelClose, processClose, request }
}

it.each(['process', 'model', 'both'] as const)('joins both native owners and retains a %s cleanup failure', async (mode) => {
  const f = await fixture()
  const modelError = new Error('Model cleanup failed.')
  const processError = new Error('Process cleanup failed.')
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  f.modelClose.mockImplementation(async () => {
    await release.promise
    if (mode !== 'process') throw modelError
  })
  if (mode !== 'model') f.processClose.mockRejectedValue(processError)
  const run = await f.provider.start(f.request)
  const closing = run.dispose()
  const errors = [...mode === 'process' ? [] : [modelError], ...mode === 'model' ? [] : [processError]]
  const outcome = expect(closing).rejects.toMatchObject({ errors })
  expect(f.modelClose).toHaveBeenCalledOnce()
  expect(f.processClose).toHaveBeenCalledOnce()
  expect(run.dispose()).toBe(closing)
  release.resolve(undefined)
  await outcome
})

it.each([false, true])('releases the model transport after process startup fails, retaining cleanup failure=%s', async (cleanupFails) => {
  const f = await fixture()
  const startup = new Error('Native startup failed.')
  const cleanup = new Error('Model cleanup failed.')
  vi.mocked(startCodexRun).mockRejectedValueOnce(startup)
  if (cleanupFails) f.modelClose.mockRejectedValueOnce(cleanup)
  const starting = f.provider.start(f.request)
  if (cleanupFails) await expect(starting).rejects.toMatchObject({ errors: [startup, cleanup] })
  else await expect(starting).rejects.toBe(startup)
  expect(f.modelClose).toHaveBeenCalledOnce()
  expect(f.processClose).not.toHaveBeenCalled()
})

it('prepares an explicit managed persistent member without allocating a process or model listener', async () => {
  const f = await fixture()
  if (f.provider.prepareContinuable === undefined || f.provider.agentRouteDefaults === undefined) {
    throw new Error('An LLM-enabled Codex provider must expose its persistent route.')
  }
  const sessionId = SessionId('managed-persistent-child')
  await expect(f.provider.prepareContinuable({ parent: f.request.parent, signal: f.request.signal,
    cwd: f.request.cwd, sessionId })).resolves.toEqual({})
  expect(startManagedCodexModel).not.toHaveBeenCalled()
  expect(startCodexRun).not.toHaveBeenCalled()
})

it('inherits a managed member upstream across a nested member alias', async () => {
  const f = await fixture(true)
  f.ctx.provide('modelAccess', { decide: () => ({ allowed: true }) })
  const parent = { ...f.request.parent, options: { provider: 'parent-responses', model: 'm' } }
  const member = parentAgent(f.request.cwd, 'nested-parent', f.ctx)
  await f.provider.prepareContinuable!({ parent, sessionId: member.id, cwd: f.request.cwd, signal: f.request.signal })
  const child = SessionId('nested-child')
  await f.provider.prepareContinuable!({ parent: { ...member, options: f.provider.agentRouteDefaults! },
    sessionId: child, cwd: f.request.cwd, signal: f.request.signal })
  const store = new ExternalBindingStore(join(f.request.cwd, 'codex.jsonl'))
  expect(store.modelSelection(child)).toEqual({ mode: 'managed', provider: 'parent-responses', model: 'm' })
  expect(startManagedCodexModel).not.toHaveBeenCalled()
})

it('inherits a managed member upstream when the member delegates a one-shot run', async () => {
  const f = await fixture(true)
  f.ctx.provide('modelAccess', { decide: () => ({ allowed: true }) })
  const parent = { ...f.request.parent, options: { provider: 'parent-responses', model: 'm' } }
  const member = { ...parentAgent(f.request.cwd, 'one-shot-delegating-member', f.ctx),
    options: f.provider.agentRouteDefaults! }
  await f.provider.prepareContinuable!({ parent, sessionId: member.id, cwd: f.request.cwd, signal: f.request.signal })
  const run = await f.ctx.subagents.start('codex', { parent: member, prompt: [{ type: 'text', text: 'Nested task' }],
    signal: f.request.signal })
  try {
    expect(startManagedCodexModel).toHaveBeenCalledOnce()
    const call = vi.mocked(startManagedCodexModel).mock.calls[0]!
    expect(call[1]).toBe(member)
    expect(call[2]).toMatchObject({ provider: 'parent-responses', model: 'm' })
  } finally { await run.dispose() }
})

it.each(['prepare', 'turn'] as const)('refuses managed remote member %s before allocating a native owner', async (phase) => {
  const f = await fixture()
  await f.ctx.plugin(AgentRegistry)
  f.ctx.effect(() => f.ctx.agents.register(f.request.parent))
  vi.spyOn(await import('@deepseek-ai/dsh-subagent'), 'resolveChildExecution').mockResolvedValue({
    cwd: f.request.cwd, target: 'ssh:17', remote: true, subprocess: f.ctx.subprocess,
  })
  try {
    if (phase === 'prepare') {
      await expect(f.provider.prepareContinuable!({ parent: f.request.parent, sessionId: SessionId('remote-member'),
        cwd: f.request.cwd, signal: f.request.signal })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    } else {
      const chunks = []
      for await (const chunk of f.ctx.llm.stream({ ...f.provider.agentRouteDefaults!, sessionId: f.request.parent.id,
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Remote managed task' }] })] })) chunks.push(chunk)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_CAPABILITY' } } })
    }
    expect(startManagedCodexModel).not.toHaveBeenCalled()
    expect(startCodexRun).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks() }
})

async function remoteFixture() {
  const f = await fixture()
  const execution = { cwd: f.request.cwd, target: 'ssh:17', remote: true, subprocess: f.ctx.subprocess }
  const forward = vi.fn<SshConnection['forwardLoopback']>()
  const ssh: Pick<SshConnection, 'ready' | 'forwardLoopback'> = {
    ready: Promise.resolve({ protocol: 2 as const, hash: 'a'.repeat(64), kind: 'node-script' as const,
      platform: 'linux' as const, nodeVersion: process.version, executable: '/remote/node', root: '/remote/helper', workspace: f.request.cwd }),
    forwardLoopback: forward,
  }
  vi.spyOn(await import('@deepseek-ai/dsh-subagent'), 'resolveChildExecution').mockResolvedValue(execution)
  // The provider consumes these two operations; the SSH suites own the transport internals.
  vi.spyOn(await import('@deepseek-ai/dsh-agent-preset-registry'), 'environmentForAgent').mockReturnValue(ssh as SshConnection)
  const executable = vi.spyOn(f.ctx.subprocess, 'resolveExecutable').mockResolvedValue('/remote/codex')
  onTestFinished(() => { vi.restoreAllMocks() })
  return { ...f, forward, executable }
}

it('prepares managed SSH members with no listener or forwarding allocation', async () => {
  const f = await remoteFixture()
  await expect(f.provider.prepareContinuable!({ parent: f.request.parent, sessionId: SessionId('remote-child'),
    cwd: f.request.cwd, signal: f.request.signal })).resolves.toEqual({})
  expect(f.forward).not.toHaveBeenCalled()
  expect(startManagedCodexModel).not.toHaveBeenCalled()
  expect(startCodexRun).not.toHaveBeenCalled()
  expect(f.executable).toHaveBeenCalledOnce()
})

it('passes the initiating SSH forwarding owner to managed one-shot inference', async () => {
  const f = await remoteFixture()
  const run = await f.provider.start(f.request)
  try {
    const args = vi.mocked(startManagedCodexModel).mock.calls[0]
    expect(args?.[4]).toBeTypeOf('function')
    const beforeClose = async () => {}
    await args?.[4]?.(31011, beforeClose, f.request.signal)
    expect(f.forward).toHaveBeenCalledExactlyOnceWith(31011, beforeClose, f.request.signal)
    expect(vi.mocked(startCodexRun).mock.calls[0]?.[1]).toMatchObject({ executable: '/remote/codex' })
  } finally { await run.dispose() }
})

it('resolves a remote executable before allocating its managed model listener', async () => {
  const f = await remoteFixture()
  f.executable.mockRejectedValueOnce(new Error('remote executable unavailable'))
  await expect(f.provider.start(f.request)).rejects.toThrow('remote executable unavailable')
  expect(startManagedCodexModel).not.toHaveBeenCalled()
  expect(startCodexRun).not.toHaveBeenCalled()
  expect(f.forward).not.toHaveBeenCalled()
})

it('retains SSH forwarding on a persistent model owner when its remote process allocation fails', async () => {
  const f = await remoteFixture()
  await f.ctx.plugin(AgentRegistry)
  f.ctx.effect(() => f.ctx.agents.register(f.request.parent))
  vi.spyOn(f.ctx.subprocess, 'spawn').mockRejectedValue(new Error('remote process allocation refused'))
  const chunks = []
  for await (const chunk of f.ctx.llm.stream({ ...f.provider.agentRouteDefaults!, sessionId: f.request.parent.id,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Remote managed task' }] })] })) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  expect(vi.mocked(startManagedCodexModel).mock.calls[0]?.[4]).toBeTypeOf('function')
  expect(f.modelClose).toHaveBeenCalledOnce()
})
