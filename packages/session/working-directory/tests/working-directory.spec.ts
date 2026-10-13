import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WorkingDirectory, { type Config as WorkingDirectoryConfig } from '@deepseek-ai/dsh-working-directory'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as WorkingDirectoryTool from '@deepseek-ai/dsh-tool-working-directory'

async function fixture(config?: (root: string) => WorkingDirectoryConfig) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-working-directory-')))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext: false } })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    const directoryFiber = ctx.plugin(WorkingDirectory, config?.(root) ?? {})
    await directoryFiber
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('directory-owner'), {}, { cwd: root })
    return {
      ctx, root, agent, harness, directoryFiber,
      async [Symbol.asyncDispose]() {
        await ctx.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

describe('Session working directories', () => {
  it('keeps origin metadata and other Sessions independent while logging the changed directory', async () => {
    await using f = await fixture()
    const child = join(f.root, 'child')
    await mkdir(child)
    const sibling = await f.harness.create(SessionId('sibling'), {}, { cwd: f.root })
    await expect(f.ctx.workingDirectory.set(f.agent, 'child')).resolves.toBe(child)
    expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(child)
    expect(f.ctx.workingDirectory.get(sibling.session)).toBe(f.root)
    expect(f.agent.session.header.cwd).toBe(f.root)
    expect(f.agent.session.snapshotEvents()).toContainEqual(expect.objectContaining({
      type: 'working-directory/change', data: { cwd: child },
    }))
    const messages = f.harness.claim(f.agent, 'next-step', 1)
    expect(messages).toEqual([expect.objectContaining({
      role: 'user',
      content: [{ type: 'text', text: `The working directory changed from ${JSON.stringify(f.root)} to ${JSON.stringify(child)}.` }],
    })])
  })

  it('restores directory state from the log', async () => {
    await using f = await fixture()
    const child = join(f.root, 'child')
    await mkdir(child)
    await f.ctx.workingDirectory.set(f.agent, child)
    const restored = f.ctx.sessions.create(SessionId('restored'), {
      meta: { cwd: f.root }, seed: f.agent.session.snapshotEvents(),
    })
    expect(f.ctx.workingDirectory.get(restored)).toBe(child)
  })

  it('exposes the current directory in wire observations after replay without an Agent', async () => {
    await using f = await fixture()
    const directory = join(f.root, 'moved')
    await mkdir(directory)
    const withoutOrigin = f.ctx.sessions.create(SessionId('wire-without-origin'))
    expect(f.ctx.sessionProjections.snapshot(withoutOrigin).values.workingDirectory).toBeNull()
    expect(f.ctx.sessionProjections.snapshot(f.agent.session).values.workingDirectory).toBe(f.root)
    await f.ctx.workingDirectory.set(f.agent, directory)
    const restored = f.ctx.sessions.create(SessionId('wire-restored'), {
      meta: { cwd: f.root }, seed: f.agent.session.snapshotEvents(),
    })
    expect(f.ctx.agents.get(restored.id)).toBeUndefined()
    expect(f.ctx.sessionProjections.snapshot(restored).values.workingDirectory).toBe(directory)
    expect(restored.header.cwd).toBe(f.root)
  })

  it('serializes concurrent relative changes and recovers after a rejected change', async () => {
    await using f = await fixture()
    await mkdir(join(f.root, 'a', 'b'), { recursive: true })
    await expect(Promise.all([
      f.ctx.workingDirectory.set(f.agent, 'a'),
      f.ctx.workingDirectory.set(f.agent, 'b'),
    ])).resolves.toEqual([join(f.root, 'a'), join(f.root, 'a', 'b')])
    await expect(f.ctx.workingDirectory.set(f.agent, 'missing')).rejects.toThrow('directory does not exist')
    await expect(f.ctx.workingDirectory.set(f.agent, '..')).resolves.toBe(join(f.root, 'a'))
  })

  it('returns to the original project when the selected directory disappears and injects the recovery', async () => {
    await using f = await fixture()
    const child = join(f.root, 'temporary')
    await mkdir(child)
    await f.ctx.workingDirectory.set(f.agent, child)
    f.harness.claim(f.agent, 'next-step', 1)
    await rm(child, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.root)
    expect(f.harness.claim(f.agent, 'next-step', 1)).toEqual([expect.objectContaining({
      content: [{ type: 'text', text: `The working directory ${JSON.stringify(child)} is unavailable. The working directory is now ${JSON.stringify(f.root)}.` }],
    })])
  })

  it('returns to the original project when the recorded directory sits outside it', async () => {
    await using f = await fixture()
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-working-directory-outside-')))
    try {
      f.agent.session.append('working-directory/change', { cwd: outside })
      expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(outside)
      await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.root)
      expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(f.root)
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
        .toEqual([expect.objectContaining({ data: { cwd: outside } }), expect.objectContaining({ data: { cwd: f.root } })])
      expect(f.harness.claim(f.agent, 'next-step', 1)).toEqual([expect.objectContaining({
        content: [{ type: 'text', text: `The working directory ${JSON.stringify(outside)} is unavailable. The working directory is now ${JSON.stringify(f.root)}.` }],
      })])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('reports a missing original project and confines recovery to that project', async () => {
    await using f = await fixture()
    const origin = join(f.root, 'original')
    await mkdir(origin)
    const agent = await f.harness.create(SessionId('removed-origin'), {}, { cwd: origin })
    await rm(origin, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(agent)).rejects.toThrow('directory does not exist')
    // The project's parent lies outside the Session's root: containment, not recovery.
    await expect(f.ctx.workingDirectory.set(agent, f.root)).rejects.toThrow('outside the project directory')
    await mkdir(origin)
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(origin)
  })

  it('rejects files, empty paths, and cancelled changes without changing state', async () => {
    await using f = await fixture()
    await writeFile(join(f.root, 'file'), '')
    await expect(f.ctx.workingDirectory.set(f.agent, 'file')).rejects.toThrow('directory does not exist')
    await expect(f.ctx.workingDirectory.set(f.agent, '')).rejects.toThrow('cd must not be empty')
    const controller = new AbortController()
    controller.abort(new Error('cancelled directory change'))
    await expect(f.ctx.workingDirectory.set(f.agent, f.root, controller.signal)).rejects.toThrow('cancelled directory change')
    expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(f.root)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
  })

  it('keeps unchanged reads and changes free of transition notices', async () => {
    await using f = await fixture()
    await f.ctx.workingDirectory.ensure(f.agent)
    await f.ctx.workingDirectory.set(f.agent, f.root)
    expect(f.harness.claim(f.agent, 'next-step', 1)).toEqual([])
  })

  it('validates a directory equal to the project root with a single filesystem resolve', async () => {
    await using f = await fixture()
    const resolve = vi.spyOn(f.ctx.fs, 'resolve')
    await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.root)
    expect(resolve).toHaveBeenCalledOnce()
    await mkdir(join(f.root, 'child'))
    await f.ctx.workingDirectory.set(f.agent, 'child')
    resolve.mockClear()
    await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(join(f.root, 'child'))
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('provides required user context instead of a system-prompt directory, including recovery during assembly', async () => {
    await using f = await fixture()
    const child = join(f.root, 'temporary')
    await mkdir(child)
    await f.ctx.workingDirectory.set(f.agent, child)
    await rm(child, { recursive: true })
    const assembly = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
    expect(renderContextSnapshot(assembly)).toContain(`Current working directory: ${JSON.stringify(f.root)}.`)
    expect(renderPrompt(assembly)).not.toContain(f.root)
    expect(renderContextSnapshot(await f.ctx.systemPrompt.assemble())).toBe('')
  })

  it('uses and records the configured launch fallback for a Session without origin metadata', async () => {
    await using f = await fixture()
    const agent = await f.harness.create(SessionId('without-origin'))
    const fallback = f.ctx.workingDirectory.defaultDirectory
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(fallback)
    expect(agent.session.snapshotEvents()).toContainEqual(expect.objectContaining({
      type: 'working-directory/change', data: { cwd: fallback },
    }))
  })

  it('rejects a relative deployment default before accepting Sessions', async () => {
    await expect(fixture(() => ({ defaultDirectory: 'relative/project' }))).rejects.toThrow('defaultDirectory must be absolute')
  })

  it('recovers a Session without origin metadata to its configured default', async () => {
    await using f = await fixture(root => ({ defaultDirectory: root }))
    const agent = await f.harness.create(SessionId('fallback-recovery'))
    const temporary = join(f.root, 'temporary')
    await mkdir(temporary)
    await f.ctx.workingDirectory.set(agent, temporary)
    f.harness.claim(agent, 'next-step', 1)
    await rm(temporary, { recursive: true })
    await expect(f.ctx.workingDirectory.ensure(agent)).resolves.toBe(f.root)
    expect(agent.session.header.cwd).toBeUndefined()
    expect(f.harness.claim(agent, 'next-step', 1)).toEqual([expect.objectContaining({
      content: [{ type: 'text', text: `The working directory ${JSON.stringify(temporary)} is unavailable. The working directory is now ${JSON.stringify(f.root)}.` }],
    })])
  })

  it.each(['remove', 'replace'] as const)('retains required current-directory context after an assembly transform can %s it', async (change) => {
    await using f = await fixture()
    f.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      return {
        ...assembled,
        contexts: change === 'remove' ? [] : [{ name: 'working-directory:current', text: 'outdated directory' }],
      }
    })
    const assembled = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
    expect(assembled.contexts).toEqual([{
      name: 'working-directory:current', text: `Current working directory: ${JSON.stringify(f.root)}.`, interpolate: false,
    }])
    expect(renderPrompt(assembled)).not.toContain(f.root)
  })

  it.each([false, true])('renders variable-looking directory names literally after context removal is %s', async (removeContext) => {
    await using f = await fixture()
    const directory = join(f.root, '{{project}}-{{unknown}}-{{malformed-name}}')
    await mkdir(directory)
    f.ctx.systemPrompt.variable('project', () => 'wrong-directory')
    if (removeContext) {
      f.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(), contexts: [] }))
    }
    await f.ctx.workingDirectory.set(f.agent, directory)
    const assembly = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
    expect(renderContextSnapshot(assembly)).toContain(`Current working directory: ${JSON.stringify(directory)}.`)
    expect(renderContextSnapshot(assembly)).not.toContain('wrong-directory')
  })

  it('does not commit a cancelled filesystem lookup and lets the next queued change proceed', async () => {
    await using f = await fixture()
    await mkdir(join(f.root, 'first'))
    await mkdir(join(f.root, 'second'))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stat = f.ctx.fs.stat.bind(f.ctx.fs)
    const probe = vi.spyOn(f.ctx.fs, 'stat').mockImplementationOnce(async (target) => {
      const info = await stat(target)
      entered.resolve(undefined)
      await release.promise
      return info
    })
    const controller = new AbortController()
    const cancelled = f.ctx.workingDirectory.set(f.agent, 'first', controller.signal)
    const rejection = expect(cancelled).rejects.toThrow('cancelled while checking directory')
    try {
      await entered.promise
      const queued = f.ctx.workingDirectory.set(f.agent, 'second')
      controller.abort(new Error('cancelled while checking directory'))
      release.resolve(undefined)
      await rejection
      await expect(queued).resolves.toBe(join(f.root, 'second'))
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change'))
        .toEqual([expect.objectContaining({ data: { cwd: join(f.root, 'second') } })])
      expect(f.harness.claim(f.agent, 'next-step', 1)).toHaveLength(1)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([cancelled, rejection])
      probe.mockRestore()
    }
  })

  it.each(['ensure', 'set'] as const)('aborts and drains pending %s before disposal completes', async (operation) => {
    await using f = await fixture()
    const directories = f.ctx.workingDirectory
    const entered = Promise.withResolvers<AbortSignal>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stat = f.ctx.fs.stat.bind(f.ctx.fs)
    const probe = vi.spyOn(f.ctx.fs, 'stat').mockImplementationOnce(async (target, signal) => {
      const info = await stat(target)
      if (signal === undefined) throw new Error('directory probe requires a cancellation signal')
      signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      entered.resolve(signal)
      await release.promise
      return info
    })
    const pending = operation === 'ensure'
      ? directories.ensure(f.agent)
      : directories.set(f.agent, f.root)
    const rejection = expect(pending).rejects.toThrow('working-directory service disposed')
    let disposal: Promise<void> | undefined
    try {
      const signal = await entered.promise
      let disposed = false
      disposal = f.directoryFiber.dispose().then(() => { disposed = true })
      await aborted.promise
      // Flush disposal's promise reactions while the provider remains parked.
      await setImmediate()
      expect(signal.aborted).toBe(true)
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await rejection
      await disposal
      expect(disposed).toBe(true)
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
      expect(f.harness.claim(f.agent, 'next-step', 1)).toEqual([])
      await expect(directories.ensure(f.agent)).rejects.toThrow('working-directory service disposed')
      expect(probe).toHaveBeenCalledOnce()
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([pending, rejection, disposal])
      probe.mockRestore()
    }
  })

  it('refuses an Agent disposed during directory inspection without publishing a change', async () => {
    await using f = await fixture()
    await mkdir(join(f.root, 'child'))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stat = f.ctx.fs.stat.bind(f.ctx.fs)
    const probe = vi.spyOn(f.ctx.fs, 'stat').mockImplementationOnce(async (target) => {
      const info = await stat(target)
      entered.resolve(undefined)
      await release.promise
      return info
    })
    const pending = f.ctx.workingDirectory.set(f.agent, 'child')
    const rejection = expect(pending).rejects.toThrow('inactive context')
    try {
      await entered.promise
      await f.agent.ctx.fiber.dispose()
      release.resolve(undefined)
      await rejection
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
      await expect(f.ctx.workingDirectory.ensure(f.agent)).rejects.toThrow('inactive context')
      expect(probe).toHaveBeenCalledOnce()
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([pending, rejection])
      probe.mockRestore()
    }
  })

  it('returns committed state and warns when the notice cannot be queued', async () => {
    await using f = await fixture()
    const child = join(f.root, 'child')
    await mkdir(child)
    const inject = vi.spyOn(f.agent, 'inject').mockImplementation(() => { throw new Error('inbox unavailable') })
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    try {
      await expect(f.ctx.workingDirectory.set(f.agent, child)).resolves.toBe(child)
      expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(child)
      expect(warn).toHaveBeenCalledWith(`working-directory: committed ${JSON.stringify(child)}, but could not queue its notice: Error: inbox unavailable`)
      const restored = await f.ctx.agents.create({
        sessionId: SessionId('notice-failure-restored'),
        seed: f.agent.session.snapshotEvents(),
        meta: { cwd: f.root },
      })
      try {
        expect(renderContextSnapshot(await f.ctx.systemPrompt.assemble({ agent: restored.agent, scope: restored.agent })))
          .toContain(`Current working directory: ${JSON.stringify(child)}.`)
      } finally {
        await restored.dispose()
      }
    } finally {
      inject.mockRestore()
      warn.mockRestore()
    }
  })

  it('exposes reading and changing through the same model tool and unregisters it on disposal', async () => {
    await using f = await fixture()
    await mkdir(join(f.root, 'child'))
    const fiber = f.ctx.plugin(WorkingDirectoryTool)
    await fiber
    const execute = (arguments_: { cd?: string }, withAgent = true) => f.ctx.tools.execute({
      name: 'working_directory', callId: ToolCallId('directory-call'), arguments: arguments_,
      signal: new AbortController().signal, ...withAgent ? { agent: f.agent } : {},
    })
    expect(await execute({})).toMatchObject({ value: { cwd: f.root }, isError: false })
    expect(await execute({ cd: 'child' })).toMatchObject({ value: { cwd: join(f.root, 'child') }, isError: false })
    expect(await execute({}, false)).toMatchObject({ isError: true })
    await fiber.dispose()
    expect(f.ctx.tools.schemas().some(tool => tool.name === 'working_directory')).toBe(false)
  })
})

