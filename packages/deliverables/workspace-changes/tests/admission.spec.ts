/** Review maintenance precedes admitted model input and retains its process permits through exit. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, expect, it, vi } from 'vitest'
import * as WorkspaceChanges from '../src/index.ts'
import { PosixRecorderExecution } from '../src/execution.ts'
import { GitRunner } from '../src/git.ts'
import { ReviewStore } from '../src/review-store.ts'
import { changes, endTurn, git, mutate, settle, startTurn, toolCall } from './support.ts'

type Request = Parameters<Context['resourceBudget']['acquire']>[0]

/** A managed generation with no admitted human input yet. */
class PreInputBudget extends Service {
  readonly requests: Request[] = []
  active = 0

  constructor(ctx: Context) { super(ctx, 'resourceBudget') }

  async acquire(request: Request) {
    this.requests.push(request)
    if (request.origin !== 'infrastructure') throw new Error('No Session input has been admitted')
    this.active += 1
    let released = false
    return {
      signal: request.signal ?? new AbortController().signal,
      release: async () => { if (!released) { released = true; this.active -= 1 } },
      uncertain: async () => { throw new Error('Unconfirmed review process exit') },
    }
  }
}

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  }
})

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-review-admission-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(PreInputBudget)
  ctx.provide('resourceBudgetRequired', true)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem)
  return { ctx, root, budget: ctx.resourceBudget as PreInputBudget }
}

it.each([false, true])('waits for both first-turn review checks before model input (storage failure: %s)', async (storageFails) => {
  const { ctx, root } = await setup()
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  await ctx.plugin(WorkspaceChanges, { storageRoot: join(root, '.reviews') } as WorkspaceChanges.Config)
  const session = ctx.sessions.create(SessionId('concurrent-review-checks'), { meta: { cwd } })
  const baselineEntered = Promise.withResolvers<undefined>()
  const baselineReleased = Promise.withResolvers<undefined>()
  const probeReleased = Promise.withResolvers<undefined>()
  const probeDone = Promise.withResolvers<undefined>()
  // oxlint-disable-next-line typescript/unbound-method -- The spy invokes the original with its own receiver.
  const run = GitRunner.prototype.run
  // oxlint-disable-next-line typescript/unbound-method -- The spy invokes the original with its own receiver.
  const probe = ReviewStore.prototype.probe
  vi.spyOn(GitRunner.prototype, 'run').mockImplementation(async function (this: GitRunner, args, options) {
    if (args[0] === 'rev-parse') {
      baselineEntered.resolve(undefined)
      await baselineReleased.promise
    }
    return await run.call(this, args, options)
  })
  const storage = vi.spyOn(ReviewStore.prototype, 'probe').mockImplementation(async function (this: ReviewStore, id, bytes) {
    await probeReleased.promise
    try {
      if (storageFails) throw new Error('fixture review storage is unavailable')
      await probe.call(this, id, bytes)
    } finally { probeDone.resolve(undefined) }
  })
  const next = vi.fn(() => Promise.resolve({ kind: 'enter', messages: [] }))
  startTurn(session, 1)
  const result = Promise.resolve(ctx.waterfall('agent/pre-step', {
    agent: { id: session.id, session }, turn: 1, step: 1, messages: [], signal: new AbortController().signal,
  } as never, next as never))
  void result.catch(() => { /* This request's terminal failure is asserted below. */ })
  try {
    await baselineEntered.promise
    await vi.waitFor(() => { expect(storage).toHaveBeenCalledExactlyOnceWith(session.id, 0) })
    probeReleased.resolve(undefined)
    await probeDone.promise
    expect(next).not.toHaveBeenCalled()
    baselineReleased.resolve(undefined)
    if (storageFails) {
      await expect(result).rejects.toThrow('storage is not ready')
      expect(next).not.toHaveBeenCalled()
      const reports = session.snapshotEvents().filter(event => event.type === 'workspace/changes')
      expect(reports.map(event => event.data)).toEqual([{ turn: 1, incomplete: true }])
    } else {
      await expect(result).resolves.toMatchObject({ kind: 'enter' })
      expect(next).toHaveBeenCalledOnce()
    }
  } finally {
    probeReleased.resolve(undefined)
    baselineReleased.resolve(undefined)
    await result.catch(() => { /* Release the request owned by this fixture before provider teardown. */ })
  }
})

