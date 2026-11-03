/** Review maintenance precedes admitted model input and retains its process permits through exit. */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, expect, it } from 'vitest'
import * as WorkspaceChanges from '../src/index.ts'
import { PosixRecorderExecution } from '../src/execution.ts'
import { GitRunner } from '../src/git.ts'
import { changes, endTurn, git, settle, startTurn, toolCall } from './support.ts'

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
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
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