describe('project containment', () => {
  it('rejects siblings outside the project root and accepts subdirectories and the root itself', async () => {
    await using f = await fixture()
    const child = join(f.root, 'child')
    const grandchild = join(child, 'grandchild')
    await mkdir(grandchild, { recursive: true })
    await expect(f.ctx.workingDirectory.set(f.agent, '..')).rejects.toThrow('outside the project directory')
    await expect(f.ctx.workingDirectory.set(f.agent, child)).resolves.toBe(child)
    await expect(f.ctx.workingDirectory.set(f.agent, 'grandchild')).resolves.toBe(grandchild)
    await expect(f.ctx.workingDirectory.set(f.agent, '..')).resolves.toBe(child)
    await expect(f.ctx.workingDirectory.set(f.agent, '..')).resolves.toBe(f.root)
    await expect(f.ctx.workingDirectory.set(f.agent, '..')).rejects.toThrow('outside the project directory')
    await expect(f.ctx.workingDirectory.set(f.agent, f.root)).resolves.toBe(f.root)
  })

  it('rejects a symlink inside the project that points outside it', async () => {
    await using f = await fixture()
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-working-directory-outside-')))
    try {
      await symlink(outside, join(f.root, 'escape'))
      await expect(f.ctx.workingDirectory.set(f.agent, 'escape'))
        .rejects.toThrow(`is outside the project directory ${JSON.stringify(f.root)}`)
      expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(f.root)
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('canonicalizes through resolve without committing a durable change', async () => {
    await using f = await fixture()
    const child = join(f.root, 'child')
    await mkdir(child)
    await expect(f.ctx.workingDirectory.resolve(f.agent, 'child/../child')).resolves.toBe(child)
    await expect(f.ctx.workingDirectory.resolve(f.agent, '..')).rejects.toThrow('outside the project directory')
    expect(f.ctx.workingDirectory.get(f.agent.session)).toBe(f.root)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
  })
})

describe('provider transport failures', () => {
  it('keeps the recorded directory, appends nothing, and warns once until a validation succeeds', async () => {
    await using f = await fixture()
    const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
    const resolve = vi.spyOn(f.ctx.fs, 'resolve')
    try {
      resolve.mockRejectedValueOnce(new Error('transport lost'))
      await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.root)
      resolve.mockRejectedValueOnce(new Error('transport lost again'))
      await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.root)
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]?.[0]).toContain('could not validate')
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'working-directory/change')).toEqual([])
      await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.root)
      resolve.mockRejectedValueOnce(new Error('transport lost after recovery'))
      await expect(f.ctx.workingDirectory.ensure(f.agent)).resolves.toBe(f.root)
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
      resolve.mockRestore()
    }
  })

  it('still rejects aborted lookups while the provider is unreachable', async () => {
    await using f = await fixture()
    const resolve = vi.spyOn(f.ctx.fs, 'resolve').mockRejectedValue(new Error('transport lost'))
    try {
      const controller = new AbortController()
      controller.abort(new Error('cancelled'))
      await expect(f.ctx.workingDirectory.ensure(f.agent, controller.signal)).rejects.toThrow('cancelled')
    } finally {
      resolve.mockRestore()
    }
  })

  it('surfaces a provider failure from an explicit change instead of reporting a missing directory', async () => {
    await using f = await fixture()
    const resolve = vi.spyOn(f.ctx.fs, 'resolve').mockRejectedValue(new Error('connection reset'))
    try {
      await expect(f.ctx.workingDirectory.set(f.agent, 'child')).rejects.toThrow('connection reset')
      await expect(f.ctx.workingDirectory.resolve(f.agent, 'child')).rejects.toThrow('connection reset')
    } finally {
      resolve.mockRestore()
    }
  })
})