it('captures file-tool edits without a Git process until an ancestor becomes a repository', async () => {
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) vi.stubEnv(key, undefined)
  }
  const { ctx, root, budget } = await setup()
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  await ctx.plugin(WorkspaceChanges, { storageRoot: join(root, '.reviews') } as WorkspaceChanges.Config)
  const session = ctx.sessions.create(SessionId('plain-then-repository'), { meta: { cwd } })
  startTurn(session, 1)
  await settle(ctx, session)
  await mutate(ctx, session, 1, 'write', { file_path: 'result.txt', content: 'first\n' },
    () => writeFile(join(cwd, 'result.txt'), 'first\n'))
  endTurn(session, 1)
  await settle(ctx, session)
  expect((await changes(ctx, session))[0]?.files.map(file => file.path)).toEqual(['result.txt'])
  expect(budget.requests).toEqual([])

  git(root, 'init', '-q', '-b', 'main')
  startTurn(session, 2)
  await settle(ctx, session)
  await writeFile(join(cwd, 'shell.txt'), 'second\n')
  toolCall(session, 2, 'bash', { command: 'write shell.txt' })
  endTurn(session, 2)
  await settle(ctx, session)
  expect((await changes(ctx, session)).at(-1)?.files.map(file => file.path)).toEqual(['shell.txt'])
  expect(budget.requests.length).toBeGreaterThan(0)
  expect(budget.requests.every(request => request.origin === 'infrastructure')).toBe(true)
  expect(budget.active).toBe(0)
})

it('records the first turn before input admission without admitting an ordinary process', async () => {
  const { ctx, root, budget } = await setup()
  git(root, 'init', '-q', '-b', 'main')
  await ctx.plugin(WorkspaceChanges, { storageRoot: join(root, '.reviews') } as WorkspaceChanges.Config)
  const session = ctx.sessions.create(SessionId('first-unadmitted-turn'), { meta: { cwd: root } })
  startTurn(session, 1)
  await settle(ctx, session)
  await writeFile(join(root, 'result.txt'), 'review\n')
  toolCall(session, 1, 'write', { file_path: 'result.txt', content: 'review\n' })
  endTurn(session, 1)
  await settle(ctx, session)
  expect((await changes(ctx, session)).at(-1)?.files.map(file => file.path)).toEqual(['result.txt'])
  expect(budget.requests.length).toBeGreaterThan(0)
  expect(budget.requests.every(request => request.origin === 'infrastructure')).toBe(true)
  await expect(ctx.subprocess.spawn({
    argv: ['git', '--version'], cwd: root,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: 1000,
  })).rejects.toThrow('No Session input has been admitted')
  await ctx.fiber.dispose()
  expect(budget.active).toBe(0)
})

it.skipIf(process.platform === 'win32')('keeps execution-target scratch maintenance and cleanup independent of admitted input', async () => {
  const { ctx, root, budget } = await setup()
  const execution = new PosixRecorderExecution(ctx.fs, ctx.subprocess, root, 30_000)
  const signal = new AbortController().signal
  expect((await execution.paths(signal)).cwd).toBe(root)
  const directory = await execution.temporary(join(root, 'snapshot-'), signal)
  const command = new GitRunner(ctx.subprocess, await ctx.subprocess.resolveExecutable('git'), {
    timeoutMs: 30_000, outputMaxBytes: 4096,
  }, execution)
  expect((await command.run(['--version'], { cwd: root, signal })).exitCode).toBe(0)
  await execution.remove(directory)
  expect(budget.requests.length).toBeGreaterThan(0)
  expect(budget.requests.every(request => request.origin === 'infrastructure')).toBe(true)
  await ctx.fiber.dispose()
  expect(budget.active).toBe(0)
})