/** Posix-keyed stand-in for the fs an SSH standing realm provides. */
class FakeRemoteFs extends FileSystem {
  constructor(ctx: Context, private readonly directories: ReadonlySet<string>) {
    super(ctx)
  }

  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    opts?.signal?.throwIfAborted()
    const absolute = posix.normalize(posix.isAbsolute(path) ? path : posix.resolve(opts?.cwd ?? '/', path))
    return Promise.resolve({ targetKey: FsTargetKey(absolute), displayPath: absolute })
  }

  processPath(target: FsTarget): string {
    return target.targetKey
  }

  fileUrl(target: FsTarget): string {
    return `ssh://remote${target.targetKey}`
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(parent.targetKey, child.targetKey)
    return relative === '' || (!relative.startsWith('..') && !posix.isAbsolute(relative))
  }

  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    return Promise.resolve(this.directories.has(target.targetKey)
      ? { version: FsVersion('1'), type: 'directory' }
      : undefined)
  }

  lstat(): Promise<never> {
    return Promise.reject(new Error('FakeRemoteFs: lstat is not implemented'))
  }

  readText(): Promise<never> {
    return Promise.reject(new Error('FakeRemoteFs: readText is not implemented'))
  }

  streamText(): Promise<never> {
    return Promise.reject(new Error('FakeRemoteFs: streamText is not implemented'))
  }

  readBytes(): Promise<never> {
    return Promise.reject(new Error('FakeRemoteFs: readBytes is not implemented'))
  }

  readByteRange(): Promise<never> {
    return Promise.reject(new Error('FakeRemoteFs: readByteRange is not implemented'))
  }

  listDir(): Promise<never> {
    return Promise.reject(new Error('FakeRemoteFs: listDir is not implemented'))
  }

  writeText(): Promise<never> {
    return Promise.reject(new Error('FakeRemoteFs: writeText is not implemented'))
  }

  editText(): Promise<never> {
    return Promise.reject(new Error('FakeRemoteFs: editText is not implemented'))
  }
}

const SSH_FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

/**
 * Install one shadowed `fs` on the standing scope, mirroring an SSH realm:
 * the isolate swap keeps the scope's `fs` registration distinct from the
 * host's, and the FileSystem service provides itself on the scope.
 */
function shadowFs(scopeCtx: Context, directories: ReadonlySet<string>): FileSystem {
  const isolate = Object.create(scopeCtx[Context.isolate]) as Record<string, symbol>
  isolate['fs'] = Symbol('fs')
  scopeCtx[Context.isolate] = isolate
  return new FakeRemoteFs(scopeCtx, directories)
}

describe('SSH-bound Sessions', () => {
  it('validates through the realm fs and never touches the host fs', async () => {
    await using f = await fixture()
    await f.ctx.plugin(Loader)
    await f.ctx.plugin(PluginPackages)
    f.ctx.baseUrl = pathToFileURL(SSH_FIXTURES).href
    f.ctx.loader.builtins.include = Include
    f.ctx.loader.builtins.group = Group
    await f.ctx.plugin(TypertRegistry)
    await f.ctx.plugin(AgentPresets, {
      default: 'empty',
      roots: [{ path: SSH_FIXTURES, trust: 'system' }],
      includeUserRoot: false,
    })
    f.ctx.agentPresets.registerRealm('ssh-realm', (scope) => {
      shadowFs(scope, new Set(['/remote/project', '/remote/project/sub']))
    })
    const hostResolve = vi.spyOn(f.ctx.fs, 'resolve')
    const hostStat = vi.spyOn(f.ctx.fs, 'stat')
    const bound = await f.ctx.agents.create({
      sessionId: SessionId('ssh-bound'),
      meta: { cwd: '/remote/project', sshTarget: 7 },
      setup: async (agentCtx: Context) => void await f.ctx.agentPresets.mount(agentCtx, 'empty', 'ssh-realm'),
    })
    await expect(f.ctx.workingDirectory.set(bound.agent, 'sub')).resolves.toBe('/remote/project/sub')
    expect(f.ctx.workingDirectory.get(bound.agent.session)).toBe('/remote/project/sub')
    expect(bound.agent.session.header.cwd).toBe('/remote/project')
    expect(hostResolve).not.toHaveBeenCalled()
    expect(hostStat).not.toHaveBeenCalled()
    await bound.dispose()
  })

  it('fails closed for an SSH-bound Session whose realm has no fs', async () => {
    await using f = await fixture()
    const bound = await f.ctx.agents.create({
      sessionId: SessionId('ssh-no-realm'),
      meta: { cwd: '/remote/project', sshTarget: 7 },
    })
    await expect(f.ctx.workingDirectory.ensure(bound.agent))
      .rejects.toThrow(`working-directory: SSH-bound Session ${JSON.stringify('ssh-no-realm')} has no SSH filesystem`)
    await expect(f.ctx.workingDirectory.set(bound.agent, 'sub'))
      .rejects.toThrow('has no SSH filesystem')
    await bound.dispose()
  })
})

describe('real Loader composition', () => {
  it('mounts from cordis.yml and the model request carries the current directory line', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-working-directory-loader-')))
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    try {
      const configPath = join(root, 'cordis.yml')
      await writeFile(configPath, [
        "- name: '@deepseek-ai/dsh-llm'",
        "- name: '@deepseek-ai/dsh-session'",
        "- name: '@deepseek-ai/dsh-session-projection'",
        "- name: '@deepseek-ai/dsh-system-prompt'",
        '  config:',
        '    includeRuntimeContext: true',
        "- name: '@deepseek-ai/dsh-tools'",
        "- name: '@deepseek-ai/dsh-agent'",
        "- name: '@deepseek-ai/dsh-fs-local'",
        '  config:',
        `    cwd: ${JSON.stringify(root)}`,
        "- name: '@deepseek-ai/dsh-working-directory'",
        "- name: '@deepseek-ai/dsh-agent-loop'",
        '  config:',
        '    agents: []',
        '',
      ].join('\n'))
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm')
      const { default: SessionStore } = await import('@deepseek-ai/dsh-session')
      const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
      const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
      const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
      const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent')
      const { default: AgentLoop } = await import('@deepseek-ai/dsh-agent-loop')
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-llm', LlmRuntime],
        ['@deepseek-ai/dsh-session', SessionStore],
        ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
        ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
        ['@deepseek-ai/dsh-tools', ToolRuntime],
        ['@deepseek-ai/dsh-agent', AgentRegistry],
        ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
        ['@deepseek-ai/dsh-working-directory', WorkingDirectory],
        ['@deepseek-ai/dsh-agent-loop', AgentLoop],
      ])
      const missing = (name: string) => (): never => {
        throw new Error(`unexpected Loader ${name} call`)
      }
      ctx.loader.internal = {
        version: 'v2',
        loadCache: new Map(),
        import: async (specifier: string) => {
          if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
        register: missing('register'),
        getOrCreateModuleJob: missing('getOrCreateModuleJob'),
        resolveSync: missing('resolveSync'),
        load: missing('load'),
      }
      await ctx.loader.create({
        name: 'cordis:include',
        config: { path: pathToFileURL(configPath).href },
      })
      await ctx.loader.await()

      const { MockAdapter, textResponse } = await import('../../../core/agent-loop/tests/mock-adapter.ts')
      const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
      const adapter = new MockAdapter([textResponse('done')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = await ctx.agentLoop.create(SessionId('composed-directory'), { provider: 'mock', model: 'mock' }, { cwd: root })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const request = adapter.requests[0]
      expect(request).toBeDefined()
      const contexts = request?.messages.filter(message => message.source?.kind === 'runtime-context') ?? []
      expect(contexts).toHaveLength(1)
      const body = contexts.flatMap(message => message.content).map(block => block.type === 'text' ? block.text : '').join('')
      expect(body).toContain(`Current working directory: ${JSON.stringify(root)}.`)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
